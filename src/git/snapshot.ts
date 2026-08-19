import pako from "pako";
import { te, concat } from "./util";

export interface SnapshotFile {
  /** path inside the archive, without the top-level prefix */
  path: string;
  mode: number; // 0o644 / 0o755
  symlink: boolean;
  data: Uint8Array;
}


function safePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\")) return false;
  return p.split("/").every((c) => c !== "" && c !== "." && c !== "..");
}

function safeTarget(t: string): boolean {
  if (t.startsWith("/")) return false;
  return t.split("/").every((c) => c !== "..");
}

function safeEntry(f: SnapshotFile): boolean {
  if (!safePath(f.path)) return false;
  if (f.symlink && !safeTarget(new TextDecoder().decode(f.data))) return false;
  return true;
}

function octal(n: number, width: number): Uint8Array {
  const s = n.toString(8).padStart(width - 1, "0") + "\0";
  return te.encode(s);
}

function tarHeader(path: string, mode: number, size: number, mtime: number, typeflag: string, linkname: string): Uint8Array {
  const h = new Uint8Array(512);
  let name = path;
  let prefix = "";
  if (te.encode(name).length > 100) {
    // ustar prefix split at a slash
    const idx = path.slice(0, 155).lastIndexOf("/");
    if (idx > 0) {
      prefix = path.slice(0, idx);
      name = path.slice(idx + 1);
    }
  }
  h.set(te.encode(name).subarray(0, 100), 0);
  h.set(octal(mode, 8), 100);
  h.set(octal(0, 8), 108); // uid
  h.set(octal(0, 8), 116); // gid
  h.set(octal(size, 12), 124);
  h.set(octal(mtime, 12), 136);
  h.set(te.encode("        "), 148); // checksum placeholder = spaces
  h.set(te.encode(typeflag), 156);
  h.set(te.encode(linkname).subarray(0, 100), 157);
  h.set(te.encode("ustar\0" + "00"), 257);
  h.set(te.encode("root").subarray(0, 32), 265);
  h.set(te.encode("root").subarray(0, 32), 297);
  h.set(te.encode(prefix).subarray(0, 155), 345);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.set(te.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return h;
}

export function tarGz(prefix: string, files: SnapshotFile[], mtime: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    if (!safeEntry(f)) continue;
    const path = `${prefix}/${f.path}`;
    if (f.symlink) {
      const target = new TextDecoder().decode(f.data);
      parts.push(tarHeader(path, 0o777, 0, mtime, "2", target));
      continue;
    }
    parts.push(tarHeader(path, f.mode, f.data.length, mtime, "0", ""));
    parts.push(f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024)); // end-of-archive
  return pako.gzip(concat(parts));
}


const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(unixSecs: number): { time: number; date: number } {
  const d = new Date(unixSecs * 1000);
  const date = (((d.getUTCFullYear() - 1980) & 0x7f) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { time, date };
}

export function zip(prefix: string, files: SnapshotFile[], mtime: number): Uint8Array {
  const { time, date } = dosDateTime(mtime);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    if (!safeEntry(f)) continue;
    const name = te.encode(`${prefix}/${f.path}`);
    const crc = crc32(f.data);
    const compressed = f.data.length ? pako.deflateRaw(f.data) : new Uint8Array(0);
    const method = f.data.length ? 8 : 0;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, compressed);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by unix
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((f.symlink ? 0o120000 | 0o777 : 0o100000 | f.mode) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + compressed.length;
  }
  const cdStart = offset;
  let cdLen = 0;
  for (const c of central) cdLen += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, cdStart, true);
  return concat([...parts, ...central, eocd]);
}
