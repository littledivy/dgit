import { SHA1_DVS, ubcCheck } from "./sha1dc-tables";

/**
 * Incremental SHA-1. Workers' crypto.subtle is one-shot and async; pack
 * streaming needs a running digest and the object database wants sync
 * hashing, so we carry our own (git still speaks SHA-1 for object ids).
 */
export class Sha1 {
  private h0 = 0x67452301 | 0;
  private h1 = 0xefcdab89 | 0;
  private h2 = 0x98badcfe | 0;
  private h3 = 0x10325476 | 0;
  private h4 = 0xc3d2e1f0 | 0;
  private block = new Uint8Array(64);
  private blockLen = 0;
  private bytes = 0;
  private w = new Int32Array(80);

  /** Reinitialize so one instance can hash many inputs without reallocating. */
  reset(): this {
    this.h0 = 0x67452301 | 0;
    this.h1 = 0xefcdab89 | 0;
    this.h2 = 0x98badcfe | 0;
    this.h3 = 0x10325476 | 0;
    this.h4 = 0xc3d2e1f0 | 0;
    this.blockLen = 0;
    this.bytes = 0;
    return this;
  }

  update(data: Uint8Array): this {
    this.bytes += data.length;
    let off = 0;
    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      const take = Math.min(need, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      off = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    while (off + 64 <= data.length) {
      this.compress(data, off);
      off += 64;
    }
    if (off < data.length) {
      this.block.set(data.subarray(off), 0);
      this.blockLen = data.length - off;
    }
    return this;
  }

  digest(): Uint8Array {
    const bitLenHi = Math.floor((this.bytes * 8) / 0x100000000);
    const bitLenLo = (this.bytes * 8) >>> 0;
    const pad = new Uint8Array(((this.blockLen < 56 ? 56 : 120) - this.blockLen) + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, bitLenHi);
    dv.setUint32(pad.length - 4, bitLenLo);
    this.update(pad);
    const out = new Uint8Array(20);
    const ov = new DataView(out.buffer);
    ov.setInt32(0, this.h0);
    ov.setInt32(4, this.h1);
    ov.setInt32(8, this.h2);
    ov.setInt32(12, this.h3);
    ov.setInt32(16, this.h4);
    return out;
  }

  private compress(buf: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (n << 1) | (n >>> 31);
    }
    let a = this.h0, b = this.h1, c = this.h2, d = this.h3, e = this.h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc | 0;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6 | 0;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
  }
}

export function sha1(data: Uint8Array): Uint8Array {
  return new Sha1().update(data).digest();
}

/*
 * SHA-1 collision detection (SHA-1DC)
 *
 * A port of Stevens & Shumow's sha1collisiondetection, the same defence
 * git adopted after SHAttered. Every compressed block is screened by
 * ubcCheck against 32 known disturbance vectors; a flagged DV is then
 * confirmed by recompressing the block from the DV's test step with the
 * perturbed message. If the reconstructed chaining value reproduces the
 * real one, the block is half of a collision attack.
 *
 * Like git, safe-hash mangling stays off: the digest is always plain
 * SHA-1, so object ids never move. Detection is reported out-of-band and
 * the caller refuses the object.
 */

const DVS = SHA1_DVS.map((dv) => ({
  testt: dv.testt,
  maskb: dv.maskb,
  dm: Int32Array.from(dv.dm),
}));

const K0 = 0x5a827999 | 0;
const K1 = 0x6ed9eba1 | 0;
const K2 = 0x8f1bbcdc | 0;
const K3 = 0xca62c1d6 | 0;

/**
 * One step of the compression function, run over a rotating register file
 * so a single loop can serve any step index. At step `i` the roles
 * (a,b,c,d,e) live at v[(role - i) mod 5].
 */
function stepForward(v: Int32Array, i: number, m: Int32Array): void {
  const ia = (5 - (i % 5)) % 5;
  const ib = (ia + 1) % 5;
  const ic = (ia + 2) % 5;
  const id = (ia + 3) % 5;
  const ie = (ia + 4) % 5;
  const a = v[ia], b = v[ib], c = v[ic], d = v[id], e = v[ie];
  let f: number, k: number;
  if (i < 20) { f = d ^ (b & (c ^ d)); k = K0; }
  else if (i < 40) { f = b ^ c ^ d; k = K1; }
  else if (i < 60) { f = (b & c) | (d & (b ^ c)); k = K2; }
  else { f = b ^ c ^ d; k = K3; }
  v[ie] = (e + (((a << 5) | (a >>> 27)) + f + k + m[i])) | 0;
  v[ib] = (b << 30) | (b >>> 2);
}

/** Inverse of stepForward: undoes step `i`. */
function stepBackward(v: Int32Array, i: number, m: Int32Array): void {
  const ia = (5 - (i % 5)) % 5;
  const ib = (ia + 1) % 5;
  const ic = (ia + 2) % 5;
  const id = (ia + 3) % 5;
  const ie = (ia + 4) % 5;
  const a = v[ia];
  const b = ((v[ib] >>> 30) | (v[ib] << 2)) | 0;
  v[ib] = b;
  const c = v[ic], d = v[id], e = v[ie];
  let f: number, k: number;
  if (i < 20) { f = d ^ (b & (c ^ d)); k = K0; }
  else if (i < 40) { f = b ^ c ^ d; k = K1; }
  else if (i < 60) { f = (b & c) | (d & (b ^ c)); k = K2; }
  else { f = b ^ c ^ d; k = K3; }
  v[ie] = (e - (((a << 5) | (a >>> 27)) + f + k + m[i])) | 0;
}

/**
 * Reconstruct the chaining values a block would have had, had it been
 * compressed with the perturbed message `me2`. Runs backwards from step
 * `t` to recover the input chaining value, then forwards to step 79 for
 * the output. `state` is the real block's register file entering step t.
 */
function recompress(
  t: number,
  ihvin: Int32Array,
  ihvout: Int32Array,
  me2: Int32Array,
  state: Int32Array,
  scratch: Int32Array
): void {
  scratch.set(state);
  for (let i = t - 1; i >= 0; i--) stepBackward(scratch, i, me2);
  ihvin.set(scratch);
  scratch.set(state);
  for (let i = t; i < 80; i++) stepForward(scratch, i, me2);
  for (let j = 0; j < 5; j++) ihvout[j] = (ihvin[j] + scratch[j]) | 0;
}

/**
 * Collision-detecting SHA-1. Drop-in for {@link Sha1}: `digest()` returns
 * the identical bytes for every input. After digesting, {@link collision}
 * reports whether any block looked like a collision-attack near-collision
 * block.
 */
export class Sha1Dc {
  private ihv = new Int32Array(5);
  private block = new Uint8Array(64);
  private blockLen = 0;
  private bytes = 0;
  /** expanded message of the block being compressed */
  private m1 = new Int32Array(80);
  private m2 = new Int32Array(80);
  /** register file entering steps 58 and 65 — the only DV test steps */
  private state58 = new Int32Array(5);
  private state65 = new Int32Array(5);
  private ihvin = new Int32Array(5);
  private ihvout = new Int32Array(5);
  private scratch = new Int32Array(5);
  private found = false;

  constructor() {
    this.reset();
  }

  /** True when a near-collision block was seen since the last reset. */
  get collision(): boolean {
    return this.found;
  }

  reset(): this {
    this.ihv[0] = 0x67452301 | 0;
    this.ihv[1] = 0xefcdab89 | 0;
    this.ihv[2] = 0x98badcfe | 0;
    this.ihv[3] = 0x10325476 | 0;
    this.ihv[4] = 0xc3d2e1f0 | 0;
    this.blockLen = 0;
    this.bytes = 0;
    this.found = false;
    return this;
  }

  update(data: Uint8Array): this {
    this.bytes += data.length;
    let off = 0;
    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      const take = Math.min(need, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      off = take;
      if (this.blockLen === 64) {
        this.process(this.block, 0);
        this.blockLen = 0;
      }
    }
    while (off + 64 <= data.length) {
      this.process(data, off);
      off += 64;
    }
    if (off < data.length) {
      this.block.set(data.subarray(off), 0);
      this.blockLen = data.length - off;
    }
    return this;
  }

  digest(): Uint8Array {
    const bitLenHi = Math.floor((this.bytes * 8) / 0x100000000);
    const bitLenLo = (this.bytes * 8) >>> 0;
    const pad = new Uint8Array(((this.blockLen < 56 ? 56 : 120) - this.blockLen) + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, bitLenHi);
    dv.setUint32(pad.length - 4, bitLenLo);
    this.update(pad);
    const out = new Uint8Array(20);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) ov.setInt32(i * 4, this.ihv[i]);
    return out;
  }

  /** Compress one block, retaining what the collision check needs. */
  private process(buf: Uint8Array, off: number): void {
    const w = this.m1;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (n << 1) | (n >>> 31);
    }
    const ihv = this.ihv;
    let a = ihv[0], b = ihv[1], c = ihv[2], d = ihv[3], e = ihv[4];
    for (let i = 0; i < 80; i++) {
      // The unrolled reference names registers canonically while this loop
      // shifts them, so a snapshot at step i must be rotated back by i mod 5.
      if (i === 58) {
        // 58 mod 5 == 3
        this.state58[0] = d; this.state58[1] = e; this.state58[2] = a;
        this.state58[3] = b; this.state58[4] = c;
      } else if (i === 65) {
        // 65 mod 5 == 0
        this.state65[0] = a; this.state65[1] = b; this.state65[2] = c;
        this.state65[3] = d; this.state65[4] = e;
      }
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = K0; }
      else if (i < 40) { f = b ^ c ^ d; k = K1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = K2; }
      else { f = b ^ c ^ d; k = K3; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    ihv[0] = (ihv[0] + a) | 0;
    ihv[1] = (ihv[1] + b) | 0;
    ihv[2] = (ihv[2] + c) | 0;
    ihv[3] = (ihv[3] + d) | 0;
    ihv[4] = (ihv[4] + e) | 0;

    if (this.found) return; // already refused; skip the rest of the work
    const mask = ubcCheck(w);
    if (mask === 0) return;
    const m2 = this.m2;
    for (const dv of DVS) {
      if ((mask & (1 << dv.maskb)) === 0) continue;
      const dm = dv.dm;
      for (let j = 0; j < 80; j++) m2[j] = w[j] ^ dm[j];
      recompress(
        dv.testt,
        this.ihvin,
        this.ihvout,
        m2,
        dv.testt === 58 ? this.state58 : this.state65,
        this.scratch
      );
      const o = this.ihvout;
      if (((o[0] ^ ihv[0]) | (o[1] ^ ihv[1]) | (o[2] ^ ihv[2]) | (o[3] ^ ihv[3]) | (o[4] ^ ihv[4])) === 0) {
        this.found = true;
        return;
      }
    }
  }
}

/** Thrown when a hashed object carries a SHA-1 collision-attack block. */
export class Sha1CollisionError extends Error {
  readonly oid: string;
  constructor(oid: string) {
    super(`object ${oid.slice(0, 12)} triggered SHA-1 collision detection; refused`);
    this.name = "Sha1CollisionError";
    this.oid = oid;
  }
}
