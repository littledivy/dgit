import { concat, isOid, ZERO_OID, te } from "./util";
import { pkt, FLUSH, PktParser } from "./pktline";
import { GitStore } from "./store";
import { PackWriter } from "./pack";
import { OidSet } from "./oidset";
import { MultipartCapture, MultipartPackUpload } from "./multipart";
import { parseCommit, parseTag, parseTree, isGitlinkMode, isTreeMode, TYPE_NUM, NUM_TYPE, ObjType } from "./objects";

const AGENT = "agent=dgit/0.3";
const INFINITE_DEPTH = 0x7fffffff;
const SIDEBAND_CHUNK = 32 * 1024;
const WALK_YIELD = 5000;
/**
 * Committer-date skew tolerated before the uninteresting (have) commit walk
 * stops descending. Cutting the walk short can only ever shrink the "client
 * already has it" set, i.e. send a few redundant objects — never omit one —
 * so a day of slack is a safe way to keep an incremental fetch off the full
 * commit graph.
 */
const WALK_DATE_SLOP = 24 * 60 * 60;

export type Service = "git-upload-pack" | "git-receive-pack";

/**
 * Optional R2-backed full-clone offload, write side only: on a full-clone MISS
 * the DO tees the generated pack into a multipart upload so it never buffers the
 * whole pack in isolate memory (no size cap). Absent on celld and on Workers
 * without the binding, in which case every clone is served from the DO exactly
 * as before. HITs are served by the Worker streaming R2 directly, not the DO.
 */
export interface PackCache {
  repo: string;
  /** Begin a multipart pack build under `key`, stamping the object count as
   * customMetadata; null when R2 is unavailable (the clone still streams). */
  beginMultipart(key: string, objects: number): Promise<MultipartPackUpload | null>;
}

/** GET /info/refs?service=... — smart ref advertisement. */
export function advertisement(store: GitStore, service: Service, v2 = false): Uint8Array {
  if (v2 && service === "git-upload-pack") {
    return concat([pkt("version 2\n"), pkt(`${AGENT}\n`), pkt("ls-refs\n"), pkt("fetch=shallow\n"), FLUSH]);
  }
  const caps =
    service === "git-upload-pack"
      ? [
          "multi_ack_detailed",
          "no-done",
          "shallow",
          "side-band-64k",
          `symref=HEAD:${store.head()}`,
          AGENT,
        ].join(" ")
      : ["report-status", "delete-refs", "ofs-delta", "side-band-64k", AGENT].join(" ");

  const lines: Uint8Array[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs: { name: string; target: string }[] = [];
  if (service === "git-upload-pack") {
    const head = store.resolveHead();
    if (head) refs.push({ name: "HEAD", target: head });
  }
  refs.push(...store.refs());

  if (refs.length === 0) {
    lines.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      lines.push(pkt(i === 0 ? `${r.target} ${r.name}\0${caps}\n` : `${r.target} ${r.name}\n`));
    });
  }
  lines.push(FLUSH);
  return concat(lines);
}

/**
 * The oids a fetch is allowed to `want`: exactly what the advertisement above
 * exposes — HEAD, every current ref tip, and the peeled commit target of each
 * annotated tag (git advertises those as `<tag>^{}`).
 *
 * This is git's default (`uploadpack.allowAnySHA1InWant=false`): serving any
 * oid the database merely *has* leaks objects that are no longer reachable
 * from any ref — a commit orphaned by a force-push stays readable to anyone
 * who learned its sha. Membership in a set of ref tips, so a normal fetch
 * (which only ever wants advertised tips) pays a few hash lookups, not a walk.
 */
export async function advertisedOids(store: GitStore): Promise<Set<string>> {
  const oids = new Set<string>();
  const head = store.resolveHead();
  if (head) oids.add(head);
  for (const r of store.refs()) {
    oids.add(r.target);
    // peel annotated tags; lightweight tags already point at the commit
    if (!r.name.startsWith("refs/tags/")) continue;
    if (store.typeAndSize(r.target)?.type !== "tag") continue;
    const peeled = await peelToCommitOid(store, r.target);
    if (peeled) oids.add(peeled);
  }
  return oids;
}

/**
 * True when `wants` is exactly the set of current ref tips — a true full clone,
 * not a single-branch or partial fetch. Only then does the whole-repo reachable
 * cache describe precisely what the client asked for; a subset of the tips would
 * pull unrelated branches' objects in and leave the client with danglers.
 */
export function wantsAreAllTips(store: GitStore, wants: string[]): boolean {
  const tips = new Set<string>();
  for (const r of store.refs()) tips.add(r.target);
  if (tips.size === 0) return false;
  const wantSet = new Set(wants);
  if (wantSet.size !== tips.size) return false;
  for (const t of tips) if (!wantSet.has(t)) return false;
  return true;
}

export function sidebandFrames(band: number, payload: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let off = 0; off < payload.length; off += SIDEBAND_CHUNK) {
    const chunk = payload.subarray(off, off + SIDEBAND_CHUNK);
    const framed = new Uint8Array(chunk.length + 1);
    framed[0] = band;
    framed.set(chunk, 1);
    frames.push(pkt(framed));
  }
  return frames;
}

/**
 * Serve a full clone by streaming the R2-cached raw pack straight from the
 * Worker: the protocol's pack preamble, the
 * optional band-2 progress line, then the pack re-chunked into band-1 side-band
 * frames as R2 hands it over, then flush. Framing is identical to the DO path
 * and the pack bytes are the stored bytes, so the client receives a
 * byte-for-byte-equal pack. Memory is one R2 read chunk at a time — never
 * proportional to pack size — and the DO is never contacted for bytes.
 */
export function streamingCloneResponse(
  body: ReadableStream<Uint8Array>,
  objects: number,
  noProgress: boolean, v2 = false
): Response {
  const headers = {
    "content-type": "application/x-git-upload-pack-result",
    "cache-control": "no-cache",
    "x-pack-cache": "hit",
  };
  const reader = body.getReader();
  let started = false;
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    pull: async (ctrl) => {
      try {
        if (!started) {
          started = true;
          ctrl.enqueue(pkt(v2 ? "packfile\n" : "NAK\n"));
          if (!noProgress) {
            for (const f of sidebandFrames(2, te.encode(`Enumerating objects: ${objects}, done.\n`))) ctrl.enqueue(f);
          }
        }
        const { done: rdone, value } = await reader.read();
        if (rdone) {
          if (!done) {
            done = true;
            ctrl.enqueue(FLUSH);
            ctrl.close();
          }
          return;
        }
        for (const f of sidebandFrames(1, value)) ctrl.enqueue(f);
      } catch (err) {
        ctrl.error(err);
      }
    },
    cancel: () => reader.cancel(),
  });
  return new Response(stream, { headers });
}

interface UploadRequest {
  command: "fetch" | "ls-refs" | null;
  wants: string[];
  haves: string[];
  done: boolean;
  clientShallows: string[];
  deepen: number; // 0 = no depth limit requested
  caps: Set<string>;
}

export function parseUploadRequest(body: Uint8Array): UploadRequest {
  const parser = new PktParser(body);
  const req: UploadRequest = {
    command: null,
    wants: [],
    haves: [],
    done: false,
    clientShallows: [],
    deepen: 0,
    caps: new Set(),
  };
  for (let p = parser.read(); p !== null; p = parser.read()) {
    if (p.kind !== "line") continue;
    const line = p.text;
    if (line === "command=fetch" || line === "command=ls-refs") {
      req.command = line === "command=fetch" ? "fetch" : "ls-refs";
    } else if (line === "no-progress" || line === "symrefs" || line === "peel") {
      req.caps.add(line);
    } else if (line.startsWith("want ")) {
      req.wants.push(line.slice(5, 45));
      // capabilities ride on the first want line
      for (const cap of line.slice(45).trim().split(" ")) if (cap) req.caps.add(cap);
    } else if (line.startsWith("have ")) {
      req.haves.push(line.slice(5, 45));
    } else if (line.startsWith("shallow ")) {
      req.clientShallows.push(line.slice(8, 48));
    } else if (line.startsWith("deepen ")) {
      req.deepen = parseInt(line.slice(7), 10) || 0;
    } else if (line === "done") {
      req.done = true;
    }
  }
  return req;
}

async function lsRefs(store: GitStore, req: UploadRequest): Promise<Uint8Array> {
  const lines: Uint8Array[] = [];
  const head = store.resolveHead();
  if (head) lines.push(pkt(`${head} HEAD${req.caps.has("symrefs") ? ` symref-target:${store.head()}` : ""}\n`));
  for (const ref of store.refs()) {
    let peeled = "";
    if (req.caps.has("peel") && ref.name.startsWith("refs/tags/") && store.typeAndSize(ref.target)?.type === "tag") {
      const oid = await peelToCommitOid(store, ref.target);
      if (oid) peeled = ` peeled:${oid}`;
    }
    lines.push(pkt(`${ref.target} ${ref.name}${peeled}\n`));
  }
  return concat([...lines, FLUSH]);
}

/** Follow tag objects down to the underlying commit oid (or null). */
async function peelToCommitOid(store: GitStore, oid: string): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    const obj = await store.get(oid);
    if (!obj) return null;
    if (obj.type === "commit") return oid;
    if (obj.type === "tag") {
      oid = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Newest committer time (ms) across every current ref tip and HEAD: each tip is
 * peeled through annotated tags to its commit and its committer time taken;
 * non-commit tips are ignored, parse errors skipped. Falls back to Date.now()
 * when the repo holds no commits. Committer time is unix seconds, so ×1000.
 */
export async function latestCommitTime(store: GitStore): Promise<number> {
  const tips = new Set<string>();
  const head = store.resolveHead();
  if (head) tips.add(head);
  for (const r of store.refs()) tips.add(r.target);
  let max = 0;
  for (const tip of tips) {
    try {
      const oid = await peelToCommitOid(store, tip);
      if (!oid) continue;
      const obj = await store.get(oid);
      if (obj?.type !== "commit") continue;
      const t = parseCommit(obj.data).committer.time;
      if (t > max) max = t;
    } catch {
      // broken/unparseable tip: skip it, never fail the push/config
    }
  }
  return max > 0 ? max * 1000 : Date.now();
}

/**
 * Depth-limited commit set from the wants (BFS, min depth wins; the tip is
 * depth 1, like git). Boundary commits are included but their parents cut.
 */
async function computeDepthSet(
  store: GitStore,
  wants: string[],
  depth: number
): Promise<{ commits: Set<string>; boundary: Set<string> }> {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const queue: { oid: string; depth: number }[] = [];
  for (const w of wants) {
    const c = await peelToCommitOid(store, w);
    if (c && !commits.has(c)) {
      commits.add(c);
      queue.push({ oid: c, depth: 1 });
    }
  }
  while (queue.length) {
    const { oid, depth: d } = queue.shift()!;
    const obj = await store.get(oid);
    if (obj?.type !== "commit") continue;
    const parents = parseCommit(obj.data).parents;
    if (d >= depth) {
      // every commit reached at the depth limit is a graft point, root commits
      // included — git's get_shallow_commits() marks them unconditionally, and
      // the client compares the advertised list against its own .git/shallow
      boundary.add(oid);
      continue;
    }
    boundary.delete(oid); // reachable within depth via this (shorter) path
    for (const p of parents) {
      if (!commits.has(p) && store.has(p)) {
        commits.add(p);
        queue.push({ oid: p, depth: d + 1 });
      }
    }
  }
  return { commits, boundary };
}

/**
 * Commits reachable from the wants without passing through one of the
 * client's haves — the "interesting" side of the walk — plus the oldest
 * committer date among them. Commit objects only; no trees are touched.
 *
 * The date is what bounds the uninteresting side: nothing older than the
 * oldest thing the client is asking for can be needed as a boundary, so the
 * have walk may stop there instead of marching down the whole commit graph.
 */
async function interestingCommits(
  store: GitStore,
  wants: string[],
  haveCommits: Set<string>,
  yieldMaybe: () => Promise<void>
): Promise<{ set: OidSet; minTime: number }> {
  const set = new OidSet(4096);
  const stack: string[] = [];
  for (const w of wants) {
    const c = await peelToCommitOid(store, w);
    if (c && !haveCommits.has(c) && set.addHex(c)) stack.push(c);
  }
  let minTime = Infinity;
  while (stack.length) {
    const oid = stack.pop()!;
    const obj = await store.get(oid);
    if (obj?.type !== "commit") continue;
    await yieldMaybe();
    const c = parseCommit(obj.data);
    if (c.committer.time < minTime) minTime = c.committer.time;
    for (const p of c.parents) {
      if (haveCommits.has(p)) continue; // the client's side of the boundary
      if (store.has(p) && set.addHex(p)) stack.push(p);
    }
  }
  return { set, minTime };
}

/**
 * Objects the client demonstrably already has, marked the way git marks
 * UNINTERESTING: commits reachable from the haves (cut at the client's
 * shallow boundaries), plus the *tree closure of the boundary commits only*
 * — the client's own tips and the uninteresting parents of the commits it is
 * asking for. Boundary tree descent halts the moment it reaches an object
 * already known present, so shared subtrees are walked once, and history the
 * fetch never touches is never inflated at all.
 *
 * The set is deliberately allowed to be an under-approximation: leaving an
 * object out only means re-sending something the client had (a bigger pack),
 * while putting one in wrongly would produce a broken pack. Every bound here
 * therefore errs towards sending.
 */
async function excludedObjects(
  store: GitStore,
  haves: string[],
  clientShallows: string[],
  wants: string[]
): Promise<OidSet> {
  const excluded = new OidSet(Math.max(haves.length * 64, 4096));
  if (!haves.length) return excluded; // full clone: nothing is excluded

  let ops = 0;
  const yieldMaybe = async () => {
    if (++ops % WALK_YIELD === 0) await new Promise((r) => setTimeout(r, 0));
  };

  // the client's tips, peeled through any annotated tags
  const haveCommits = new Set<string>();
  for (const h of haves) {
    if (!store.has(h)) continue;
    const c = await peelToCommitOid(store, h);
    if (c) haveCommits.add(c);
  }

  const { set: interesting, minTime } = await interestingCommits(store, wants, haveCommits, yieldMaybe);
  // minTime stays Infinity when the client wants nothing new: then no ancestor
  // of a have can be a boundary and the walk stops at the haves themselves.
  const cutoff = minTime === Infinity ? Infinity : minTime - WALK_DATE_SLOP;

  // uninteresting commit walk — commits and tags only, no trees
  const shallowStops = new Set(clientShallows);
  const commitStack: string[] = [];
  for (const h of haves) {
    if (store.has(h) && excluded.addHex(h)) commitStack.push(h);
  }
  while (commitStack.length) {
    const oid = commitStack.pop()!;
    const obj = await store.get(oid);
    if (!obj) continue;
    await yieldMaybe();
    if (obj.type === "tag") {
      const t = parseTag(obj.data).object;
      if (t && store.has(t) && excluded.addHex(t)) commitStack.push(t);
      continue;
    }
    if (obj.type !== "commit") continue;
    const c = parseCommit(obj.data);
    if (shallowStops.has(oid)) continue; // client's history stops here
    if (c.committer.time < cutoff) continue; // older than anything wanted
    for (const p of c.parents) {
      if (store.has(p) && excluded.addHex(p)) commitStack.push(p);
    }
  }

  // boundary commits whose trees are worth marking: the client's own tips
  // (it has those trees in full) and the uninteresting parents of interesting
  // commits (git's mark_edges_uninteresting).
  const boundary: string[] = [];
  for (const c of haveCommits) boundary.push(c);
  for (let i = 0; i < interesting.size; i++) {
    const oid = interesting.atHex(i);
    if (excluded.hasHex(oid)) continue; // contested: reachable from a have too
    const obj = await store.get(oid);
    if (obj?.type !== "commit") continue;
    await yieldMaybe();
    for (const p of parseCommit(obj.data).parents) {
      if (excluded.hasHex(p)) boundary.push(p);
    }
  }

  const trees: string[] = [];
  for (const oid of boundary) {
    const obj = await store.get(oid);
    if (obj?.type !== "commit") continue;
    const tree = parseCommit(obj.data).tree;
    if (tree && excluded.addHex(tree)) trees.push(tree);
  }
  while (trees.length) {
    const oid = trees.pop()!;
    const obj = await store.get(oid);
    if (obj?.type !== "tree") continue;
    await yieldMaybe();
    for (const e of parseTree(obj.data)) {
      if (isGitlinkMode(e.mode)) continue;
      // already present => the whole subtree below it is too; stop descending
      if (excluded.addHex(e.oid) && isTreeMode(e.mode)) trees.push(e.oid);
    }
  }
  return excluded;
}

/**
 * Objects to pack: closure of wants, minus excluded, cut at commitLimit.
 * Returned as one OidSet whose tagged sub-set is the pack contents — the
 * untagged remainder is the walk's visited bookkeeping, which is a strict
 * superset, so one set carries both roles at half the per-object cost.
 *
 * `descendThroughExcluded` is set only when the client is deepening: with a
 * shallow client, commits BELOW its boundary are not excluded and must be
 * reachable even when the walk enters via commits it already has (deepen and
 * unshallow fetches). On an ordinary fetch the walk must stop dead at an
 * excluded commit — descending anyway re-sends the history the client
 * deliberately does not have, and strands it below its own shallow graft.
 * Blobs are added by type lookup alone — never inflated during the walk.
 */
async function collectPackOids(
  store: GitStore,
  wants: string[],
  excluded: OidSet,
  commitLimit: Set<string> | null,
  descendThroughExcluded: boolean,
  expected: number
): Promise<OidSet> {
  // The frontier is the visited set itself, walked in insertion order by a
  // cursor: a child is appended with addHex (deduped in place) and reached
  // when the cursor gets to it, so there is no separate stack of hex oids to
  // hold alongside the OidSet. The result set is decided by membership, so
  // this BFS and the old DFS produce the identical walk and marked sub-set.
  const walk = new OidSet(expected);
  for (const w of wants) walk.addHex(w);
  let ops = 0;
  for (let i = 0; i < walk.size; i++) {
    const oid = walk.atHex(i);
    if (++ops % WALK_YIELD === 0) await new Promise((r) => setTimeout(r, 0));
    const meta = store.typeAndSize(oid);
    if (!meta) throw new Error(`missing object ${oid}`);
    if (meta.type === "commit" && commitLimit && !commitLimit.has(oid)) continue;
    if (excluded.hasHex(oid)) {
      if (descendThroughExcluded && meta.type === "commit") {
        const full = (await store.get(oid))!;
        for (const p of parseCommit(full.data).parents) walk.addHex(p);
      }
      continue;
    }
    walk.markHex(oid);
    if (meta.type === "blob") continue; // leaf: membership only
    for (const child of childOids((await store.get(oid))!)) walk.addHex(child);
  }
  return walk;
}

/**
 * POST /git-upload-pack — stateless protocol v0 with single-ack negotiation,
 * shallow (--depth) support, side-band-64k, and a streamed pack response.
 * Stored pack entries are copied verbatim (deltas preserved) whenever their
 * base ships in the same pack; everything else is inflated and re-deflated.
 */
export async function uploadPack(
  store: GitStore,
  body: Uint8Array,
  release: () => void = () => {},
  packCache?: PackCache
): Promise<Response> {
  const headers = {
    "content-type": "application/x-git-upload-pack-result",
    "cache-control": "no-cache",
  };
  const req = parseUploadRequest(body);
  if (req.command === "ls-refs") {
    release();
    return new Response(await lsRefs(store, req) as unknown as BodyInit, { headers });
  }
  const v2 = req.command === "fetch";
  if (!req.wants.length || req.wants.some((w) => !isOid(w))) {
    release();
    return new Response(pkt("ERR no valid wants\n") as unknown as BodyInit, { headers });
  }
  // a want must be an object we currently advertise, not merely one we store
  const allowed = await advertisedOids(store);
  for (const w of req.wants) {
    if (!allowed.has(w) || !store.has(w)) {
      release();
      return new Response(pkt(`ERR upload-pack: not our ref ${w}\n`) as unknown as BodyInit, { headers });
    }
  }

  const preamble: Uint8Array[] = [];

  // shallow section (only when the client asked to deepen)
  let commitLimit: Set<string> | null = null;
  if (req.deepen > 0) {
    if (v2) preamble.push(pkt("shallow-info\n"));
    const clientShallowSet = new Set(req.clientShallows);
    if (req.deepen >= INFINITE_DEPTH) {
      // --unshallow: full history, everything the client thought was shallow opens up
      for (const s of req.clientShallows) {
        if (store.has(s)) preamble.push(pkt(`unshallow ${s}\n`));
      }
    } else {
      const { commits, boundary } = await computeDepthSet(store, req.wants, req.deepen);
      commitLimit = commits;
      for (const b of boundary) {
        if (!clientShallowSet.has(b)) preamble.push(pkt(`shallow ${b}\n`));
      }
      for (const s of req.clientShallows) {
        if (commits.has(s) && !boundary.has(s)) preamble.push(pkt(`unshallow ${s}\n`));
      }
    }
    preamble.push(v2 ? te.encode("0001") : FLUSH);
  }
  if (v2 && !req.done) preamble.length = 0;

  // Negotiation. A round with neither haves nor done (shallow discovery) gets
  // no ack line at all — a stray NAK would desync the client's stateless
  // response stream.
  //
  // Single-ack cannot carry a stateless fetch on its own: `ACK <oid>` means
  // "negotiation over, pack follows", so a client that receives one mid-round
  // stops negotiating and reads the response as a pack — but git only batches
  // 16 haves per round, and the follow-up request it sends carries no haves at
  // all. The pack therefore has to be produced by the same request that
  // carried the haves, which is exactly what multi_ack_detailed's `ready` plus
  // `no-done` is for. This mirrors upload-pack's wire shape line for line;
  // clients that negotiate neither capability keep the single-ack path.
  const common = req.haves.filter((h) => isOid(h) && store.has(h));
  const lastCommon = common.length ? common[common.length - 1] : null;
  let sendPack = req.done;
  if (v2) {
    if (req.done) preamble.push(pkt("packfile\n"));
    else {
      const acknowledgments = common.length ? common.map((oid) => pkt(`ACK ${oid}\n`)) : [pkt("NAK\n")];
      preamble.push(pkt("acknowledgments\n"), ...acknowledgments, FLUSH);
    }
  } else if (!req.caps.has("multi_ack_detailed")) {
    if (req.done || req.haves.length) {
      preamble.push(pkt(common.length ? `ACK ${common[0]}\n` : "NAK\n"));
    }
  } else if (req.done) {
    for (const c of common) preamble.push(pkt(`ACK ${c} common\n`));
    preamble.push(pkt(lastCommon ? `ACK ${lastCommon}\n` : "NAK\n"));
  } else if (req.haves.length) {
    for (const c of common) preamble.push(pkt(`ACK ${c} common\n`));
    if (lastCommon && req.caps.has("no-done")) {
      // enough common ground to build the pack, and the client agreed it can
      // be answered without a `done` round trip: reply with it right here,
      // while the haves are still in hand
      preamble.push(pkt(`ACK ${lastCommon} ready\n`));
      preamble.push(pkt("NAK\n"));
      preamble.push(pkt(`ACK ${lastCommon}\n`));
      sendPack = true;
    } else {
      preamble.push(pkt("NAK\n")); // keep negotiating
    }
  }

  if (!sendPack) {
    // negotiation round only — client will POST again
    release();
    return new Response(concat(preamble) as unknown as BodyInit, { headers });
  }

  const sideband = v2 || req.caps.has("side-band-64k");
  const noProgress = req.caps.has("no-progress");

  // Full-clone fast path: no haves, not shallow/deepen, and the wants are
  // exactly the current ref tips. The reachable object set is then identical to
  // what the graph walk would rediscover, so serve it from the versioned cache
  // and skip the walk (and every commit/tree inflation it drives) entirely. A
  // missing or stale cache (version mismatch, or any failure) falls straight
  // through to the walk, which then repopulates it — so a wrong pack is never
  // served, and existing repos become fast on their next full clone.
  const fullClone = !req.haves.length && req.deepen === 0 && wantsAreAllTips(store, req.wants);

  // R2 full-clone offload (write side). Only a standard side-band-64k full clone
  // is eligible, and it is reached only after the advertised-oids gate above — so
  // the versioned key can never warm an unreachable/force-pushed object. The key
  // is the ref version, so a push/force-push/delete lands on a fresh key and
  // stale packs are simply never referenced. HITs are served by the Worker
  // streaming R2 directly; the DO only reaches here on a MISS, where it serves
  // the client and self-warms the cache via multipart while it streams (see
  // `capture` below). Absent R2 (celld / no binding) this is a plain DO clone.
  const r2Key =
    fullClone && sideband && packCache ? `pack/${packCache.repo}/${store.reachableVersion()}` : null;

  // Warm full-clone fast path: the reachable set is persisted and current, so
  // stream the pack straight out of storage in (pack_id, offset) order without
  // ever loading the object set into the isolate. This is the O(1)-memory clone
  // — no OidSet, no parallel typed arrays — bounded by one keyset page instead
  // of the object count. A cold or stale cache falls through to the walk below,
  // which rebuilds and persists the set (one in-RAM walk, then warm forever).
  if (fullClone && store.reachableCacheValid()) {
    return warmFullClone(store, {
      preamble,
      sideband,
      noProgress,
      r2Key,
      packCache,
      release,
      headers,
    });
  }

  let send = fullClone ? store.loadReachable() : null;
  if (!send) {
    const excluded = await excludedObjects(store, req.haves, req.clientShallows, req.wants);
    // a plain clone enumerates the whole database: size the walk's set up front
    // so it never doubles (a doubling keeps the old and new arrays live at once)
    const expected =
      !req.haves.length && !commitLimit && !req.deepen ? Math.max(store.objectCount(), 4096) : 4096;
    send = await collectPackOids(
      store,
      req.wants,
      excluded,
      commitLimit,
      req.deepen > 0, // descendThroughExcluded: only while deepening/unshallowing
      expected
    );
    if (fullClone) {
      try {
        await store.saveReachable(send);
      } catch {
        // the cache is best-effort: a failed persist just means the next full
        // clone walks again, never a wrong pack
      }
    }
  }
  // Emit objects in pack storage order — (packId, offset) — rather than the
  // DFS walk order they were collected in. Reused entries are copied straight
  // out of stored packs via readRaw, and the raw-chunk LRU only pays off when
  // consecutive reads stay inside the same 1MB pack chunk; walk order jumps
  // all over the pack, so it rarely does. Marching sequentially through each
  // pack lifts that hit rate to ~100% and cuts per-object decode cost.
  //
  // Order-safe: the SET of emitted entries and every entry's bytes are decided
  // by set membership alone (isMarkedHex on the delta base), never by position,
  // so only the ordering changes. Delta entries are re-addressed as REF-deltas
  // (see PackWriter.rawDelta) and git's index-pack resolves ref-deltas in any
  // order via a second pass; no ofs-deltas are ever emitted. Loose objects
  // (no pack entry) sort last, ordered by oid, for a stable total order.
  //
  // Only worth it once the packs outgrow the raw-chunk LRU: below that every
  // chunk stays cached regardless of order, so the sort would be pure overhead.
  // The arrays stay null then and emission falls back to walk order with a
  // per-object lookup, exactly as before.
  //
  // The lookups done to build the sort key are *retained* — in LEAN parallel
  // typed arrays, not an array of PackedEntry objects — and reused by the
  // stream, so sorting adds an in-memory sort but not a second round of SQL
  // lookups. Storing the reused fields as five typed arrays (~28 B/obj) rather
  // than live objects (~204 B/obj) is what keeps a one-shot full clone inside
  // the 128MB isolate at multi-million-object scale.
  //
  //   ePack     Int32     pack id (1-based), or LOOSE_PACK for objects with no
  //             pack entry (loose / unindexed) — those sort last, by oid.
  //   eDataOff  Float64   start of the stored (compressed) region. Offsets on a
  //             pack past 4GB exceed 2^32, so this must NOT be a Uint32. The
  //             (packId, dataOff) pair is also the sort key: dataOff rises
  //             monotonically with entry offset within a pack, so ordering by
  //             it reproduces pack storage order exactly.
  //   eDataLen  Uint32    length of that region (a single entry never reaches
  //             the 4GB a Uint32 caps, and readRaw could not allocate one).
  //   eSize     Float64   uncompressed entry size for the pack object header.
  //             A blob copied verbatim on a big-heap celld node can exceed 4GB
  //             uncompressed, so this is not a Uint32 either.
  //   eCode     Int32     how to emit the object, folding type and delta base
  //             into one slot (they are mutually exclusive per entry):
  //               >= 0  ref-delta whose base ships in this pack; the value is
  //                     the base's insertion index in `send` (base oid =
  //                     send.atHex(code)).
  //               <= -3 full entry copied verbatim; NUM_TYPE[-2 - code] is its
  //                     type (commit=-3, tree=-4, blob=-5, tag=-6).
  //               -1    inflate via store.get: a loose object, or a delta whose
  //                     base is not being sent (so it cannot be a ref-delta).
  const total = send.markedSize;
  let order: Int32Array | null = null;
  let ePack: Int32Array | null = null;
  let eDataOff: Float64Array | null = null;
  let eDataLen: Uint32Array | null = null;
  let eSize: Float64Array | null = null;
  let eCode: Int32Array | null = null;
  const LOOSE_PACK = 0x7fffffff; // sorts after every real (1-based) pack id
  if (store.packs.totalPackBytes() > store.packs.rawCacheWindow()) {
    ePack = new Int32Array(total);
    eDataOff = new Float64Array(total);
    eDataLen = new Uint32Array(total);
    eSize = new Float64Array(total);
    eCode = new Int32Array(total);
    for (let i = 0; i < total; i++) {
      const entry = store.packs.lookup(send.markedAtHex(i));
      if (!entry) {
        ePack[i] = LOOSE_PACK;
        eCode[i] = -1;
      } else {
        ePack[i] = entry.packId;
        eDataOff[i] = entry.dataOff;
        eDataLen[i] = entry.dataLen;
        eSize[i] = entry.entrySize;
        if (entry.baseOid) {
          // ref-delta only when the base also ships here; else inflate it
          eCode[i] = send.isMarkedHex(entry.baseOid) ? send.indexOfHex(entry.baseOid) : -1;
        } else {
          eCode[i] = -2 - TYPE_NUM[entry.type];
        }
      }
      if ((i & 8191) === 8191) await new Promise((r) => setTimeout(r, 0));
    }
    order = new Int32Array(total);
    for (let i = 0; i < total; i++) order[i] = i;
    order.sort((a, b) => {
      if (ePack![a] !== ePack![b]) return ePack![a] - ePack![b];
      if (ePack![a] === LOOSE_PACK) {
        const oa = send.markedAtHex(a);
        const ob = send.markedAtHex(b);
        return oa < ob ? -1 : oa > ob ? 1 : 0;
      }
      return eDataOff![a] - eDataOff![b];
    });
  }

  // stream the pack: preamble, then pack bytes (side-band framed if negotiated)
  const pending: Uint8Array[] = [concat(preamble)];
  let buffered: Uint8Array[] = [];
  let bufferedLen = 0;
  const flushBuffered = () => {
    if (!bufferedLen) return;
    const payload = concat(buffered);
    buffered = [];
    bufferedLen = 0;
    if (sideband) pending.push(...sidebandFrames(1, payload));
    else pending.push(payload);
  };
  // Self-warm R2 on a full-clone MISS: tee the raw pack (writer output, verbatim
  // — same bytes a later HIT re-frames) into a multipart upload alongside the
  // live stream. The pack streams into R2 in 16 MiB parts as it is generated, so
  // isolate memory is never proportional to pack size and there is no size cap.
  // A failed begin just streams the clone without caching.
  let capture: MultipartCapture | null = null;
  if (r2Key && packCache) {
    const mp = await packCache.beginMultipart(r2Key, total);
    if (mp) capture = new MultipartCapture(mp);
  }
  const writer = new PackWriter((chunk) => {
    if (capture) capture.push(chunk);
    buffered.push(chunk);
    bufferedLen += chunk.length;
    if (bufferedLen >= SIDEBAND_CHUNK) flushBuffered();
  });

  let i = 0;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    start: (ctrl) => {
      if (sideband && !noProgress) {
        pending.push(...sidebandFrames(2, te.encode(`Enumerating objects: ${total}, done.\n`)));
      }
      writer.header(total);
      for (const c of pending) ctrl.enqueue(c);
      pending.length = 0;
    },
    pull: async (ctrl) => {
      try {
        for (let n = 0; n < 64 && i < total; n++, i++) {
          const idx = order ? order[i] : i;
          if (!eCode) {
            // unsorted (small-pack) path: no sort pass ran, so do a fresh
            // per-object lookup in walk order, exactly as before OPT 2.
            const oid = send.markedAtHex(idx);
            const entry = store.packs.lookup(oid);
            if (entry && !entry.baseOid) {
              writer.rawFull(entry.type, entry.entrySize, await store.packs.readRaw(entry.packId, entry.dataOff, entry.dataLen));
            } else if (entry && entry.baseOid && send.isMarkedHex(entry.baseOid)) {
              writer.rawDelta(entry.entrySize, entry.baseOid, await store.packs.readRaw(entry.packId, entry.dataOff, entry.dataLen));
            } else {
              const obj = await store.get(oid);
              if (!obj) throw new Error(`missing object ${oid}`);
              writer.object(obj.type, obj.data);
            }
            continue;
          }
          // sorted path: everything needed to emit the object was captured in
          // the lean typed arrays, so no SQL lookup happens here.
          const code = eCode[idx];
          if (code <= -3) {
            writer.rawFull(NUM_TYPE[-2 - code], eSize![idx], await store.packs.readRaw(ePack![idx], eDataOff![idx], eDataLen![idx]));
          } else if (code >= 0) {
            writer.rawDelta(eSize![idx], send.atHex(code), await store.packs.readRaw(ePack![idx], eDataOff![idx], eDataLen![idx]));
          } else {
            const oid = send.markedAtHex(idx);
            const obj = await store.get(oid);
            if (!obj) throw new Error(`missing object ${oid}`);
            writer.object(obj.type, obj.data);
          }
        }
        if (i >= total && !finished) {
          finished = true;
          writer.finish();
          flushBuffered();
          if (sideband) pending.push(FLUSH);
        } else {
          flushBuffered();
        }
        for (const c of pending) ctrl.enqueue(c);
        pending.length = 0;
        // Warm R2 in lock-step with generation: the client already has this
        // batch's bytes, and awaiting the part upload here is what bounds isolate
        // memory to one part regardless of pack size. finish() flushes the final
        // part and completes; a failure aborts, leaving no partial R2 object.
        if (capture) {
          if (finished) await capture.finish();
          else await capture.drain();
        }
        if (finished) {
          ctrl.close();
          release(); // stream fully drained: this upload no longer holds a slot
        }
      } catch (err) {
        if (capture) await capture.abort();
        release();
        ctrl.error(err);
      }
    },
    cancel: async () => {
      // client went away mid-transfer (e.g. negotiation round abort): abort the
      // half-built multipart upload so R2 keeps no partial object
      if (capture) await capture.abort();
      release();
    },
  });
  return new Response(stream, { headers });
}

/**
 * Stream a full clone straight from the persisted reachable set, holding no
 * object set in the isolate. The reachable cache is current (the caller checked
 * `reachableCacheValid`), so the objects to send are exactly its rows: emit the
 * packed ones in (pack_id, offset) storage order a keyset page at a time, then
 * the loose ones by oid. Peak memory is one page plus one object, independent
 * of repo size — the walk path's OidSet and parallel typed arrays are gone.
 *
 * Emission is byte-identical to the walk path: a stored delta ships as a
 * ref-delta when its base is also reachable (so also sent), else it is inflated
 * whole; index-pack resolves ref-deltas by oid in any order. `total` is the
 * reachable count, declared in the header; if the set drifts mid-stream (a push
 * landing during the clone) the count guard aborts rather than ship a pack that
 * disagrees with its header — the client simply retries.
 */
async function warmFullClone(
  store: GitStore,
  opts: {
    preamble: Uint8Array[];
    sideband: boolean;
    noProgress: boolean;
    r2Key: string | null;
    packCache: PackCache | undefined;
    release: () => void;
    headers: Record<string, string>;
  },
): Promise<Response> {
  const { preamble, sideband, noProgress, r2Key, packCache, release, headers } = opts;
  const total = store.reachableCount();
  const PAGE = 1000;

  // One emit-thunk per object, in storage order: every packed reachable object
  // (marching packs sequentially), then every loose reachable object by oid.
  async function* objects(): AsyncGenerator<(w: PackWriter) => Promise<void>> {
    let curPack = 0;
    let curOff = -1;
    for (;;) {
      const rows = store.reachablePackedAfter(curPack, curOff, PAGE);
      for (const e of rows) {
        curPack = e.packId;
        curOff = e.offset;
        if (e.baseOid !== null && store.reachableHas(e.baseOid)) {
          const base = e.baseOid;
          yield async (w) =>
            w.rawDelta(e.entrySize, base, await store.packs.readRaw(e.packId, e.dataOff, e.dataLen));
        } else if (e.baseOid !== null) {
          // base is not itself being sent: it cannot be a ref-delta, inflate it
          yield async (w) => {
            const obj = await store.get(e.oid);
            if (!obj) throw new Error(`missing object ${e.oid}`);
            w.object(obj.type, obj.data);
          };
        } else {
          yield async (w) =>
            w.rawFull(e.type, e.entrySize, await store.packs.readRaw(e.packId, e.dataOff, e.dataLen));
        }
      }
      if (rows.length < PAGE) break;
    }
    let afterOid = "";
    for (;;) {
      const loose = store.reachableLooseAfter(afterOid, PAGE);
      for (const oid of loose) {
        afterOid = oid;
        yield async (w) => {
          const obj = await store.get(oid);
          if (!obj) throw new Error(`missing object ${oid}`);
          w.object(obj.type, obj.data);
        };
      }
      if (loose.length < PAGE) break;
    }
  }
  const it = objects();

  const pending: Uint8Array[] = [concat(preamble)];
  let buffered: Uint8Array[] = [];
  let bufferedLen = 0;
  const flushBuffered = () => {
    if (!bufferedLen) return;
    const payload = concat(buffered);
    buffered = [];
    bufferedLen = 0;
    if (sideband) pending.push(...sidebandFrames(1, payload));
    else pending.push(payload);
  };
  let capture: MultipartCapture | null = null;
  if (r2Key && packCache) {
    const mp = await packCache.beginMultipart(r2Key, total);
    if (mp) capture = new MultipartCapture(mp);
  }
  const writer = new PackWriter((chunk) => {
    if (capture) capture.push(chunk);
    buffered.push(chunk);
    bufferedLen += chunk.length;
    if (bufferedLen >= SIDEBAND_CHUNK) flushBuffered();
  });

  let emitted = 0;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    start: (ctrl) => {
      if (sideband && !noProgress) {
        pending.push(...sidebandFrames(2, te.encode(`Enumerating objects: ${total}, done.\n`)));
      }
      writer.header(total);
      for (const c of pending) ctrl.enqueue(c);
      pending.length = 0;
    },
    pull: async (ctrl) => {
      try {
        let drained = false;
        for (let n = 0; n < 64; n++) {
          const next = await it.next();
          if (next.done) {
            drained = true;
            break;
          }
          await next.value(writer);
          emitted++;
        }
        if (drained && !finished) {
          // A count check, not a full set-consistency check: it catches a push
          // that grew or shrank the reachable set mid-stream (the pack would
          // disagree with its declared header), so the client retries rather
          // than resolve a malformed pack. The cold path snapshots the set into
          // an OidSet and has no such window; this is the warm path's tradeoff.
          if (emitted !== total) {
            throw new Error(`reachable set drifted mid-clone: emitted ${emitted}, declared ${total}`);
          }
          finished = true;
          writer.finish();
          flushBuffered();
          if (sideband) pending.push(FLUSH);
        } else {
          flushBuffered();
        }
        for (const c of pending) ctrl.enqueue(c);
        pending.length = 0;
        if (capture) {
          if (finished) await capture.finish();
          else await capture.drain();
        }
        if (finished) {
          ctrl.close();
          release();
        }
      } catch (err) {
        if (capture) await capture.abort();
        release();
        ctrl.error(err);
      }
    },
    cancel: async () => {
      if (capture) await capture.abort();
      release();
    },
  });
  return new Response(stream, { headers });
}

/** Is `anc` an ancestor of (or equal to) `desc`? Bounded walk. */
export async function isAncestor(store: GitStore, anc: string, desc: string): Promise<boolean> {
  if (anc === desc) return true;
  const seen = new Set<string>([desc]);
  const stack = [desc];
  let visited = 0;
  while (stack.length && visited++ < 10000) {
    const obj = await store.get(stack.pop()!);
    if (obj?.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === anc) return true;
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return false;
}

export interface PushCommand {
  old: string;
  next: string;
  ref: string;
}

export interface CommandResult {
  ref: string;
  ok: boolean;
  msg?: string;
}

/** Parse the command section of a receive-pack request (already buffered). */
export function parsePushCommands(section: Uint8Array): { commands: PushCommand[]; caps: string[] } {
  const parser = new PktParser(section);
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  for (let p = parser.read(); p !== null; p = parser.read()) {
    if (p.kind === "flush") break;
    if (p.kind !== "line") continue;
    let line = p.text;
    const nul = line.indexOf("\0");
    if (nul !== -1) {
      caps = line.slice(nul + 1).trim().split(" ");
      line = line.slice(0, nul);
    }
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
    if (m) commands.push({ old: m[1], next: m[2], ref: m[3] });
  }
  return { commands, caps };
}

/** Characters git's check_ref_format rejects, plus HTML-dangerous ones. */
const BAD_REF = /[\s~^:?*\[\\'"<>&`\x00-\x1f\x7f]/;

/**
 * Every object in the closure of `tip` is present, so setting a ref to it
 * cannot brick the repo. A thin/broken pack that fails to close over its new
 * ref leaves a referenced object absent; walking commit->tree->subtrees+blobs
 * (and tag->target) with a presence probe at each node catches it before the
 * ref moves. `known` is pre-seeded with the pre-existing ref tips, whose
 * closure was validated at their own push, so descent stops there — the walk
 * touches only objects this push introduced.
 */
async function reachableComplete(store: GitStore, tip: string, known: OidSet): Promise<boolean> {
  // Cursor BFS over `known` itself: newly reached oids append past `start`,
  // and pre-existing entries (a fast-forward's already-validated closure) sit
  // before it and are never re-walked. Reusing the set as its own frontier
  // needs no separate hex-oid stack to walk it.
  const start = known.size;
  if (!known.addHex(tip)) return true; // tip already in a validated closure
  for (let i = start; i < known.size; i++) {
    const oid = known.atHex(i);
    const meta = store.typeAndSize(oid);
    if (!meta) return false;
    if (meta.type === "blob") continue;
    const obj = await store.get(oid);
    if (!obj) return false;
    for (const child of childOids(obj)) known.addHex(child);
  }
  return true;
}

/** Per-command outcome decided by the object-reading validation pass. */
interface PushDecision {
  ref: string;
  expectedOld: string; // CAS value re-checked atomically at commit
  reject?: string; // ng message; the command does not apply
  del?: boolean; // delete the ref
  set?: string; // move the ref to this oid
  forced?: boolean; // a set that strands old history (non-fast-forward)
}

/** Result of the async push validation, consumed by the sync commit under a savepoint. */
export interface PushPlan {
  decisions: PushDecision[];
  known: OidSet;
  hadCache: boolean;
}

/**
 * Validate push commands against the (already ingested) object database. This
 * is the object-reading half — connectivity + ancestry walks — and is async
 * because an R2-backed pack's bytes are fetched over the network. It performs no
 * writes; the ref mutations happen in commitPush under a savepoint. Splitting
 * the read pass out is what lets the writes stay inside transactionSync (which
 * cannot await) while still reading R2-backed objects. Pushes are serialized
 * (receiveChain) and only pushes write refs, so ref state read here is stable
 * through to commit; commitPush re-checks each CAS atomically regardless.
 */
/** The child oids a non-blob object references (blobs are leaves). */
function childOids(obj: { type: ObjType; data: Uint8Array }): string[] {
  if (obj.type === "commit") {
    const c = parseCommit(obj.data);
    return [c.tree, ...c.parents];
  }
  if (obj.type === "tag") {
    const t = parseTag(obj.data);
    return t.object ? [t.object] : [];
  }
  if (obj.type === "tree") {
    const out: string[] = [];
    for (const e of parseTree(obj.data)) if (!isGitlinkMode(e.mode)) out.push(e.oid);
    return out;
  }
  return [];
}

/**
 * Verify a freshly ingested pack is connectivity-complete — every child oid its
 * objects reference is present in `pack_objects` ∪ `objects` — and return the
 * first missing child, or null when complete. This is the storage-backed
 * counterpart to walking the graph: it scans the pack's non-blob objects one
 * keyset page at a time, stages their referenced children into `push_edges` in
 * bounded batches, and lets SQLite anti-join each batch against the stores. A
 * complete pack means every tip in it has a complete closure (by induction over
 * the edges), so the whole push is connected — checked in flat memory, with no
 * OidSet that scales with the object count. Used for a fresh push, where the
 * old walk built a reachable set the commit step then discarded anyway.
 */
async function packComplete(store: GitStore, packId: number): Promise<string | null> {
  const PAGE = 1000;
  const EDGE_BATCH = 8192;
  store.resetPushEdges();
  let after = "";
  let pending: string[] = [];
  const flush = (): string | null => {
    if (!pending.length) return null;
    store.addPushEdges(pending);
    pending = [];
    const miss = store.firstMissingPushEdge();
    store.resetPushEdges();
    return miss;
  };
  for (;;) {
    const page = store.packNonBlobOidsAfter(packId, after, PAGE);
    if (!page.length) break;
    for (const oid of page) {
      const obj = await store.get(oid);
      if (!obj) return oid; // indexed but unreadable — the pack is not complete
      for (const child of childOids(obj)) pending.push(child);
      if (pending.length >= EDGE_BATCH) {
        const miss = flush();
        if (miss) return miss;
      }
    }
    after = page[page.length - 1];
  }
  return flush();
}

export async function validatePush(
  store: GitStore,
  commands: PushCommand[],
  unpackError: string | null,
  packId: number | null
): Promise<PushPlan> {
  // whether the reachable cache is valid for the pre-push refs: only then can
  // it be extended in place (union with the connectivity walk) instead of
  // rebuilt from scratch on the next full clone
  const hadCache = store.getMeta("reachable-version") === store.reachableVersion();
  // A fresh push (no cache to extend) verifies connectivity in SQL rather than
  // by walking into an OidSet — the walk's result would be discarded by the
  // commit step's invalidate below, so it was pure memory spent to reject a
  // broken pack. `packMissing` names the first unresolved child, or stays null.
  // A fast-forward keeps the cheap new-object walk, which both verifies and
  // extends the cache in one pass.
  const packMissing =
    !hadCache && !unpackError && packId !== null ? await packComplete(store, packId) : null;
  // pre-existing ref tips bound the connectivity walk: their closure is
  // already validated, so a normal fast-forward only re-checks new objects
  const known = new OidSet(4096);
  for (const r of store.refs()) {
    known.addHex(r.target);
    const c = await peelToCommitOid(store, r.target);
    if (c) known.addHex(c);
  }
  const knownHead = store.resolveHead();
  if (knownHead) known.addHex(knownHead);

  const decisions: PushDecision[] = [];
  for (const cmd of commands) {
    if (unpackError) {
      decisions.push({ ref: cmd.ref, expectedOld: cmd.old, reject: "unpacker error" });
      continue;
    }
    const bad = !cmd.ref.startsWith("refs/") || cmd.ref.includes("..") || BAD_REF.test(cmd.ref)
      || cmd.ref.endsWith(".lock") || cmd.ref.includes("@{") || cmd.ref.includes("//")
      || cmd.ref.endsWith("/") || cmd.ref.length > 255
      || cmd.ref.split("/").some((c) => c.startsWith("."));
    if (bad) {
      decisions.push({ ref: cmd.ref, expectedOld: cmd.old, reject: "funny refname" });
      continue;
    }
    const current = store.getRef(cmd.ref) ?? ZERO_OID;
    if (current !== cmd.old) {
      decisions.push({ ref: cmd.ref, expectedOld: cmd.old, reject: "fetch first" });
      continue;
    }
    if (cmd.next === ZERO_OID) {
      decisions.push({ ref: cmd.ref, expectedOld: cmd.old, del: true });
      continue;
    }
    const connected = hadCache
      ? await reachableComplete(store, cmd.next, known)
      : packMissing === null && store.has(cmd.next);
    if (!connected) {
      decisions.push({ ref: cmd.ref, expectedOld: cmd.old, reject: "missing necessary objects" });
      continue;
    }
    const forced = cmd.old !== ZERO_OID && !(await isAncestor(store, cmd.old, cmd.next));
    decisions.push({ ref: cmd.ref, expectedOld: cmd.old, set: cmd.next, forced });
  }
  return { decisions, known, hadCache };
}

/**
 * Apply a validated PushPlan under a savepoint (transactionSync): a multi-ref
 * push must not leave half its branches moved if a later update throws. Each CAS
 * is re-checked here against live ref state so the write is atomic with its
 * guard; a mismatch (a ref moved between validation and commit, which the push
 * serialization normally prevents) both rejects that command and forces the
 * reachable cache to be rebuilt rather than extended from a now-stale walk.
 */
export function commitPush(store: GitStore, plan: PushPlan): { results: CommandResult[]; changed: boolean; needsGc: boolean } {
  const results: CommandResult[] = [];
  let changed = false;
  let needsGc = false;
  let casMismatch = false;
  for (const d of plan.decisions) {
    if (d.reject) {
      results.push({ ref: d.ref, ok: false, msg: d.reject });
      continue;
    }
    const current = store.getRef(d.ref) ?? ZERO_OID;
    if (current !== d.expectedOld) {
      results.push({ ref: d.ref, ok: false, msg: "fetch first" });
      casMismatch = true;
      continue;
    }
    if (d.del) {
      store.delRef(d.ref);
      needsGc = true;
    } else {
      store.setRef(d.ref, d.set!);
      if (d.forced) needsGc = true; // forced update strands old history
    }
    changed = true;
    results.push({ ref: d.ref, ok: true });
  }

  // keep HEAD pointing at a branch that exists (first push wins, prefer main/master)
  if (changed && store.getRef(store.head()) === null) {
    const branches = store.refs().filter((r) => r.name.startsWith("refs/heads/"));
    const preferred =
      branches.find((b) => b.name === "refs/heads/main") ??
      branches.find((b) => b.name === "refs/heads/master") ??
      branches[0];
    if (preferred) store.setHead(preferred.name);
  }

  // maintain the full-clone reachable cache. `known` holds the connectivity
  // walk: the pre-existing tips plus every object this push newly connected. On
  // a pure fast-forward with a valid prior cache, union closes over exactly the
  // new reachable set. Anything else (a force-push/delete that strands history,
  // no prior cache to extend, or a commit-time CAS mismatch that leaves `known`
  // describing a command that did not apply) invalidates it, so the next full
  // clone rebuilds by walking rather than risk serving unreachable objects.
  if (changed) {
    if (plan.hadCache && !needsGc && !casMismatch) store.extendReachable(plan.known);
    else store.invalidateReachable();
  }
  return { results, changed, needsGc };
}

/** report-status payload; ends with its own flush (nested inside band 1 when sidebanded). */
export function renderStatus(results: CommandResult[], unpackError: string | null, sideband: boolean): Uint8Array {
  const lines: Uint8Array[] = [pkt(unpackError ? `unpack ${unpackError}\n` : "unpack ok\n")];
  for (const r of results) {
    lines.push(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.msg}\n`));
  }
  lines.push(FLUSH);
  if (!sideband) return concat(lines);
  return concat([...sidebandFrames(1, concat(lines)), FLUSH]);
}
