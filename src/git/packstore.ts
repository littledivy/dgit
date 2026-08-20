import pako from "pako";
import { td, concat, toHex, Sha1 } from "./util";
import { Sha1Dc, Sha1CollisionError } from "./sha1";
import { ObjType, NUM_TYPE, objectHeader } from "./objects";
import { applyDelta } from "./pack";
import { MultipartCapture, beginRawMultipart } from "./multipart";

export const PACK_CHUNK = 1024 * 1024;
/** a pushed pack goes to R2 only when the binding is present AND the pack is at
 * least this large; smaller packs stay in SQLite (local ~ms writes/reads). R2's
 * purpose is escaping the 10 GB per-DO SQLite cap, which only large repos hit. */
export const R2_PACK_MIN_BYTES = 16 * 1024 * 1024;
/** real Workers isolates have a hard 128MB total; self-hosted celld nodes run multi-GB heaps */
const TIGHT_MEMORY = typeof caches !== "undefined";
const MAX_BUFFERED_ENTRY = (TIGHT_MEMORY ? 8 : 32) * 1024 * 1024;
/** full entries up to this size are kept in cache — they are likely delta bases */
const CACHE_ENTRY_LIMIT = (TIGHT_MEMORY ? 2 : 4) * 1024 * 1024;
/** recent entry offsets kept in memory for ofs-delta base resolution */
const OFFSET_WINDOW = 150_000;
/**
 * Decoded pack chunks kept hot for readRaw. The clone loop reads one object
 * per call in walk order, so without this every object re-SELECTs and
 * re-decodes a whole 1MB row. A handful of 1MB chunks covers any delta chain
 * and the locality of the walk.
 */
const RAW_CHUNK_CACHE = TIGHT_MEMORY ? 4 : 8;
/**
 * Hard cap on delta base-chain length when resolving an object. git's default
 * pack depth is 50; 50000 leaves enormous headroom for legitimately deep packs
 * while a crafted unbounded chain is rejected instead of looping forever. The
 * base walk is iterative (not recursive) and separately cycle-checked via a
 * seen-set, so this bounds chain length rather than guarding stack depth.
 */
const MAX_DELTA_DEPTH = 50000;
/**
 * pako output-chunk size. The default (64 KiB) is large enough that V8 keeps
 * every inflate's backing store in its array-buffer arena, so streaming a pack
 * one Inflate per object commits arena proportional to the object count — a
 * 53MB pack peaked near 250MB of buffers this way. 16 KiB chunks are collected
 * promptly, holding inflate memory to a bounded working set regardless of pack
 * size.
 */
const INFLATE_CHUNK = 16 * 1024;
const inflateAll = (data: Uint8Array): Uint8Array => {
  const inf = new pako.Inflate({ chunkSize: INFLATE_CHUNK });
  inf.push(data, true);
  if (inf.err) throw new Error(`inflate failed: ${inf.msg}`);
  return inf.result as Uint8Array;
};

export interface ObjRec {
  type: ObjType;
  data: Uint8Array;
}

export interface PackedEntry {
  oid: string;
  packId: number;
  offset: number;
  dataOff: number;
  dataLen: number;
  type: ObjType;
  size: number;
  entrySize: number;
  baseOid: string | null;
}

export type ExternalResolver = (oid: string) => ObjRec | null;

/** Byte-budgeted LRU cache of inflated objects (delta-chain bases, hot commits/trees). */
export class ObjCache {
  private map = new Map<string, ObjRec>();
  private bytes = 0;

  constructor(private budget: number) {}

  get(oid: string): ObjRec | undefined {
    const hit = this.map.get(oid);
    if (hit) {
      this.map.delete(oid);
      this.map.set(oid, hit);
    }
    return hit;
  }

  put(oid: string, obj: ObjRec): void {
    if (obj.data.length > this.budget / 4) return;
    if (this.map.has(oid)) return;
    this.map.set(oid, obj);
    this.bytes += obj.data.length;
    while (this.bytes > this.budget) {
      const oldest = this.map.keys().next().value as string;
      this.bytes -= this.map.get(oldest)!.data.length;
      this.map.delete(oldest);
    }
  }
}

// ingest is strictly sequential, so scratch hashers serve every object. The
// SHA-1DC pair is used only when collision detection is enabled; the plain
// streaming hasher covers the flag-off huge-object path.
const scratchSha = new Sha1Dc();
const streamSha = new Sha1Dc();
const streamShaPlain = new Sha1();

/**
 * Finish a SHA-1DC hash, refusing anything carrying a SHA-1 collision-attack
 * block. This is git's post-SHAttered rule: the id is still plain SHA-1, but
 * an object built to collide never enters the database.
 */
function finishOid(h: Sha1Dc): string {
  const oid = toHex(h.digest());
  if (h.collision) throw new Sha1CollisionError(oid);
  return oid;
}

/**
 * Hash a fully-materialized object. With collision detection off (default) the
 * id comes from native crypto.subtle — byte-identical to plain SHA-1 but ~24x
 * faster than the JS hasher; with it on, SHA-1DC screens every block. The
 * object is already in memory here, so the one-shot header+data buffer adds no
 * unbounded allocation.
 */
async function hashObjectAsync(type: ObjType, data: Uint8Array, cd: boolean): Promise<string> {
  if (cd) return finishOid(scratchSha.reset().update(objectHeader(type, data.length)).update(data));
  const header = objectHeader(type, data.length);
  const buf = new Uint8Array(header.length + data.length);
  buf.set(header);
  buf.set(data, header.length);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", buf)));
}

/**
 * Buffered sequential reader over a pack stored as SQLite chunk rows or an R2
 * object. Chunks are loaded through the owning PackStore's chunk cache (async
 * because an R2-backed chunk is a range GET), so byte()/window() await; the SQL
 * backend resolves without I/O.
 */
class PackReader {
  pos = 0;
  private seq = -1;
  private chunk: Uint8Array = new Uint8Array(0);

  constructor(private load: (seq: number) => Promise<Uint8Array>, readonly size: number) {}

  private async ensure(): Promise<void> {
    const want = Math.floor(this.pos / PACK_CHUNK);
    if (want !== this.seq) {
      this.chunk = await this.load(want);
      this.seq = want;
    }
  }

  async byte(): Promise<number> {
    await this.ensure();
    return this.chunk[this.pos++ - this.seq * PACK_CHUNK];
  }

  /** Remaining bytes of the chunk containing pos (never empty while pos < size). */
  async window(): Promise<Uint8Array> {
    await this.ensure();
    return this.chunk.subarray(this.pos - this.seq * PACK_CHUNK);
  }
}

/**
 * Pack-native object database: received packfiles are stored verbatim — in R2
 * under `raw/<repo>/<packId>` when a bucket is bound (PACK_CACHE), else in
 * SQLite chunk rows (the fallback / celld path) — and indexed (oid ->
 * pack/offset/base), preserving the client's delta compression. Only the index
 * ever lives in SQLite for an R2-backed pack, so pack data escapes the per-DO
 * storage ceiling. This is what lets large repos fit and stream.
 */
export class PackStore {
  /** LRU of decoded pack chunks, keyed "packId:seq" (SQLite row or R2 range). */
  private chunks = new Map<string, Uint8Array>();
  /**
   * R2 raw-pack backend for this repo, or null when no bucket is bound (celld /
   * Workers without the binding). When set, newly ingested packs store their
   * bytes in R2 under `raw/<repo>/<packId>` and keep only the index in SQLite;
   * pre-existing SQLite packs keep working (backend is recorded per pack).
   */
  private r2: { bucket: R2Bucket; repo: string } | null = null;
  /** Cached backend ('sql' | 'r2') per pack id, from pack_meta.store. */
  private backend = new Map<number, "sql" | "r2">();

  constructor(private sql: SqlStorage, private extern: ExternalResolver) {
    this.init();
  }

  /** Bind (or clear) the R2 backend. Idempotent; the DO is per-repo so this is
   * set on each request from the repo name. */
  setR2(bucket: R2Bucket | undefined, repo: string): void {
    this.r2 = bucket ? { bucket, repo } : null;
  }

  private rawKey(packId: number): string {
    return `raw/${this.r2!.repo}/${packId}`;
  }

  /** Storage backend of a pack. Cached; falls back to a pack_meta lookup. The
   * cache is primed at ingest start (before pack_meta exists) so phase B/C read
   * the right source. */
  private backendOf(packId: number): "sql" | "r2" {
    const hit = this.backend.get(packId);
    if (hit) return hit;
    const rows = this.sql
      .exec<{ store: string }>("SELECT store FROM pack_meta WHERE pack_id = ?", packId)
      .toArray();
    const b = rows[0]?.store === "r2" ? "r2" : "sql";
    this.backend.set(packId, b);
    return b;
  }

  private init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pack_meta (
        pack_id INTEGER PRIMARY KEY,
        size INTEGER NOT NULL,
        count INTEGER NOT NULL,
        created INTEGER NOT NULL,
        store TEXT NOT NULL DEFAULT 'sql'
      );
      CREATE TABLE IF NOT EXISTS pack_data (
        pack_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (pack_id, seq)
      );
      CREATE TABLE IF NOT EXISTS pack_objects (
        oid TEXT PRIMARY KEY,
        pack_id INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        data_off INTEGER NOT NULL,
        data_len INTEGER NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        entry_size INTEGER NOT NULL,
        base_oid TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pack_objects_loc ON pack_objects(pack_id, offset);
      CREATE TABLE IF NOT EXISTS pack_pending (
        pack_id INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        data_off INTEGER NOT NULL,
        data_len INTEGER NOT NULL,
        entry_size INTEGER NOT NULL,
        base_oid TEXT,
        base_offset INTEGER,
        PRIMARY KEY (pack_id, offset)
      );
    `);
    // back-fill the store column on repos whose pack_meta predates the R2 backend:
    // every such pack is SQLite-backed, which the 'sql' default records
    const cols = this.sql.exec<{ name: string }>("PRAGMA table_info(pack_meta)").toArray();
    if (!cols.some((c) => c.name === "store")) {
      this.sql.exec("ALTER TABLE pack_meta ADD COLUMN store TEXT NOT NULL DEFAULT 'sql'");
    }
  }

  wipe(): void {
    for (const t of ["pack_meta", "pack_data", "pack_objects", "pack_pending"]) {
      this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    this.chunks.clear(); // pack ids restart from 1: cached rows would be stale
    this.backend.clear();
  }

  /** Drop all packs and start empty (small-repo gc migrates objects out first). */
  reset(): void {
    this.wipe();
    this.init();
  }

  /** Pack ids of the currently R2-backed packs (for GC to delete their R2 bytes). */
  r2PackIds(): number[] {
    return this.sql
      .exec<{ pack_id: number }>("SELECT pack_id FROM pack_meta WHERE store = 'r2'")
      .toArray()
      .map((r) => r.pack_id);
  }

  /** Delete the R2 raw objects for the given pack ids (no-op without a binding). */
  async deleteR2Packs(packIds: number[]): Promise<void> {
    if (!this.r2 || !packIds.length) return;
    const keys = packIds.map((id) => this.rawKey(id));
    for (let i = 0; i < keys.length; i += 100) {
      try {
        await this.r2.bucket.delete(keys.slice(i, i + 100));
      } catch {
        // best effort: an undeleted raw object is unreferenced garbage
      }
    }
  }

  countObjects(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pack_objects").one().n;
  }

  /** Total stored bytes across all indexed packs (0 when pack-empty). */
  totalPackBytes(): number {
    return this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM pack_meta").one().n;
  }

  /**
   * Bytes of pack storage the raw-chunk LRU keeps hot. A pack no larger than
   * this fits entirely in cache, so readRaw never re-decodes a chunk no matter
   * what order objects are emitted in — sorting for read locality is pure
   * overhead below this threshold.
   */
  rawCacheWindow(): number {
    return RAW_CHUNK_CACHE * PACK_CHUNK;
  }

  lookup(oid: string): PackedEntry | null {
    const rows = this.sql
      .exec<{
        pack_id: number; offset: number; data_off: number; data_len: number;
        type: ObjType; size: number; entry_size: number; base_oid: string | null;
      }>(
        "SELECT pack_id, offset, data_off, data_len, type, size, entry_size, base_oid FROM pack_objects WHERE oid = ?",
        oid
      )
      .toArray();
    const r = rows[0];
    if (!r) return null;
    return {
      oid, packId: r.pack_id, offset: r.offset, dataOff: r.data_off, dataLen: r.data_len,
      type: r.type, size: r.size, entrySize: r.entry_size, baseOid: r.base_oid,
    };
  }

  typeAndSize(oid: string): { type: ObjType; size: number } | null {
    const rows = this.sql
      .exec<{ type: ObjType; size: number }>("SELECT type, size FROM pack_objects WHERE oid = ?", oid)
      .toArray();
    return rows[0] ?? null;
  }

  /** Distinct delta-base oids: a second reference edge gc must not sever. */
  baseOids(): string[] {
    return this.sql
      .exec<{ base_oid: string }>("SELECT DISTINCT base_oid FROM pack_objects WHERE base_oid IS NOT NULL")
      .toArray()
      .map((r) => r.base_oid);
  }

  findOidPrefix(prefix: string): string[] {
    return this.sql
      .exec<{ oid: string }>("SELECT oid FROM pack_objects WHERE oid LIKE ? LIMIT 2", prefix + "%")
      .toArray()
      .map((r) => r.oid);
  }

  /**
   * Raw stored (still-compressed) bytes of a pack region. Chunk rows are
   * fetched one at a time: a wide range in a single SELECT can exceed the
   * runtime's result-set size cap (celld materializes blob rows as JSON).
   */
  async readRaw(packId: number, off: number, len: number): Promise<Uint8Array> {
    const first = Math.floor(off / PACK_CHUNK);
    const last = Math.floor((off + len - 1) / PACK_CHUNK);
    const out = new Uint8Array(len);
    for (let seq = first; seq <= last; seq++) {
      const chunk = await this.chunk(packId, seq);
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(off, chunkStart);
      const to = Math.min(off + len, chunkStart + chunk.length);
      if (to > from) out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - off);
    }
    return out;
  }

  /**
   * One decoded pack chunk, through the LRU. For a SQLite-backed pack this is a
   * `pack_data` row; for an R2-backed pack it is an aligned ~1 MiB range GET
   * against `raw/<repo>/<packId>`, so sorted sequential reads (a clone) issue
   * ~one GET per chunk instead of one per object. Chunks are immutable once
   * written — a pack is inserted once and only ever removed wholesale (wipe/
   * reset, or the orphan sweep at the top of ingest, both of which clear the
   * cache), so a hit can never be stale.
   */
  private async chunk(packId: number, seq: number): Promise<Uint8Array> {
    const key = `${packId}:${seq}`;
    const hit = this.chunks.get(key);
    if (hit) {
      this.chunks.delete(key); // reinsert: most-recently-used goes last
      this.chunks.set(key, hit);
      return hit;
    }
    let chunk: Uint8Array;
    if (this.backendOf(packId) === "r2") {
      if (!this.r2) throw new Error(`pack ${packId}: R2 backend not bound`);
      const obj = await this.r2.bucket.get(this.rawKey(packId), {
        range: { offset: seq * PACK_CHUNK, length: PACK_CHUNK },
      });
      if (!obj) throw new Error(`pack ${packId}: missing R2 object ${this.rawKey(packId)}`);
      chunk = new Uint8Array(await obj.arrayBuffer());
    } else {
      const rows = this.sql
        .exec<{ data: ArrayBuffer }>(
          "SELECT data FROM pack_data WHERE pack_id = ? AND seq = ?",
          packId,
          seq
        )
        .toArray();
      if (!rows.length) throw new Error(`pack ${packId}: missing chunk ${seq}`);
      chunk = new Uint8Array(rows[0].data);
    }
    this.chunks.set(key, chunk);
    while (this.chunks.size > RAW_CHUNK_CACHE) {
      this.chunks.delete(this.chunks.keys().next().value as string);
    }
    return chunk;
  }

  /**
   * Inflate + delta-resolve an object out of pack storage. A crafted pack can
   * chain deltas arbitrarily deep or in a cycle, so the base chain is walked
   * ITERATIVELY (not recursively) through cheap index lookups first — bounding
   * the chain length and detecting cycles before a single delta is inflated —
   * then applied from the base upward, holding at most two inflated buffers at
   * a time. This caps both stack depth and peak memory regardless of input.
   */
  async getObject(oid: string, cache: ObjCache): Promise<ObjRec | null> {
    const cached = cache.get(oid);
    if (cached) return cached;
    const first = this.lookup(oid);
    if (!first) return null;

    // walk to the base via lookups only: collect the delta entries, resolve
    // where the chain bottoms out (a full entry, a cached object, or a thin
    // base from another pack / loose storage).
    const chain: PackedEntry[] = [];
    const seen = new Set<string>();
    let base: ObjRec | null = null;
    let cur: PackedEntry = first;
    for (;;) {
      if (seen.has(cur.oid)) throw new Error(`cyclic delta chain at ${cur.oid}`);
      seen.add(cur.oid);
      if (!cur.baseOid) {
        base = { type: cur.type, data: inflateAll(await this.readRaw(cur.packId, cur.dataOff, cur.dataLen)) };
        break;
      }
      if (chain.length >= MAX_DELTA_DEPTH) throw new Error(`delta chain exceeds depth ${MAX_DELTA_DEPTH} at ${oid}`);
      chain.push(cur);
      const cachedBase = cache.get(cur.baseOid);
      if (cachedBase) { base = cachedBase; break; }
      const next = this.lookup(cur.baseOid);
      if (!next) {
        const ext = this.extern(cur.baseOid);
        if (!ext) throw new Error(`missing delta base ${cur.baseOid} for ${cur.oid}`);
        base = ext;
        break;
      }
      cur = next;
    }

    // apply deltas from the base upward (chain is target..base order)
    let obj = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const d = chain[i];
      const delta = inflateAll(await this.readRaw(d.packId, d.dataOff, d.dataLen));
      obj = { type: base.type, data: applyDelta(obj.data, delta) };
      cache.put(d.oid, obj);
    }
    if (!chain.length) cache.put(oid, obj);
    return obj;
  }

  /**
   * Ingest a packfile arriving as a byte stream: store the bytes verbatim
   * (to R2 when a bucket is bound, else SQLite chunk rows) while verifying the
   * SHA-1 trailer on the fly, then index sequentially.
   * Deltas resolve eagerly against the LRU cache — pack ordering keeps
   * bases hot — so the straggler pass afterwards is nearly empty. Memory
   * stays bounded regardless of pack size.
   */
  async ingest(
    firstBytes: Uint8Array,
    reader: ReadableStreamDefaultReader<Uint8Array> | null,
    opts: {
      maxBytes: number;
      /** push body size (content-length ~= pack size); packs this size are
       * stored in R2 when a bucket is bound, else in SQLite. Absent/unknown
       * (chunked pushes) picks SQLite — the small-push-fast bias. */
      sizeHint?: number;
      cache: ObjCache;
      onProgress?: (msg: string) => void;
      /** called periodically so the runtime can flush its write buffer —
       * workerd holds a request's dirty pages in the 128MB isolate heap */
      flush?: () => Promise<void>;
      /** screen every block with SHA-1DC (git-parity collision detection);
       * default hashes with native crypto.subtle, which yields the identical
       * oid without the collision check */
      collisionDetect?: boolean;
    }
  ): Promise<{ packId: number; count: number }> {
    const cd = opts.collisionDetect ?? false;
    // a failed or interrupted ingest leaves rows (or an R2 raw object) without a
    // pack_meta entry; reclaim that space before starting (pack_meta is only
    // written on success). Union across every per-pack table so an R2 ingest that
    // died mid-index — whose bytes are in R2, not pack_data — is caught too.
    const orphans = this.sql
      .exec<{ pack_id: number }>(
        `SELECT pack_id FROM (
           SELECT DISTINCT pack_id FROM pack_data
           UNION SELECT DISTINCT pack_id FROM pack_objects
           UNION SELECT DISTINCT pack_id FROM pack_pending
         ) WHERE pack_id NOT IN (SELECT pack_id FROM pack_meta)`
      )
      .toArray();
    for (const o of orphans) {
      for (const t of ["pack_data", "pack_objects", "pack_pending"]) {
        this.sql.exec(`DELETE FROM ${t} WHERE pack_id = ?`, o.pack_id);
      }
      // an interrupted R2 ingest may have left a completed raw object; delete it
      if (this.r2) {
        try {
          await this.r2.bucket.delete(this.rawKey(o.pack_id));
        } catch {
          // best effort: the packId is reused next and its raw key overwritten
        }
      }
    }
    // the reclaimed pack id is about to be handed out again: drop anything the
    // chunk LRU still holds for it (and for anything else — it is only a cache)
    if (orphans.length) this.chunks.clear();
    const packId =
      (this.sql.exec<{ m: number | null }>("SELECT MAX(pack_id) AS m FROM pack_meta").one().m ?? 0) + 1;
    const started = Date.now();
    const say = (msg: string) => {
      opts.onProgress?.(msg);
      console.log(`[ingest pack ${packId} +${Math.round((Date.now() - started) / 1000)}s] ${msg.trim()}`);
    };

    // storage backend: a large pack (sizeHint >= R2_PACK_MIN_BYTES) with an R2
    // binding streams its bytes to raw/<repo>/<packId> via multipart and only the
    // index stays in SQLite; small packs (and any push without the binding or with
    // unknown length) go to pack_data as before. Prime the backend cache now — before
    // pack_meta exists — so phase B/C readRaw hits the right source. A refused
    // multipart begin (celld makes createMultipartUpload throw) degrades to SQLite.
    let capture: MultipartCapture | null = null;
    const wantR2 = this.r2 !== null && opts.sizeHint !== undefined && opts.sizeHint >= R2_PACK_MIN_BYTES;
    if (this.r2 && wantR2) {
      const mp = await beginRawMultipart(this.r2.bucket, this.rawKey(packId));
      if (mp) capture = new MultipartCapture(mp);
    }
    const r2Backed = capture !== null;
    this.backend.set(packId, r2Backed ? "r2" : "sql");

    // phase A: stream bytes into R2 (or chunk rows), hashing all but the trailing 20.
    // Strictly linear: a cursor fills a fixed 1MB buffer — the source may
    // arrive as one multi-GB chunk (celld buffers request bodies), so any
    // re-concatenation of the remainder would go quadratic.
    const sha = new Sha1();
    let tail = new Uint8Array(0); // rolling 20-byte lookbehind (the trailer)
    let total = 0;
    let seq = 0;
    const chunkBuf = new Uint8Array(PACK_CHUNK);
    let chunkLen = 0;
    let lastLogged = 0;
    const feed = (data: Uint8Array) => {
      total += data.length;
      if (total > opts.maxBytes) throw new Error("pack exceeds maximum push size");
      if (total - lastLogged >= 64 * 1024 * 1024) {
        lastLogged = total;
        say(`Receiving pack: ${Math.round(total / 1048576)}MB\n`);
      }
      const joined = tail.length ? concat([tail, data]) : data;
      if (joined.length > 20) {
        sha.update(joined.subarray(0, joined.length - 20));
        tail = joined.slice(joined.length - 20);
      } else {
        tail = joined.slice();
      }
      if (capture) {
        capture.push(data); // copied into a 16 MiB multipart part buffer
        return;
      }
      let off = 0;
      while (off < data.length) {
        const take = Math.min(PACK_CHUNK - chunkLen, data.length - off);
        chunkBuf.set(data.subarray(off, off + take), chunkLen);
        chunkLen += take;
        off += take;
        if (chunkLen === PACK_CHUNK) {
          this.sql.exec(
            "INSERT INTO pack_data (pack_id, seq, data) VALUES (?, ?, ?)",
            packId,
            seq++,
            chunkBuf.slice().buffer
          );
          chunkLen = 0;
        }
      }
    };
    // feed in bounded slices with yields, so one giant buffered body doesn't
    // monopolize the event loop for a minutes-long synchronous stretch
    const FEED_SLICE = 8 * 1024 * 1024;
    const feedSliced = async (data: Uint8Array) => {
      for (let off = 0; off < data.length; off += FEED_SLICE) {
        feed(data.subarray(off, off + FEED_SLICE));
        if (capture) {
          await capture.drain(); // upload whole 16 MiB parts, keep only the remainder
          if (capture.aborted) throw new Error("pack upload to R2 failed");
        }
        if (data.length > FEED_SLICE) await new Promise((res) => setTimeout(res, 0));
        await opts.flush?.();
      }
    };
    if (firstBytes.length) await feedSliced(firstBytes);
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) await feedSliced(value);
      }
    }
    if (!capture && chunkLen > 0) {
      this.sql.exec(
        "INSERT INTO pack_data (pack_id, seq, data) VALUES (?, ?, ?)",
        packId,
        seq++,
        chunkBuf.slice(0, chunkLen).buffer
      );
    }
    // validate the trailer before completing the R2 upload, so a corrupt push
    // never leaves a finished raw object (abort leaves R2 with nothing).
    if (total < 32) {
      if (capture) await capture.abort();
      throw new Error("pack too small");
    }
    if (toHex(tail) !== toHex(sha.digest())) {
      if (capture) await capture.abort();
      throw new Error("pack checksum mismatch");
    }
    if (capture) {
      // complete the multipart BEFORE phase B/C: both readRaw the finished raw
      // object (phase B for eager delta bases, phase C for deferred deltas).
      await capture.finish();
      if (capture.aborted) throw new Error("pack upload to R2 failed");
    }
    say(`Received pack: ${Math.round(total / 1048576)}MB\n`);

    // phase B: sequential scan with eager delta resolution
    const r = new PackReader((s) => this.chunk(packId, s), total);
    const magic = new Uint8Array(4);
    for (let i = 0; i < 4; i++) magic[i] = await r.byte();
    if (td.decode(magic) !== "PACK") throw new Error("bad pack signature");
    let version = 0, count = 0;
    for (let i = 0; i < 4; i++) version = (version << 8) | (await r.byte());
    for (let i = 0; i < 4; i++) count = (count << 8) | (await r.byte());
    if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);

    // batched index inserts: one exec per object made pack_objects a top SQL
    // cost, and deferring rows is safe because delta bases resolve from the
    // in-memory offset window and object cache — the flush points below cover
    // the rare pack_objects SELECT fallbacks (oidByOffset miss, getObject).
    // OR IGNORE keeps a duplicate oid's FIRST location — including within one
    // batch — so a failed ingest's orphan sweep can't strand a stored object.
    // workerd caps a DO SQL statement at ~100 bound variables (celld's stock
    // SQLite allows more); 10 rows x 9 cols = 90 stays under that on both.
    const OBJ_BATCH = 10;
    let objBatch: (string | number | null)[] = [];
    let objBatchRows = 0;
    const flushObjects = () => {
      if (!objBatchRows) return;
      const values = Array(objBatchRows).fill("(?,?,?,?,?,?,?,?,?)").join(",");
      this.sql.exec(
        `INSERT OR IGNORE INTO pack_objects (oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid) VALUES ${values}`,
        ...objBatch
      );
      objBatch = [];
      objBatchRows = 0;
    };
    const insertObject = (row: (string | number | null)[]) => {
      for (const v of row) objBatch.push(v);
      if (++objBatchRows >= OBJ_BATCH) flushObjects();
    };
    const insertPending = (row: (string | number | null)[]) => {
      this.sql.exec(
        "INSERT INTO pack_pending (pack_id, offset, data_off, data_len, entry_size, base_oid, base_offset) VALUES (?,?,?,?,?,?,?)",
        ...row
      );
    };

    // rotating offset -> oid window: ofs-delta bases are nearly always recent
    let winCur = new Map<number, string>();
    let winPrev = new Map<number, string>();
    const winPut = (off: number, oid: string) => {
      winCur.set(off, oid);
      if (winCur.size >= OFFSET_WINDOW) {
        winPrev = winCur;
        winCur = new Map();
      }
    };
    const oidByOffset = (off: number): string | null => {
      const hit = winCur.get(off) ?? winPrev.get(off);
      if (hit) return hit;
      flushObjects(); // a windowed miss falls back to SELECT: deferred rows must be visible
      const rows = this.sql
        .exec<{ oid: string }>("SELECT oid FROM pack_objects WHERE pack_id = ? AND offset = ?", packId, off)
        .toArray();
      return rows[0]?.oid ?? null;
    };

    let pendingCount = 0;
    for (let i = 0; i < count; i++) {
      const offset = r.pos;
      let byte = await r.byte();
      const type = (byte >> 4) & 7;
      let entrySize = byte & 15;
      let shift = 4;
      while (byte & 0x80) {
        byte = await r.byte();
        entrySize += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      }
      let baseOid: string | null = null;
      let baseOffset: number | null = null;
      if (type === 6) {
        byte = await r.byte();
        let off = byte & 0x7f;
        while (byte & 0x80) {
          byte = await r.byte();
          off = (off + 1) * 128 + (byte & 0x7f);
        }
        baseOffset = offset - off;
      } else if (type === 7) {
        const b = new Uint8Array(20);
        for (let j = 0; j < 20; j++) b[j] = await r.byte();
        baseOid = toHex(b);
      } else if (!NUM_TYPE[type]) {
        throw new Error(`bad object type ${type} at ${offset}`);
      }

      const dataOff = r.pos;
      const isFull = type >= 1 && type <= 4;
      const objType = isFull ? NUM_TYPE[type] : null;
      const buffered = entrySize <= MAX_BUFFERED_ENTRY;
      // buffered entries inflate straight into one exact-size buffer (no piece
      // array + concat, which would hold the object twice at once)
      const content = buffered ? new Uint8Array(entrySize) : null;
      if (isFull && !buffered) {
        if (cd) streamSha.reset().update(objectHeader(objType!, entrySize));
        else streamShaPlain.reset().update(objectHeader(objType!, entrySize));
      }
      let inflated = 0;
      const inf = new pako.Inflate({ chunkSize: INFLATE_CHUNK });
      (inf as unknown as { onData: (c: Uint8Array) => void }).onData = (c: Uint8Array) => {
        if (content) content.set(c, inflated);
        else if (isFull) (cd ? streamSha : streamShaPlain).update(c);
        inflated += c.length;
      };
      const anyInf = inf as unknown as { err: number; msg: string; ended: boolean; strm: { avail_in: number } };
      while (!anyInf.ended) {
        if (r.pos >= total) throw new Error(`truncated pack entry at ${offset}`);
        const win = await r.window();
        inf.push(win, false);
        if (anyInf.err) throw new Error(`inflate failed at ${dataOff}: ${anyInf.msg}`);
        r.pos += anyInf.ended ? win.length - anyInf.strm.avail_in : win.length;
      }
      if (inflated !== entrySize) throw new Error(`entry size mismatch at ${offset}`);
      const dataLen = r.pos - dataOff;

      if (isFull) {
        const oid = buffered
          ? await hashObjectAsync(objType!, content!, cd)
          : cd
            ? finishOid(streamSha)
            : toHex(streamShaPlain.digest());
        insertObject([oid, packId, offset, dataOff, dataLen, objType!, entrySize, entrySize, null]);
        winPut(offset, oid);
        if (content && content.length <= CACHE_ENTRY_LIMIT) {
          opts.cache.put(oid, { type: objType!, data: content });
        }
      } else {
        const resolvedBase = baseOid ?? (baseOffset !== null ? oidByOffset(baseOffset) : null);
        let resolved = false;
        if (buffered && resolvedBase) {
          let base: ObjRec | null = opts.cache.get(resolvedBase) ?? null;
          if (!base) {
            flushObjects(); // getObject SELECTs pack_objects: deferred rows must be visible
            try {
              base = await this.getObject(resolvedBase, opts.cache);
            } catch {
              base = null;
            }
          }
          if (!base) base = this.extern(resolvedBase);
          if (base) {
            const data = applyDelta(base.data, content!);
            const oid = await hashObjectAsync(base.type, data, cd);
            insertObject([oid, packId, offset, dataOff, dataLen, base.type, data.length, entrySize, resolvedBase]);
            winPut(offset, oid);
            if (data.length <= CACHE_ENTRY_LIMIT) {
              opts.cache.put(oid, { type: base.type, data });
            }
            resolved = true;
          }
        }
        if (!resolved) {
          insertPending([packId, offset, dataOff, dataLen, entrySize, baseOid, baseOffset]);
          pendingCount++;
        }
      }

      if (i % 2000 === 1999) {
        await new Promise((res) => setTimeout(res, 0));
        await opts.flush?.();
        if (i % 100000 === 99999) say(`Indexing objects: ${i + 1}/${count}\n`);
      }
    }
    // the header count must account for every byte up to the 20-byte trailer;
    // otherwise objects were silently dropped (or junk trails the pack)
    if (r.pos !== total - 20) throw new Error("pack has trailing data or bad object count");
    await opts.flush?.();
    say(`Indexed ${count} objects (${pendingCount} deferred)\n`);

    // phase C: stragglers — deltas whose base appeared later in the pack,
    // or thin-pack bases that live in another pack / loose storage
    let pendingTotal = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM pack_pending WHERE pack_id = ?", packId)
      .one().n;
    let resolvedTotal = 0;
    while (pendingTotal > 0) {
      let resolvedThisPass = 0;
      let lastOffset = -1;
      for (;;) {
        const page = this.sql
          .exec<{
            offset: number; data_off: number; data_len: number; entry_size: number;
            base_oid: string | null; base_offset: number | null;
          }>(
            "SELECT offset, data_off, data_len, entry_size, base_oid, base_offset FROM pack_pending WHERE pack_id = ? AND offset > ? ORDER BY offset LIMIT 500",
            packId,
            lastOffset
          )
          .toArray();
        if (!page.length) break;
        for (const row of page) {
          lastOffset = row.offset;
          let baseOid = row.base_oid;
          if (!baseOid && row.base_offset !== null) {
            baseOid = oidByOffset(row.base_offset);
            if (!baseOid) continue; // base itself still pending
          }
          if (!baseOid) continue;
          let base: ObjRec | null = null;
          flushObjects(); // getObject SELECTs pack_objects: deferred rows must be visible
          try {
            base = (await this.getObject(baseOid, opts.cache)) ?? this.extern(baseOid);
          } catch {
            base = null;
          }
          if (!base) continue; // thin base not available (yet)
          const delta = inflateAll(await this.readRaw(packId, row.data_off, row.data_len));
          const data = applyDelta(base.data, delta);
          const oid = await hashObjectAsync(base.type, data, cd);
          insertObject([oid, packId, row.offset, row.data_off, row.data_len, base.type, data.length, row.entry_size, baseOid]);
          this.sql.exec("DELETE FROM pack_pending WHERE pack_id = ? AND offset = ?", packId, row.offset);
          winPut(row.offset, oid);
          if (data.length <= CACHE_ENTRY_LIMIT) opts.cache.put(oid, { type: base.type, data });
          resolvedTotal++;
          resolvedThisPass++;
          if (resolvedTotal % 2000 === 0) {
            await new Promise((res) => setTimeout(res, 0));
            if (resolvedTotal % 100000 === 0) say(`Resolving deltas: ${resolvedTotal}\n`);
          }
        }
      }
      pendingTotal -= resolvedThisPass;
      if (resolvedThisPass === 0 && pendingTotal > 0) {
        throw new Error(`cannot resolve ${pendingTotal} delta object(s): missing base`);
      }
    }
    if (resolvedTotal) say(`Resolved ${resolvedTotal} deferred delta(s)\n`);
    flushObjects(); // commit the final partial batch before pack_meta marks the pack complete

    this.sql.exec(
      "INSERT INTO pack_meta (pack_id, size, count, created, store) VALUES (?, ?, ?, ?, ?)",
      packId, total, count, Date.now(), r2Backed ? "r2" : "sql"
    );
    return { packId, count };
  }
}
