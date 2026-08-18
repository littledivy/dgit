import pako from "pako";

/** Deflate with a zlib wrapper (what git uses for loose objects and pack entries). */
export function deflate(data: Uint8Array): Uint8Array {
  return pako.deflate(data);
}

export function inflate(data: Uint8Array): Uint8Array {
  return pako.inflate(data);
}

export function gunzip(data: Uint8Array): Uint8Array {
  return pako.ungzip(data);
}

/**
 * Inflate one zlib stream that starts at `start` inside `buf`, and report where
 * it ended. Pack files concatenate per-object zlib streams with no length
 * prefix, so the consumed byte count is the only way to find the next entry.
 */
export function inflateEntry(buf: Uint8Array, start: number): { data: Uint8Array; end: number } {
  const inf = new pako.Inflate();
  inf.push(buf.subarray(start), true);
  const anyInf = inf as unknown as { err: number; msg: string; ended: boolean; strm: { avail_in: number } };
  if (anyInf.err) throw new Error(`inflate failed at ${start}: ${anyInf.msg}`);
  if (!anyInf.ended) throw new Error(`truncated zlib stream at ${start}`);
  const consumed = buf.length - start - anyInf.strm.avail_in;
  return { data: inf.result as Uint8Array, end: start + consumed };
}
