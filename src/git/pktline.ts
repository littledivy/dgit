import { te, td, concat } from "./util";

export const FLUSH = te.encode("0000");

/** Encode one pkt-line (length prefix includes the 4 prefix bytes). */
export function pkt(payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === "string" ? te.encode(payload) : payload;
  if (body.length > 65516) throw new Error("pkt-line too long");
  return concat([te.encode((body.length + 4).toString(16).padStart(4, "0")), body]);
}

export function pktLines(...payloads: (string | Uint8Array)[]): Uint8Array {
  return concat(payloads.map(pkt));
}

export type Pkt = { kind: "flush" | "delim" | "line"; raw: Uint8Array; text: string };

/** Iterates pkt-lines from a buffer; `rest()` returns unparsed bytes (e.g. a packfile). */
export class PktParser {
  pos = 0;
  constructor(private buf: Uint8Array) {}

  /**
   * Strict 4-byte hex length. `parseInt` is too lenient for attacker-framed
   * input — it accepts leading whitespace and stops at the first non-digit, so
   * "  12" or "001g" would parse to a bogus length and desync the stream. Every
   * one of the four bytes must be a hex digit or the packet is rejected.
   */
  private len4(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.buf[this.pos + i];
      let d: number;
      if (c >= 0x30 && c <= 0x39) d = c - 0x30;
      else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
      else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
      else throw new Error("bad pkt-line length");
      n = (n << 4) | d;
    }
    return n;
  }

  read(): Pkt | null {
    if (this.pos + 4 > this.buf.length) return null;
    const len = this.len4();
    // 0000 flush and 0001 delim are the only special lengths; 0002/0003 are
    // undefined and rejected, as is any declared length that overruns the buffer.
    if (len === 0) {
      this.pos += 4;
      return { kind: "flush", raw: new Uint8Array(0), text: "" };
    }
    if (len === 1) {
      this.pos += 4;
      return { kind: "delim", raw: new Uint8Array(0), text: "" };
    }
    if (len < 4 || this.pos + len > this.buf.length) throw new Error("bad pkt-line");
    const raw = this.buf.subarray(this.pos + 4, this.pos + len);
    this.pos += len;
    let text = td.decode(raw);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    return { kind: "line", raw, text };
  }

  rest(): Uint8Array {
    return this.buf.subarray(this.pos);
  }
}
