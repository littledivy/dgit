/**
 * durable-git library entry. `createDurableGit(options)` returns the Worker
 * handler; re-export `RepoCell` and `Registry` from your entry module so the
 * runtime can find the Durable Object classes:
 *
 *   import { createDurableGit } from "durable-git";
 *   export { RepoCell, Registry } from "durable-git";
 *   export default createDurableGit({ authorize, onPush });
 */
import type { Env } from "./env";
import type { RepoInfo } from "./registry";
import { esc, age, layout, htmlResponse, errorPage } from "./ui/html";
import { CSS } from "./ui/style";
import { parseUploadRequest, streamingCloneResponse } from "./git/protocol";
import { isOid } from "./git/util";
import { gunzipLimited } from "./git/zlib";
import type { RepoCell } from "./repo";

export { RepoCell } from "./repo";
export { Registry } from "./registry";
export type { Env } from "./env";
export type { RepoInfo, RepoConfig } from "./registry";
export type { RefsResult, CommitJson, TreeResult, TreeEntryJson, BlobResult, LogResult } from "./repo";
export type { Person } from "./git/objects";

/** an upload-pack negotiation body is wants/haves/caps only — a few hundred KB */
const MAX_UPLOAD_PACK_BYTES = 16 * 1024 * 1024;

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED = new Set(["cgit.css", "favicon.ico", "robots.txt", "info", "git-upload-pack", "git-receive-pack"]);
const CACHE_TTL = 60;

/** What a request is asking to do, from the repository's point of view. */
export type AuthOp = "read" | "write" | "admin";

export interface AuthContext<E extends Env = Env> {
  repo: string;
  /** read: pages, clones, fetches, the content API; write: git push; admin: config/gc/delete */
  op: AuthOp;
  /** the repository's private flag (false for a repository that does not exist yet) */
  private: boolean;
  /** HTTP Basic credentials on the request, if any */
  credentials: { user: string; pass: string } | null;
  /** the live incoming request: headers and URL only — do NOT read its body,
   * which is consumed downstream (a hook that drains it breaks every push) */
  request: Request;
  env: E;
}

export interface RefUpdate {
  ref: string;
  /** all-zeros for a created ref */
  old: string;
  /** all-zeros for a deleted ref */
  new: string;
}

export interface PushEvent {
  repo: string;
  /** the ref updates this push actually applied (rejected commands excluded) */
  updates: RefUpdate[];
  /** unix millis of the newest committer date after the push */
  commitTime: number;
}

export interface DurableGitOptions<E extends Env = Env> {
  /**
   * Gate every repository-scoped request. Return true to allow, false for the
   * default 401 Basic challenge, or a Response to send verbatim (a custom
   * challenge, a redirect to your login page). The default implementation is
   * the stock token check: reads of public repositories are open; writes,
   * admin operations, and anything on a private repository require a
   * GIT_TOKEN/GIT_TOKENS match, with per-IP failure rate limiting.
   */
  authorize?: (ctx: AuthContext<E>) => boolean | Response | Promise<boolean | Response>;
  /**
   * Fired after a push applies at least one ref update, off the response path
   * (via waitUntil), so a slow or throwing hook never fails the push.
   */
  onPush?: (event: PushEvent, env: E) => void | Promise<void>;
}

function tokens(env: Env): string[] {
  const list = [env.GIT_TOKEN ?? "", ...(env.GIT_TOKENS ?? "").split(",")];
  return list.map((t) => t.trim()).filter(Boolean);
}

function unauthorized(): Response {
  return new Response("auth required\n", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="dgit"' },
  });
}

function tooManyRequests(retryAfterMs: number): Response {
  return new Response("too many failed attempts\n", {
    status: 429,
    headers: { "retry-after": String(Math.ceil(retryAfterMs / 1000)) },
  });
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Fixed-length SHA-256 digests, so this leaks nothing about input length. */
function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Timing-safe string comparison for authorize hooks. `credentials.pass ===
 * secret` leaks the match length through timing; compare through this instead.
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  return digestsEqual(await digest(a), await digest(b));
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function parseBasic(req: Request): { user: string; pass: string } | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(":");
    if (colon === -1) return { user: decoded, pass: "" };
    return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_MAX_IPS = 5000;
const authFailures = new Map<string, { count: number; resetAt: number }>();

function pruneAuthFailures(now: number): void {
  if (authFailures.size <= RATE_LIMIT_MAX_IPS) return;
  for (const [ip, e] of authFailures) {
    if (e.resetAt <= now) authFailures.delete(ip);
  }
  while (authFailures.size > RATE_LIMIT_MAX_IPS) {
    const oldest = authFailures.keys().next().value;
    if (oldest === undefined) break;
    authFailures.delete(oldest);
  }
}

function rateLimited(ip: string): number | null {
  const e = authFailures.get(ip);
  if (!e || e.resetAt <= Date.now()) return null;
  return e.count >= RATE_LIMIT_MAX ? e.resetAt - Date.now() : null;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const e = authFailures.get(ip);
  if (!e || e.resetAt <= now) {
    authFailures.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    e.count++;
  }
  pruneAuthFailures(now);
}

/** The default authorize: HTTP Basic where the password is one of the configured tokens. */
async function tokenAuthorize(ctx: AuthContext): Promise<boolean | Response> {
  if (ctx.op === "read" && !ctx.private) return true;
  const valid = tokens(ctx.env);
  if (!valid.length) {
    return new Response("access is disabled: set the GIT_TOKEN secret\n", { status: 403 });
  }
  const header = ctx.request.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return unauthorized();

  const ip = clientIp(ctx.request);
  const retryMs = rateLimited(ip);
  if (retryMs !== null) return tooManyRequests(retryMs);

  // a Basic header that failed to decode is a failed attempt, same as a wrong
  // password — otherwise malformed headers probe the endpoint rate-limit-free
  if (!ctx.credentials) {
    recordAuthFailure(ip);
    return unauthorized();
  }

  const passDigest = await digest(ctx.credentials.pass);
  let ok = false;
  for (const v of valid) ok = digestsEqual(passDigest, await digest(v)) || ok;
  if (!ok) {
    recordAuthFailure(ip);
    return unauthorized();
  }
  return true;
}

function siteBase(env: Env) {
  return {
    site: env.SITE_NAME ?? "dgit",
    siteDesc: env.SITE_DESC ?? "",
    title: env.SITE_NAME ?? "dgit",
    sub: env.SITE_DESC ?? "",
    tab: "index",
  };
}

async function indexPage(env: Env): Promise<Response> {
  const registry = env.REGISTRY.getByName("registry");
  const repos = await registry.list();
  let rows = "";
  for (const r of repos) {
    rows +=
      `<tr><td><a href='/${encodeURIComponent(r.name)}/'>${esc(r.name)}</a></td>` +
      `<td>${esc(r.desc || "[no description]")}</td>` +
      `<td>${esc(r.owner || env.SITE_OWNER || "")}</td>` +
      `<td>${age(Math.floor(r.idle / 1000))}</td></tr>`;
  }
  const body = `
<table class='list nowrap'>
<tr class='nohover'><th class='left'>Name</th><th class='left'>Description</th><th class='left'>Owner</th><th class='left'>Updated</th></tr>
${rows || "<tr class='nohover'><td colspan='4'>no repositories yet &mdash; create one by pushing: <code>git push https://&lt;this-host&gt;/myrepo.git main</code></td></tr>"}
</table>`;
  return htmlResponse(layout({ ...siteBase(env), body }));
}

/**
 * Per-isolate memo of registry lookups. Without it every page view — cache
 * hit or not — funnels through the single Registry DO, which becomes the
 * global bottleneck under a traffic spike. Staleness window is small and
 * only affects metadata (descriptions, versions, the private flag). Bounded
 * and short-TTL'd on misses so enumerating random repo names can't grow it
 * unbounded.
 */
const infoMemo = new Map<string, { at: number; info: RepoInfo | null }>();
const INFO_TTL_MS = 20_000;
const INFO_NEG_TTL_MS = 2_000;
const INFO_MEMO_MAX = 5000;

function pruneInfoMemo(): void {
  while (infoMemo.size > INFO_MEMO_MAX) {
    const oldest = infoMemo.keys().next().value;
    if (oldest === undefined) break;
    infoMemo.delete(oldest);
  }
}

async function repoInfo(env: Env, repo: string, fresh: boolean): Promise<RepoInfo | null> {
  const hit = infoMemo.get(repo);
  if (!fresh && hit && Date.now() - hit.at < (hit.info ? INFO_TTL_MS : INFO_NEG_TTL_MS)) return hit.info;
  const info = await env.REGISTRY.getByName("registry").get(repo);
  infoMemo.set(repo, { at: Date.now(), info });
  pruneInfoMemo();
  return info;
}

/** Cache API is a Cloudflare-only surface; celld has none, so feature-detect. */
function pageCache(): Cache | null {
  try {
    // eslint-disable-next-line no-undef
    return typeof caches !== "undefined" && (caches as unknown as { default?: Cache }).default
      ? (caches as unknown as { default: Cache }).default
      : null;
  } catch {
    return null;
  }
}

/**
 * R2 full-clone fast path, served entirely from the Worker so the DO is never
 * contacted for bytes (this is the read-offload that avoids the workerd
 * DO->response stall on large packs). Detects a true full clone from the tiny
 * negotiation body — wants, no haves, `done`, not shallow/deepen, side-band-64k
 * — then asks the DO only for the cheap versioned key (no pack generation) and
 * streams the stored raw pack from R2 with on-the-fly side-band framing. Returns
 * null (a miss, a partial/shallow fetch, or any failure) to fall through to the
 * normal DO clone path. Callers MUST invoke this only after the auth gate, so a
 * private repo never streams R2 bytes to an anonymous client.
 */
async function serveCloneFromR2(
  env: Env,
  repo: string,
  body: Uint8Array,
  stub: DurableObjectStub<RepoCell>
): Promise<Response | null> {
  const bucket = env.PACK_CACHE;
  if (!bucket) return null;
  const req = parseUploadRequest(body);
  const fullClone =
    req.wants.length > 0 &&
    req.wants.every(isOid) &&
    req.haves.length === 0 &&
    req.done &&
    req.deepen === 0 &&
    req.clientShallows.length === 0 &&
    req.caps.has("side-band-64k");
  if (!fullClone) return null;
  let key: string | null;
  try {
    key = await stub.currentPackKey(repo, req.wants);
  } catch {
    return null;
  }
  if (!key) return null;
  let obj: R2ObjectBody | null;
  try {
    obj = await bucket.get(key);
  } catch {
    return null;
  }
  if (!obj) return null;
  const objects = parseInt(obj.customMetadata?.objects ?? "", 10);
  if (!Number.isFinite(objects)) return null;
  return streamingCloneResponse(obj.body, objects, req.caps.has("no-progress"));
}

function parseRefUpdates(res: Response): RefUpdate[] {
  const header = res.headers.get("x-ref-updates");
  if (!header) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(header)) as RefUpdate[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The returned handler: a valid Worker default export, with `fetch` non-optional
 * so it can also be delegated to from a wrapping router. */
export interface DurableGitHandler<E extends Env = Env> {
  fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response>;
}

export function createDurableGit<E extends Env = Env>(options: DurableGitOptions<E> = {}): DurableGitHandler<E> {
  const authorize = options.authorize ?? tokenAuthorize;
  return {
    async fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/" || path === "") {
        // the index is the front door under load: cache it briefly at the edge
        const cache = pageCache();
        if (cache) {
          const key = new Request(`${url.origin}/?__index`, { method: "GET" });
          const hit = await cache.match(key);
          if (hit) return hit;
          const res = await indexPage(env);
          const toCache = new Response(res.clone().body, res);
          toCache.headers.set("cache-control", "public, max-age=30");
          ctx.waitUntil(cache.put(key, toCache));
          return res;
        }
        return indexPage(env);
      }
      if (path === "/cgit.css") {
        return new Response(CSS, { headers: { "content-type": "text/css", "cache-control": "public, max-age=3600" } });
      }
      if (path === "/robots.txt") {
        return new Response(
          "User-agent: *\nDisallow: /*/snapshot/\nDisallow: /*/blame/\nDisallow: /*/stats/\nDisallow: /*/diff/\nDisallow: /*/rawdiff/\nDisallow: /*/patch/\n",
          { headers: { "content-type": "text/plain" } }
        );
      }
      if (path === "/favicon.ico") {
        return new Response("not found\n", { status: 404 });
      }

      const m = path.match(/^\/([^/]+?)(\.git)?(\/.*)?$/);
      if (!m) return errorPage(siteBase(env), "bad request", 400);
      const repo = decodeURIComponent(m[1]);
      const sub = m[3] ?? "/";
      if (!REPO_NAME.test(repo) || RESERVED.has(repo)) {
        return errorPage(siteBase(env), `no such repository: ${repo}`, 404);
      }

      const registry = env.REGISTRY.getByName("registry");

      const isReceive =
        sub === "/git-receive-pack" ||
        (sub === "/info/refs" && url.searchParams.get("service") === "git-receive-pack");
      const isProtocol = isReceive || sub === "/git-upload-pack" || sub === "/info/refs";
      const isApi = sub.startsWith("/api/");
      const isAdmin =
        ((sub === "/config" || sub === "/description") && req.method === "PUT") ||
        (sub === "/gc" && req.method === "POST") ||
        ((sub === "/" || sub === "") && req.method === "DELETE");

      // mutations read the registry fresh; page views tolerate a short memo
      const info: RepoInfo | null = await repoInfo(env, repo, isReceive || isAdmin);

      // every repo-scoped request passes through authorize; the default hook
      // waves reads of public repositories straight through
      const op: AuthOp = isReceive ? "write" : isAdmin ? "admin" : "read";
      const decision = await authorize({
        repo,
        op,
        private: !!info?.priv,
        credentials: parseBasic(req),
        request: req,
        env,
      });
      if (decision instanceof Response) return decision;
      if (!decision) return unauthorized();

      // only pushes and admin ops may touch repos that don't exist yet
      if (!info && !isReceive && !isAdmin) {
        if (isApi) return Response.json({ error: `repository not found: ${repo}` }, { status: 404 });
        if (isProtocol) return new Response(`repository not found: ${repo}\n`, { status: 404 });
        return errorPage(siteBase(env), `no such repository: ${repo}`, 404);
      }

      // page cache for public repo GET pages (versioned key; skipped on celld)
      const cache = pageCache();
      const cacheable =
        cache !== null &&
        req.method === "GET" &&
        !isProtocol &&
        info !== null &&
        !info.priv &&
        !req.headers.has("authorization");
      let cacheKey: Request | null = null;
      if (cacheable) {
        const keyUrl = new URL(url.toString());
        keyUrl.searchParams.set("__v", String(info!.ver));
        cacheKey = new Request(keyUrl.toString(), { method: "GET" });
        const hit = await cache!.match(cacheKey);
        if (hit) return hit;
      }

      const stub = env.REPO.getByName(repo);
      const doUrl = new URL(req.url);
      doUrl.pathname = sub;
      // On celld, re-wrapping a bytes-backed request yields a stream-backed one
      // whose consumption UTF-8-decodes the whole body (fatal for multi-hundred-
      // MB binary packs). Forward explicit bytes there; stream on workerd.
      let fwdBody: BodyInit | null = null;
      if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
        const declared = parseInt(req.headers.get("content-length") ?? "", 10);
        const smallUploadPack =
          sub === "/git-upload-pack" && (!Number.isFinite(declared) || declared <= MAX_UPLOAD_PACK_BYTES);
        if (smallUploadPack) {
          // buffer the tiny negotiation body so a full clone can be served straight
          // from R2 (never touching the DO for bytes); the auth gate above has
          // already run, so a private repo cannot reach this point anonymously.
          const raw = new Uint8Array(await req.arrayBuffer());
          let parsed: Uint8Array = raw;
          if (req.headers.get("content-encoding")?.includes("gzip")) {
            try {
              parsed = gunzipLimited(raw, MAX_UPLOAD_PACK_BYTES);
            } catch {
              parsed = new Uint8Array(0);
            }
          }
          if (env.PACK_CACHE && parsed.length) {
            const hit = await serveCloneFromR2(env, repo, parsed, stub);
            if (hit) return hit;
          }
          fwdBody = raw; // miss: forward the original (still-encoded) bytes to the DO
        } else {
          fwdBody = pageCache() === null ? ((await req.arrayBuffer()) as ArrayBuffer) : req.body;
        }
      }
      const fwd = new Request(doUrl.toString(), {
        method: req.method,
        headers: req.headers,
        body: fwdBody,
      });
      fwd.headers.set("x-repo", repo);
      fwd.headers.set("x-host", url.host);
      fwd.headers.set("x-proto", url.protocol.replace(":", ""));
      const res = await stub.fetch(fwd);

      // bookkeeping after successful mutations. idle is the newest committer date
      // (x-commit-time), computed by the DO which alone can read the object graph
      if (res.ok && sub === "/git-receive-pack" && res.headers.get("x-changed") === "1") {
        const idle = parseInt(res.headers.get("x-commit-time") ?? "", 10) || Date.now();
        try {
          // a registry hiccup must not fail an already-applied push; next push heals
          await registry.upsert(repo, idle);
        } catch {
          // registry deferred
        }
        if (options.onPush) {
          const event: PushEvent = { repo, updates: parseRefUpdates(res), commitTime: idle };
          ctx.waitUntil(
            Promise.resolve(options.onPush(event, env)).catch((err) => {
              console.log(`[onPush ${repo}] hook failed: ${err instanceof Error ? err.message : String(err)}`);
            })
          );
        }
      }
      if (res.ok && (sub === "/config" || sub === "/description") && req.method === "PUT") {
        try {
          const cfg = (await res.clone().json()) as {
            description: string;
            owner: string;
            section: string;
            private: boolean;
          };
          const idle = parseInt(res.headers.get("x-commit-time") ?? "", 10) || Date.now();
          if (!info) await registry.upsert(repo, idle);
          await registry.setConfig(
            repo,
            {
              desc: cfg.description,
              owner: cfg.owner,
              section: cfg.section,
              priv: cfg.private,
            },
            idle
          );
        } catch {
          // non-JSON response; skip registry sync
        }
      }
      if (res.ok && (sub === "/" || sub === "") && req.method === "DELETE") {
        await registry.remove(repo);
      }
      if (isReceive || isAdmin) infoMemo.delete(repo); // this isolate sees its own mutations

      if (cacheable && cacheKey && res.ok && !res.headers.has("set-cookie")) {
        const toCache = new Response(res.clone().body, res);
        toCache.headers.set("cache-control", `public, max-age=${CACHE_TTL}`);
        ctx.waitUntil(cache!.put(cacheKey, toCache));
      }
      // x-ref-updates is a Worker<->cell event channel, not client data
      if (res.headers.has("x-ref-updates")) {
        const out = new Response(res.body, res);
        out.headers.delete("x-ref-updates");
        return out;
      }
      return res;
    },
  };
}
