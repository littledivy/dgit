import { te, td, toHex, fromHex, concat, sha1hex, Sha1 } from "./util";
import { deflate, inflateEntry } from "./zlib";
import { ObjType, NUM_TYPE, TYPE_NUM, objectHeader, hashObject } from "./objects";

export interface PackedObject {
  oid: string;
  type: ObjType;
  data: Uint8Array;
}

const OFS_DELTA = 6;
const REF_DELTA = 7;

interface RawEntry {
  offset: number; // offset of the entry header within the pack (ofs-delta base key)
  type: number;
  data: Uint8Array; // object content, or delta payload for delta entries
  baseOffset?: number;
  baseOid?: string;
  resolved?: { type: ObjType; data: Uint8Array };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  const varint = () => {
    let r = 0, shift = 0, b: number;
    do {
      b = delta[pos++];
      r += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return r;
  };
  const srcSize = varint();
  const tgtSize = varint();
  if (srcSize !== base.length) throw new Error("delta base size mismatch");
  const out = new Uint8Array(tgtSize);
  let op = 0;
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if (cmd & 0x80) {
      // copy from base
      let off = 0, size = 0;
      if (cmd & 0x01) off = delta[pos++];
      if (cmd & 0x02) off |= delta[pos++] << 8;
      if (cmd & 0x04) off |= delta[pos++] << 16;
      if (cmd & 0x08) off += delta[pos++] * 0x1000000;
      if (cmd & 0x10) size = delta[pos++];
      if (cmd & 0x20) size |= delta[pos++] << 8;
      if (cmd & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.set(base.subarray(off, off + size), op);
      op += size;
    } else if (cmd) {
      // insert literal
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

/**
 * Parse and index a packfile: inflate every entry, resolve ofs/ref deltas
 * (including thin-pack bases fetched through `getBase`), and hash each object.
 */
export function indexPack(
  pack: Uint8Array,
  getBase: (oid: string) => { type: ObjType; data: Uint8Array } | null
): PackedObject[] {
  if (pack.length < 32 || td.decode(pack.subarray(0, 4)) !== "PACK")
    throw new Error("bad pack signature");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = view.getUint32(8);

  // verify trailer checksum
  const trailer = toHex(pack.subarray(pack.length - 20));
  const actual = sha1hex(pack.subarray(0, pack.length - 20));
  if (trailer !== actual) throw new Error("pack checksum mismatch");

  const entries: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const offset = pos;
    let byte = pack[pos++];
    const type = (byte >> 4) & 7;
    while (byte & 0x80) {
      byte = pack[pos++];
    }
    const entry: RawEntry = { offset, type, data: new Uint8Array(0) };
    if (type === OFS_DELTA) {
      byte = pack[pos++];
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        off = (off + 1) * 128 + (byte & 0x7f);
      }
      entry.baseOffset = offset - off;
    } else if (type === REF_DELTA) {
      entry.baseOid = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (!NUM_TYPE[type]) {
      throw new Error(`bad object type ${type} at ${offset}`);
    }
    const { data, end } = inflateEntry(pack, pos);
    entry.data = data;
    pos = end;
    if (type !== OFS_DELTA && type !== REF_DELTA) {
      entry.resolved = { type: NUM_TYPE[type], data };
    }
    entries.push(entry);
  }

  // resolve deltas; bases can be other pack entries or (thin pack) store objects
  const byOffset = new Map<number, RawEntry>();
  for (const e of entries) byOffset.set(e.offset, e);
  const oidOf = new Map<RawEntry, string>();
  const byOid = new Map<string, RawEntry>();

  const hashEntry = (e: RawEntry) => {
    if (!e.resolved || oidOf.has(e)) return;
    const oid = hashObject(e.resolved.type, e.resolved.data);
    oidOf.set(e, oid);
    byOid.set(oid, e);
  };
  for (const e of entries) hashEntry(e);

  let unresolved = entries.filter((e) => !e.resolved);
  while (unresolved.length) {
    let progress = false;
    const next: RawEntry[] = [];
    for (const e of unresolved) {
      let base: { type: ObjType; data: Uint8Array } | null = null;
      if (e.baseOffset !== undefined) {
        base = byOffset.get(e.baseOffset)?.resolved ?? null;
      } else if (e.baseOid) {
        base = byOid.get(e.baseOid)?.resolved ?? getBase(e.baseOid);
      }
      if (base) {
        e.resolved = { type: base.type, data: applyDelta(base.data, e.data) };
        hashEntry(e);
        progress = true;
      } else {
        next.push(e);
      }
    }
    if (!progress) throw new Error(`cannot resolve ${next.length} delta object(s): missing base`);
    unresolved = next;
  }

  return entries.map((e) => ({ oid: oidOf.get(e)!, type: e.resolved!.type, data: e.resolved!.data }));
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

/** Convenience: build a whole pack in memory (used for small internal packs). */
export function buildPack(objects: { type: ObjType; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const w = new PackWriter((c) => parts.push(c));
  w.header(objects.length);
  for (const o of objects) w.object(o.type, o.data);
  w.finish();
  return concat(parts);
}
