export const te = new TextEncoder();
export const td = new TextDecoder();

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const ZERO_OID = "0".repeat(40);

export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export function sha1hex(data: Uint8Array): string {
  return toHex(sha1(data));
}

import { sha1 } from "./sha1";
export { sha1, Sha1 } from "./sha1";
