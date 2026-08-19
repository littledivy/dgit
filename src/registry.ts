import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export type RepoInfo = {
  name: string;
  desc: string;
  owner: string;
  section: string;
  priv: number; // 1 = requires auth for all access, hidden from index
  /** unix millis of last push */
  idle: number;
  /** bumped on every push/config change; used as the page-cache version */
  ver: number;
};

export type RepoConfig = {
  desc?: string;
  owner?: string;
  section?: string;
  priv?: boolean;
};

/** Site-wide list of repositories (one instance, name "registry"). */
export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        name TEXT PRIMARY KEY,
        desc TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        section TEXT NOT NULL DEFAULT '',
        priv INTEGER NOT NULL DEFAULT 0,
        idle INTEGER NOT NULL DEFAULT 0,
        ver INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_repos_section_name ON repos (section, name);
    `);
    // upgrade path for databases created by earlier versions
    for (const col of ["section TEXT NOT NULL DEFAULT ''", "priv INTEGER NOT NULL DEFAULT 0", "ver INTEGER NOT NULL DEFAULT 1"]) {
      try {
        ctx.storage.sql.exec(`ALTER TABLE repos ADD COLUMN ${col}`);
      } catch {
        // column already exists
      }
    }
  }

  upsert(name: string, idle: number): void {
    // seed ver from the clock so a deleted-and-recreated repo never reuses
    // cache-key versions from its previous incarnation
    this.ctx.storage.sql.exec(
      "INSERT INTO repos (name, idle, ver) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET idle = excluded.idle, ver = ver + 1",
      name,
      idle,
      Date.now()
    );
  }

  setConfig(name: string, cfg: RepoConfig): void {
    const cur = this.get(name);
    if (!cur) return;
    this.ctx.storage.sql.exec(
      "UPDATE repos SET desc = ?, owner = ?, section = ?, priv = ?, ver = ver + 1 WHERE name = ?",
      cfg.desc ?? cur.desc,
      cfg.owner ?? cur.owner,
      cfg.section ?? cur.section,
      cfg.priv === undefined ? cur.priv : cfg.priv ? 1 : 0,
      name
    );
  }

  remove(name: string): void {
    this.ctx.storage.sql.exec("DELETE FROM repos WHERE name = ?", name);
  }

  get(name: string): RepoInfo | null {
    const rows = this.ctx.storage.sql
      .exec<RepoInfo>("SELECT name, desc, owner, section, priv, idle, ver FROM repos WHERE name = ?", name)
      .toArray();
    return rows[0] ?? null;
  }

  /** Public index page feed: excludes private repos, bounded so a large table can't dump wholesale over RPC. */
  list(limit = 1000): RepoInfo[] {
    return this.ctx.storage.sql
      .exec<RepoInfo>(
        "SELECT name, desc, owner, section, priv, idle, ver FROM repos WHERE priv = 0 ORDER BY section, name LIMIT ?",
        limit
      )
      .toArray();
  }
}
