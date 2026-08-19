import { concat, isOid, ZERO_OID, te } from "./util";
import { pkt, FLUSH, PktParser } from "./pktline";
import { GitStore } from "./store";
import { PackWriter } from "./pack";
import { OidSet } from "./oidset";
import { parseCommit, parseTag, parseTree, isGitlinkMode, isTreeMode, TYPE_NUM, NUM_TYPE } from "./objects";

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

/** GET /info/refs?service=... — smart ref advertisement (protocol v0). */
export function advertisement(store: GitStore, service: Service): Uint8Array {
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
export function advertisedOids(store: GitStore): Set<string> {
  const oids = new Set<string>();
  const head = store.resolveHead();
  if (head) oids.add(head);
  for (const r of store.refs()) {
    oids.add(r.target);
    // peel annotated tags; lightweight tags already point at the commit
    if (!r.name.startsWith("refs/tags/")) continue;
    if (store.typeAndSize(r.target)?.type !== "tag") continue;
    const peeled = peelToCommitOid(store, r.target);
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
function wantsAreAllTips(store: GitStore, wants: string[]): boolean {
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

interface UploadRequest {
  wants: string[];
  haves: string[];
  done: boolean;
  clientShallows: string[];
  deepen: number; // 0 = no depth limit requested
  caps: Set<string>;
}

function parseUploadRequest(body: Uint8Array): UploadRequest {
  const parser = new PktParser(body);
  const req: UploadRequest = {
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
    if (line.startsWith("want ")) {
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

/** Follow tag objects down to the underlying commit oid (or null). */
function peelToCommitOid(store: GitStore, oid: string): string | null {
  for (let i = 0; i < 10; i++) {
    const obj = store.get(oid);
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
 * Depth-limited commit set from the wants (BFS, min depth wins; the tip is
 * depth 1, like git). Boundary commits are included but their parents cut.
 */
function computeDepthSet(
  store: GitStore,
  wants: string[],
  depth: number
): { commits: Set<string>; boundary: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const queue: { oid: string; depth: number }[] = [];
  for (const w of wants) {
    const c = peelToCommitOid(store, w);
    if (c && !commits.has(c)) {
      commits.add(c);
      queue.push({ oid: c, depth: 1 });
    }
  }
  while (queue.length) {
    const { oid, depth: d } = queue.shift()!;
    const obj = store.get(oid);
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
    const c = peelToCommitOid(store, w);
    if (c && !haveCommits.has(c) && set.addHex(c)) stack.push(c);
  }
  let minTime = Infinity;
  while (stack.length) {
    const oid = stack.pop()!;
    const obj = store.get(oid);
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
    const c = peelToCommitOid(store, h);
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
    const obj = store.get(oid);
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
    const obj = store.get(oid);
    if (obj?.type !== "commit") continue;
    await yieldMaybe();
    for (const p of parseCommit(obj.data).parents) {
      if (excluded.hasHex(p)) boundary.push(p);
    }
  }

  const trees: string[] = [];
  for (const oid of boundary) {
    const obj = store.get(oid);
    if (obj?.type !== "commit") continue;
    const tree = parseCommit(obj.data).tree;
    if (tree && excluded.addHex(tree)) trees.push(tree);
  }
  while (trees.length) {
    const oid = trees.pop()!;
    const obj = store.get(oid);
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
  const walk = new OidSet(expected);
  const stack = [...wants];
  let ops = 0;
  while (stack.length) {
    const oid = stack.pop()!;
    if (!walk.addHex(oid)) continue;
    if (++ops % WALK_YIELD === 0) await new Promise((r) => setTimeout(r, 0));
    const meta = store.typeAndSize(oid);
    if (!meta) throw new Error(`missing object ${oid}`);
    if (meta.type === "commit" && commitLimit && !commitLimit.has(oid)) continue;
    if (excluded.hasHex(oid)) {
      if (descendThroughExcluded && meta.type === "commit") {
        const full = store.get(oid)!;
        stack.push(...parseCommit(full.data).parents);
      }
      continue;
    }
    walk.markHex(oid);
    if (meta.type === "blob") continue; // leaf: membership only
    const full = store.get(oid)!;
    if (full.type === "commit") {
      const c = parseCommit(full.data);
      stack.push(c.tree, ...c.parents);
    } else if (full.type === "tag") {
      const t = parseTag(full.data);
      if (t.object) stack.push(t.object);
    } else if (full.type === "tree") {
      for (const e of parseTree(full.data)) {
        if (!isGitlinkMode(e.mode)) stack.push(e.oid);
      }
    }
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
  release: () => void = () => {}
): Promise<Response> {
  const headers = {
    "content-type": "application/x-git-upload-pack-result",
    "cache-control": "no-cache",
  };
  const req = parseUploadRequest(body);
  if (!req.wants.length || req.wants.some((w) => !isOid(w))) {
    release();
    return new Response(pkt("ERR no valid wants\n") as unknown as BodyInit, { headers });
  }
  // a want must be an object we currently advertise, not merely one we store
  const allowed = advertisedOids(store);
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
    const clientShallowSet = new Set(req.clientShallows);
    if (req.deepen >= INFINITE_DEPTH) {
      // --unshallow: full history, everything the client thought was shallow opens up
      for (const s of req.clientShallows) {
        if (store.has(s)) preamble.push(pkt(`unshallow ${s}\n`));
      }
    } else {
      const { commits, boundary } = computeDepthSet(store, req.wants, req.deepen);
      commitLimit = commits;
      for (const b of boundary) {
        if (!clientShallowSet.has(b)) preamble.push(pkt(`shallow ${b}\n`));
      }
      for (const s of req.clientShallows) {
        if (commits.has(s) && !boundary.has(s)) preamble.push(pkt(`unshallow ${s}\n`));
      }
    }
    preamble.push(FLUSH);
  }

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
  if (!req.caps.has("multi_ack_detailed")) {
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

  // Full-clone fast path: no haves, not shallow/deepen, and the wants are
  // exactly the current ref tips. The reachable object set is then identical to
  // what the graph walk would rediscover, so serve it from the versioned cache
  // and skip the walk (and every commit/tree inflation it drives) entirely. A
  // missing or stale cache (version mismatch, or any failure) falls straight
  // through to the walk, which then repopulates it — so a wrong pack is never
  // served, and existing repos become fast on their next full clone.
  const fullClone = !req.haves.length && req.deepen === 0 && wantsAreAllTips(store, req.wants);
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

  const sideband = req.caps.has("side-band-64k");
  const noProgress = req.caps.has("no-progress");

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
  const writer = new PackWriter((chunk) => {
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
    pull: (ctrl) => {
      try {
        for (let n = 0; n < 64 && i < total; n++, i++) {
          const idx = order ? order[i] : i;
          if (!eCode) {
            // unsorted (small-pack) path: no sort pass ran, so do a fresh
            // per-object lookup in walk order, exactly as before OPT 2.
            const oid = send.markedAtHex(idx);
            const entry = store.packs.lookup(oid);
            if (entry && !entry.baseOid) {
              writer.rawFull(entry.type, entry.entrySize, store.packs.readRaw(entry.packId, entry.dataOff, entry.dataLen));
            } else if (entry && entry.baseOid && send.isMarkedHex(entry.baseOid)) {
              writer.rawDelta(entry.entrySize, entry.baseOid, store.packs.readRaw(entry.packId, entry.dataOff, entry.dataLen));
            } else {
              const obj = store.get(oid);
              if (!obj) throw new Error(`missing object ${oid}`);
              writer.object(obj.type, obj.data);
            }
            continue;
          }
          // sorted path: everything needed to emit the object was captured in
          // the lean typed arrays, so no SQL lookup happens here.
          const code = eCode[idx];
          if (code <= -3) {
            writer.rawFull(NUM_TYPE[-2 - code], eSize![idx], store.packs.readRaw(ePack![idx], eDataOff![idx], eDataLen![idx]));
          } else if (code >= 0) {
            writer.rawDelta(eSize![idx], send.atHex(code), store.packs.readRaw(ePack![idx], eDataOff![idx], eDataLen![idx]));
          } else {
            const oid = send.markedAtHex(idx);
            const obj = store.get(oid);
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
        if (finished) {
          ctrl.close();
          release(); // stream fully drained: this upload no longer holds a slot
        }
      } catch (err) {
        release();
        ctrl.error(err);
      }
    },
    cancel: () => {
      // client went away mid-transfer (e.g. negotiation round abort)
      release();
    },
  });
  return new Response(stream, { headers });
}

/** Is `anc` an ancestor of (or equal to) `desc`? Bounded walk. */
export function isAncestor(store: GitStore, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>([desc]);
  const stack = [desc];
  let visited = 0;
  while (stack.length && visited++ < 10000) {
    const obj = store.get(stack.pop()!);
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
function reachableComplete(store: GitStore, tip: string, known: OidSet): boolean {
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!known.addHex(oid)) continue;
    const meta = store.typeAndSize(oid);
    if (!meta) return false;
    if (meta.type === "blob") continue;
    const obj = store.get(oid);
    if (!obj) return false;
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
  return true;
}

/** Apply ref updates after the pack (if any) has been ingested. */
export function applyPushCommands(
  store: GitStore,
  commands: PushCommand[],
  unpackError: string | null
): { results: CommandResult[]; changed: boolean; needsGc: boolean } {
  const results: CommandResult[] = [];
  let changed = false;
  let needsGc = false;
  // whether the reachable cache is valid for the pre-push refs: only then can
  // it be extended in place (union with the connectivity walk) instead of
  // rebuilt from scratch on the next full clone
  const hadCache = store.getMeta("reachable-version") === store.reachableVersion();
  // pre-existing ref tips bound the connectivity walk: their closure is
  // already validated, so a normal fast-forward only re-checks new objects
  const known = new OidSet(4096);
  for (const r of store.refs()) {
    known.addHex(r.target);
    const c = peelToCommitOid(store, r.target);
    if (c) known.addHex(c);
  }
  const knownHead = store.resolveHead();
  if (knownHead) known.addHex(knownHead);
  for (const cmd of commands) {
    if (unpackError) {
      results.push({ ref: cmd.ref, ok: false, msg: "unpacker error" });
      continue;
    }
    const bad = !cmd.ref.startsWith("refs/") || cmd.ref.includes("..") || BAD_REF.test(cmd.ref)
      || cmd.ref.endsWith(".lock") || cmd.ref.includes("@{") || cmd.ref.includes("//")
      || cmd.ref.endsWith("/") || cmd.ref.length > 255
      || cmd.ref.split("/").some((c) => c.startsWith("."));
    if (bad) {
      results.push({ ref: cmd.ref, ok: false, msg: "funny refname" });
      continue;
    }
    const current = store.getRef(cmd.ref) ?? ZERO_OID;
    if (current !== cmd.old) {
      results.push({ ref: cmd.ref, ok: false, msg: "fetch first" });
      continue;
    }
    if (cmd.next === ZERO_OID) {
      store.delRef(cmd.ref);
      needsGc = true;
    } else {
      if (!reachableComplete(store, cmd.next, known)) {
        results.push({ ref: cmd.ref, ok: false, msg: "missing necessary objects" });
        continue;
      }
      if (cmd.old !== ZERO_OID && !isAncestor(store, cmd.old, cmd.next)) {
        needsGc = true; // forced update strands old history
      }
      store.setRef(cmd.ref, cmd.next);
    }
    changed = true;
    results.push({ ref: cmd.ref, ok: true });
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
  // or no prior cache to extend) invalidates it, so the next full clone rebuilds
  // by walking rather than risk serving objects that are no longer reachable.
  if (changed) {
    if (hadCache && !needsGc) store.extendReachable(known);
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
