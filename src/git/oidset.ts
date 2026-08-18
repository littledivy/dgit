import { fromHex, toHex } from "./util";

/**
 * Memory-compact set + insertion-ordered list of object ids. A JS
 * Set<string> of 40-char hex strings costs ~100 bytes per entry — at
 * Linux scale (10M objects) that is gigabytes. This stores raw 20-byte
 * digests in typed arrays: ~20B per entry plus a u32 open-addressing table.
 */
export class OidSet {
  private table: Uint32Array; // 1-based indices into the entry list; 0 = empty
  private mask: number;
  private data: Uint8Array; // 20 bytes per entry, insertion order
  private count = 0;

  constructor(expected = 1024) {
    let cap = 2048;
    while (cap < expected * 2) cap *= 2;
    this.table = new Uint32Array(cap);
    this.mask = cap - 1;
    this.data = new Uint8Array(Math.max(expected, 1024) * 20);
  }

  get size(): number {
    return this.count;
  }

  private hashAt(bytes: Uint8Array, off: number): number {
    // oids are uniformly random; the first 4 bytes are a fine hash
    return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
  }

  private equalsEntry(idx: number, bytes: Uint8Array, off: number): boolean {
    const base = idx * 20;
    for (let i = 0; i < 20; i++) {
      if (this.data[base + i] !== bytes[off + i]) return false;
    }
    return true;
  }

  private grow(): void {
    const newTable = new Uint32Array(this.table.length * 2);
    const newMask = newTable.length - 1;
    for (let i = 0; i < this.count; i++) {
      let slot = this.hashAt(this.data, i * 20) & newMask;
      while (newTable[slot] !== 0) slot = (slot + 1) & newMask;
      newTable[slot] = i + 1;
    }
    this.table = newTable;
    this.mask = newMask;
  }

  /** Adds a hex oid; returns false if it was already present. */
  addHex(hex: string): boolean {
    return this.addBytes(fromHex(hex), 0);
  }

  addBytes(bytes: Uint8Array, off: number): boolean {
    if ((this.count + 1) * 2 > this.table.length) this.grow();
    let slot = this.hashAt(bytes, off) & this.mask;
    while (this.table[slot] !== 0) {
      if (this.equalsEntry(this.table[slot] - 1, bytes, off)) return false;
      slot = (slot + 1) & this.mask;
    }
    if ((this.count + 1) * 20 > this.data.length) {
      const bigger = new Uint8Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data.set(bytes.subarray(off, off + 20), this.count * 20);
    this.table[slot] = ++this.count;
    return true;
  }

  hasHex(hex: string): boolean {
    return this.hasBytes(fromHex(hex), 0);
  }

  hasBytes(bytes: Uint8Array, off: number): boolean {
    let slot = this.hashAt(bytes, off) & this.mask;
    while (this.table[slot] !== 0) {
      if (this.equalsEntry(this.table[slot] - 1, bytes, off)) return true;
      slot = (slot + 1) & this.mask;
    }
    return false;
  }

  /** Hex oid of the i-th inserted entry. */
  atHex(i: number): string {
    return toHex(this.data.subarray(i * 20, i * 20 + 20));
  }
}
