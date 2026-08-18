import { esc } from "./html";

/**
 * Small regex-based syntax highlighter. Returns per-line HTML (tokens never
 * cross line boundaries in the output, so callers can add line numbers).
 */

interface Lang {
  keywords: Set<string>;
  lineComment?: string;
  blockComment?: [string, string];
  strings: string[]; // quote delimiters
  hashComment?: boolean;
}

const KW = (s: string) => new Set(s.split(" "));

const C_LIKE = "if else for while do switch case default break continue return goto typedef struct union enum const static volatile extern register signed unsigned void char short int long float double sizeof inline restrict bool true false NULL nullptr class public private protected virtual override new delete namespace using template typename this try catch throw operator friend constexpr auto";
const JS = "abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface is keyof let module namespace never new null number object of package private protected public readonly return set static string super switch symbol this throw true try type typeof undefined var void while with yield";
const PY = "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self match case";
const GO = "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota make new len cap append copy delete panic recover error string int int8 int16 int32 int64 uint byte rune float32 float64 bool";
const RS = "as break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await union box Some None Ok Err String Vec Option Result";
const SH = "if then else elif fi for while until do done case esac function in select time coproc return exit break continue local export readonly declare unset shift source alias echo printf read cd test set";
const RB = "BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative attr_accessor puts";
const JAVA = "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record sealed permits";
const SQL = "select from where insert into values update delete create table index view drop alter add primary key foreign references not null unique default check constraint join left right inner outer on as order by group having limit offset union all distinct and or in exists between like is case when then else end begin commit rollback transaction";

const LANGS: Record<string, Lang> = {
  js: { keywords: KW(JS), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  py: { keywords: KW(PY), hashComment: true, strings: ['"""', "'''", '"', "'"] },
  go: { keywords: KW(GO), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  rs: { keywords: KW(RS), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  c: { keywords: KW(C_LIKE), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'"] },
  sh: { keywords: KW(SH), hashComment: true, strings: ['"', "'"] },
  rb: { keywords: KW(RB), hashComment: true, strings: ['"', "'"] },
  java: { keywords: KW(JAVA), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'"] },
  sql: { keywords: KW(SQL), lineComment: "--", blockComment: ["/*", "*/"], strings: ["'"] },
  css: { keywords: new Set(), blockComment: ["/*", "*/"], strings: ['"', "'"] },
  json: { keywords: KW("true false null"), strings: ['"'] },
  toml: { keywords: KW("true false"), hashComment: true, strings: ['"', "'"] },
  yaml: { keywords: KW("true false null yes no"), hashComment: true, strings: ['"', "'"] },
};

const EXT_LANG: Record<string, string> = {
  js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js",
  py: "py", pyi: "py",
  go: "go",
  rs: "rs",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c", m: "c", java: "java", kt: "java", scala: "java", cs: "java", swift: "java",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh", makefile: "sh",
  rb: "rb", pl: "rb", php: "rb",
  sql: "sql",
  css: "css", scss: "css", less: "css",
  json: "json", jsonc: "json",
  toml: "toml", ini: "toml", cfg: "toml",
  yaml: "yaml", yml: "yaml",
};

interface Token {
  cls: string | null;
  text: string;
}

function tokenize(src: string, lang: Lang): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  let plain = "";
  const flushPlain = () => {
    if (plain) {
      tokens.push({ cls: null, text: plain });
      plain = "";
    }
  };
  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);

  outer: while (i < n) {
    const c = src[i];
    // comments
    if (lang.lineComment && src.startsWith(lang.lineComment, i)) {
      flushPlain();
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      tokens.push({ cls: "hl-c", text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (lang.hashComment && c === "#") {
      flushPlain();
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      tokens.push({ cls: "hl-c", text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (lang.blockComment && src.startsWith(lang.blockComment[0], i)) {
      flushPlain();
      let j = src.indexOf(lang.blockComment[1], i + lang.blockComment[0].length);
      j = j === -1 ? n : j + lang.blockComment[1].length;
      tokens.push({ cls: "hl-c", text: src.slice(i, j) });
      i = j;
      continue;
    }
    // strings
    for (const q of lang.strings) {
      if (src.startsWith(q, i)) {
        flushPlain();
        let j = i + q.length;
        while (j < n) {
          if (src[j] === "\\") {
            j += 2;
            continue;
          }
          if (src.startsWith(q, j)) {
            j += q.length;
            break;
          }
          // single-quote strings don't span lines (heuristic)
          if (q.length === 1 && q !== "`" && src[j] === "\n") break;
          j++;
        }
        tokens.push({ cls: "hl-s", text: src.slice(i, Math.min(j, n)) });
        i = Math.min(j, n);
        continue outer;
      }
    }
    // numbers
    if (/[0-9]/.test(c) && (i === 0 || !isWord(src[i - 1]))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObB._]/.test(src[j])) j++;
      flushPlain();
      tokens.push({ cls: "hl-n", text: src.slice(i, j) });
      i = j;
      continue;
    }
    // words
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && isWord(src[j])) j++;
      const word = src.slice(i, j);
      if (lang.keywords.has(word)) {
        flushPlain();
        tokens.push({ cls: "hl-k", text: word });
      } else {
        plain += word;
      }
      i = j;
      continue;
    }
    plain += c;
    i++;
  }
  flushPlain();
  return tokens;
}

/** Highlight source; returns one HTML string per line (already escaped). */
export function highlightLines(src: string, filename: string): string[] {
  const base = filename.toLowerCase();
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
  const langKey = EXT_LANG[ext];
  const plainLines = src.split("\n");
  if (plainLines[plainLines.length - 1] === "") plainLines.pop();
  if (!langKey || src.length > 512 * 1024) {
    return plainLines.map((l) => esc(l));
  }
  const tokens = tokenize(src, LANGS[langKey]);
  const lines: string[] = [];
  let cur = "";
  for (const t of tokens) {
    const parts = t.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push(cur);
        cur = "";
      }
      if (parts[i]) {
        cur += t.cls ? `<span class='${t.cls}'>${esc(parts[i])}</span>` : esc(parts[i]);
      }
    }
  }
  lines.push(cur);
  if (lines[lines.length - 1] === "" && lines.length > plainLines.length) lines.pop();
  while (lines.length < plainLines.length) lines.push("");
  return lines.slice(0, plainLines.length || 1);
}
