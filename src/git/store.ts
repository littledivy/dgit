import { concat } from "./util";
import { deflate, inflate } from "./zlib";
import { ObjType } from "./objects";
import { PackStore, ObjCache, ObjRec } from "./packstore";

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
    `);
  }

  has(oid: string): boolean {
    if (this.sql.exec("SELECT 1 FROM objects WHERE oid = ?", oid).toArray().length > 0) return true;
    return this.packs.typeAndSize(oid) !== null;
  }

  typeAndSize(oid: string): { type: ObjType; size: number } | null {
    const rows = this.sql
      .exec<{ type: ObjType; size: number }>("SELECT type, size FROM objects WHERE oid = ?", oid)
      .toArray();
    return rows[0] ?? this.packs.typeAndSize(oid);
  }

  private getLoose(oid: string): ObjRec | null {
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

  get(oid: string): { type: ObjType; data: Uint8Array } | null {
    return this.getLoose(oid) ?? this.packs.getObject(oid, this.cache);
  }

  put(oid: string, type: ObjType, data: Uint8Array): void {
    if (this.sql.exec("SELECT 1 FROM objects WHERE oid = ?", oid).toArray().length > 0) return;
    const packed = deflate(data);
    this.sql.exec("INSERT INTO objects (oid, type, size) VALUES (?, ?, ?)", oid, type, data.length);
    for (let seq = 0, off = 0; off < packed.length || seq === 0; seq++, off += CHUNK) {
      const slice = packed.slice(off, off + CHUNK);
      this.sql.exec("INSERT INTO chunks (oid, seq, data) VALUES (?, ?, ?)", oid, seq, slice.buffer);
    }
  }

  objectCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM objects").one().n + this.packs.countObjects();
  }

  /** Resolve an abbreviated oid; null if unknown or ambiguous. */
  findOid(prefix: string): string | null {
    if (!/^[0-9a-f]{4,40}$/.test(prefix)) return null;
    const loose = this.sql
      .exec<{ oid: string }>("SELECT oid FROM objects WHERE oid LIKE ? LIMIT 2", prefix + "%")
      .toArray()
      .map((r) => r.oid);
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
    for (const t of ["objects", "chunks", "refs", "meta"]) {
      this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    this.packs.wipe();
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
}
