import type { Env } from "./env";
import type { RepoInfo } from "./registry";
import { esc, age, layout, htmlResponse, errorPage } from "./ui/html";
import { CSS } from "./ui/style";

export { RepoCell } from "./repo";
export { Registry } from "./registry";

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED = new Set(["cgit.css", "favicon.ico", "robots.txt", "info", "git-upload-pack", "git-receive-pack"]);
const CACHE_TTL = 60;

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

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
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

/** HTTP Basic where the password (only) is one of the configured tokens. */
async function checkAuth(req: Request, env: Env): Promise<Response | null> {
  const valid = tokens(env);
  if (!valid.length) {
    return new Response("access is disabled: set the GIT_TOKEN secret\n", { status: 403 });
  }
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return unauthorized();

  const ip = clientIp(req);
  const retryMs = rateLimited(ip);
  if (retryMs !== null) return tooManyRequests(retryMs);

  let pass = "";
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(":");
    pass = colon === -1 ? "" : decoded.slice(colon + 1);
  } catch {
    recordAuthFailure(ip);
    return unauthorized();
  }

  const passDigest = await digest(pass);
  let ok = false;
  for (const v of valid) ok = digestsEqual(passDigest, await digest(v)) || ok;
  if (!ok) {
    recordAuthFailure(ip);
    return unauthorized();
  }
  return null;
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
  let lastSection: string | null = null;
  for (const r of repos) {
    if (r.section !== lastSection) {
      if (r.section) {
        rows += `<tr class='nohover'><td class='reposection' colspan='4'>${esc(r.section)}</td></tr>`;
      }
      lastSection = r.section;
    }
    rows +=
      `<tr><td><a href='/${encodeURIComponent(r.name)}/'>${esc(r.name)}</a></td>` +
      `<td>${esc(r.desc || "[no description]")}</td>` +
      `<td>${esc(r.owner || env.SITE_OWNER || "")}</td>` +
      `<td>${age(Math.floor(r.idle / 1000))}</td></tr>`;
  }
  const body = `
<table class='list nowrap'>
<tr class='nohover'><th class='left'>Name</th><th class='left'>Description</th><th class='left'>Owner</th><th class='left'>Idle</th></tr>
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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    const isAdmin =
      ((sub === "/config" || sub === "/description") && req.method === "PUT") ||
      (sub === "/gc" && req.method === "POST") ||
      ((sub === "/" || sub === "") && req.method === "DELETE");

    // mutations read the registry fresh; page views tolerate a short memo
    const info: RepoInfo | null = await repoInfo(env, repo, isReceive || isAdmin);

    // pushes, admin operations, and everything on a private repo require auth
    if (isReceive || isAdmin || info?.priv) {
      const denied = await checkAuth(req, env);
      if (denied) return denied;
    }

    // only pushes and admin ops may touch repos that don't exist yet
    if (!info && !isReceive && !isAdmin) {
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
      fwdBody = pageCache() === null ? ((await req.arrayBuffer()) as ArrayBuffer) : req.body;
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

    // bookkeeping after successful mutations
    if (res.ok && sub === "/git-receive-pack" && res.headers.get("x-changed") === "1") {
      await registry.upsert(repo, Date.now());
    }
    if (res.ok && (sub === "/config" || sub === "/description") && req.method === "PUT") {
      try {
        const cfg = (await res.clone().json()) as {
          description: string;
          owner: string;
          section: string;
          private: boolean;
        };
        if (!info) await registry.upsert(repo, Date.now());
        await registry.setConfig(repo, {
          desc: cfg.description,
          owner: cfg.owner,
          section: cfg.section,
          priv: cfg.private,
        });
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
    return res;
  },
} satisfies ExportedHandler<Env>;
