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

  read(): Pkt | null {
    if (this.pos + 4 > this.buf.length) return null;
    const len = parseInt(td.decode(this.buf.subarray(this.pos, this.pos + 4)), 16);
    if (Number.isNaN(len)) throw new Error("bad pkt-line length");
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
