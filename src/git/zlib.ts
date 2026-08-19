import pako from "pako";
import { concat } from "./util";

/** Deflate with a zlib wrapper (what git uses for loose objects and pack entries). */
export function deflate(data: Uint8Array): Uint8Array {
  return pako.deflate(data);
}

export function inflate(data: Uint8Array): Uint8Array {
  return pako.inflate(data);
}

/**
 * gunzip with an output budget. A gzipped request body compresses ~1000:1 in
 * the adversarial case, so the compressed length says nothing about what it
 * inflates to: the only safe bound is on the bytes coming *out*. Inflating
 * incrementally and stopping the moment the budget is passed means an
 * over-inflating body costs the budget, not the bomb.
 */
export function gunzipLimited(data: Uint8Array, maxOut: number): Uint8Array {
  const inf = new pako.Inflate({ windowBits: 15 + 16 });
  const parts: Uint8Array[] = [];
  let out = 0;
  (inf as unknown as { onData: (c: Uint8Array) => void }).onData = (c: Uint8Array) => {
    out += c.length;
    if (out > maxOut) throw new Error(`request body exceeds maximum size (${maxOut} bytes decompressed)`);
    parts.push(c);
  };
  inf.push(data, true);
  const anyInf = inf as unknown as { err: number; msg: string };
  if (anyInf.err) throw new Error(`gunzip failed: ${anyInf.msg}`);
  return concat(parts);
}
