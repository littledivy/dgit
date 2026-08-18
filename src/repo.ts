import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { td, te, isOid, concat } from "./git/util";
import { GitStore } from "./git/store";
import { ObjCache } from "./git/packstore";
import { gunzip } from "./git/zlib";
import {
  advertisement,
  uploadPack,
  parsePushCommands,
  applyPushCommands,
  renderStatus,
  sidebandFrames,
  Service,
} from "./git/protocol";
import {
  Commit,
  parseCommit,
  parseTag,
  parseTree,
  isTreeMode,
  isGitlinkMode,
  modeString,
  TreeEntry,
} from "./git/objects";
import { diffLines, toHunks, isBinary, Hunk, DiffOp } from "./git/diff";
import { blame, BlameHistoryEntry } from "./git/blame";
import { tarGz, zip, SnapshotFile } from "./git/snapshot";
import { esc, age, fmtDate, fmtDate2822, layout, htmlResponse, errorPage, LayoutOpts } from "./ui/html";
import { renderMarkdown } from "./ui/markdown";
import { highlightLines } from "./ui/highlight";

const LOG_PAGE = 50;
const MAX_DIFF_FILES = 100;
const MAX_DIFF_BLOB = 512 * 1024;
const MAX_LOG_SCAN = 5000;
const MAX_STATS_SCAN = 2000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
// like cgit's about-file: a dedicated about page wins over the README
const README_NAMES = [
  "about.md",
  "about.markdown",
  "about",
  "readme.md",
  "readme.markdown",
  "readme",
  "readme.txt",
  "readme.rst",
];

interface LogEntry {
  oid: string;
  commit: Commit;
}

interface LogFilter {
  path?: string[];
  qt?: string;
  q?: string;
}

interface FileDiff {
  path: string;
  o: { oid: string; mode: string } | null;
  n: { oid: string; mode: string } | null;
  kind: "text" | "binary" | "toolarge";
  ops: DiffOp[] | null;
  hunks: Hunk[];
  add: number;
  del: number;
}

export class RepoCell extends DurableObject<Env> {
  store: GitStore;
  /** pushes are serialized: concurrent ingests would race pack-id allocation */
  private receiveChain: Promise<void> = Promise.resolve();
  /** concurrent clone walks contend on one event loop; bound them */
  private activeUploads = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new GitStore(ctx.storage.sql);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const repo = req.headers.get("x-repo") ?? "repo";
    const host = req.headers.get("x-host") ?? url.host;
    const proto = req.headers.get("x-proto") ?? "https";
    const path = url.pathname;

    try {
      if (path === "/info/refs" && req.method === "GET") {
        const service = url.searchParams.get("service");
        if (service !== "git-upload-pack" && service !== "git-receive-pack") {
          return new Response("smart HTTP only\n", { status: 400 });
        }
        return new Response(advertisement(this.store, service as Service) as unknown as BodyInit, {
          headers: {
            "content-type": `application/x-${service}-advertisement`,
            "cache-control": "no-cache",
          },
        });
      }
      if (path === "/git-upload-pack" && req.method === "POST") {
        if (this.activeUploads >= 4) {
          return new Response("busy: too many concurrent fetches, retry shortly\n", {
            status: 503,
            headers: { "retry-after": "15" },
          });
        }
        this.activeUploads++;
        try {
          return await uploadPack(this.store, await this.readBody(req));
        } finally {
          this.activeUploads--;
        }
      }
      if (path === "/git-receive-pack" && req.method === "POST") {
        return this.receive(req, repo);
      }

      if (path === "/config" && req.method === "PUT") {
        return this.handleConfig(await req.text());
      }
      if (path === "/description" && req.method === "PUT") {
        return this.handleConfig(JSON.stringify({ description: (await req.text()).trim() }));
      }
      if ((path === "/" || path === "") && req.method === "DELETE") {
        // wipe() drops every table we own; deliberately NOT storage.deleteAll():
        // on celld, deleteAll sweeps the ltx replication control tables too and
        // permanently breaks WAL capture for the cell (patch submitted upstream)
        this.store.wipe();
        await this.ctx.storage.deleteAlarm();
        // this instance stays resident: bring the (empty) schema back so
        // later requests — including a re-creating push — find their tables
        this.store = new GitStore(this.ctx.storage.sql);
        return new Response("deleted\n");
      }
      if (path === "/gc" && req.method === "POST") {
        const result = this.runGc();
        return Response.json(result);
      }

      if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
      return this.ui(repo, host, proto, path, url.searchParams);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`error: ${msg}\n`, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    if (this.store.getMeta("gc-pending") === "1") {
      this.runGc();
      this.store.setMeta("gc-pending", "0");
    }
  }

  private handleConfig(body: string): Response {
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(body);
    } catch {
      return new Response("invalid JSON\n", { status: 400 });
    }
    if (typeof cfg.description === "string") this.store.setMeta("description", cfg.description.slice(0, 200));
    if (typeof cfg.owner === "string") this.store.setMeta("owner", cfg.owner.slice(0, 100));
    if (typeof cfg.section === "string") this.store.setMeta("section", cfg.section.slice(0, 100));
    if (typeof cfg.private === "boolean") this.store.setMeta("private", cfg.private ? "1" : "0");
    return Response.json({
      description: this.store.getMeta("description") ?? "",
      owner: this.store.getMeta("owner") ?? "",
      section: this.store.getMeta("section") ?? "",
      private: this.store.getMeta("private") === "1",
    });
  }

  /**
   * Delete loose objects unreachable from any ref. Objects inside stored
   * packs are kept (deleting mid-pack is impossible without a repack);
   * huge repos skip the sweep entirely — the walk isn't worth it.
   */
  private runGc(): { removed: number; kept: number; skipped?: boolean } {
    if (this.store.packs.countObjects() > 300_000) {
      return { removed: 0, kept: this.store.objectCount(), skipped: true };
    }
    const reachable = new Set<string>();
    const stack: string[] = this.store.refs().map((r) => r.target);
    const head = this.store.resolveHead();
    if (head) stack.push(head);
    while (stack.length) {
      const oid = stack.pop()!;
      if (reachable.has(oid)) continue;
      const obj = this.store.get(oid);
      if (!obj) continue;
      reachable.add(oid);
      if (obj.type === "commit") {
        const c = parseCommit(obj.data);
        stack.push(c.tree, ...c.parents);
      } else if (obj.type === "tag") {
        const t = parseTag(obj.data);
        if (t.object) stack.push(t.object);
      } else if (obj.type === "tree") {
        for (const e of parseTree(obj.data)) {
          if (!isGitlinkMode(e.mode)) stack.push(e.oid);
        }
      }
    }
    let removed = 0;
    for (const oid of this.store.allOids()) {
      if (!reachable.has(oid)) {
        this.store.deleteObject(oid);
        removed++;
      }
    }
    // repack-by-migration: reachable pack objects move to loose storage,
    // then the packs (including anything stranded inside them) are dropped
    const packCount = this.store.packs.countObjects();
    if (packCount > 0) {
      let migrated = 0;
      for (const oid of reachable) {
        if (this.store.packs.lookup(oid)) {
          const obj = this.store.get(oid);
          if (obj) {
            this.store.put(oid, obj.type, obj.data);
            migrated++;
          }
        }
      }
      removed += packCount - migrated;
      this.store.packs.reset();
    }
    return { removed, kept: reachable.size };
  }

  private async readBody(req: Request): Promise<Uint8Array> {
    let body: Uint8Array = new Uint8Array(await req.arrayBuffer());
    if (req.headers.get("content-encoding")?.includes("gzip")) body = gunzip(body);
    return body;
  }

  /**
   * Push handling. The pack is ingested chunk-by-chunk as it arrives (never
   * fully buffered), but the RESPONSE is not returned until processing
   * completes: returning a streaming response early makes the runtime treat
   * the request as finished, and celld then idle-evicts the cell (and
   * retires its isolate) out from under a long ingest.
   */
  private async receive(req: Request, repo: string): Promise<Response> {
    const maxBytes = (parseInt(this.env.MAX_PUSH_MB ?? "", 10) || 8192) * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    // chain: a second push (e.g. a client retry of the same POST) must
    // wait — two interleaved ingests would both claim the next pack id
    // and sweep each other's in-progress rows as orphans
    const run = this.receiveChain.then(() =>
      this.processReceive(req, repo, maxBytes, (c) => chunks.push(c))
    );
    this.receiveChain = run.then(
      () => {},
      () => {}
    );
    try {
      await run;
    } catch (err) {
      console.log(`[receive ${repo}] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return new Response(`error: ${err instanceof Error ? err.message : String(err)}\n`, { status: 500 });
    }
    return new Response(concat(chunks) as unknown as BodyInit, {
      headers: {
        "content-type": "application/x-git-receive-pack-result",
        "cache-control": "no-cache",
      },
    });
  }

  private async processReceive(
    req: Request,
    repo: string,
    maxBytes: number,
    emit: (chunk: Uint8Array) => void
  ): Promise<void> {
    console.log(`[receive ${repo}] processing push request`);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let buf: Uint8Array;
    if (req.headers.get("content-encoding")?.includes("gzip")) {
      buf = gunzip(new Uint8Array(await req.arrayBuffer())); // only small pushes arrive gzipped
    } else {
      reader = (req.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>) ?? null;
      buf = new Uint8Array(0);
    }

    // read the pkt-line command section (small); everything after is the pack
    let pos = 0;
    const need = async (n: number): Promise<boolean> => {
      while (buf.length - pos < n) {
        if (!reader) return false;
        const { done, value } = await reader.read();
        if (done) return false;
        if (value?.length) buf = concat([buf, value]);
      }
      return true;
    };
    for (;;) {
      if (!(await need(4))) break;
      const len = parseInt(td.decode(buf.subarray(pos, pos + 4)), 16);
      if (Number.isNaN(len)) throw new Error("bad pkt-line in push request");
      if (len === 0) {
        pos += 4;
        break;
      }
      if (!(await need(len))) throw new Error("truncated push request");
      pos += len;
    }
    const { commands, caps } = parsePushCommands(buf.subarray(0, pos));
    const wantStatus = caps.includes("report-status");
    const sideband = caps.includes("side-band-64k");
    const progress = (msg: string) => {
      if (!sideband) return;
      for (const f of sidebandFrames(2, te.encode(msg))) emit(f);
    };

    let firstPackBytes = buf.subarray(pos);
    let hasPack = firstPackBytes.length > 0;
    if (!hasPack && reader) {
      const { done, value } = await reader.read();
      if (!done && value?.length) {
        firstPackBytes = value;
        hasPack = true;
      }
    }

    let unpackError: string | null = null;
    if (hasPack) {
      try {
        // a dedicated cache makes pack-adjacent delta bases nearly free; on
        // real Workers the whole isolate has a hard 128MB, so stay small there
        const budget = typeof caches !== "undefined" ? 16 * 1024 * 1024 : 512 * 1024 * 1024;
        await this.store.packs.ingest(firstPackBytes, reader, {
          maxBytes,
          cache: new ObjCache(budget),
          onProgress: progress,
          flush: () => this.ctx.storage.sync(),
        });
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
        console.log(`[receive ${repo}] unpack error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        try {
          await reader?.cancel();
        } catch {
          // client may already be gone
        }
      }
    }

    const { results, changed, needsGc } = applyPushCommands(this.store, commands, unpackError);
    if (changed) {
      this.store.setMeta("created", "1");
      this.store.setMeta("last-push", String(Date.now()));
      try {
        // after a huge ingest, celld's output gate can refuse outbound calls
        // until the burst is proven durable — registration must not take the
        // whole (already applied) push down with it; the next push heals it
        await this.env.REGISTRY.getByName("registry").upsert(repo, Date.now());
      } catch (err) {
        console.log(`[receive ${repo}] registry upsert deferred: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (needsGc) {
      this.store.setMeta("gc-pending", "1");
      try {
        await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
      } catch (err) {
        console.log(`[receive ${repo}] gc alarm deferred: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (wantStatus) emit(renderStatus(results, unpackError, sideband));
  }


  private base(repo: string, tab: string, ref?: string, formAction?: string): Omit<LayoutOpts, "body"> {
    const branches = this.store
      .refs()
      .filter((r) => r.name.startsWith("refs/heads/"))
      .map((r) => r.name.slice(11))
      .slice(0, 50);
    const headBranch = this.store.head().replace("refs/heads/", "");
    return {
      site: this.env.SITE_NAME ?? "dgit",
      siteDesc: this.env.SITE_DESC ?? "",
      title: `${repo} - ${tab}`,
      repo,
      sub: this.store.getMeta("description") || "[no description]",
      tab,
      ref: ref ?? headBranch,
      hasAbout: this.findReadme() !== null,
      branches,
      formAction: formAction ?? `/${encodeURIComponent(repo)}/`,
    };
  }

  private ui(repo: string, host: string, proto: string, path: string, q: URLSearchParams): Response {
    const h = q.get("h") ?? undefined;
    if (path === "/" || path === "") return this.summaryPage(repo, host, proto);
    if (path === "/about/" || path === "/about") return this.aboutPage(repo, h);
    if (path === "/log/" || path === "/log")
      return this.logPage(repo, h, parseInt(q.get("ofs") ?? "0", 10) || 0, {
        path: q.get("path") ? decodePath("/" + q.get("path")!) : undefined,
        qt: q.get("qt") ?? undefined,
        q: q.get("q") ?? undefined,
      });
    if (path === "/refs/" || path === "/refs") return this.refsPage(repo);
    if (path === "/commit/" || path === "/commit") return this.commitPage(repo, q.get("id") ?? undefined, h);
    if (path === "/diff/" || path === "/diff")
      return this.diffPage(repo, q.get("id") ?? undefined, q.get("id2") ?? undefined, h, false);
    if (path === "/rawdiff/" || path === "/rawdiff")
      return this.diffPage(repo, q.get("id") ?? undefined, q.get("id2") ?? undefined, h, true);
    if (path === "/patch/" || path === "/patch") return this.patchPage(repo, q.get("id") ?? undefined, h);
    if (path === "/tag/" || path === "/tag") return this.tagPage(repo, q.get("h") ?? q.get("id") ?? undefined);
    if (path === "/atom/" || path === "/atom") return this.atomPage(repo, host, proto, h);
    if (path === "/stats/" || path === "/stats") return this.statsPage(repo, h, q.get("period") ?? "m");
    if (path === "/blob/" || path === "/blob") return this.blobByIdPage(q.get("id") ?? "");
    if (path.startsWith("/tree")) return this.treePage(repo, h, decodePath(path.slice("/tree".length)));
    if (path.startsWith("/plain")) return this.plainPage(h, decodePath(path.slice("/plain".length)));
    if (path.startsWith("/blame")) return this.blamePage(repo, h, decodePath(path.slice("/blame".length)));
    if (path.startsWith("/snapshot/")) return this.snapshotPage(repo, decodeURIComponent(path.slice("/snapshot/".length)));
    return errorPage(this.base(repo, "summary"), `page not found: ${path}`);
  }


  /** Resolve ?h= (branch, tag, full ref, or oid) to an object id. */
  private resolveRef(h?: string): { refName: string | null; oid: string } | null {
    if (!h) {
      const oid = this.store.resolveHead();
      return oid ? { refName: this.store.head(), oid } : null;
    }
    for (const cand of [`refs/heads/${h}`, `refs/tags/${h}`, h]) {
      const oid = this.store.getRef(cand);
      if (oid) return { refName: cand, oid };
    }
    const full = this.store.findOid(h);
    if (full) return { refName: null, oid: full };
    return null;
  }

  /** Follow tag objects until we reach a commit. */
  private peelToCommit(oid: string): { oid: string; commit: Commit } | null {
    for (let i = 0; i < 10; i++) {
      const obj = this.store.get(oid);
      if (!obj) return null;
      if (obj.type === "commit") return { oid, commit: parseCommit(obj.data) };
      if (obj.type === "tag") {
        oid = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  private loadCommit(oid: string): Commit | null {
    const obj = this.store.get(oid);
    return obj?.type === "commit" ? parseCommit(obj.data) : null;
  }

  /** oid of the entry at `path` in this commit's tree (any type), or null. */
  private pathOid(commit: Commit, path: string[]): string | null {
    let oid = commit.tree;
    for (const seg of path) {
      const obj = this.store.get(oid);
      if (obj?.type !== "tree") return null;
      const entry = parseTree(obj.data).find((e) => e.name === seg);
      if (!entry) return null;
      oid = entry.oid;
    }
    return oid;
  }

  private matchesFilter(e: LogEntry, filter: LogFilter): boolean {
    if (filter.path && filter.path.length) {
      const mine = this.pathOid(e.commit, filter.path);
      const parent = e.commit.parents[0] ? this.loadCommit(e.commit.parents[0]) : null;
      const theirs = parent ? this.pathOid(parent, filter.path) : null;
      if (mine === theirs) return false;
    }
    if (filter.q) {
      const q = filter.q.toLowerCase();
      const qt = filter.qt ?? "grep";
      if (qt === "author") {
        if (!`${e.commit.author.name} ${e.commit.author.email}`.toLowerCase().includes(q)) return false;
      } else if (qt === "committer") {
        if (!`${e.commit.committer.name} ${e.commit.committer.email}`.toLowerCase().includes(q)) return false;
      } else {
        if (!e.commit.message.toLowerCase().includes(q)) return false;
      }
    }
    return true;
  }

  /** Date-ordered commit walk (newest first) with optional filtering. */
  private walkLog(tip: string, skip: number, limit: number, filter: LogFilter = {}): { entries: LogEntry[]; more: boolean } {
    const first = this.peelToCommit(tip);
    if (!first) return { entries: [], more: false };
    const seen = new Set<string>([first.oid]);
    const frontier: LogEntry[] = [{ oid: first.oid, commit: first.commit }];
    const out: LogEntry[] = [];
    let scanned = 0;
    while (frontier.length && out.length < skip + limit + 1 && scanned++ < MAX_LOG_SCAN) {
      frontier.sort((a, b) => b.commit.committer.time - a.commit.committer.time);
      const cur = frontier.shift()!;
      if (this.matchesFilter(cur, filter)) out.push(cur);
      for (const p of cur.commit.parents) {
        if (seen.has(p)) continue;
        seen.add(p);
        const c = this.loadCommit(p);
        if (c) frontier.push({ oid: p, commit: c });
      }
    }
    return { entries: out.slice(skip, skip + limit), more: out.length > skip + limit };
  }

  /** First-parent history of a path (for blame), newest first, with blobs. */
  private pathHistory(tip: string, path: string[], cap: number): BlameHistoryEntry[] {
    const out: BlameHistoryEntry[] = [];
    let cur = this.peelToCommit(tip);
    let steps = 0;
    while (cur && steps++ < MAX_LOG_SCAN && out.length < cap) {
      const myOid = this.pathOid(cur.commit, path);
      const parent = cur.commit.parents[0] ? this.peelToCommit(cur.commit.parents[0]) : null;
      const parentOid = parent ? this.pathOid(parent.commit, path) : null;
      if (myOid !== parentOid) {
        const blob = myOid ? this.store.get(myOid) : null;
        out.push({ oid: cur.oid, commit: cur.commit, blob: blob?.type === "blob" ? blob.data : null });
        if (!parentOid) break; // file created here
      }
      cur = parent;
    }
    return out;
  }

  /** Map oid -> decorations (branch/tag pointing at it). */
  private decorations(repo: string): Map<string, string> {
    const map = new Map<string, string>();
    const r = `/${encodeURIComponent(repo)}`;
    for (const ref of this.store.refs()) {
      let html = "";
      let target = ref.target;
      if (ref.name.startsWith("refs/heads/")) {
        html = `<a class='branch-deco' href='${r}/log/?h=${encodeURIComponent(ref.name.slice(11))}'>${esc(ref.name.slice(11))}</a>`;
      } else if (ref.name.startsWith("refs/tags/")) {
        const peeled = this.peelToCommit(ref.target);
        if (peeled) target = peeled.oid;
        html = `<a class='tag-deco' href='${r}/tag/?h=${encodeURIComponent(ref.name.slice(10))}'>${esc(ref.name.slice(10))}</a>`;
      } else continue;
      map.set(target, (map.get(target) ?? "") + html);
    }
    return map;
  }

  private lookupPath(
    rootTree: string,
    path: string[]
  ): { kind: "tree"; entries: TreeEntry[] } | { kind: "blob"; entry: TreeEntry } | null {
    let treeOid = rootTree;
    for (let i = 0; i < path.length; i++) {
      const obj = this.store.get(treeOid);
      if (obj?.type !== "tree") return null;
      const entry = parseTree(obj.data).find((e) => e.name === path[i]);
      if (!entry) return null;
      if (i === path.length - 1 && !isTreeMode(entry.mode)) {
        return { kind: "blob", entry };
      }
      if (!isTreeMode(entry.mode)) return null;
      treeOid = entry.oid;
    }
    const obj = this.store.get(treeOid);
    if (obj?.type !== "tree") return null;
    return { kind: "tree", entries: parseTree(obj.data) };
  }

  private findReadme(): { name: string; oid: string } | null {
    const head = this.store.resolveHead();
    if (!head) return null;
    const c = this.peelToCommit(head);
    if (!c) return null;
    const root = this.store.get(c.commit.tree);
    if (root?.type !== "tree") return null;
    const entries = parseTree(root.data);
    for (const want of README_NAMES) {
      const e = entries.find((x) => x.name.toLowerCase() === want && !isTreeMode(x.mode));
      if (e) return { name: e.name, oid: e.oid };
    }
    return null;
  }

  private flattenTree(treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
    const obj = this.store.get(treeOid);
    if (obj?.type !== "tree") return;
    for (const e of parseTree(obj.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (isTreeMode(e.mode)) this.flattenTree(e.oid, p, out);
      else if (!isGitlinkMode(e.mode)) out.set(p, { oid: e.oid, mode: e.mode });
    }
  }


  private computeDiff(oldTree: string | null, newTree: string): { files: FileDiff[]; truncated: boolean } {
    const oldFiles = new Map<string, { oid: string; mode: string }>();
    const newFiles = new Map<string, { oid: string; mode: string }>();
    if (oldTree) this.flattenTree(oldTree, "", oldFiles);
    this.flattenTree(newTree, "", newFiles);
    const paths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort();
    const files: FileDiff[] = [];
    let truncated = false;
    for (const p of paths) {
      const o = oldFiles.get(p) ?? null;
      const n = newFiles.get(p) ?? null;
      if (o && n && o.oid === n.oid && o.mode === n.mode) continue;
      if (files.length >= MAX_DIFF_FILES) {
        truncated = true;
        break;
      }
      const oldData = o ? this.store.get(o.oid)?.data ?? new Uint8Array(0) : new Uint8Array(0);
      const newData = n ? this.store.get(n.oid)?.data ?? new Uint8Array(0) : new Uint8Array(0);
      const fd: FileDiff = { path: p, o, n, kind: "text", ops: null, hunks: [], add: 0, del: 0 };
      if (isBinary(oldData) || isBinary(newData)) {
        fd.kind = "binary";
      } else if (oldData.length > MAX_DIFF_BLOB || newData.length > MAX_DIFF_BLOB) {
        fd.kind = "toolarge";
      } else {
        const ops = diffLines(td.decode(oldData), td.decode(newData));
        if (!ops) {
          fd.kind = "toolarge";
        } else {
          fd.ops = ops;
          fd.hunks = toHunks(ops);
          for (const op of ops) {
            if (op.tag === "add") fd.add++;
            if (op.tag === "del") fd.del++;
          }
        }
      }
      files.push(fd);
    }
    return { files, truncated };
  }

  private renderDiffHtml(repo: string, files: FileDiff[], truncated: boolean): string {
    let statRows = "";
    let diffHtml = "";
    let totalAdd = 0, totalDel = 0;
    for (const f of files) {
      totalAdd += f.add;
      totalDel += f.del;
      const status = !f.o
        ? " (new)"
        : !f.n
          ? " (deleted)"
          : f.o.mode !== f.n.mode
            ? ` <span class='modechange'>[mode ${f.o.mode} -&gt; ${f.n.mode}]</span>`
            : "";
      statRows += `<tr><td>${esc(f.path)}${status}</td><td class='add right'>+${f.add}</td><td class='del right'>-${f.del}</td></tr>`;
      let bodyHtml: string;
      if (f.kind === "binary") {
        bodyHtml = `<div>Binary files differ</div>`;
      } else if (f.kind === "toolarge") {
        bodyHtml = `<div>Diff skipped: file too large</div>`;
      } else {
        bodyHtml = f.hunks.map((hk) => renderHunk(hk)).join("");
      }
      diffHtml += `<div class='head'>diff --git a/${esc(f.path)} b/${esc(f.path)}</div>${bodyHtml}`;
    }
    return `
<div class='diffstat-header'>Diffstat</div>
<table class='diffstat'>
${statRows || "<tr><td>(no changes)</td></tr>"}
</table>
<div class='diffstat-summary'>${files.length} file${files.length === 1 ? "" : "s"} changed, ${totalAdd} insertions(+), ${totalDel} deletions(-)${truncated ? " [diff truncated]" : ""}</div>
<table class='diff'><tr><td>${diffHtml}</td></tr></table>`;
  }

  private renderRawDiff(files: FileDiff[]): string {
    let out = "";
    for (const f of files) {
      out += `diff --git a/${f.path} b/${f.path}\n`;
      if (!f.o) {
        out += `new file mode ${f.n!.mode.padStart(6, "0")}\n`;
        out += `index 0000000..${f.n!.oid.slice(0, 7)}\n`;
      } else if (!f.n) {
        out += `deleted file mode ${f.o.mode.padStart(6, "0")}\n`;
        out += `index ${f.o.oid.slice(0, 7)}..0000000\n`;
      } else {
        if (f.o.mode !== f.n.mode) {
          out += `old mode ${f.o.mode.padStart(6, "0")}\nnew mode ${f.n.mode.padStart(6, "0")}\n`;
        }
        out += `index ${f.o.oid.slice(0, 7)}..${f.n.oid.slice(0, 7)}${f.o.mode === f.n.mode ? ` ${f.n.mode.padStart(6, "0")}` : ""}\n`;
      }
      if (f.kind === "binary") {
        out += `Binary files a/${f.path} and b/${f.path} differ\n`;
        continue;
      }
      if (f.kind === "toolarge") {
        out += `--- diff skipped: file too large ---\n`;
        continue;
      }
      out += f.o ? `--- a/${f.path}\n` : `--- /dev/null\n`;
      out += f.n ? `+++ b/${f.path}\n` : `+++ /dev/null\n`;
      for (const hk of f.hunks) {
        out += `@@ -${hk.aStart},${hk.aLen} +${hk.bStart},${hk.bLen} @@\n`;
        for (const op of hk.ops) {
          out += (op.tag === "add" ? "+" : op.tag === "del" ? "-" : " ") + op.line + "\n";
        }
      }
    }
    return out;
  }


  private aboutPage(repo: string, h: string | undefined): Response {
    const base = this.base(repo, "about", h, `/${encodeURIComponent(repo)}/about/`);
    const readme = this.findReadme();
    if (!readme) return errorPage(base, "no readme found");
    const obj = this.store.get(readme.oid);
    if (!obj) return errorPage(base, "missing readme blob");
    const text = td.decode(obj.data);
    const lower = readme.name.toLowerCase();
    const body =
      lower.endsWith(".md") || lower.endsWith(".markdown")
        ? `<div class='md'>${renderMarkdown(text)}</div>`
        : `<pre>${esc(text)}</pre>`;
    return htmlResponse(layout({ ...base, body }));
  }

  private summaryPage(repo: string, host: string, proto: string): Response {
    const base = this.base(repo, "summary");
    const branches = this.store.refs().filter((r) => r.name.startsWith("refs/heads/"));
    const tags = this.store.refs().filter((r) => r.name.startsWith("refs/tags/"));
    const r = `/${encodeURIComponent(repo)}`;

    if (!branches.length && !tags.length) {
      return htmlResponse(
        layout({
          ...base,
          body:
            `<div class='error'>empty repository</div>` +
            `<p>push something to get started:</p>` +
            `<pre>git remote add origin ${esc(proto)}://${esc(host)}/${esc(repo)}.git\ngit push -u origin main</pre>`,
        })
      );
    }

    const branchRows = branches
      .slice(0, 10)
      .map((b) => {
        const name = b.name.slice(11);
        const c = this.peelToCommit(b.target);
        if (!c) return "";
        return `<tr><td><a href='${r}/log/?h=${encodeURIComponent(name)}'>${esc(name)}</a></td>` +
          `<td><a href='${r}/commit/?id=${c.oid}'>${esc(c.commit.subject)}</a></td>` +
          `<td>${esc(c.commit.author.name)}</td><td>${age(c.commit.committer.time)}</td></tr>`;
      })
      .join("");

    const tagRows = tags
      .slice(0, 10)
      .map((t) => {
        const name = t.name.slice(10);
        const obj = this.store.get(t.target);
        let when = 0;
        let target = t.target;
        if (obj?.type === "tag") {
          const tag = parseTag(obj.data);
          when = tag.tagger?.time ?? 0;
          target = tag.object;
        }
        const c = this.peelToCommit(target);
        if (c && !when) when = c.commit.committer.time;
        const snap = `<a href='${r}/snapshot/${encodeURIComponent(repo)}-${encodeURIComponent(name)}.tar.gz'>tar.gz</a> ` +
          `<a href='${r}/snapshot/${encodeURIComponent(repo)}-${encodeURIComponent(name)}.zip'>zip</a>`;
        return `<tr><td><a href='${r}/tag/?h=${encodeURIComponent(name)}'>${esc(name)}</a></td>` +
          `<td><a href='${r}/commit/?id=${target}'>${esc(c?.commit.subject ?? "")}</a></td>` +
          `<td>${esc(c?.commit.author.name ?? "")}</td><td>${age(when)}</td><td class='snapshots'>${snap}</td></tr>`;
      })
      .join("");

    const headOid = this.store.resolveHead();
    const recent = headOid ? this.walkLog(headOid, 0, 10).entries : [];
    const deco = this.decorations(repo);
    const logRows = recent
      .map(
        (e) =>
          `<tr><td>${age(e.commit.committer.time)}</td>` +
          `<td><a href='${r}/commit/?id=${e.oid}'>${esc(e.commit.subject)}</a>${deco.get(e.oid) ?? ""}</td>` +
          `<td>${esc(e.commit.author.name)}</td></tr>`
      )
      .join("");

    const body = `
<table class='list nowrap'>
<tr class='nohover'><th class='left'>Branch</th><th class='left'>Commit message</th><th class='left'>Author</th><th class='left'>Age</th><th></th></tr>
${branchRows}
${tags.length ? `<tr class='nohover'><td colspan='5'>&nbsp;</td></tr><tr class='nohover'><th class='left'>Tag</th><th class='left'>Commit message</th><th class='left'>Author</th><th class='left'>Age</th><th class='left'>Download</th></tr>${tagRows}` : ""}
<tr class='nohover'><td colspan='5'>&nbsp;</td></tr>
<tr class='nohover'><th class='left'>Age</th><th class='left'>Commit message</th><th class='left'>Author</th><th colspan='2'></th></tr>
${logRows}
<tr class='nohover'><td colspan='5'>&nbsp;</td></tr>
<tr class='nohover'><th class='left' colspan='5'>Clone</th></tr>
<tr class='nohover'><td colspan='5' class='clone-url'>${esc(proto)}://${esc(host)}/${esc(repo)}.git</td></tr>
</table>`;
    return htmlResponse(layout({ ...base, body }));
  }

  private logPage(repo: string, h: string | undefined, ofs: number, filter: LogFilter): Response {
    const r = `/${encodeURIComponent(repo)}`;
    const base = this.base(repo, "log", h, `${r}/log/`);
    let tip = h;
    if (filter.qt === "range" && filter.q) {
      tip = filter.q;
      filter = {};
    }
    const rr = this.resolveRef(tip);
    if (!rr) return errorPage(base, tip ? `bad ref: ${tip}` : "empty repository");
    const { entries, more } = this.walkLog(rr.oid, ofs, LOG_PAGE, filter);
    const deco = this.decorations(repo);
    const rows = entries
      .map(
        (e) =>
          `<tr><td>${age(e.commit.committer.time)}</td>` +
          `<td><a href='${r}/commit/?id=${e.oid}'>${esc(e.commit.subject)}</a>${deco.get(e.oid) ?? ""}</td>` +
          `<td>${esc(e.commit.author.name)}</td></tr>`
      )
      .join("");
    const params = new URLSearchParams();
    if (h) params.set("h", h);
    if (filter.q) params.set("q", filter.q);
    if (filter.qt) params.set("qt", filter.qt);
    if (filter.path?.length) params.set("path", filter.path.join("/"));
    const link = (o: number) => {
      const p = new URLSearchParams(params);
      if (o > 0) p.set("ofs", String(o));
      return `?${p.toString()}`;
    };
    const nav =
      `<div style='margin-top:1em'>` +
      (ofs > 0 ? `<a href='${link(Math.max(0, ofs - LOG_PAGE))}'>[prev]</a> ` : "") +
      (more ? `<a href='${link(ofs + LOG_PAGE)}'>[next]</a>` : "") +
      `</div>`;
    const qt = filter.qt ?? "grep";
    const searchForm =
      `<form method='get' action='${r}/log/'>` +
      (h ? `<input type='hidden' name='h' value='${esc(h)}'/>` : "") +
      `<select name='qt'>` +
      ["grep", "author", "committer", "range"]
        .map((t) => `<option value='${t}'${t === qt ? " selected='selected'" : ""}>${t}</option>`)
        .join("") +
      `</select> <input type='text' name='q' size='30' value='${esc(filter.q ?? "")}'/> ` +
      `<input type='submit' value='search'/></form>`;
    const pathNote = filter.path?.length
      ? `<div class='path'>path: ${esc(filter.path.join("/"))} (<a href='${r}/log/${h ? `?h=${encodeURIComponent(h)}` : ""}'>clear</a>)</div>`
      : "";
    const body = `
${searchForm}
${pathNote}
<table class='list nowrap'>
<tr class='nohover'><th class='left'>Age</th><th class='left'>Commit message</th><th class='left'>Author</th></tr>
${rows || "<tr class='nohover'><td colspan='3'>(no matching commits)</td></tr>"}
</table>${nav}`;
    return htmlResponse(layout({ ...base, body }));
  }

  private refsPage(repo: string): Response {
    const r = `/${encodeURIComponent(repo)}`;
    const base = this.base(repo, "refs", undefined, `${r}/refs/`);
    const refs = this.store.refs();
    const branches = refs.filter((x) => x.name.startsWith("refs/heads/"));
    const tags = refs.filter((x) => x.name.startsWith("refs/tags/"));
    const branchRows = branches
      .map((b) => {
        const name = b.name.slice(11);
        const c = this.peelToCommit(b.target);
        const snap = `<a href='${r}/snapshot/${encodeURIComponent(repo)}-${encodeURIComponent(name)}.tar.gz'>tar.gz</a> ` +
          `<a href='${r}/snapshot/${encodeURIComponent(repo)}-${encodeURIComponent(name)}.zip'>zip</a>`;
        return `<tr><td><a href='${r}/log/?h=${encodeURIComponent(name)}'>${esc(name)}</a></td>` +
          `<td class='sha1'><a href='${r}/commit/?id=${b.target}'>${b.target.slice(0, 10)}</a></td>` +
          `<td>${esc(c?.commit.author.name ?? "")}</td><td>${c ? age(c.commit.committer.time) : ""}</td><td class='snapshots'>${snap}</td></tr>`;
      })
      .join("");
    const tagRows = tags
      .map((t) => {
        const name = t.name.slice(10);
        const obj = this.store.get(t.target);
        let when = 0;
        let who = "";
        let target = t.target;
        if (obj?.type === "tag") {
          const tag = parseTag(obj.data);
          when = tag.tagger?.time ?? 0;
          who = tag.tagger?.name ?? "";
          target = tag.object;
        } else if (obj?.type === "commit") {
          const c = parseCommit(obj.data);
          when = c.committer.time;
          who = c.author.name;
        }
        const snap = `<a href='${r}/snapshot/${encodeURIComponent(repo)}-${encodeURIComponent(name)}.tar.gz'>tar.gz</a> ` +
          `<a href='${r}/snapshot/${encodeURIComponent(repo)}-${encodeURIComponent(name)}.zip'>zip</a>`;
        return `<tr><td><a href='${r}/tag/?h=${encodeURIComponent(name)}'>${esc(name)}</a></td>` +
          `<td class='sha1'><a href='${r}/commit/?id=${target}'>${target.slice(0, 10)}</a></td>` +
          `<td>${esc(who)}</td><td>${age(when)}</td><td class='snapshots'>${snap}</td></tr>`;
      })
      .join("");
    const body = `
<table class='list nowrap'>
<tr class='nohover'><th class='left' colspan='5'>Branch</th></tr>
${branchRows || "<tr class='nohover'><td colspan='5'>none</td></tr>"}
<tr class='nohover'><td colspan='5'>&nbsp;</td></tr>
<tr class='nohover'><th class='left' colspan='5'>Tag</th></tr>
${tagRows || "<tr class='nohover'><td colspan='5'>none</td></tr>"}
</table>`;
    return htmlResponse(layout({ ...base, body }));
  }

  private pathBar(repo: string, h: string | undefined, path: string[]): string {
    const q = h ? `?h=${encodeURIComponent(h)}` : "";
    let html = `path: <a href='/${encodeURIComponent(repo)}/tree/${q}'>root</a>`;
    let acc = "";
    for (const seg of path) {
      acc += "/" + encodeURIComponent(seg);
      html += `/<a href='/${encodeURIComponent(repo)}/tree${acc}${q}'>${esc(seg)}</a>`;
    }
    return html;
  }

  private treePage(repo: string, h: string | undefined, path: string[]): Response {
    const r = `/${encodeURIComponent(repo)}`;
    const base = this.base(repo, "tree", h, `${r}/tree/${path.map(encodeURIComponent).join("/")}`);
    const rr = this.resolveRef(h);
    if (!rr) return errorPage(base, h ? `bad ref: ${h}` : "empty repository");
    const head = this.peelToCommit(rr.oid);
    if (!head) return errorPage(base, "no commit found");
    const found = this.lookupPath(head.commit.tree, path);
    if (!found) return errorPage(base, `path not found: ${path.join("/")}`);
    const withPath = { ...base, pathBar: this.pathBar(repo, h, path) };

    if (found.kind === "blob") {
      return this.blobPage(repo, h, path, found.entry, withPath);
    }

    const q = h ? `?h=${encodeURIComponent(h)}` : "";
    const prefix = path.map(encodeURIComponent).join("/");
    const rows = found.entries
      .map((e) => {
        const href = `${prefix ? prefix + "/" : ""}${encodeURIComponent(e.name)}`;
        const dir = isTreeMode(e.mode);
        const gitlink = isGitlinkMode(e.mode);
        const size = dir || gitlink ? "" : String(this.store.typeAndSize(e.oid)?.size ?? "");
        const link = gitlink
          ? `${esc(e.name)} @ ${e.oid.slice(0, 10)}`
          : `<a class='${dir ? "ls-dir" : "ls-blob"}' href='${r}/tree/${href}${q}'>${esc(e.name)}</a>`;
        const pathParam = [...path, e.name].map(encodeURIComponent).join("/");
        const logLink = `<a href='${r}/log/?${h ? `h=${encodeURIComponent(h)}&` : ""}path=${pathParam}'>log</a>`;
        const fileLinks = dir || gitlink ? "" : ` <a href='${r}/plain/${href}${q}'>plain</a> <a href='${r}/blame/${href}${q}'>blame</a>`;
        return `<tr><td class='ls-mode'>${modeString(e.mode)}</td><td>${link}</td><td class='ls-size'>${size}</td>` +
          `<td>${gitlink ? "" : logLink}${fileLinks}</td></tr>`;
      })
      .join("");
    const body = `
<table class='list'>
<tr class='nohover'><th class='left'>Mode</th><th class='left'>Name</th><th class='right'>Size</th><th></th></tr>
${rows}
</table>`;
    return htmlResponse(layout({ ...withPath, body }));
  }

  private blobPage(
    repo: string,
    h: string | undefined,
    path: string[],
    entry: TreeEntry,
    base: Omit<LayoutOpts, "body">
  ): Response {
    const obj = this.store.get(entry.oid);
    if (!obj) return errorPage(base, "missing blob");
    const r = `/${encodeURIComponent(repo)}`;
    const q = h ? `?h=${encodeURIComponent(h)}` : "";
    const href = path.map(encodeURIComponent).join("/");
    const plainHref = `${r}/plain/${href}${q}`;
    if (isBinary(obj.data)) {
      const body = `<div>Binary file (${obj.data.length} bytes) &mdash; <a href='${plainHref}'>download</a></div>`;
      return htmlResponse(layout({ ...base, body }));
    }
    const name = path[path.length - 1] ?? "";
    const lines = highlightLines(td.decode(obj.data), name);
    const nums = lines.map((_, i) => `<a id='n${i + 1}' href='#n${i + 1}'>${i + 1}</a>`).join("\n");
    const code = lines.map((l) => l || " ").join("\n");
    const body = `
<div>blob: ${entry.oid} (<a href='${plainHref}'>plain</a>) (<a href='${r}/blame/${href}${q}'>blame</a>)</div>
<table class='blob'>
<tr><td class='linenumbers'><pre>${nums}</pre></td><td class='lines'><pre><code>${code}</code></pre></td></tr>
</table>`;
    return htmlResponse(layout({ ...base, body }));
  }

  private blamePage(repo: string, h: string | undefined, path: string[]): Response {
    const r = `/${encodeURIComponent(repo)}`;
    const base = this.base(repo, "tree", h, `${r}/blame/${path.map(encodeURIComponent).join("/")}`);
    const withPath = { ...base, pathBar: this.pathBar(repo, h, path) };
    const rr = this.resolveRef(h);
    if (!rr) return errorPage(withPath, "empty repository");
    if (!path.length) return errorPage(withPath, "blame needs a file path");
    const history = this.pathHistory(rr.oid, path, 200);
    if (!history.length || !history[0].blob) return errorPage(withPath, `no such file: ${path.join("/")}`);
    if (isBinary(history[0].blob)) return errorPage(withPath, "cannot blame a binary file");
    const result = blame(history);
    if (!result) return errorPage(withPath, "blame skipped: file too large");
    // group consecutive lines from the same commit
    let rows = "";
    for (let i = 0; i < result.length; ) {
      let j = i;
      while (j < result.length && result[j].oid === result[i].oid) j++;
      const b = result[i];
      const codeLines: string[] = [];
      const numLines: string[] = [];
      for (let k = i; k < j; k++) {
        numLines.push(String(k + 1));
        codeLines.push(esc(result[k].line) || " ");
      }
      rows += `<tr><td class='sha1'><a href='${r}/commit/?id=${b.oid}'>${b.oid.slice(0, 8)}</a> ${esc(b.author)} ${age(b.time)}</td>` +
        `<td class='linenumbers'><pre>${numLines.join("\n")}</pre></td>` +
        `<td class='lines'><pre>${codeLines.join("\n")}</pre></td></tr>`;
      i = j;
    }
    const body = `<table class='blame blob'>${rows}</table>`;
    return htmlResponse(layout({ ...withPath, body }));
  }

  private plainPage(h: string | undefined, path: string[]): Response {
    const rr = this.resolveRef(h);
    if (!rr) return new Response("not found\n", { status: 404 });
    const head = this.peelToCommit(rr.oid);
    if (!head) return new Response("not found\n", { status: 404 });
    const found = this.lookupPath(head.commit.tree, path);
    if (!found || found.kind !== "blob") return new Response("not found\n", { status: 404 });
    const obj = this.store.get(found.entry.oid);
    if (!obj) return new Response("not found\n", { status: 404 });
    return rawBlobResponse(obj.data, path[path.length - 1] ?? "");
  }

  private blobByIdPage(id: string): Response {
    const oid = this.store.findOid(id);
    if (!oid) return new Response("not found\n", { status: 404 });
    const obj = this.store.get(oid);
    if (!obj || obj.type !== "blob") return new Response("not a blob\n", { status: 404 });
    return rawBlobResponse(obj.data, "");
  }

  private commitPage(repo: string, id: string | undefined, h: string | undefined): Response {
    const r = `/${encodeURIComponent(repo)}`;
    const base = this.base(repo, "commit", h, `${r}/commit/`);
    const oid = this.resolveCommitId(id, h);
    if (!oid) return errorPage(base, "commit not found");
    const commit = this.loadCommit(oid);
    if (!commit) return errorPage(base, `commit not found: ${oid}`);

    const parent = commit.parents[0] ? this.loadCommit(commit.parents[0]) : null;
    const { files, truncated } = this.computeDiff(parent?.tree ?? null, commit.tree);
    const deco = this.decorations(repo);

    const body = `
<table class='commit-info'>
<tr><th>author</th><td>${esc(commit.author.name)} &lt;${esc(commit.author.email)}&gt;</td><td class='right'>${fmtDate(commit.author.time, commit.author.tz)}</td></tr>
<tr><th>committer</th><td>${esc(commit.committer.name)} &lt;${esc(commit.committer.email)}&gt;</td><td class='right'>${fmtDate(commit.committer.time, commit.committer.tz)}</td></tr>
<tr><th>commit</th><td colspan='2' class='sha1'>${oid} (<a href='${r}/patch/?id=${oid}'>patch</a>)</td></tr>
<tr><th>tree</th><td colspan='2' class='sha1'><a href='${r}/tree/?h=${oid}'>${commit.tree}</a></td></tr>
${commit.parents.map((p) => `<tr><th>parent</th><td colspan='2' class='sha1'><a href='?id=${p}'>${p}</a> (<a href='${r}/diff/?id=${oid}&id2=${p}'>diff</a>)</td></tr>`).join("")}
<tr><th>download</th><td colspan='2' class='sha1'><a href='${r}/snapshot/${encodeURIComponent(repo)}-${oid.slice(0, 10)}.tar.gz'>${esc(repo)}-${oid.slice(0, 10)}.tar.gz</a> <a href='${r}/snapshot/${encodeURIComponent(repo)}-${oid.slice(0, 10)}.zip'>zip</a></td></tr>
</table>
<div class='commit-subject'>${esc(commit.subject)}${deco.get(oid) ?? ""}</div>
<div class='commit-msg'>${esc(commit.message.split("\n").slice(1).join("\n").trim())}</div>
${this.renderDiffHtml(repo, files, truncated)}`;
    return htmlResponse(layout({ ...base, body }));
  }

  private resolveCommitId(id: string | undefined, h: string | undefined): string | null {
    if (id) {
      const full = this.store.findOid(id);
      return full ? this.peelToCommit(full)?.oid ?? null : null;
    }
    const rr = this.resolveRef(h);
    return rr ? this.peelToCommit(rr.oid)?.oid ?? null : null;
  }

  /** diff/rawdiff: changes id2..id (default id2 = first parent of id). */
  private diffPage(repo: string, id: string | undefined, id2: string | undefined, h: string | undefined, raw: boolean): Response {
    const base = this.base(repo, "diff", h, `/${encodeURIComponent(repo)}/diff/`);
    const newOid = this.resolveCommitId(id, h);
    if (!newOid) return raw ? new Response("not found\n", { status: 404 }) : errorPage(base, "commit not found");
    const commit = this.loadCommit(newOid)!;
    let oldOid: string | null = null;
    if (id2) {
      oldOid = this.resolveCommitId(id2, undefined);
      if (!oldOid) return raw ? new Response("bad id2\n", { status: 404 }) : errorPage(base, `bad id2: ${id2}`);
    } else {
      oldOid = commit.parents[0] ?? null;
    }
    const oldCommit = oldOid ? this.loadCommit(oldOid) : null;
    const { files, truncated } = this.computeDiff(oldCommit?.tree ?? null, commit.tree);
    if (raw) {
      return new Response(this.renderRawDiff(files), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const body = `
<div class='commit-subject'>diff: ${oldOid ? `<a href='../commit/?id=${oldOid}'>${oldOid.slice(0, 10)}</a>` : "(root)"} .. <a href='../commit/?id=${newOid}'>${newOid.slice(0, 10)}</a></div>
${this.renderDiffHtml(repo, files, truncated)}`;
    return htmlResponse(layout({ ...base, body }));
  }

  /** git-format-patch style output, applies with `git am`. */
  private patchPage(repo: string, id: string | undefined, h: string | undefined): Response {
    const oid = this.resolveCommitId(id, h);
    if (!oid) return new Response("not found\n", { status: 404 });
    const commit = this.loadCommit(oid)!;
    const parent = commit.parents[0] ? this.loadCommit(commit.parents[0]) : null;
    const { files } = this.computeDiff(parent?.tree ?? null, commit.tree);
    const bodyText = commit.message.split("\n").slice(1).join("\n").trim();
    let statLines = "";
    let totalAdd = 0, totalDel = 0;
    for (const f of files) {
      statLines += ` ${f.path} | ${f.add + f.del} ${"+".repeat(Math.min(f.add, 30))}${"-".repeat(Math.min(f.del, 30))}\n`;
      totalAdd += f.add;
      totalDel += f.del;
    }
    const patch =
      `From ${oid} Mon Sep 17 00:00:00 2001\n` +
      `From: ${commit.author.name} <${commit.author.email}>\n` +
      `Date: ${fmtDate2822(commit.author.time, commit.author.tz)}\n` +
      `Subject: [PATCH] ${commit.subject}\n` +
      `\n` +
      (bodyText ? bodyText + "\n" : "") +
      `---\n` +
      statLines +
      ` ${files.length} file${files.length === 1 ? "" : "s"} changed, ${totalAdd} insertions(+), ${totalDel} deletions(-)\n` +
      `\n` +
      this.renderRawDiff(files) +
      `--\ndgit 0.2\n`;
    return new Response(patch, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  private tagPage(repo: string, name: string | undefined): Response {
    const r = `/${encodeURIComponent(repo)}`;
    const base = this.base(repo, "refs", undefined, `${r}/refs/`);
    if (!name) return errorPage(base, "no tag given");
    const target = this.store.getRef(`refs/tags/${name}`) ?? this.store.findOid(name);
    if (!target) return errorPage(base, `tag not found: ${name}`);
    const obj = this.store.get(target);
    if (!obj) return errorPage(base, `missing object`);
    let body: string;
    if (obj.type === "tag") {
      const tag = parseTag(obj.data);
      body = `
<table class='commit-info'>
<tr><th>tag name</th><td>${esc(tag.tag || name)}</td></tr>
${tag.tagger ? `<tr><th>tag date</th><td>${fmtDate(tag.tagger.time, tag.tagger.tz)}</td></tr><tr><th>tagged by</th><td>${esc(tag.tagger.name)} &lt;${esc(tag.tagger.email)}&gt;</td></tr>` : ""}
<tr><th>tagged object</th><td class='sha1'><a href='${r}/commit/?id=${tag.object}'>${tag.object}</a> (${esc(tag.type)})</td></tr>
<tr><th>download</th><td class='sha1'><a href='${r}/snapshot/${encodeURIComponent(repo)}-${encodeURIComponent(name)}.tar.gz'>${esc(repo)}-${esc(name)}.tar.gz</a> <a href='${r}/snapshot/${encodeURIComponent(repo)}-${encodeURIComponent(name)}.zip'>zip</a></td></tr>
</table>
<div class='commit-msg'>${esc(tag.message.trim())}</div>`;
    } else {
      body = `
<table class='commit-info'>
<tr><th>tag name</th><td>${esc(name)}</td></tr>
<tr><th>tagged object</th><td class='sha1'><a href='${r}/commit/?id=${target}'>${target}</a> (lightweight)</td></tr>
</table>`;
    }
    return htmlResponse(layout({ ...base, body }));
  }

  private snapshotPage(repo: string, filename: string): Response {
    let format: "tar.gz" | "zip";
    let stem: string;
    if (filename.endsWith(".tar.gz")) {
      format = "tar.gz";
      stem = filename.slice(0, -7);
    } else if (filename.endsWith(".tgz")) {
      format = "tar.gz";
      stem = filename.slice(0, -4);
    } else if (filename.endsWith(".zip")) {
      format = "zip";
      stem = filename.slice(0, -4);
    } else {
      return new Response("unsupported snapshot format (use .tar.gz or .zip)\n", { status: 400 });
    }
    // cgit-style: reponame-ref.tar.gz; also accept a bare ref and a v-prefix
    const candidates = [stem];
    if (stem.startsWith(`${repo}-`)) candidates.push(stem.slice(repo.length + 1));
    for (const c of [...candidates]) candidates.push(`v${c}`);
    let commit: { oid: string; commit: Commit } | null = null;
    for (const cand of candidates) {
      const rr = this.resolveRef(cand);
      if (rr) {
        commit = this.peelToCommit(rr.oid);
        if (commit) break;
      }
    }
    if (!commit) return new Response(`no ref matches snapshot name: ${stem}\n`, { status: 404 });

    const flat = new Map<string, { oid: string; mode: string }>();
    this.flattenTree(commit.commit.tree, "", flat);
    const files: SnapshotFile[] = [];
    let total = 0;
    for (const [path, info] of flat) {
      const obj = this.store.get(info.oid);
      if (!obj) continue;
      total += obj.data.length;
      if (total > MAX_SNAPSHOT_BYTES) {
        return new Response("snapshot too large\n", { status: 413 });
      }
      const m = parseInt(info.mode, 8);
      files.push({
        path,
        mode: m & 0o100 ? 0o755 : 0o644,
        symlink: (m & 0o170000) === 0o120000,
        data: obj.data,
      });
    }
    const archive = format === "tar.gz"
      ? tarGz(stem, files, commit.commit.committer.time)
      : zip(stem, files, commit.commit.committer.time);
    return new Response(archive as unknown as BodyInit, {
      headers: {
        "content-type": format === "tar.gz" ? "application/gzip" : "application/zip",
        "content-disposition": `attachment; filename="${filename.replaceAll('"', "")}"`,
      },
    });
  }

  private atomPage(repo: string, host: string, proto: string, h: string | undefined): Response {
    const rr = this.resolveRef(h);
    if (!rr) return new Response("empty repository\n", { status: 404 });
    const { entries } = this.walkLog(rr.oid, 0, 20);
    const abs = `${proto}://${host}/${encodeURIComponent(repo)}`;
    const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const updated = entries[0] ? iso(entries[0].commit.committer.time) : iso(0);
    const items = entries
      .map(
        (e) => `<entry>
<title>${esc(e.commit.subject)}</title>
<updated>${iso(e.commit.committer.time)}</updated>
<author><name>${esc(e.commit.author.name)}</name><email>${esc(e.commit.author.email)}</email></author>
<published>${iso(e.commit.author.time)}</published>
<link rel='alternate' type='text/html' href='${abs}/commit/?id=${e.oid}'/>
<id>urn:sha1:${e.oid}</id>
<content type='text'>${esc(e.commit.message)}</content>
</entry>`
      )
      .join("\n");
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns='http://www.w3.org/2005/Atom'>
<title>${esc(repo)}</title>
<subtitle>${esc(this.store.getMeta("description") ?? "")}</subtitle>
<id>${abs}/</id>
<link rel='self' href='${abs}/atom/'/>
<link rel='alternate' type='text/html' href='${abs}/'/>
<updated>${updated}</updated>
${items}
</feed>`;
    return new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8" } });
  }

  private statsPage(repo: string, h: string | undefined, period: string): Response {
    const r = `/${encodeURIComponent(repo)}`;
    const base = this.base(repo, "stats", h, `${r}/stats/`);
    const rr = this.resolveRef(h);
    if (!rr) return errorPage(base, "empty repository");
    const { entries } = this.walkLog(rr.oid, 0, MAX_STATS_SCAN);

    const keyOf = (t: number): string => {
      const d = new Date(t * 1000);
      if (period === "y") return String(d.getUTCFullYear());
      if (period === "w") {
        const onejan = Date.UTC(d.getUTCFullYear(), 0, 1);
        const week = Math.ceil(((d.getTime() - onejan) / 86400000 + 1) / 7);
        return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
      }
      if (period === "q") return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    const periodKeys: string[] = [];
    const byAuthor = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();
    for (const e of entries) {
      const key = keyOf(e.commit.committer.time);
      if (!periodKeys.includes(key)) periodKeys.push(key);
      const author = e.commit.author.name || "(unknown)";
      if (!byAuthor.has(author)) byAuthor.set(author, new Map());
      const m = byAuthor.get(author)!;
      m.set(key, (m.get(key) ?? 0) + 1);
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    const cols = periodKeys.slice(0, 8);
    const authors = [...byAuthor.entries()]
      .map(([name, m]) => ({ name, m, total: [...m.values()].reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);
    const periodLinks = [
      ["w", "week"],
      ["m", "month"],
      ["q", "quarter"],
      ["y", "year"],
    ]
      .map(([p, label]) =>
        p === period
          ? `<strong>${label}</strong>`
          : `<a href='?${h ? `h=${encodeURIComponent(h)}&` : ""}period=${p}'>${label}</a>`
      )
      .join(" | ");
    const rows = authors
      .map(
        (a) =>
          `<tr><td class='name'>${esc(a.name)}</td>` +
          cols.map((k) => `<td>${a.m.get(k) ?? ""}</td>`).join("") +
          `<td><strong>${a.total}</strong></td></tr>`
      )
      .join("");
    const totalRow =
      `<tr><td class='name'><strong>Total</strong></td>` +
      cols.map((k) => `<td><strong>${totals.get(k) ?? 0}</strong></td>`).join("") +
      `<td><strong>${entries.length}</strong></td></tr>`;
    const body = `
<div>Commits per author per ${period === "w" ? "week" : period === "y" ? "year" : period === "q" ? "quarter" : "month"} (${periodLinks})${entries.length >= MAX_STATS_SCAN ? ` &mdash; last ${MAX_STATS_SCAN} commits` : ""}</div>
<table class='stats'>
<tr><th>Author</th>${cols.map((k) => `<th>${esc(k)}</th>`).join("")}<th>Total</th></tr>
${rows}
${totalRow}
</table>`;
    return htmlResponse(layout({ ...base, body }));
  }
}

function renderHunk(hk: Hunk): string {
  let html = `<div class='hunk'>@@ -${hk.aStart},${hk.aLen} +${hk.bStart},${hk.bLen} @@</div>`;
  for (const op of hk.ops) {
    const cls = op.tag === "add" ? "add" : op.tag === "del" ? "del" : "ctx";
    const sign = op.tag === "add" ? "+" : op.tag === "del" ? "-" : " ";
    html += `<div class='${cls}'>${sign}${esc(op.line) || " "}</div>`;
  }
  return html;
}

function rawBlobResponse(data: Uint8Array, name: string): Response {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", pdf: "application/pdf", html: "text/plain",
  };
  const ct = types[ext] ?? (isBinary(data) ? "application/octet-stream" : "text/plain; charset=utf-8");
  return new Response(data as unknown as BodyInit, { headers: { "content-type": ct } });
}

function decodePath(p: string): string[] {
  return p
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s))
    .filter((s) => s !== "." && s !== "..");
}
