import { fromHex, toHex } from "./util";

/**
 * Memory-compact set + insertion-ordered list of object ids. A JS
 * Set<string> of 40-char hex strings costs ~100 bytes per entry — at
 * Linux scale (10M objects) that is gigabytes. This stores raw 20-byte
 * digests in typed arrays: ~20B per entry plus a u32 open-addressing table.
 *
 * A set can also carry a *tagged sub-set* (mark/isMarked/markedAt): one bit
 * per entry plus a u32 index list. Two nested roles — e.g. the object walk's
 * "visited" and its strict subset "send" — then cost ~28B/object in one set
 * instead of ~56B in two.
 */
export class OidSet {
  private table: Uint32Array; // 1-based indices into the entry list; 0 = empty
  private mask: number;
  private data: Uint8Array; // 20 bytes per entry, insertion order
  private count = 0;
  // tagged sub-set, allocated lazily on first mark()
  private marks: Uint8Array | null = null; // one bit per entry index
  private markedIdx: Uint32Array | null = null; // tagged entry indices, insertion order
  private markedCount = 0;

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

  /** Number of entries in the tagged sub-set. */
  get markedSize(): number {
    return this.markedCount;
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

  /** Make room for the entry about to be written at index `this.count`. */
  private growData(): void {
    if ((this.count + 1) * 20 > this.data.length) {
      const bigger = new Uint8Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    if (this.marks && (this.count >> 3) >= this.marks.length) {
      const bigger = new Uint8Array(this.marks.length * 2);
      bigger.set(this.marks);
      this.marks = bigger;
    }
  }

  /** Entry index of `bytes`, inserting it when absent. */
  private indexOrInsert(bytes: Uint8Array, off: number): number {
    if ((this.count + 1) * 2 > this.table.length) this.grow();
    let slot = this.hashAt(bytes, off) & this.mask;
    while (this.table[slot] !== 0) {
      if (this.equalsEntry(this.table[slot] - 1, bytes, off)) return this.table[slot] - 1;
      slot = (slot + 1) & this.mask;
    }
    this.growData();
    this.data.set(bytes.subarray(off, off + 20), this.count * 20);
    this.table[slot] = ++this.count;
    return this.count - 1;
  }

  /** Adds a hex oid; returns false if it was already present. */
  addHex(hex: string): boolean {
    return this.addBytes(fromHex(hex), 0);
  }

  addBytes(bytes: Uint8Array, off: number): boolean {
    const before = this.count;
    // a freshly inserted entry always lands at index `before`
    return this.indexOrInsert(bytes, off) === before;
  }

  hasHex(hex: string): boolean {
    return this.hasBytes(fromHex(hex), 0);
  }

  /** Insertion-order entry index of `hex`, or -1 if absent. */
  indexOfHex(hex: string): number {
    return this.indexOf(fromHex(hex), 0);
  }

  hasBytes(bytes: Uint8Array, off: number): boolean {
    return this.indexOf(bytes, off) >= 0;
  }

  /** Entry index of `bytes`, or -1. */
  private indexOf(bytes: Uint8Array, off: number): number {
    let slot = this.hashAt(bytes, off) & this.mask;
    while (this.table[slot] !== 0) {
      if (this.equalsEntry(this.table[slot] - 1, bytes, off)) return this.table[slot] - 1;
      slot = (slot + 1) & this.mask;
    }
    return -1;
  }

  /** Hex oid of the i-th inserted entry. */
  atHex(i: number): string {
    return toHex(this.data.subarray(i * 20, i * 20 + 20));
  }

  /**
   * Adds `hex` if needed and puts it in the tagged sub-set.
   * Returns false if it was already tagged.
   */
  markHex(hex: string): boolean {
    const idx = this.indexOrInsert(fromHex(hex), 0);
    if (!this.marks) this.marks = new Uint8Array(((this.data.length / 20) >> 3) + 1);
    const byte = idx >> 3;
    const bit = 1 << (idx & 7);
    if (this.marks[byte] & bit) return false;
    this.marks[byte] |= bit;
    if (!this.markedIdx) this.markedIdx = new Uint32Array(1024);
    if (this.markedCount === this.markedIdx.length) {
      const bigger = new Uint32Array(this.markedIdx.length * 2);
      bigger.set(this.markedIdx);
      this.markedIdx = bigger;
    }
    this.markedIdx[this.markedCount++] = idx;
    return true;
  }

  isMarkedHex(hex: string): boolean {
    if (!this.marks) return false;
    const idx = this.indexOf(fromHex(hex), 0);
    return idx >= 0 && (this.marks[idx >> 3] & (1 << (idx & 7))) !== 0;
  }

  /** Hex oid of the i-th entry of the tagged sub-set. */
  markedAtHex(i: number): string {
    const idx = this.markedIdx![i];
    return toHex(this.data.subarray(idx * 20, idx * 20 + 20));
  }
}
