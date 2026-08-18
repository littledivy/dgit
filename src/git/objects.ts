import { te, td, toHex, concat, sha1hex } from "./util";

export type ObjType = "commit" | "tree" | "blob" | "tag";

export const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_TYPE: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

export function objectHeader(type: ObjType, size: number): Uint8Array {
  return te.encode(`${type} ${size}\0`);
}

export function hashObject(type: ObjType, data: Uint8Array): string {
  return sha1hex(concat([objectHeader(type, data.length), data]));
}

export interface Person {
  name: string;
  email: string;
  /** unix seconds */
  time: number;
  tz: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
  /** first line of the message */
  subject: string;
}

export interface Tag {
  object: string;
  type: string;
  tag: string;
  tagger: Person | null;
  message: string;
}

export interface TreeEntry {
  mode: string; // e.g. "100644", "40000", "120000", "160000"
  name: string;
  oid: string;
}

function parsePerson(line: string): Person {
  // "Name <email> 1234567890 +0100"
  const m = line.match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
  if (!m) return { name: line, email: "", time: 0, tz: "+0000" };
  return { name: m[1], email: m[2], time: parseInt(m[3], 10), tz: m[4] };
}

function splitHeaders(text: string): { headers: [string, string][]; message: string } {
  const nn = text.indexOf("\n\n");
  const head = nn === -1 ? text : text.slice(0, nn);
  const message = nn === -1 ? "" : text.slice(nn + 2);
  const headers: [string, string][] = [];
  for (const line of head.split("\n")) {
    // continuation lines (gpgsig etc.) start with a space; append to previous
    if (line.startsWith(" ") && headers.length) {
      headers[headers.length - 1][1] += "\n" + line.slice(1);
      continue;
    }
    const sp = line.indexOf(" ");
    if (sp > 0) headers.push([line.slice(0, sp), line.slice(sp + 1)]);
  }
  return { headers, message };
}

export function parseCommit(data: Uint8Array): Commit {
  const { headers, message } = splitHeaders(td.decode(data));
  const c: Commit = {
    tree: "",
    parents: [],
    author: { name: "", email: "", time: 0, tz: "+0000" },
    committer: { name: "", email: "", time: 0, tz: "+0000" },
    message,
    subject: message.split("\n", 1)[0] ?? "",
  };
  for (const [k, v] of headers) {
    if (k === "tree") c.tree = v;
    else if (k === "parent") c.parents.push(v);
    else if (k === "author") c.author = parsePerson(v);
    else if (k === "committer") c.committer = parsePerson(v);
  }
  return c;
}

export function parseTag(data: Uint8Array): Tag {
  const { headers, message } = splitHeaders(td.decode(data));
  const t: Tag = { object: "", type: "", tag: "", tagger: null, message };
  for (const [k, v] of headers) {
    if (k === "object") t.object = v;
    else if (k === "type") t.type = v;
    else if (k === "tag") t.tag = v;
    else if (k === "tagger") t.tagger = parsePerson(v);
  }
  return t;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    let sp = pos;
    while (data[sp] !== 0x20) sp++;
    const mode = td.decode(data.subarray(pos, sp));
    let nul = sp + 1;
    while (data[nul] !== 0) nul++;
    const name = td.decode(data.subarray(sp + 1, nul));
    const oid = toHex(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

export function isGitlinkMode(mode: string): boolean {
  return mode === "160000";
}

/** Render a tree-entry mode the way cgit/ls-tree does: d rwx r-x r-x etc. */
export function modeString(mode: string): string {
  const m = parseInt(mode, 8);
  if (isTreeMode(mode)) return "d---------";
  if (isGitlinkMode(mode)) return "m---------";
  if ((m & 0o170000) === 0o120000) return "lrwxrwxrwx";
  const bits = (n: number) => `${n & 4 ? "r" : "-"}${n & 2 ? "w" : "-"}${n & 1 ? "x" : "-"}`;
  return `-${bits((m >> 6) & 7)}${bits((m >> 3) & 7)}${bits(m & 7)}`;
}
