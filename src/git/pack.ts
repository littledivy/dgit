import { te, fromHex, Sha1 } from "./util";
import { deflate } from "./zlib";
import { ObjType, TYPE_NUM } from "./objects";

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  // bounded read: a truncated/crafted delta must throw, never read past the end
  // (which would fold `undefined` into offsets/sizes and corrupt the result).
  const next = (): number => {
    if (pos >= delta.length) throw new Error("delta truncated");
    return delta[pos++];
  };
  const varint = () => {
    let r = 0, shift = 0, b: number;
    do {
      b = next();
      r += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return r;
  };
  const srcSize = varint();
  const tgtSize = varint();
  if (srcSize !== base.length) throw new Error("delta base size mismatch");
  if (tgtSize > 512 * 1024 * 1024) throw new Error("delta target too large");
  const out = new Uint8Array(tgtSize);
  let op = 0;
  while (pos < delta.length) {
    const cmd = next();
    if (cmd & 0x80) {
      // copy from base
      let off = 0, size = 0;
      if (cmd & 0x01) off = next();
      if (cmd & 0x02) off |= next() << 8;
      if (cmd & 0x04) off |= next() << 16;
      if (cmd & 0x08) off += next() * 0x1000000;
      if (cmd & 0x10) size = next();
      if (cmd & 0x20) size |= next() << 8;
      if (cmd & 0x40) size |= next() << 16;
      if (size === 0) size = 0x10000;
      if (off + size > base.length) throw new Error("delta copy out of range");
      if (op + size > tgtSize) throw new Error("delta copy overflows target");
      out.set(base.subarray(off, off + size), op);
      op += size;
    } else if (cmd) {
      // insert literal
      if (pos + cmd > delta.length) throw new Error("delta literal truncated");
      if (op + cmd > tgtSize) throw new Error("delta literal overflows target");
      out.set(delta.subarray(pos, pos + cmd), op);
      op += cmd;
      pos += cmd;
    } else {
      throw new Error("invalid delta opcode 0");
    }
  }
  if (op !== tgtSize) throw new Error("delta target size mismatch");
  return out;
}

const REF_DELTA_NUM = 7;

function encodeTypeSizeNum(typeNum: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

function encodeTypeSize(type: ObjType, size: number): Uint8Array {
  return encodeTypeSizeNum(TYPE_NUM[type], size);
}

/**
 * Incremental packfile writer: emits raw pack bytes through `emit` while
 * keeping the running SHA-1 for the trailer, so packs can be streamed
 * without ever materializing the whole file.
 */
export class PackWriter {
  private sha = new Sha1();

  constructor(private emit: (chunk: Uint8Array) => void) {}

  private out(chunk: Uint8Array): void {
    this.sha.update(chunk);
    this.emit(chunk);
  }

  header(count: number): void {
    const h = new Uint8Array(12);
    h.set(te.encode("PACK"), 0);
    const dv = new DataView(h.buffer);
    dv.setUint32(4, 2);
    dv.setUint32(8, count);
    this.out(h);
  }

  object(type: ObjType, data: Uint8Array): void {
    this.out(encodeTypeSize(type, data.length));
    this.out(deflate(data));
  }

  /** Copy a stored full entry verbatim (already zlib-compressed). */
  rawFull(type: ObjType, entrySize: number, compressed: Uint8Array): void {
    this.out(encodeTypeSize(type, entrySize));
    this.out(compressed);
  }

  /** Copy a stored delta entry verbatim, addressed as a ref-delta. */
  rawDelta(entrySize: number, baseOid: string, compressed: Uint8Array): void {
    this.out(encodeTypeSizeNum(REF_DELTA_NUM, entrySize));
    this.out(fromHex(baseOid));
    this.out(compressed);
  }

  finish(): void {
    this.emit(this.sha.digest()); // trailer is not part of the hashed content
  }
}
