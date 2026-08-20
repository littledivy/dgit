// A minimal platform on durable-git: public reads of public repos,
// per-repository deploy keys in KV, a CI webhook on push, and a route that
// reads repository content over RPC. Bind the Durable Objects as dgit's own
// wrangler.jsonc does and re-export the classes.
import { createDurableGit, secretsEqual, type Env as DgitEnv, type PushEvent } from "durable-git";

export { RepoCell, Registry } from "durable-git";

interface Env extends DgitEnv {
  /** key: repository name, value: its push token */
  DEPLOY_KEYS: KVNamespace;
  CI_WEBHOOK: string;
}

/** a repository's deploy key also grants private reads and admin ops */
async function holdsDeployKey(env: Env, repo: string, pass: string | undefined): Promise<boolean> {
  const key = await env.DEPLOY_KEYS.get(repo);
  return key !== null && (await secretsEqual(pass ?? "", key));
}

const git = createDurableGit<Env>({
  // consulting ctx.private is on the hook: it replaces the default policy
  async authorize({ repo, op, private: priv, credentials, env }) {
    if (op === "read" && !priv) return true;
    return holdsDeployKey(env, repo, credentials?.pass);
  },
  async onPush(event: PushEvent, env: Env) {
    await fetch(env.CI_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  },
});

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // serve any repository's README at /_readme/<repo> over RPC. RPC bypasses
    // authorize, so the route gates itself: validate the name (an unchecked
    // getByName materializes a cell per probe), then hold private repos to
    // the same key as a push.
    if (url.pathname.startsWith("/_readme/")) {
      const repo = url.pathname.slice("/_readme/".length);
      if (!REPO_NAME.test(repo)) return new Response("bad repository name\n", { status: 400 });
      const info = await env.REGISTRY.getByName("registry").get(repo);
      if (!info) return new Response("not found\n", { status: 404 });
      if (info.priv && !(await holdsDeployKey(env, repo, parseBasicPass(req)))) {
        return new Response("auth required\n", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="platform"' },
        });
      }
      const blob = await env.REPO.getByName(repo).readBlob(undefined, "README.md");
      if (!blob) return new Response("no README\n", { status: 404 });
      return new Response(blob.data, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    return git.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

function parseBasicPass(req: Request): string | undefined {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return undefined;
  try {
    const decoded = atob(header.slice(6));
    return decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return undefined;
  }
}
