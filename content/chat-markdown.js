"use strict";
// Renders the assistant's Markdown replies in the chat. The reply is parsed into a small tree and built
// with DOM calls only (no innerHTML), so anything in a reply stays text. Math goes through KaTeX when the
// page has it; links open through the host, which only allows http(s) and mailto.
var NoctuaMarkdown = (() => {
  // ------------------------------------------------------------ inline
  const PUNCT = /[\s.,;:!?)\]}'"*_~-]/;
  function closing(text, from, marker) {
    // The closing marker must follow a non-space character.
    for (let at = text.indexOf(marker, from); at >= 0; at = text.indexOf(marker, at + 1)) {
      if (at > from && !/\s/.test(text[at - 1])) return at;
    }
    return -1;
  }
  function inline(text) {
    const out = [];
    let plain = "";
    const flush = () => { if (plain) { out.push({ t: "text", v: plain }); plain = ""; } };
    for (let i = 0; i < text.length; ) {
      const c = text[i], rest = text.slice(i);
      // Backslash escapes: \* \_ \` \$ ... (but \( \) \[ \] start math)
      if (c === "\\" && /^\\[()]/.test(rest)) {
        const end = text.indexOf("\\)", i + 2);
        if (rest[1] === "(" && end > i) { flush(); out.push({ t: "math", v: text.slice(i + 2, end) }); i = end + 2; continue; }
      }
      if (c === "\\" && /[\\`*_{}[\]()#+\-.!|~$<>]/.test(text[i + 1] || "")) { plain += text[i + 1]; i += 2; continue; }
      if (c === "`") {
        const ticks = /^`+/.exec(rest)[0], end = text.indexOf(ticks, i + ticks.length);
        if (end > i) { flush(); out.push({ t: "code", v: text.slice(i + ticks.length, end).replace(/^ (.+) $/, "$1") }); i = end + ticks.length; continue; }
        plain += ticks; i += ticks.length; continue;
      }
      if (c === "$") {
        // $x$ needs a non-space after the opening and before the closing $, and no digit after it (so "$5 and $10" stays text).
        if (rest[1] === "$") {
          const end = text.indexOf("$$", i + 2);
          if (end > i + 2) { flush(); out.push({ t: "math", v: text.slice(i + 2, end), display: true }); i = end + 2; continue; }
        } else if (rest[1] && !/\s/.test(rest[1])) {
          let end = -1;
          for (let j = i + 1; j < text.length; j++) {
            if (text[j] === "\\") { j++; continue; }
            if (text[j] === "$") { if (!/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] || "")) end = j; break; }
          }
          if (end > i + 1) { flush(); out.push({ t: "math", v: text.slice(i + 1, end) }); i = end + 1; continue; }
        }
      }
      if ((c === "*" || c === "_") && rest[1] === c) {
        const end = closing(text, i + 2, c + c);
        const opensWord = c === "*" || i === 0 || PUNCT.test(text[i - 1]);
        if (end > i + 2 && opensWord && !/\s/.test(rest[2])) { flush(); out.push({ t: "strong", c: inline(text.slice(i + 2, end)) }); i = end + 2; continue; }
      }
      if ((c === "*" || c === "_") && rest[1] !== c && rest[1] && !/\s/.test(rest[1])) {
        const opensWord = c === "*" || i === 0 || PUNCT.test(text[i - 1]);
        let end = closing(text, i + 1, c);
        while (end > 0 && text[end + 1] === c) end = closing(text, end + 2, c);
        const closesWord = end > 0 && (c === "*" || end + 1 >= text.length || PUNCT.test(text[end + 1]));
        if (opensWord && closesWord) { flush(); out.push({ t: "em", c: inline(text.slice(i + 1, end)) }); i = end + 1; continue; }
      }
      if (c === "~" && rest[1] === "~") {
        const end = closing(text, i + 2, "~~");
        if (end > i + 2) { flush(); out.push({ t: "del", c: inline(text.slice(i + 2, end)) }); i = end + 2; continue; }
      }
      if (c === "[") {
        const m = /^\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
        if (m) { flush(); out.push({ t: "link", href: m[2], c: inline(m[1]) }); i += m[0].length; continue; }
      }
      const auto = /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_\]])/.exec(rest);
      if (auto && (i === 0 || /[\s(]/.test(text[i - 1]))) { flush(); out.push({ t: "link", href: auto[1], c: [{ t: "text", v: auto[1] }] }); i += auto[1].length; continue; }
      plain += c; i++;
    }
    flush();
    return out;
  }

  // ------------------------------------------------------------ blocks
  const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const isRule = line => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
  const isTableSep = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
  const cellsOf = line => {
    let body = line.trim();
    if (body.startsWith("|")) body = body.slice(1);
    if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
    const cells = [];
    let cell = "";
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\" && body[i + 1] === "|") { cell += "|"; i++; continue; }
      if (body[i] === "`") { const end = body.indexOf("`", i + 1); if (end > i) { cell += body.slice(i, end + 1); i = end; continue; } }
      if (body[i] === "|") { cells.push(cell.trim()); cell = ""; continue; }
      cell += body[i];
    }
    cells.push(cell.trim());
    return cells;
  };
  const indentOf = line => /^\s*/.exec(line)[0].replace(/\t/g, "    ").length;

  function parse(source) {
    const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    return blocks(lines, 0);
  }
  function blocks(lines, depth) {
    const out = [];
    let para = [];
    const flush = () => { if (para.length) { out.push({ t: "p", lines: para.map(inline) }); para = []; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { flush(); continue; }
      const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
      if (fence) {
        flush();
        const code = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
        out.push({ t: "pre", lang: fence[2] || "", v: code.join("\n") });
        continue;
      }
      // Display math on its own lines: $$ ... $$ or \[ ... \]
      const open = /^\s*(\$\$|\\\[)(.*)$/.exec(line);
      if (open) {
        const close = open[1] === "$$" ? "$$" : "\\]";
        const first = open[2];
        const atEnd = first.indexOf(close);
        if (atEnd >= 0 && !first.slice(atEnd + close.length).trim()) { flush(); out.push({ t: "math", v: first.slice(0, atEnd) }); continue; }
        if (atEnd < 0) {
          let end = -1;
          for (let j = i + 1; j < lines.length; j++) if (lines[j].includes(close)) { end = j; break; }
          if (end > 0 && !lines[end].slice(lines[end].indexOf(close) + close.length).trim()) {
            flush();
            out.push({ t: "math", v: [first, ...lines.slice(i + 1, end), lines[end].slice(0, lines[end].indexOf(close))].join("\n") });
            i = end;
            continue;
          }
        }
      }
      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) { flush(); out.push({ t: "h", level: heading[1].length, c: inline(heading[2]) }); continue; }
      if (isRule(line)) { flush(); out.push({ t: "hr" }); continue; }
      if (/^\s{0,3}>/.test(line)) {
        flush();
        const quoted = [];
        for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i--;
        out.push({ t: "quote", c: depth < 8 ? blocks(quoted, depth + 1) : [{ t: "p", lines: quoted.map(inline) }] });
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const head = cellsOf(line), aligns = cellsOf(lines[i + 1]).map(s => /^:-+:$/.test(s) ? "center" : /-:$/.test(s) ? "right" : /^:-/.test(s) ? "left" : "");
        const rows = [];
        for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(cellsOf(lines[i]).map(inline));
        i--;
        out.push({ t: "table", head: head.map(inline), aligns, rows });
        continue;
      }
      const item = BULLET.exec(line);
      if (item && (para.length === 0 || item[1].length === 0)) {
        flush();
        const base = indentOf(line), ordered = /\d/.test(item[2]);
        const list = { t: ordered ? "ol" : "ul", start: ordered ? parseInt(item[2], 10) : 1, items: [] };
        let body = null;
        for (; i < lines.length; i++) {
          const current = lines[i], bullet = BULLET.exec(current);
          if (bullet && indentOf(current) === base && /\d/.test(bullet[2]) === ordered) { body = [bullet[3]]; list.items.push(body); continue; }
          if (!current.trim()) {
            // A blank line ends the list unless the next line continues it (indented, or another item).
            const next = lines[i + 1];
            if (next !== undefined && (indentOf(next) > base || (BULLET.exec(next) && indentOf(next) === base))) { body.push(""); continue; }
            break;
          }
          if (indentOf(current) > base) { body.push(current.slice(Math.min(indentOf(current), base + 4))); continue; }
          if (!bullet && body && !BULLET.exec(current) && !/^\s*(#|>|```|~~~)/.test(current)) { body.push(current.trim()); continue; }  // lazy continuation
          break;
        }
        i--;
        list.items = list.items.map(lines2 => depth < 8 ? blocks(lines2, depth + 1) : [{ t: "p", lines: lines2.map(inline) }]);
        out.push(list);
        continue;
      }
      para.push(line.trim());
    }
    flush();
    return out;
  }

  // ------------------------------------------------------------ DOM
  function render(document, source, { katex = null, openURL = null } = {}) {
    const frag = document.createDocumentFragment();
    const el = (tag, className) => { const node = document.createElement(tag); if (className) node.className = className; return node; };
    const math = (tex, display) => {
      const node = el(display ? "div" : "span", display ? "md-math-display" : "md-math");
      if (katex?.render) {
        try { katex.render(tex, node, { displayMode: !!display, throwOnError: false, strict: "ignore", trust: false, maxExpand: 500 }); return node; } catch (_) {}
      }
      node.textContent = display ? tex : "$" + tex + "$";
      return node;
    };
    const inlines = (parent, nodes) => {
      for (const n of nodes) {
        if (n.t === "text") parent.append(document.createTextNode(n.v));
        else if (n.t === "code") { const c = el("code"); c.textContent = n.v; parent.append(c); }
        else if (n.t === "math") parent.append(math(n.v, n.display));
        else if (n.t === "link") {
          const a = el("a");
          a.setAttribute("href", "#");
          a.title = n.href;
          a.dataset.href = n.href;
          inlines(a, n.c);
          a.addEventListener("click", event => { event.preventDefault(); if (/^(https?:|mailto:)/i.test(n.href)) openURL?.(n.href); });
          parent.append(a);
        } else { const node = el({ strong: "strong", em: "em", del: "del" }[n.t] || "span"); inlines(node, n.c || []); parent.append(node); }
      }
    };
    const build = (parent, list) => {
      for (const b of list) {
        if (b.t === "p") {
          const p = el("p");
          b.lines.forEach((line, n) => { if (n) p.append(el("br")); inlines(p, line); });
          parent.append(p);
        } else if (b.t === "h") { const h = el("h" + Math.min(6, b.level + 2)); inlines(h, b.c); parent.append(h); }  // replies' # headings stay small
        else if (b.t === "hr") parent.append(el("hr"));
        else if (b.t === "pre") { const pre = el("pre"), code = el("code"); code.textContent = b.v; if (b.lang) code.dataset.lang = b.lang; pre.append(code); parent.append(pre); }
        else if (b.t === "math") parent.append(math(b.v, true));
        else if (b.t === "quote") { const q = el("blockquote"); build(q, b.c); parent.append(q); }
        else if (b.t === "ul" || b.t === "ol") {
          const list = el(b.t);
          if (b.t === "ol" && b.start !== 1) list.setAttribute("start", String(b.start));
          for (const item of b.items) { const li = el("li"); build(li, item); list.append(li); }
          parent.append(list);
        } else if (b.t === "table") {
          const wrap = el("div", "md-table"), table = el("table"), thead = el("thead"), tbody = el("tbody"), tr = el("tr");
          b.head.forEach((cell, n) => { const th = el("th"); if (b.aligns[n]) th.style.textAlign = b.aligns[n]; inlines(th, cell); tr.append(th); });
          thead.append(tr);
          for (const row of b.rows) {
            const r = el("tr");
            b.head.forEach((_, n) => { const td = el("td"); if (b.aligns[n]) td.style.textAlign = b.aligns[n]; inlines(td, row[n] || []); r.append(td); });
            tbody.append(r);
          }
          table.append(thead, tbody); wrap.append(table); parent.append(wrap);
        }
      }
    };
    build(frag, parse(source));
    return frag;
  }

  return { parse, inline, render };
})();
if (typeof module !== "undefined") module.exports = NoctuaMarkdown;
