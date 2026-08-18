import { esc } from "./html";

/**
 * Compact markdown renderer for README/about pages. Supported: headings,
 * fenced code, lists, blockquotes, hr, links, images, emphasis, inline
 * code, autolinks. Not supported: tables, footnotes, raw HTML (everything
 * is escaped first; only http(s)/relative/# link targets are allowed).
 */

function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:)?\/\//i.test(u) || u.startsWith("#") || /^[\w./-]/.test(u)) {
    if (/^javascript:/i.test(u) || /^data:/i.test(u) || /^vbscript:/i.test(u)) return null;
    return u;
  }
  return null;
}

function inline(text: string): string {
  let s = esc(text);
  // inline code first (protects its content from other rules)
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // images
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, alt, url) => {
    const u = safeUrl(url);
    return u ? `<img src='${u}' alt='${alt}' style='max-width:100%'/>` : alt;
  });
  // links
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, txt, url) => {
    const u = safeUrl(url);
    return u ? `<a href='${u}'>${txt}</a>` : txt;
  });
  // bold, italics
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1<em>$2</em>");
  // autolink bare urls (not already inside an attribute)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, "$1<a href='$2'>$2</a>");
  return s;
}

export function renderMarkdown(src: string): string {
  const lines = src.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let listStack: ("ul" | "ol")[] = [];
  let quote = false;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join("\n"))}</p>`);
      para = [];
    }
  };
  const closeLists = (depth: number) => {
    while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
  };
  const closeQuote = () => {
    if (quote) {
      out.push("</blockquote>");
      quote = false;
    }
  };

  for (const raw of lines) {
    if (inCode) {
      if (/^\s*(```|~~~)\s*$/.test(raw)) {
        out.push(`<pre class='md-code'><code>${esc(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        codeLines.push(raw);
      }
      continue;
    }
    const fence = raw.match(/^\s*(```|~~~)\s*(\S*)\s*$/);
    if (fence) {
      flushPara();
      closeLists(0);
      closeQuote();
      inCode = true;
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeLists(0);
      closeQuote();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(raw)) {
      flushPara();
      closeLists(0);
      closeQuote();
      out.push("<hr/>");
      continue;
    }
    const bq = raw.match(/^\s*>\s?(.*)$/);
    if (bq) {
      flushPara();
      closeLists(0);
      if (!quote) {
        out.push("<blockquote>");
        quote = true;
      }
      out.push(inline(bq[1]) + "<br/>");
      continue;
    }
    const li = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      closeQuote();
      const depth = Math.min(Math.floor(li[1].length / 2), 3) + 1;
      const kind: "ul" | "ol" = /^[-*+]$/.test(li[2]) ? "ul" : "ol";
      while (listStack.length < depth) {
        out.push(`<${kind}>`);
        listStack.push(kind);
      }
      closeLists(depth);
      out.push(`<li>${inline(li[3])}</li>`);
      continue;
    }
    if (/^\s*$/.test(raw)) {
      flushPara();
      closeLists(0);
      closeQuote();
      continue;
    }
    // setext-ish: plain text joins the current paragraph
    closeLists(0);
    closeQuote();
    para.push(raw);
  }
  if (inCode) out.push(`<pre class='md-code'><code>${esc(codeLines.join("\n"))}</code></pre>`);
  flushPara();
  closeLists(0);
  closeQuote();
  return out.join("\n");
}
