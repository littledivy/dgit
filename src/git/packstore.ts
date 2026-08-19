import pako from "pako";
import { td, concat, toHex, Sha1 } from "./util";
import { Sha1Dc, Sha1CollisionError } from "./sha1";
import { ObjType, NUM_TYPE, objectHeader } from "./objects";
import { applyDelta } from "./pack";

export const PACK_CHUNK = 1024 * 1024;
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
 * pack depth is 50; 100 leaves generous headroom for legitimately deep packs
 * while a crafted deeper (or cyclic) chain is rejected instead of overflowing
 * the stack or looping forever.
 */
const MAX_DELTA_DEPTH = 100;

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

// ingest is strictly sequential, so scratch hashers serve every object
const scratchSha = new Sha1Dc();
const streamSha = new Sha1Dc();

/**
 * Finish an object hash, refusing anything carrying a SHA-1 collision-attack
 * block. This is git's post-SHAttered rule: the id is still plain SHA-1, but
 * an object built to collide never enters the database.
 */
function finishOid(h: Sha1Dc): string {
  const oid = toHex(h.digest());
  if (h.collision) throw new Sha1CollisionError(oid);
  return oid;
}

/**
 * Every ingested object goes through the collision-detecting hash, so there
 * is no fast path here: crypto.subtle is ~10x quicker on large blobs but
 * cannot screen for near-collision blocks, and an attacker would only have to
 * pad past the threshold to skip the check.
 */
async function hashObjectAsync(type: ObjType, data: Uint8Array): Promise<string> {
  return finishOid(scratchSha.reset().update(objectHeader(type, data.length)).update(data));
}

/** Buffered sequential reader over a pack stored as chunk rows. */
class PackReader {
  pos = 0;
  private seq = -1;
  private chunk: Uint8Array = new Uint8Array(0);

  constructor(private sql: SqlStorage, private packId: number, readonly size: number) {}

  private ensure(): void {
    const want = Math.floor(this.pos / PACK_CHUNK);
    if (want !== this.seq) {
      const rows = this.sql
        .exec<{ data: ArrayBuffer }>(
          "SELECT data FROM pack_data WHERE pack_id = ? AND seq = ?",
          this.packId,
          want
        )
        .toArray();
      if (!rows.length) throw new Error(`pack ${this.packId}: missing chunk ${want}`);
      this.chunk = new Uint8Array(rows[0].data);
      this.seq = want;
    }
  }

  byte(): number {
    this.ensure();
    return this.chunk[this.pos++ - this.seq * PACK_CHUNK];
  }

  /** Remaining bytes of the chunk containing pos (never empty while pos < size). */
  window(): Uint8Array {
    this.ensure();
    return this.chunk.subarray(this.pos - this.seq * PACK_CHUNK);
  }
}

/**
 * Pack-native object database: received packfiles are stored verbatim in
 * chunk rows and indexed (oid -> pack/offset/base), preserving the client's
 * delta compression. This is what lets Linux-sized repos fit and stream.
 */
export class PackStore {
  /** LRU of decoded `pack_data` rows, keyed "packId:seq". */
  private chunks = new Map<string, Uint8Array>();

  constructor(private sql: SqlStorage, private extern: ExternalResolver) {
    this.init();
  }

  private init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pack_meta (
        pack_id INTEGER PRIMARY KEY,
        size INTEGER NOT NULL,
        count INTEGER NOT NULL,
        created INTEGER NOT NULL
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
  }

  wipe(): void {
    for (const t of ["pack_meta", "pack_data", "pack_objects", "pack_pending"]) {
      this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    this.chunks.clear(); // pack ids restart from 1: cached rows would be stale
  }

  /** Drop all packs and start empty (small-repo gc migrates objects out first). */
  reset(): void {
    this.wipe();
    this.init();
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
  readRaw(packId: number, off: number, len: number): Uint8Array {
    const first = Math.floor(off / PACK_CHUNK);
    const last = Math.floor((off + len - 1) / PACK_CHUNK);
    const out = new Uint8Array(len);
    for (let seq = first; seq <= last; seq++) {
      const chunk = this.chunk(packId, seq);
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(off, chunkStart);
      const to = Math.min(off + len, chunkStart + chunk.length);
      if (to > from) out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - off);
    }
    return out;
  }

  /**
   * One decoded `pack_data` row, through the LRU. Rows are immutable once
   * written — a pack chunk is inserted exactly once and only ever removed
   * wholesale (wipe/reset, or the orphan sweep at the top of ingest, both of
   * which clear the cache), so a hit can never be stale.
   */
  private chunk(packId: number, seq: number): Uint8Array {
    const key = `${packId}:${seq}`;
    const hit = this.chunks.get(key);
    if (hit) {
      this.chunks.delete(key); // reinsert: most-recently-used goes last
      this.chunks.set(key, hit);
      return hit;
    }
    const rows = this.sql
      .exec<{ data: ArrayBuffer }>(
        "SELECT data FROM pack_data WHERE pack_id = ? AND seq = ?",
        packId,
        seq
      )
      .toArray();
    if (!rows.length) throw new Error(`pack ${packId}: missing chunk ${seq}`);
    const chunk = new Uint8Array(rows[0].data);
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
  getObject(oid: string, cache: ObjCache): ObjRec | null {
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
        base = { type: cur.type, data: pako.inflate(this.readRaw(cur.packId, cur.dataOff, cur.dataLen)) };
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
      const delta = pako.inflate(this.readRaw(d.packId, d.dataOff, d.dataLen));
      obj = { type: base.type, data: applyDelta(obj.data, delta) };
      cache.put(d.oid, obj);
    }
    if (!chain.length) cache.put(oid, obj);
    return obj;
  }

  /**
   * Ingest a packfile arriving as a byte stream: store chunks verbatim
   * (verifying the SHA-1 trailer on the fly), then index sequentially.
   * Deltas resolve eagerly against the LRU cache — pack ordering keeps
   * bases hot — so the straggler pass afterwards is nearly empty. Memory
   * stays bounded regardless of pack size.
   */
  async ingest(
    firstBytes: Uint8Array,
    reader: ReadableStreamDefaultReader<Uint8Array> | null,
    opts: {
      maxBytes: number;
      cache: ObjCache;
      onProgress?: (msg: string) => void;
      /** called periodically so the runtime can flush its write buffer —
       * workerd holds a request's dirty pages in the 128MB isolate heap */
      flush?: () => Promise<void>;
    }
  ): Promise<{ packId: number; count: number }> {
    // a failed or interrupted ingest leaves rows without a pack_meta entry;
    // reclaim that space before starting (pack_meta is only written on success)
    const orphans = this.sql
      .exec<{ pack_id: number }>(
        "SELECT DISTINCT d.pack_id AS pack_id FROM pack_data d LEFT JOIN pack_meta m ON m.pack_id = d.pack_id WHERE m.pack_id IS NULL"
      )
      .toArray();
    for (const o of orphans) {
      for (const t of ["pack_data", "pack_objects", "pack_pending"]) {
        this.sql.exec(`DELETE FROM ${t} WHERE pack_id = ?`, o.pack_id);
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

    // phase A: stream bytes into chunk rows, hashing all but the trailing 20.
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
    if (chunkLen > 0) {
      this.sql.exec(
        "INSERT INTO pack_data (pack_id, seq, data) VALUES (?, ?, ?)",
        packId,
        seq++,
        chunkBuf.slice(0, chunkLen).buffer
      );
    }
    if (total < 32) throw new Error("pack too small");
    if (toHex(tail) !== toHex(sha.digest())) throw new Error("pack checksum mismatch");
    say(`Received pack: ${Math.round(total / 1048576)}MB\n`);

    // phase B: sequential scan with eager delta resolution
    const r = new PackReader(this.sql, packId, total);
    const magic = new Uint8Array(4);
    for (let i = 0; i < 4; i++) magic[i] = r.byte();
    if (td.decode(magic) !== "PACK") throw new Error("bad pack signature");
    let version = 0, count = 0;
    for (let i = 0; i < 4; i++) version = (version << 8) | r.byte();
    for (let i = 0; i < 4; i++) count = (count << 8) | r.byte();
    if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);

    // single-row statements: celld's SQLite caps bound variables far lower
    // than workerd, and in-process inserts are cheap even at Linux scale
    const insertObject = (row: (string | number | null)[]) => {
      // OR IGNORE, never OR REPLACE: a duplicate object must keep its FIRST
      // location. Re-pointing it at the incoming pack means the orphan sweep
      // erases it from the index if this ingest fails — objects that were
      // safely stored become unresolvable ("missing base") forever after.
      this.sql.exec(
        "INSERT OR IGNORE INTO pack_objects (oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid) VALUES (?,?,?,?,?,?,?,?,?)",
        ...row
      );
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
      const rows = this.sql
        .exec<{ oid: string }>("SELECT oid FROM pack_objects WHERE pack_id = ? AND offset = ?", packId, off)
        .toArray();
      return rows[0]?.oid ?? null;
    };

    let pendingCount = 0;
    for (let i = 0; i < count; i++) {
      const offset = r.pos;
      let byte = r.byte();
      const type = (byte >> 4) & 7;
      let entrySize = byte & 15;
      let shift = 4;
      while (byte & 0x80) {
        byte = r.byte();
        entrySize += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      }
      let baseOid: string | null = null;
      let baseOffset: number | null = null;
      if (type === 6) {
        byte = r.byte();
        let off = byte & 0x7f;
        while (byte & 0x80) {
          byte = r.byte();
          off = (off + 1) * 128 + (byte & 0x7f);
        }
        baseOffset = offset - off;
      } else if (type === 7) {
        const b = new Uint8Array(20);
        for (let j = 0; j < 20; j++) b[j] = r.byte();
        baseOid = toHex(b);
      } else if (!NUM_TYPE[type]) {
        throw new Error(`bad object type ${type} at ${offset}`);
      }

      const dataOff = r.pos;
      const isFull = type >= 1 && type <= 4;
      const objType = isFull ? NUM_TYPE[type] : null;
      const buffered = entrySize <= MAX_BUFFERED_ENTRY;
      const pieces: Uint8Array[] = [];
      if (isFull && !buffered) streamSha.reset().update(objectHeader(objType!, entrySize));
      let inflated = 0;
      const inf = new pako.Inflate();
      (inf as unknown as { onData: (c: Uint8Array) => void }).onData = (c: Uint8Array) => {
        inflated += c.length;
        if (buffered) pieces.push(c);
        else if (isFull) streamSha.update(c);
      };
      const anyInf = inf as unknown as { err: number; msg: string; ended: boolean; strm: { avail_in: number } };
      while (!anyInf.ended) {
        if (r.pos >= total) throw new Error(`truncated pack entry at ${offset}`);
        const win = r.window();
        inf.push(win, false);
        if (anyInf.err) throw new Error(`inflate failed at ${dataOff}: ${anyInf.msg}`);
        r.pos += anyInf.ended ? win.length - anyInf.strm.avail_in : win.length;
      }
      if (inflated !== entrySize) throw new Error(`entry size mismatch at ${offset}`);
      const dataLen = r.pos - dataOff;

      if (isFull) {
        let content: Uint8Array | null = null;
        let oid: string;
        if (buffered) {
          content = pieces.length === 1 ? pieces[0] : concat(pieces);
          oid = await hashObjectAsync(objType!, content);
        } else {
          oid = finishOid(streamSha);
        }
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
            try {
              base = this.getObject(resolvedBase, opts.cache);
            } catch {
              base = null;
            }
          }
          if (!base) base = this.extern(resolvedBase);
          if (base) {
            const delta = pieces.length === 1 ? pieces[0] : concat(pieces);
            const content = applyDelta(base.data, delta);
            const oid = await hashObjectAsync(base.type, content);
            insertObject([oid, packId, offset, dataOff, dataLen, base.type, content.length, entrySize, resolvedBase]);
            winPut(offset, oid);
            if (content.length <= CACHE_ENTRY_LIMIT) {
              opts.cache.put(oid, { type: base.type, data: content });
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
          try {
            base = this.getObject(baseOid, opts.cache) ?? this.extern(baseOid);
          } catch {
            base = null;
          }
          if (!base) continue; // thin base not available (yet)
          const delta = pako.inflate(this.readRaw(packId, row.data_off, row.data_len));
          const data = applyDelta(base.data, delta);
          const oid = await hashObjectAsync(base.type, data);
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

    this.sql.exec(
      "INSERT INTO pack_meta (pack_id, size, count, created) VALUES (?, ?, ?, ?)",
      packId, total, count, Date.now()
    );
    return { packId, count };
  }
}
