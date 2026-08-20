# dgit

Durable **git**.

dgit is a git server for Cloudflare Workers and for your own machines
with [celld](https://celld.dev). Each repository is a Durable Object: a
small server with a name and a private SQLite database that holds the
repository's objects and refs, speaks the git smart HTTP protocol to a
stock git client, and renders a cgit-style web interface. There is no
origin server, no filesystem, and no GitHub in the critical path. A
repository nobody touches costs almost nothing, and applications shard
by construction: one hot repository cannot slow another. Reads are
public; pushes authenticate; pushing to a name that does not exist
creates the repository.

## How it works

dgit implements git in TypeScript: pkt-line framing, packfile parsing
with ofs- and ref-delta resolution, pack generation over a streaming
SHA-1, commit/tree/tag codecs, and a Myers diff. The one dependency is
pako, for zlib.

A push streams into the repository's cell and is stored as the packfile
the client sent; an index maps each object id to its pack, offset, and
delta base, so the client's compression is preserved rather than
re-derived. When an R2 bucket is bound the pack bytes are written to R2
and only the index stays in the cell's SQLite, so pack storage is no
longer capped by the per-cell database. A clone walks the closure of the
requested refs and copies the stored compressed bytes verbatim into the
outgoing pack; a full clone, once built, is cached in R2 and afterwards
streamed straight from the Worker, so repeat clones never load the cell.
Fetch
negotiation excludes the closure of the client's haves, cut correctly
at shallow boundaries, so an incremental fetch downloads only what is
missing. Shallow clones (`--depth`, deepening, `--unshallow`), thin
packs, side-band progress, forced updates, and ref deletion behave as
they do against any git server.

The web interface is the cgit surface: summary, refs, log with search
and per-path history, tree, blob with syntax highlighting, blame,
commit and arbitrary-range diffs, `format-patch` output that applies
cleanly with `git am`, tar.gz and zip snapshots of any ref, about pages
rendered from the README, atom feeds, and commit-activity statistics.
Repositories carry a description, an owner, a section on the index
page, and a private flag that hides them and gates every read behind
the push token.

## Deploy to Cloudflare

```sh
npm install
npx wrangler r2 bucket create dgit-pack-cache   # optional: R2 pack offload + clone cache
npx wrangler deploy
npx wrangler secret put GIT_TOKEN   # the push password
```

The `PACK_CACHE` R2 binding in `wrangler.jsonc` is optional: with it,
pushed pack bytes live in R2 (off the cell's SQLite) and full clones are
served straight from R2 by the Worker without loading the cell. Remove
the binding and everything falls back to the SQLite-only path.

Then push anything:

```sh
git remote add origin https://<your-host>/myrepo.git
git push -u origin main
```

A Workers request is bounded at 128MB of memory and five minutes of
CPU, so a very large history lands as a series of smaller pushes rather
than one; day-to-day pushes, clones, and fetches fit comfortably.
Building a full-history clone of a repository with millions of objects
can exceed the CPU bound the first time — once such a clone is cached in
R2 it streams from the Worker without rebuilding, and shallow and
incremental fetches of the same repository are fine regardless. The
largest repositories belong on celld.

## Self-host on celld

celld runs the same Worker against a bucket you own, with none of the
managed platform's request bounds. Set a real `GIT_TOKEN` var in
`wrangler.celld.jsonc` first:

```sh
celld deploy wrangler.celld.jsonc --bucket s3://my-cells --endpoint https://...
CELLD_V8_HEAP_LIMIT_MB=4096 CELLD_LTX_DURABILITY_TIMEOUT_SECS=180 \
celld --bucket s3://my-cells --endpoint https://... \
  --listen 0.0.0.0:8080 --internal-listen 10.0.0.1:8081 --advertise 10.0.0.1:8081
```

Each repository's SQLite database replicates to the bucket; nodes are
disposable, and a killed node's repositories come back bit-identical.
The heap and durability-deadline variables give large single-cell
ingests the room the defaults do not.

## Build on dgit

dgit is also a library, published as
[`durable-git`](https://www.npmjs.com/package/durable-git). The deployed
Worker above is three lines around it:

```ts
import { createDurableGit, secretsEqual } from "durable-git";
export { RepoCell, Registry } from "durable-git";

export default createDurableGit({
  async authorize({ repo, op, private: priv, credentials, env }) {
    if (op === "read" && !priv) return true;
    return secretsEqual(credentials?.pass ?? "", await lookupDeployKey(env, repo));
  },
  onPush(event, env) {
    return fetch("https://ci.example.com/hook", { method: "POST", body: JSON.stringify(event) });
  },
});
```

The package ships TypeScript source, which wrangler bundles directly;
bind the Durable Object classes as [wrangler.jsonc](wrangler.jsonc) does
and re-export them from your entry module.

`authorize` gates every repository-scoped request and replaces the
stock `GIT_TOKEN` policy entirely (the private flag is yours to
consult); `onPush` fires with the ref updates a push applied. Every
repository also serves a JSON content API, gated like its pages, and
the same surface as typed RPC on the cell. `ui: false` runs it headless
behind your own frontend, `cors` opens the API cross-origin, and
`namespaces: true` routes GitHub-style `owner/name` repositories. See
docs at [docs/api.md](docs/api.md).

## Operate

```sh
curl -X PUT  -u x:$GIT_TOKEN -d '{"description":"...","section":"tools","private":false}' \
  https://<host>/myrepo/config                       # describe and place a repository
curl -X POST -u x:$GIT_TOKEN https://<host>/myrepo/gc    # prune unreachable objects
curl -X DELETE -u x:$GIT_TOKEN https://<host>/myrepo     # delete a repository
```

Garbage collection also runs by itself, from a Durable Object alarm,
after a forced update or a ref deletion. `GIT_TOKENS` holds additional
comma-separated tokens; `MAX_PUSH_MB` caps a single push. Setting
`SHA1DC=1` screens every pushed object for a SHA-1 collision attack on
ingest; by default objects are hashed with native SHA-1 — the same
object ids, without the check.

## Contributions

Pull requests are disabled. Send a `git format-patch` attachment to [me@littledivy.com](mailto:me@littledivy.com).
