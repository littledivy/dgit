export interface DiffOp {
  tag: "eq" | "del" | "add";
  line: string;
}

export interface Hunk {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  ops: DiffOp[];
}

const MAX_LINES = 40000;
const MAX_PRODUCT = 4_000_000;
const MAX_D = 2000;
const TRACE_BUDGET = 8_000_000;

/** Myers O(ND) line diff. Returns null when the input is too large. */
export function diffLines(aText: string, bText: string): DiffOp[] | null {
  const a = aText.split("\n");
  const b = bText.split("\n");
  if (a[a.length - 1] === "") a.pop();
  if (b[b.length - 1] === "") b.pop();
  const N = a.length, M = b.length;

  if (N === 0 || M === 0) {
    const ops: DiffOp[] = [];
    for (const line of a) ops.push({ tag: "del", line });
    for (const line of b) ops.push({ tag: "add", line });
    return ops;
  }
  if (N + M > MAX_LINES) return null;
  if (N * M > MAX_PRODUCT) return null;

  const max = N + M;
  const dCap = Math.min(MAX_D, Math.max(1, Math.floor(TRACE_BUDGET / max)));
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let dFound = -1;
  outer: for (let d = 0; d <= max; d++) {
    if (d > dCap) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= N && y >= M) {
        dFound = d;
        break outer;
      }
    }
  }

  const ops: DiffOp[] = [];
  let x = N, y = M;
  for (let d = dFound; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ tag: "eq", line: a[--x] });
      y--;
    }
    if (x === prevX) {
      ops.push({ tag: "add", line: b[--y] });
    } else {
      ops.push({ tag: "del", line: a[--x] });
    }
  }
  while (x > 0) {
    ops.push({ tag: "eq", line: a[--x] });
    y--;
  }
  ops.reverse();
  return ops;
}

/** Group diff ops into unified hunks with `context` lines of context. */
export function toHunks(ops: DiffOp[], context = 3): Hunk[] {
  // indexes of non-eq ops
  const changes: number[] = [];
  ops.forEach((op, i) => {
    if (op.tag !== "eq") changes.push(i);
  });
  if (!changes.length) return [];

  // merge change ranges whose context windows touch
  const ranges: [number, number][] = [];
  let start = changes[0], end = changes[0];
  for (const i of changes.slice(1)) {
    if (i - end <= context * 2) {
      end = i;
    } else {
      ranges.push([start, end]);
      start = end = i;
    }
  }
  ranges.push([start, end]);

  const hunks: Hunk[] = [];
  let aLine = 1, bLine = 1, opIdx = 0;
  for (const [s, e] of ranges) {
    const from = Math.max(0, s - context);
    const to = Math.min(ops.length - 1, e + context);
    // advance line counters up to `from`
    while (opIdx < from) {
      const op = ops[opIdx++];
      if (op.tag !== "add") aLine++;
      if (op.tag !== "del") bLine++;
    }
    const hunk: Hunk = { aStart: aLine, aLen: 0, bStart: bLine, bLen: 0, ops: [] };
    while (opIdx <= to) {
      const op = ops[opIdx++];
      hunk.ops.push(op);
      if (op.tag !== "add") {
        hunk.aLen++;
        aLine++;
      }
      if (op.tag !== "del") {
        hunk.bLen++;
        bLine++;
      }
    }
    if (hunk.aLen === 0) hunk.aStart = aLine - 1;
    if (hunk.bLen === 0) hunk.bStart = bLine - 1;
    hunks.push(hunk);
  }
  return hunks;
}

export function isBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}
