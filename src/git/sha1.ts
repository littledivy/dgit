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
