import { concat, te, sha1hex } from "./util";
import { deflate, inflate } from "./zlib";
import { ObjType } from "./objects";
import { OidSet } from "./oidset";
import { PackStore, ObjCache, ObjRec } from "./packstore";

/** A reachable pack entry, streamed in storage order by `reachablePackedAfter`.
 *  The `size` field of a full PackedEntry is not needed to emit the pack, so it
 *  is left unselected. */
export interface PackedReachable {
  oid: string;
  packId: number;
  offset: number;
  dataOff: number;
  dataLen: number;
  type: ObjType;
  entrySize: number;
  baseOid: string | null;
}

const CHUNK = 1024 * 1024; // stay well under the DO SQLite per-row limit
// serving cache: Workers isolates have a hard 128MB total, so stay modest
// there; self-hosted celld nodes run with multi-GB heaps
const CACHE_BUDGET = typeof caches !== "undefined" ? 16 * 1024 * 1024 : 128 * 1024 * 1024;

/**
 * Git object database + refs, stored in a Durable Object's SQLite database.
 * Small/legacy objects live loose (zlib-deflated, chunked across rows);
 * pushed packs are kept verbatim and served through the PackStore index.
 */
export class GitStore {
  readonly packs: PackStore;
  readonly cache = new ObjCache(CACHE_BUDGET);
  /**
   * Whether the loose `objects` table holds anything. A pushed repo is
   * pack-native — loose objects only appear after a gc migration (see
   * runGc) — so on the normal path this is false and every get/has/typeAndSize
   * skips a guaranteed-miss loose SELECT and goes straight to the pack index.
   * Cached in memory and mirrored to the `has-loose` meta row so it survives
   * isolate eviction; back-filled once for repos that predate the flag.
   */
  private hasLoose: boolean;

  constructor(private sql: SqlStorage) {
    this.packs = new PackStore(sql, (oid) => this.getLoose(oid));
    sql.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        oid TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        oid TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (oid, seq)
      );
      CREATE TABLE IF NOT EXISTS refs (
        name TEXT PRIMARY KEY,
        target TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reachable (
        oid TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS peeled (
        oid TEXT PRIMARY KEY,
        target TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stats_cache (
        tip_oid TEXT NOT NULL,
        period TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (tip_oid, period)
      );
      CREATE TABLE IF NOT EXISTS push_edges (
        child TEXT NOT NULL
      );
    `);
    const flag = this.getMeta("has-loose");
    if (flag === null) {
      // back-fill: a repo migrated by an older build may already hold loose
      // objects with no flag set — probe once and record the answer
      const any = this.sql.exec("SELECT 1 FROM objects LIMIT 1").toArray().length > 0;
      this.setMeta("has-loose", any ? "1" : "0");
      this.hasLoose = any;
    } else {
      this.hasLoose = flag === "1";
    }
  }

  has(oid: string): boolean {
    if (this.hasLoose && this.sql.exec("SELECT 1 FROM objects WHERE oid = ?", oid).toArray().length > 0) return true;
    return this.packs.typeAndSize(oid) !== null;
  }

  typeAndSize(oid: string): { type: ObjType; size: number } | null {
    if (this.hasLoose) {
      const rows = this.sql
        .exec<{ type: ObjType; size: number }>("SELECT type, size FROM objects WHERE oid = ?", oid)
        .toArray();
      if (rows[0]) return rows[0];
    }
    return this.packs.typeAndSize(oid);
  }

  private getLoose(oid: string): ObjRec | null {
    if (!this.hasLoose) return null;
    const rows = this.sql
      .exec<{ type: ObjType; size: number }>("SELECT type, size FROM objects WHERE oid = ?", oid)
      .toArray();
    if (!rows.length) return null;
    const chunks = this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM chunks WHERE oid = ? ORDER BY seq", oid)
      .toArray();
    const packed = concat(chunks.map((r) => new Uint8Array(r.data)));
    return { type: rows[0].type, data: inflate(packed) };
  }

  async get(oid: string): Promise<{ type: ObjType; data: Uint8Array } | null> {
    return this.getLoose(oid) ?? (await this.packs.getObject(oid, this.cache));
  }

  /**
   * Bind (or clear) the R2 raw-pack backend for this repo. Absent binding keeps
   * every pack in SQLite (celld / Workers without the binding). Idempotent and
   * cheap: the DO is per-repo, so this is set on each request from the repo name.
   */
  setR2(bucket: R2Bucket | undefined, repo: string): void {
    this.packs.setR2(bucket, repo);
  }

  put(oid: string, type: ObjType, data: Uint8Array): void {
    if (this.sql.exec("SELECT 1 FROM objects WHERE oid = ?", oid).toArray().length > 0) return;
    const packed = deflate(data);
    this.sql.exec("INSERT INTO objects (oid, type, size) VALUES (?, ?, ?)", oid, type, data.length);
    for (let seq = 0, off = 0; off < packed.length || seq === 0; seq++, off += CHUNK) {
      const slice = packed.slice(off, off + CHUNK);
      this.sql.exec("INSERT INTO chunks (oid, seq, data) VALUES (?, ?, ?)", oid, seq, slice.buffer);
    }
    // the repo now has at least one loose object (gc migration path): the
    // loose probe can no longer be skipped
    if (!this.hasLoose) {
      this.hasLoose = true;
      this.setMeta("has-loose", "1");
    }
  }

  objectCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM objects").one().n + this.packs.countObjects();
  }

  // --- push connectivity ---------------------------------------------------
  // Connectivity of a fresh push is checked in SQL, not by an in-memory graph
  // walk: the pushed pack must be complete, i.e. every object it introduces
  // must have its referenced children in `pack_objects` ∪ `objects`. Children
  // are staged into `push_edges` in bounded batches and each batch is
  // anti-joined against the stores, so the check costs O(batch) rows of scratch
  // rather than an OidSet that scales with the object count.

  /** A page of a pack's non-blob oids after `after` (keyset, so the scan holds
   * one page, never the whole pack). Empty array ends the walk. */
  packNonBlobOidsAfter(packId: number, after: string, limit: number): string[] {
    return this.sql
      .exec<{ oid: string }>(
        "SELECT oid FROM pack_objects WHERE pack_id = ? AND type != 'blob' AND oid > ? ORDER BY oid LIMIT ?",
        packId,
        after,
        limit,
      )
      .toArray()
      .map((r) => r.oid);
  }

  resetPushEdges(): void {
    this.sql.exec("DELETE FROM push_edges");
  }

  /** Stage referenced child oids, chunked under the DO's ~100 bound-variable
   * statement cap. */
  addPushEdges(children: string[]): void {
    for (let i = 0; i < children.length; i += 64) {
      const batch = children.slice(i, i + 64);
      const values = batch.map(() => "(?)").join(",");
      this.sql.exec(`INSERT INTO push_edges (child) VALUES ${values}`, ...batch);
    }
  }

  /** The first staged child absent from both stores, or null when every staged
   * child is present. SQLite runs the membership test over its own indexes, so
   * no oid set is built in the isolate. */
  firstMissingPushEdge(): string | null {
    const rows = this.sql
      .exec<{ child: string }>(
        `SELECT e.child FROM push_edges e
         WHERE NOT EXISTS (SELECT 1 FROM pack_objects p WHERE p.oid = e.child)
           AND NOT EXISTS (SELECT 1 FROM objects o WHERE o.oid = e.child)
         LIMIT 1`,
      )
      .toArray();
    return rows.length ? rows[0].child : null;
  }

  /** Resolve an abbreviated oid; null if unknown or ambiguous. */
  findOid(prefix: string): string | null {
    if (!/^[0-9a-f]{4,40}$/.test(prefix)) return null;
    const loose = this.hasLoose
      ? this.sql
          .exec<{ oid: string }>("SELECT oid FROM objects WHERE oid LIKE ? LIMIT 2", prefix + "%")
          .toArray()
          .map((r) => r.oid)
      : [];
    const all = [...new Set([...loose, ...this.packs.findOidPrefix(prefix)])];
    return all.length === 1 ? all[0] : null;
  }

  allOids(): string[] {
    return this.sql.exec<{ oid: string }>("SELECT oid FROM objects").toArray().map((r) => r.oid);
  }

  deleteObject(oid: string): void {
    this.sql.exec("DELETE FROM objects WHERE oid = ?", oid);
    this.sql.exec("DELETE FROM chunks WHERE oid = ?", oid);
  }

  dbSize(): number {
    return this.sql.databaseSize;
  }

  wipe(): void {
    for (const t of ["objects", "chunks", "refs", "meta", "reachable", "peeled", "stats_cache"]) {
      this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    this.packs.wipe();
    // meta (with the flag) is gone; a fresh empty repo has no loose objects
    this.hasLoose = false;
  }


  /** All refs except HEAD, sorted by name. */
  refs(): { name: string; target: string }[] {
    return this.sql
      .exec<{ name: string; target: string }>(
        "SELECT name, target FROM refs WHERE name != 'HEAD' ORDER BY name"
      )
      .toArray();
  }

  getRef(name: string): string | null {
    const rows = this.sql
      .exec<{ target: string }>("SELECT target FROM refs WHERE name = ?", name)
      .toArray();
    return rows[0]?.target ?? null;
  }

  setRef(name: string, target: string): void {
    this.sql.exec(
      "INSERT INTO refs (name, target) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET target = excluded.target",
      name,
      target
    );
  }

  delRef(name: string): void {
    this.sql.exec("DELETE FROM refs WHERE name = ?", name);
  }

  /** HEAD symref target, e.g. "refs/heads/main". */
  head(): string {
    const raw = this.getRef("HEAD");
    if (raw?.startsWith("ref: ")) return raw.slice(5);
    return raw ?? "refs/heads/main";
  }

  setHead(refName: string): void {
    this.setRef("HEAD", `ref: ${refName}`);
  }

  /** Resolve HEAD to an oid, or null for an empty/unborn repo. */
  resolveHead(): string | null {
    return this.getRef(this.head());
  }


  getMeta(key: string): string | null {
    const rows = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray();
    return rows[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  /**
   * Cached peel target for an oid (tag -> ... -> commit). Tag oids are
   * content-addressed and immutable, so a hit never needs a version check.
   */
  getPeeled(oid: string): string | null {
    const rows = this.sql.exec<{ target: string }>("SELECT target FROM peeled WHERE oid = ?", oid).toArray();
    return rows[0]?.target ?? null;
  }

  setPeeled(oid: string, target: string): void {
    this.sql.exec("INSERT OR IGNORE INTO peeled (oid, target) VALUES (?, ?)", oid, target);
  }

  /**
   * Cached commit-activity aggregation for a (tip commit oid, period) pair.
   * Keyed on the tip's oid rather than a ref name: history under a fixed
   * commit oid is immutable, so no version check is needed for a hit.
   */
  getStatsCache(tipOid: string, period: string): string | null {
    const rows = this.sql
      .exec<{ data: string }>("SELECT data FROM stats_cache WHERE tip_oid = ? AND period = ?", tipOid, period)
      .toArray();
    return rows[0]?.data ?? null;
  }

  setStatsCache(tipOid: string, period: string, data: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO stats_cache (tip_oid, period, data) VALUES (?, ?, ?)",
      tipOid,
      period,
      data
    );
  }

  /**
   * A tag over the current ref state (names + tips + HEAD). The cached
   * reachable object set is keyed on it: any push, ref delete, or gc changes
   * a tip and so bumps the version, which is exactly when the set can change.
   * A sha1 hex string never collides with the "" invalidation sentinel.
   */
  reachableVersion(): string {
    const parts: string[] = [];
    for (const r of this.refs()) parts.push(`${r.name}\0${r.target}`);
    parts.push(`HEAD\0${this.getRef("HEAD") ?? ""}`);
    return sha1hex(te.encode(parts.join("\n")));
  }

  /**
   * The cached reachable object set as an OidSet with every entry marked (so
   * markedSize/markedAtHex/isMarkedHex feed the pack-emission path directly),
   * or null when the cache is missing or its version no longer matches current
   * refs. The version check is the only correctness gate — a stale set is
   * never returned, so the fast path can never serve unreachable objects.
   */
  loadReachable(): OidSet | null {
    if (this.getMeta("reachable-version") !== this.reachableVersion()) return null;
    const rows = this.sql.exec<{ oid: string }>("SELECT oid FROM reachable").toArray();
    if (!rows.length) return null;
    const set = new OidSet(rows.length);
    for (const r of rows) set.markHex(r.oid);
    return set;
  }

  /**
   * Persist the marked sub-set of `set` (a full clone's reachable object set)
   * and stamp it with the current ref version. Yields periodically so a large
   * write never monopolizes the event loop; if refs change mid-write (a push
   * landing during a cold clone) the version guard abandons the stamp, leaving
   * the half-written table unversioned and thus ignored until it is rebuilt.
   */
  async saveReachable(set: OidSet): Promise<void> {
    const version = this.reachableVersion();
    this.sql.exec("DELETE FROM reachable");
    const n = set.markedSize;
    for (let i = 0; i < n; i++) {
      this.sql.exec("INSERT OR IGNORE INTO reachable (oid) VALUES (?)", set.markedAtHex(i));
      if ((i & 8191) === 8191) {
        if (this.reachableVersion() !== version) return;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (this.reachableVersion() !== version) return;
    this.setMeta("reachable-version", version);
  }

  /**
   * Fold every oid in `set` into the cached reachable set and re-stamp it with
   * the current ref version. Used on a fast-forward push, where the receive
   * connectivity walk already visited exactly the newly connected objects:
   * union with the prior (validated) set yields the new reachable set without
   * a fresh graph walk. Only sound when no object became unreachable — the
   * caller must have a valid prior cache and no stranded history.
   */
  extendReachable(set: OidSet): void {
    for (let i = 0; i < set.size; i++) {
      this.sql.exec("INSERT OR IGNORE INTO reachable (oid) VALUES (?)", set.atHex(i));
    }
    this.setMeta("reachable-version", this.reachableVersion());
  }

  /** Drop the version stamp so the next full clone rebuilds the set by walking. */
  invalidateReachable(): void {
    this.setMeta("reachable-version", "");
  }

  /**
   * True when the persisted reachable set still matches the current refs, so a
   * full clone can stream its objects straight from storage (see
   * `reachablePackedAfter`) instead of loading the whole set into an OidSet and
   * walking. The version check is the same correctness gate `loadReachable`
   * uses — a stale set is never streamed.
   */
  reachableCacheValid(): boolean {
    return this.getMeta("reachable-version") === this.reachableVersion();
  }

  /** Size of the cached reachable set — the exact object count a warm full
   *  clone declares in its pack header. */
  reachableCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reachable").one().n;
  }

  /** Whether `oid` is in the cached reachable set. On the warm full-clone path a
   *  stored delta ships as a ref-delta only when its base is also being sent,
   *  i.e. also reachable; otherwise that object is inflated whole. */
  reachableHas(oid: string): boolean {
    return this.sql.exec("SELECT 1 FROM reachable WHERE oid = ? LIMIT 1", oid).toArray().length > 0;
  }

  /**
   * Reachable objects that live in a pack, one keyset page at a time in
   * (pack_id, offset) storage order. Marching each pack sequentially keeps the
   * raw-chunk cache hitting, and the (pack_id, offset) cursor holds no
   * per-object state in the isolate — so a warm full clone streams in O(page)
   * memory no matter how many objects the repo has, replacing the OidSet and
   * parallel typed arrays the walk path builds.
   */
  reachablePackedAfter(afterPack: number, afterOffset: number, limit: number): PackedReachable[] {
    return this.sql
      .exec<{
        oid: string;
        pack_id: number;
        offset: number;
        data_off: number;
        data_len: number;
        type: ObjType;
        entry_size: number;
        base_oid: string | null;
      }>(
        `SELECT p.oid, p.pack_id, p.offset, p.data_off, p.data_len, p.type, p.entry_size, p.base_oid
           FROM reachable r JOIN pack_objects p ON p.oid = r.oid
          WHERE p.pack_id > ? OR (p.pack_id = ? AND p.offset > ?)
          ORDER BY p.pack_id, p.offset
          LIMIT ?`,
        afterPack,
        afterPack,
        afterOffset,
        limit,
      )
      .toArray()
      .map((r) => ({
        oid: r.oid,
        packId: r.pack_id,
        offset: r.offset,
        dataOff: r.data_off,
        dataLen: r.data_len,
        type: r.type,
        entrySize: r.entry_size,
        baseOid: r.base_oid,
      }));
  }

  /** Reachable objects with no pack entry (loose), ordered by oid — streamed
   *  after every packed object so a warm full clone has a stable total order. */
  reachableLooseAfter(afterOid: string, limit: number): string[] {
    return this.sql
      .exec<{ oid: string }>(
        `SELECT r.oid FROM reachable r
          WHERE NOT EXISTS (SELECT 1 FROM pack_objects p WHERE p.oid = r.oid) AND r.oid > ?
          ORDER BY r.oid LIMIT ?`,
        afterOid,
        limit,
      )
      .toArray()
      .map((r) => r.oid);
  }
}
