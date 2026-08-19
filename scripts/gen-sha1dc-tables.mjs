#!/usr/bin/env node
/**
 * Regenerates src/git/sha1dc-tables.ts from the upstream C source.
 *
 *   node scripts/gen-sha1dc-tables.mjs [path/to/ubc_check.c]
 *
 * With no argument the file is fetched from cr-marcstevens/sha1collisiondetection.
 * The disturbance-vector table and the unavoidable-bit-condition expressions
 * are transcribed by rule, never retyped — a typo in 2560 table words would
 * be undetectable by reading. Re-run scripts/sha1dc-test.mjs afterwards; it
 * pins digests of both the DV table and ubcCheck's behaviour.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const UPSTREAM =
  "https://raw.githubusercontent.com/cr-marcstevens/sha1collisiondetection/master/lib/ubc_check.c";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "git", "sha1dc-tables.ts");

const src = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : await (await fetch(UPSTREAM)).text();

const bitConsts = new Map();
for (const m of src.matchAll(/static const uint32_t (DV_\w+_bit)\s*=\s*\(uint32_t\)\(1\)\s*<<\s*(\d+);/g)) {
  bitConsts.set(m[1], Number(m[2]));
}
if (bitConsts.size !== 32) throw new Error(`expected 32 DV bit constants, got ${bitConsts.size}`);

const tableBody = src.slice(src.indexOf("dv_info_t sha1_dvs[] ="));
const rowRe = /\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\{([^}]*)\}\s*\}/g;
const rows = [];
for (const m of tableBody.matchAll(rowRe)) {
  const [, dvType, dvK, dvB, testt, maski, maskb] = m.map(Number);
  if (dvType === 0) break; // sentinel row terminates the table
  const dm = m[7].split(",").map((s) => s.trim()).filter(Boolean);
  if (dm.length !== 80) throw new Error(`dm has ${dm.length} words, expected 80`);
  rows.push({ dvType, dvK, dvB, testt, maski, maskb, dm });
}
if (rows.length !== 32) throw new Error(`expected 32 disturbance vectors, got ${rows.length}`);
for (const r of rows) {
  // ubc_check.h only defines DOSTORESTATE58 and DOSTORESTATE65, and
  // DVMASKSIZE is 1, so the port keeps exactly two retained states and a
  // single mask word. A new upstream table could break both assumptions.
  if (r.testt !== 58 && r.testt !== 65) throw new Error(`unsupported testt ${r.testt}`);
  if (r.maski !== 0) throw new Error(`unsupported maski ${r.maski}`);
}

const fnStart = src.indexOf("void ubc_check(const uint32_t W[80], uint32_t dvmask[1])");
if (fnStart < 0) throw new Error("ubc_check definition not found");
let body = src.slice(src.indexOf("{", fnStart) + 1);
body = body.slice(0, body.lastIndexOf("dvmask[0]=mask;"));
body = body.replace(/uint32_t mask = ~\(\(uint32_t\)\(0\)\);/, "");

// C uint32 arithmetic maps onto JS int32 bit-for-bit:
//   * '>>' on uint32 is a logical shift            -> '>>>'
//   * subtraction wraps mod 2^32; two's complement gives the same bits, and
//     every result is consumed by a bitwise operator, so no masking is needed
//   * C truthiness of 'if (x)' and '!x' matches JS for int32 (0 is falsy)
let js = body.replace(/>>/g, ">>>").replace(/DV_(\w+)_bit/g, (_, name) => {
  const key = `DV_${name}_bit`;
  if (!bitConsts.has(key)) throw new Error(`unknown constant ${key}`);
  return `(1 << ${bitConsts.get(key)})`;
});
for (const bad of ["uint32_t", "->", "sizeof", "static", "const "]) {
  if (js.includes(bad)) throw new Error(`unconverted C construct: ${bad}`);
}
const stmts = js.split("\n").map((l) => l.trim()).filter(Boolean);
for (const s of stmts) {
  if (!/^(mask &=|if \(|\|\||!|\)|\{|\}|else)/.test(s)) throw new Error(`unexpected statement: ${s}`);
}

const dvLines = rows
  .map(
    (r) =>
      `  { testt: ${r.testt}, maskb: ${r.maskb}, dm: [${r.dm.join(",")}] },` +
      ` // ${r.dvType === 1 ? "I" : "II"}(${r.dvK},${r.dvB})`
  )
  .join("\n");

writeFileSync(
  OUT,
  `// GENERATED — do not edit by hand.
// Transcribed from sha1collisiondetection/lib/ubc_check.c (Marc Stevens, Dan
// Shumow; MIT). Regenerate with scripts/gen-sha1dc-tables.mjs.
//
// C uint32 arithmetic maps onto JS int32 bit-for-bit: '>>' becomes '>>>' and
// wrapping subtraction is left to two's-complement, since every result feeds a
// bitwise operator.

/** One disturbance vector: the step to recompress from, its bit in the UBC
 *  mask, and the expanded-message XOR difference. */
export interface Sha1Dv {
  readonly testt: number;
  readonly maskb: number;
  readonly dm: readonly number[];
}

/** The ${rows.length} disturbance vectors checked by SHA-1DC. */
export const SHA1_DVS: readonly Sha1Dv[] = [
${dvLines}
];

/**
 * Check the unavoidable bit conditions for every DV against an expanded
 * message block. Returns a mask whose bit \`maskb\` is set when every UBC for
 * that DV holds, i.e. when the DV is worth the cost of a recompression check.
 */
export function ubcCheck(W: Int32Array): number {
  let mask = ~0;
${js.replace(/\n\t/g, "\n  ").replace(/\t/g, "  ").trimEnd()}
  return mask;
}
`
);
console.log(`wrote ${OUT}: ${rows.length} DVs, ${stmts.length} UBC statements`);
