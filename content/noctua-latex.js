'use strict';
// A LaTeX-subset typesetter for Noctua notes. Math goes to KaTeX; the
// surrounding document structure (sections, lists, theorem-likes, proofs,
// equation numbers, \label/\ref, \cite) is handled here. All literal text is
// HTML-escaped, so a note can never inject markup.
//
//   NoctuaLatex.renderDoc(sources, { cite(keys, { textual, note }) -> html })
//     sources: one string per text block, or null for a drawing (which ends
//     the paragraph flow, like a figure). Returns one HTML string per source.
//     Numbering and labels run across the whole note. `opts.preamble`: the
//     note's preamble, whose \newcommand etc. apply to every block.
//     `opts.image(path) -> url | null` resolves \includegraphics paths.

const NoctuaLatex = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const THEOREMS = {
    theorem: ['Theorem', 'plain'], lemma: ['Lemma', 'plain'], proposition: ['Proposition', 'plain'],
    corollary: ['Corollary', 'plain'], conjecture: ['Conjecture', 'plain'], claim: ['Claim', 'plain'],
    definition: ['Definition', 'definition'], example: ['Example', 'definition'], problem: ['Problem', 'definition'],
    question: ['Question', 'definition'], exercise: ['Exercise', 'definition'], assumption: ['Assumption', 'definition'],
    remark: ['Remark', 'remark'], note: ['Note', 'remark'],
  };
  const MATH_ENVS = new Set(['equation', 'align', 'gather', 'multline', 'alignat', 'displaymath', 'eqnarray']);
  const HEADINGS = { section: 0, subsection: 1, subsubsection: 2 };

  // ------------------------------------------------------------ scanning helpers

  // `s[i]` is '{' (or '['); returns { text, end } with end just past the match.
  function group(s, i, open = '{', close = '}') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
    }
    return { text: s.slice(i + 1), end: s.length };
  }

  const skipSpace = (s, i) => { while (i < s.length && /[ \t]/.test(s[i])) i++; return i; };

  // Optional [..] argument at i (after spaces).
  function optArg(s, i) {
    const j = skipSpace(s, i);
    if (s[j] !== '[') return { text: null, end: i };
    return group(s, j, '[', ']');
  }

  function reqArg(s, i) {
    const j = skipSpace(s, i);
    if (s[j] !== '{') return { text: '', end: i };
    return group(s, j);
  }

  // Index of the matching \end{env} for a \begin{env} whose body starts at i.
  function findEnd(s, i, env) {
    const open = `\\begin{${env}}`, close = `\\end{${env}}`;
    let depth = 1;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '\\' && s.startsWith(open, j)) { depth++; j += open.length - 1; }
      else if (s[j] === '\\' && s.startsWith(close, j)) { if (--depth === 0) return j; j += close.length - 1; }
      else if (s[j] === '\\') j++;
    }
    return -1;
  }

  // End of an inline math span starting at i ('$' or '\('), or -1.
  function mathEnd(s, i) {
    if (s[i] === '$') {
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '$') return j + 1;
      }
      return -1;
    }
    const e = s.indexOf('\\)', i + 2);
    return e < 0 ? -1 : e + 2;
  }

  // Splits at top-level occurrences of `sep` (outside braces and nested envs).
  function splitTop(s, sep) {
    const out = [];
    let depth = 0, envDepth = 0, last = 0;
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') {
        if (s.startsWith('\\begin{', j)) envDepth++;
        else if (s.startsWith('\\end{', j)) envDepth--;
        else if (!depth && !envDepth && s.startsWith(sep, j)) { out.push(s.slice(last, j)); last = j + sep.length; j += sep.length - 1; continue; }
        j++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    out.push(s.slice(last));
    return out;
  }

  function stripComments(s) {
    return s.replace(/(^|[^\\])%.*$/gm, '$1');
  }

  // Pulls \newcommand/\renewcommand/\def/\DeclareMathOperator definitions out of the text into `macros`.
  function extractMacros(s, macros) {
    const re = /\\(?:re)?newcommand\*?\s*|\\def\s*|\\DeclareMathOperator(\*?)\s*/g;
    let out = '', last = 0, m;
    while ((m = re.exec(s))) {
      let i = re.lastIndex, name;
      if (s[i] === '{') { const g = group(s, i); name = g.text.trim(); i = g.end; }
      else { const n = /^\\[A-Za-z]+/.exec(s.slice(i)); if (!n) continue; name = n[0]; i += name.length; }
      if (!/^\\[A-Za-z]+$/.test(name)) continue;
      const args = optArg(s, i);           // [n] argument count (KaTeX uses #1..#n as-is)
      if (args.text !== null) i = args.end;
      if (m[0].startsWith('\\def')) { while (i < s.length && s[i] !== '{') i++; }
      const body = reqArg(s, i);
      macros[name] = m[0].startsWith('\\Declare') ? `\\operatorname${m[1]}{${body.text}}` : body.text;
      out += s.slice(last, m.index);
      last = body.end;
      re.lastIndex = body.end;
    }
    return out + s.slice(last);
  }

  // ------------------------------------------------------------ math

  function katexHtml(tex, display, st) {
    if (st.dry) return '';
    try {
      return katex.renderToString(tex, {
        displayMode: display, throwOnError: false, output: 'html', strict: 'ignore',
        macros: { ...st.macros }, trust: false,
      });
    } catch (e) {
      return `<span class="tex-error">${esc(tex)}</span>`;
    }
  }

  // Records \label{..} found in `tex` against `value` and removes them.
  const labelAnchor = key => `<span class="tex-anchor" data-tex-label="${esc(key)}"></span>`;
  function takeLabels(tex, value, st, anchors) {
    return tex.replace(/\\label\s*\{([^}]*)\}/g, (_, k) => {
      const key = k.trim();
      if (value != null) st.labels[key] = String(value);
      anchors.push(labelAnchor(key));
      return '';
    });
  }

  function display(body, env, st) {
    const anchors = [];
    let base = env ? env.replace('*', '') : null;
    // eqnarray is `a & = & b`; align wants `a &= b`, so fold the first two column marks together.
    if (base === 'eqnarray') { body = splitTop(body, '\\\\').map((row) => row.replace(/^([^&]*)&([^&]*)&/, '$1&$2 ')).join('\\\\'); base = 'align'; }
    const numbered = !!env && !env.endsWith('*') && base !== 'displaymath';
    const noNum = (t) => /\\(nonumber|notag)\b/.test(t);
    const clean = (t) => t.replace(/\\(nonumber|notag)\b/g, '');
    let tex;
    if (!base || base === 'equation' || base === 'displaymath') {
      let n = null;
      if (numbered && !noNum(body) && !/\\tag\b/.test(body)) n = ++st.eq;
      tex = clean(takeLabels(body, n, st, anchors)) + (n ? `\\tag{${n}}` : '');
    } else {
      // align / gather / alignat / multline: one number per row (multline: last row only).
      const head = base === 'alignat' ? (/^\s*\{[^}]*\}/.exec(body)?.[0] || '{1}') : '';
      const rows = splitTop(head ? body.slice(body.indexOf(head) + head.length) : body, '\\\\');
      const out = rows.map((row, k) => {
        const last = k === rows.length - 1;
        const wants = numbered && !noNum(row) && !/\\tag\b/.test(row) && row.trim() && (base !== 'multline' || last);
        const n = wants ? ++st.eq : null;
        return clean(takeLabels(row, n, st, anchors)) + (n ? ` \\tag{${n}}` : '');
      });
      const kat = base === 'multline' ? 'gather' : base;  // KaTeX has no multline
      tex = `\\begin{${kat}*}${head}${out.join('\\\\')}\\end{${kat}*}`;
    }
    return `<div class="tex-display">${anchors.join('')}${katexHtml(tex, true, st)}</div>`;
  }

  // ------------------------------------------------------------ inline text

  const SIMPLE = {
    '\\ldots': '…', '\\dots': '…', '\\S': '§', '\\P': '¶', '\\quad': ' ', '\\qquad': '  ',
    '\\,': ' ', '\\ ': ' ', '\\;': ' ', '\\!': '', '\\newline': '<br>', '\\noindent': '', '\\hfill': '',
    '\\par': '', '\\centering': '', '\\smallskip': '', '\\medskip': '', '\\bigskip': '', '\\copyright': '©',
    '\\LaTeX': '<span class="tex-logo">L<sup>a</sup>T<sub>e</sub>X</span>', '\\TeX': '<span class="tex-logo">T<sub>e</sub>X</span>',
    '\\textbackslash': '\\', '\\slash': '/', '\\hrule': '<hr class="tex-rule">', '\\newpage': '', '\\clearpage': '', '\\vfill': '', '\\hfil': '', '\\textendash': '–', '\\textemdash': '—',
  };
  const STYLE_ARG = {
    emph: ['<em>', '</em>'], textit: ['<i>', '</i>'], textbf: ['<b>', '</b>'], texttt: ['<code>', '</code>'],
    textsc: ['<span class="sc">', '</span>'], underline: ['<u>', '</u>'], textrm: ['', ''], text: ['', ''],
    textsf: ['<span class="sf">', '</span>'], textup: ['<span class="up">', '</span>'], mbox: ['', ''],
    textsuperscript: ['<sup>', '</sup>'], textsubscript: ['<sub>', '</sub>'],
  };
  const STYLE_SWITCH = { '\\bf': STYLE_ARG.textbf, '\\it': STYLE_ARG.textit, '\\em': STYLE_ARG.emph, '\\tt': STYLE_ARG.texttt, '\\sc': STYLE_ARG.textsc, '\\sf': STYLE_ARG.textsf };

  // Named colours and #rgb/#rrggbb only; anything else is ignored rather than passed to CSS.
  const safeColor = (c) => {
    const v = String(c).trim();
    return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) || /^[a-z]{3,20}$/i.test(v) ? v : null;
  };
  const safeUrl = (u) => /^(https?:|mailto:)/i.test(u.trim()) ? u.trim() : null;

  function inline(s, st) {
    let out = '', i = 0;
    const text = (t) => { out += esc(t); };
    while (i < s.length) {
      const c = s[i];
      if (c === '$' || s.startsWith('\\(', i)) {
        const e = mathEnd(s, i);
        if (e > 0) {
          const open = c === '$' ? 1 : 2;
          out += katexHtml(s.slice(i + open, e - open), false, st);
          i = e;
          continue;
        }
      }
      if (c === '\\') {
        if (s.startsWith('\\\\', i)) { out += '<br>'; i = optArg(s, i + 2).end; continue; }
        const sym = /^\\[%&$#_{}~^]/.exec(s.slice(i, i + 2));
        if (sym) { text(sym[0][1] === '~' ? '~' : sym[0][1] === '^' ? '^' : sym[0][1]); i += 2; continue; }
        const m = /^\\([A-Za-z]+\*?|[,;! ])/.exec(s.slice(i));
        if (!m) { text(c); i++; continue; }
        const cmd = m[1], whole = '\\' + cmd;
        let j = i + m[0].length;
        if (SIMPLE[whole] !== undefined) {
          out += SIMPLE[whole];
          if (/^[A-Za-z]/.test(cmd) && s[j] === ' ') j++;   // control words eat one space
          else if (s.startsWith('{}', j)) j += 2;
          i = j;
          continue;
        }
        if (STYLE_ARG[cmd]) {
          const a = reqArg(s, j);
          out += STYLE_ARG[cmd][0] + inline(a.text, st) + STYLE_ARG[cmd][1];
          i = a.end;
          continue;
        }
        if (cmd === 'cite' || cmd === 'citep' || cmd === 'citet' || cmd === 'citeauthor' || cmd === 'citeyear') {
          const note = optArg(s, j);
          const a = reqArg(s, note.end);
          const keys = a.text.split(',').map((k) => k.trim()).filter(Boolean);
          out += st.opts.cite ? st.opts.cite(keys, { textual: cmd === 'citet', note: note.text, kind: cmd })
            : `[${esc(keys.join(', '))}]`;
          i = a.end;
          continue;
        }
        if (cmd === 'includegraphics' || cmd === 'includevideo') {
          const o = optArg(s, j);
          const a = reqArg(s, o.end);
          out += graphic(o.text, a.text, st, cmd === 'includevideo');
          i = a.end;
          continue;
        }
        if (cmd === 'noteref') {
          const a = reqArg(s, j);
          out += st.opts.noteref ? st.opts.noteref(a.text.trim()) : `[${esc(a.text.trim())}]`;
          i = a.end;
          continue;
        }
        if (cmd === 'ref' || cmd === 'eqref' || cmd === 'autoref' || cmd === 'cref') {
          const a = reqArg(s, j);
          const v = st.labels[a.text.trim()];
          const shown = v == null ? '<span class="tex-missing">??</span>' : esc(v);
          const text = cmd === 'eqref' ? `(${shown})` : shown;
          out += v == null ? text : `<a class="tex-ref" href="#note-label-${encodeURIComponent(a.text.trim())}" data-tex-ref="${esc(a.text.trim())}">${text}</a>`;
          i = a.end;
          continue;
        }
        if (cmd === 'label') {
          const a = reqArg(s, j);
          if (st.current) st.labels[a.text.trim()] = st.current;
          out += labelAnchor(a.text.trim());
          i = a.end;
          continue;
        }
        if (cmd === 'href') {
          const u = reqArg(s, j), t = reqArg(s, u.end);
          const url = safeUrl(u.text);
          out += url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${inline(t.text, st)}</a>` : inline(t.text, st);
          i = t.end;
          continue;
        }
        if (cmd === 'url') {
          const u = reqArg(s, j);
          const url = safeUrl(u.text);
          out += url ? `<a href="${esc(url)}" target="_blank" rel="noopener"><code>${esc(u.text)}</code></a>` : `<code>${esc(u.text)}</code>`;
          i = u.end;
          continue;
        }
        if (cmd === 'footnote') {
          const a = reqArg(s, j);
          out += `<sup class="tex-fn" title="${esc(a.text)}">${++st.fn}</sup>`;
          i = a.end;
          continue;
        }
        if (cmd === 'vspace' || cmd === 'hspace' || cmd === 'vspace*' || cmd === 'hspace*' || cmd === 'vskip' || cmd === 'hskip') {
          // Spacing commands carry a length; the preview ignores them but must not print it.
          i = cmd === 'vskip' || cmd === 'hskip' ? j + (/^\s*[-+\d.]+\s*[a-z]{2}(?:\s+plus\s+[-+\d.]+\s*[a-z]{2})?/i.exec(s.slice(j))?.[0].length || 0) : reqArg(s, j).end;
          continue;
        }
        if (cmd === 'title' || cmd === 'author' || cmd === 'date') {
          const a = reqArg(s, j);
          (st.meta ||= {})[cmd] = a.text;
          i = a.end;
          continue;
        }
        if (cmd === 'maketitle') {
          const meta = st.meta || {};
          out += `<div class="tex-title">${meta.title ? `<h1>${inline(meta.title, st)}</h1>` : ''}${meta.author ? `<p class="tex-author">${inline(meta.author, st)}</p>` : ''}${meta.date ? `<p class="tex-date">${inline(meta.date, st)}</p>` : ''}</div>`;
          i = j;
          continue;
        }
        if (cmd === 'textcolor' || cmd === 'colorbox') {
          const c = reqArg(s, j), a = reqArg(s, c.end), color = safeColor(c.text);
          out += color ? `<span style="${cmd === 'colorbox' ? 'background' : 'color'}:${color}">${inline(a.text, st)}</span>` : inline(a.text, st);
          i = a.end;
          continue;
        }
        if (cmd === 'today') { text(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })); i = j; continue; }
        if (STYLE_SWITCH[whole]) { i = j; continue; }  // only meaningful inside a {..} group, handled below
        // Unknown command: show it, muted, rather than silently dropping it.
        out += `<span class="tex-unknown">${esc(whole)}</span>`;
        i = j;
        continue;
      }
      if (c === '{') {
        const g = group(s, i);
        const sw = /^\s*(\\[A-Za-z]+)\b\s*/.exec(g.text);
        const colored = /^\s*\\color\s*\{([^}]*)\}\s*/.exec(g.text);
        if (colored) {
          const color = safeColor(colored[1]);
          const inner = inline(g.text.slice(colored[0].length), st);
          out += color ? `<span style="color:${color}">${inner}</span>` : inner;
        } else if (sw && STYLE_SWITCH[sw[1]]) {
          const [o, cl] = STYLE_SWITCH[sw[1]];
          out += o + inline(g.text.slice(sw[0].length), st) + cl;
        } else out += inline(g.text, st);
        i = g.end;
        continue;
      }
      if (c === '}') { i++; continue; }
      if (s.startsWith('~~', i) && /\S/.test(s[i + 2] || '')) {
        const e = s.indexOf('~~', i + 2);
        if (e > i + 2 && /\S/.test(s[e - 1])) { out += `<s>${inline(s.slice(i + 2, e), st)}</s>`; i = e + 2; continue; }
      }
      if (c === '~') { out += '&nbsp;'; i++; continue; }
      if (s.startsWith('---', i)) { out += '—'; i += 3; continue; }
      if (s.startsWith('--', i)) { out += '–'; i += 2; continue; }
      if (s.startsWith('``', i)) { out += '“'; i += 2; continue; }
      if (s.startsWith("''", i)) { out += '”'; i += 2; continue; }
      // Markdown emphasis and code. Delimiters must hug the text, so `2 * 3 * 4` stays arithmetic.
      if (s.startsWith('**', i) && /\S/.test(s[i + 2] || '')) {
        const e = s.indexOf('**', i + 2);
        if (e > i + 2 && /\S/.test(s[e - 1]) && !s.slice(i, e).includes('\n\n')) { out += `<b>${inline(s.slice(i + 2, e), st)}</b>`; i = e + 2; continue; }
      }
      if (c === '*' && s[i + 1] !== '*' && /\S/.test(s[i + 1] || '')) {
        let e = i + 1;
        while ((e = s.indexOf('*', e)) >= 0 && (s[e + 1] === '*' || !/\S/.test(s[e - 1]))) e += s[e + 1] === '*' ? 2 : 1;
        if (e > i + 1 && !s.slice(i, e).includes('\n\n')) { out += `<em>${inline(s.slice(i + 1, e), st)}</em>`; i = e + 1; continue; }
      }
      if (c === '`' && s[i + 1] !== '`' && s[i - 1] !== '`') {
        const e = s.indexOf('`', i + 1);
        if (e > i + 1 && !s.slice(i, e).includes('\n') && s[e + 1] !== '`') { out += `<code>${esc(s.slice(i + 1, e))}</code>`; i = e + 1; continue; }
      }
      if (c === '`') { out += '‘'; i++; continue; }
      if (c === "'") { out += '’'; i++; continue; }
      if (c === '\n') { out += ' '; i++; continue; }
      text(c);
      i++;
    }
    return out;
  }

  // ------------------------------------------------------------ figures

  // `width=0.5\textwidth` (or \linewidth, \columnwidth; bare means 1) -> 0.5, else null.
  function widthFrac(o) {
    const m = /(?:^|,)\s*width\s*=\s*(\d*\.?\d*)\s*\\(?:textwidth|linewidth|columnwidth)(?![A-Za-z])/.exec(o || '');
    return m ? (m[1] === '' ? 1 : parseFloat(m[1])) : null;
  }
  const pct = (f) => +(f * 100).toFixed(2);

  // \includegraphics -> an image. data-img numbers the images of a block in
  // source order, so the editor can map a clicked image back to its source.
  function graphic(opts, path, st, video = false) {
    const k = st.img++;
    const w = widthFrac(opts);
    const style = w != null ? ` style="width:${pct(w)}%"` : '';
    const src = st.opts.image ? st.opts.image(path.trim()) : null;
    if (!src) return `<span class="tex-img missing" data-img="${k}"${style}>missing media: ${esc(path)}</span>`;
    if (video) return `<span class="tex-img tex-video" data-img="${k}"${style}><video src="${esc(src)}" controls playsinline preload="metadata" aria-label="${esc(path)}"></video><span class="video-error" hidden>Cannot play this video. Try MP4 with H.264 video and AAC audio.</span></span>`;
    return `<span class="tex-img" data-img="${k}"${style}><img src="${esc(src)}" alt="${esc(path)}" draggable="false"></span>`;
  }

  // The body of a figure (num set) or subfigure (num null): its items in
  // source order, its caption, and whether \hfill spreads the row.
  const FIG_TOKEN = /\\begin\s*\{subfigure\}|\\caption(?![A-Za-z])\s*|\\(?:hfill|quad|qquad|centering)(?![A-Za-z])/y;
  function figParts(body, st, num) {
    const items = [];
    let caption = null, text = '', hfill = false, sub = 0, i = 0;
    const flush = () => { if (text.trim()) items.push(inline(text.trim(), st)); text = ''; };
    while (i < body.length) {
      FIG_TOKEN.lastIndex = i;
      const m = body[i] === '\\' ? FIG_TOKEN.exec(body) : null;
      if (!m) { text += body[i++]; continue; }
      flush();
      if (m[0].startsWith('\\begin')) {
        const w = reqArg(body, optArg(body, i + m[0].length).end);
        const end = findEnd(body, w.end, 'subfigure');
        if (!num) { i = end < 0 ? body.length : end + 15; continue; }  // no nesting
        const letter = String.fromCharCode(97 + sub++);
        st.current = num + letter;
        const p = figParts(end < 0 ? body.slice(w.end) : body.slice(w.end, end), st, null);
        st.current = String(num);
        const f = widthFrac('width=' + w.text.trim());
        items.push(`<div class="tex-subfig"${f != null ? ` style="width:${pct(f)}%"` : ''}>${p.items.join(' ')}<div class="tex-subcap">(${letter})${p.caption ? ' ' + p.caption : ''}</div></div>`);
        i = end < 0 ? body.length : end + '\\end{subfigure}'.length;
      } else if (m[0].startsWith('\\caption')) {
        const a = reqArg(body, optArg(body, i + m[0].length).end);
        caption = inline(a.text, st);
        i = a.end;
      } else {
        if (!m[0].includes('centering')) hfill = true;
        i += m[0].length;
      }
    }
    flush();
    return { items, caption, hfill };
  }

  function figure(body, st) {
    const num = ++st.fig;
    st.current = String(num);
    const p = figParts(body, st, num);
    const cap = p.caption == null ? '' : `<figcaption><span class="tex-fig-num">Figure ${num}:</span> ${p.caption}</figcaption>`;
    return `<figure class="tex-figure"><div class="tex-fig-row${p.hfill ? ' spread' : ''}">${p.items.join('')}</div>${cap}</figure>`;
  }


  // ------------------------------------------------------------ tables

  // Splits tabular text into rows and cells at top level only: braces and $math$
  // protect \\ and &, as do escaped \&.
  function tableRows(body) {
    const rows = [[]];
    let cell = '', depth = 0, math = false;
    const endCell = () => { rows[rows.length - 1].push(cell); cell = ''; };
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '\\') {
        if (body[i + 1] === '\\' && depth === 0 && !math) {
          endCell(); rows.push([]); i++;
          const o = /^\s*\[[^\]]*\]/.exec(body.slice(i + 1));
          if (o) i += o[0].length;
          continue;
        }
        cell += c + (body[i + 1] ?? ''); i++; continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth = Math.max(0, depth - 1);
      else if (c === '$' && depth === 0) math = !math;
      else if (c === '&' && depth === 0 && !math) { endCell(); continue; }
      cell += c;
    }
    endCell();
    return rows;
  }

  // Column spec like |l|c|r| or p{3cm}l -> ['left','center','right', ...].
  function columnAligns(spec) {
    const out = [];
    for (let i = 0; i < spec.length; i++) {
      const c = spec[i];
      if (c === 'l' || c === 'c' || c === 'r') out.push({ l: 'left', c: 'center', r: 'right' }[c]);
      else if ('pmbX'.includes(c)) { out.push('left'); if (spec[i + 1] === '{') i = group(spec, i + 1).end - 1; }
      else if ((c === '@' || c === '!' || c === '>' || c === '<') && spec[i + 1] === '{') i = group(spec, i + 1).end - 1;
    }
    return out;
  }

  const RULE = /^\s*\\(hline|toprule|midrule|bottomrule|cline\s*\{[^}]*\})/;
  function tabular(body, st) {
    const spec = reqArg(body, 0);
    const aligns = columnAligns(spec.text);
    const rows = tableRows(body.slice(spec.end));
    let html = '', bottom = false;
    rows.forEach((cells, r) => {
      let rule = false;
      let first = cells[0] || '';
      for (let m; (m = RULE.exec(first)); ) { rule = true; first = first.slice(m[0].length); }
      cells = [first, ...cells.slice(1)];
      const last = r === rows.length - 1;
      if (last && cells.length === 1 && !cells[0].replace(/\\(?:hline|toprule|midrule|bottomrule)/g, '').trim()) { bottom = bottom || rule || /\\(hline|bottomrule)/.test(cells[0]); return; }
      let col = 0, tds = '';
      for (let cell of cells) {
        cell = cell.trim();
        let span = 1, align = aligns[col] || 'left';
        const mc = /^\\multicolumn\s*(?=\{)/.exec(cell);
        if (mc) {
          const n = reqArg(cell, mc[0].length), sp = reqArg(cell, n.end), tx = reqArg(cell, sp.end);
          span = Math.max(1, parseInt(n.text, 10) || 1);
          align = columnAligns(sp.text)[0] || align;
          cell = tx.text;
        }
        tds += `<td${span > 1 ? ` colspan="${span}"` : ''} style="text-align:${align}">${inline(cell.trim(), st)}</td>`;
        col += span;
      }
      html += `<tr${rule ? ' class="rule"' : ''}>${tds}</tr>`;
    });
    return `<div class="tex-table-wrap"><table class="tex-table${bottom ? ' rule-bottom' : ''}"><tbody>${html}</tbody></table></div>`;
  }

  function tableFloat(body, st) {
    const num = ++st.tab;
    st.current = String(num);
    let caption = null;
    const at = body.search(/\\caption(?![A-Za-z])/);
    if (at >= 0) {
      const m = /^\\caption(?![A-Za-z])\s*/.exec(body.slice(at));
      const a = reqArg(body, optArg(body, at + m[0].length).end);
      caption = inline(a.text, st);
      body = body.slice(0, at) + body.slice(a.end);
    }
    const inner = blocks(body.replace(/\\centering(?![A-Za-z])/g, ''), { ...st, firstPara: true }, st);
    return `<figure class="tex-tablefloat">${caption == null ? '' : `<figcaption><span class="tex-fig-num">Table ${num}:</span> ${caption}</figcaption>`}${inner}</figure>`;
  }

  // GitHub-style pipe tables.
  const PIPE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  function pipeCells(line) {
    const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
    return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
  }
  function pipeTable(lines, st) {
    const aligns = pipeCells(lines[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
    const row = (line, tag) => `<tr>${pipeCells(line).map((c, k) => `<${tag} style="text-align:${aligns[k] || 'left'}">${inline(c, st)}</${tag}>`).join('')}</tr>`;
    return `<div class="tex-table-wrap"><table class="tex-table md"><thead>${row(lines[0], 'th')}</thead><tbody>${lines.slice(2).map((l) => row(l, 'td')).join('')}</tbody></table></div>`;
  }

  // ------------------------------------------------------------ block structure

  function heading(kind, star, title, st) {
    if (kind === 'paragraph') return null;  // run-in, handled by the caller
    const lvl = HEADINGS[kind];
    let num = '';
    if (!star) {
      st.sec[lvl]++;
      for (let k = lvl + 1; k < st.sec.length; k++) st.sec[k] = 0;
      num = st.sec.slice(0, lvl + 1).join('.');
      st.current = num;
    }
    const tag = ['h2', 'h3', 'h4'][lvl];
    return `<${tag} class="tex-h">${num ? `<span class="tex-secnum">${num}</span>` : ''}${inline(title, st)}</${tag}>`;
  }

  // Puts `head` at the start of the first paragraph of `html` (run-in heads).
  function runIn(head, html) {
    return /^<p[^>]*>/.test(html) ? html.replace(/^(<p[^>]*>)/, `$1${head} `) : `<p class="noindent">${head}</p>${html}`;
  }

  function environment(env, opt, body, st) {
    const base = env.replace('*', '');
    if (MATH_ENVS.has(base)) return display(body, env, st);
    if (base === 'itemize' || base === 'enumerate' || base === 'description') {
      const items = splitTop(body, '\\item').slice(1);
      const lis = items.map((it) => {
        let label = null;
        const o = optArg(it, 0);
        if (o.text !== null) { label = o.text; it = it.slice(o.end); }
        const inner = blocks(it, { ...st, inList: true, firstPara: true }, st);
        if (base === 'description') return `<dt>${inline(label || '', st)}</dt><dd>${inner}</dd>`;
        return `<li${label !== null ? ` class="custom" data-label="${esc(label)}"` : ''}>${label !== null ? `<span class="tex-label">${inline(label, st)}</span>` : ''}${inner}</li>`;
      }).join('');
      const tag = base === 'enumerate' ? 'ol' : base === 'description' ? 'dl' : 'ul';
      return `<${tag} class="tex-list">${lis}</${tag}>`;
    }
    if (THEOREMS[base]) {
      const [name, style] = THEOREMS[base];
      let num = '';
      if (!env.endsWith('*')) { num = String(++st.thm); st.current = num; }
      const head = `<span class="tex-thm-head">${name}${num ? ' ' + num : ''}${opt ? ` <span class="tex-thm-note">(${inline(opt, st)})</span>` : ''}.</span>`;
      const inner = blocks(body, { ...st, firstPara: true }, st);
      return `<div class="tex-thm ${style}">${runIn(head, inner)}</div>`;
    }
    if (base === 'proof') {
      const head = `<span class="tex-proof-head">${opt ? inline(opt, st) : 'Proof'}.</span>`;
      let inner = runIn(head, blocks(body, { ...st, firstPara: true }, st));
      const qed = '<span class="tex-qed">∎</span>';
      inner = /<\/p>$/.test(inner) ? inner.replace(/<\/p>$/, `${qed}</p>`) : inner + `<p class="noindent">${qed}</p>`;
      return `<div class="tex-proof">${inner}</div>`;
    }
    if (base === 'center' || base === 'quote' || base === 'quotation' || base === 'abstract') {
      const inner = blocks(body, { ...st, firstPara: true }, st);
      return `<div class="tex-${base}">${base === 'abstract' ? '<div class="tex-abstract-head">Abstract</div>' : ''}${inner}</div>`;
    }
    if (base === 'figure') return figure(body, st);
    if (base === 'tabular' || base === 'tabularx' || base === 'longtable') return tabular(body, st);
    if (base === 'table') return tableFloat(body, st);
    if (base === 'verbatim') return `<pre class="tex-verbatim">${esc(body.replace(/^\n/, ''))}</pre>`;
    return `<div class="tex-env"><span class="tex-unknown">${esc(env)}</span>${blocks(body, { ...st, firstPara: true }, st)}</div>`;
  }

  // Parses paragraphs and block constructs. `child` state shares counters and
  // labels with `root` (objects are shared by reference; numbers are copied
  // back after nested calls).
  // Only standalone links on trusted YouTube hosts become players.
  function youtubeEmbed(link) {
    const url = /^https?:\/\/(?:www\.|m\.)?(youtube\.com|youtu\.be)\/([^\s<>"']*)$/i.exec(link);
    if (!url) return '';
    const path = url[2];
    const id = url[1].toLowerCase() === 'youtu.be'
      ? /^([\w-]{11})(?:[?#]|$)/.exec(path)?.[1]
      : /^(?:shorts|live|embed)\/([\w-]{11})(?:[?#]|$)/.exec(path)?.[1]
        || (/^watch\?/.test(path) ? /[?&]v=([\w-]{11})(?:[&#]|$)/.exec(path)?.[1] : null);
    if (!id) return '';
    const time = /[?&#](?:t|start)=([\dhms]+)(?:[&#]|$)/.exec(path)?.[1] || '';
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(time);
    const seconds = /^\d+$/.test(time) ? Number(time) : parts ? Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0) : 0;
    const start = Number.isSafeInteger(seconds) && seconds > 0 ? `?start=${seconds}` : '';
    // The player itself is attached by the editor with DOM APIs: privileged documents
    // strip <iframe> from innerHTML, and only validated IDs may become players.
    return `<div class="tex-youtube" data-yt-id="${id}" data-yt-start="${seconds > 0 && start ? seconds : 0}"><a class="tex-yt-link" href="https://www.youtube.com/watch?v=${id}${seconds > 0 && start ? '&t=' + seconds : ''}" target="_blank" rel="noopener">▶ Watch on YouTube</a></div>`;
  }

  const MD_BULLET = /^\s{0,3}([-*+])\s+(\S.*)$/, MD_NUMBER = /^\s{0,3}(\d{1,3})[.)]\s+(\S.*)$/;
  function markdownLine(s, i, lineEnd, line, st) {
    const h = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const kind = ['section', 'subsection', 'subsubsection', 'paragraph'][h[1].length - 1];
      return {html: kind === 'paragraph' ? `<p class="noindent">${inline(`\\textbf{${h[2]}}`, st)}</p>` : heading(kind, '*', h[2], st), end: lineEnd, heading: true};
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return {html: '<hr class="tex-rule">', end: lineEnd};
    const fence = /^\s*(```|~~~)\s*\S*\s*$/.exec(line);
    if (fence) {
      const close = new RegExp('^\\s*' + fence[1] + '\\s*$', 'm');
      const rest = s.slice(lineEnd + 1), m = close.exec(rest);
      const code = m ? rest.slice(0, m.index) : rest;
      return {html: `<pre class="tex-verbatim">${esc(code.replace(/\n$/, ''))}</pre>`, end: m ? lineEnd + 1 + m.index + m[0].length : s.length};
    }
    if (/^\s{0,3}>/.test(line)) {
      const lines = [];
      let k = i;
      while (k < s.length) {
        const e = s.indexOf('\n', k), stop = e < 0 ? s.length : e, l = s.slice(k, stop);
        if (!/^\s{0,3}>/.test(l)) break;
        lines.push(l.replace(/^\s{0,3}>\s?/, ''));
        k = stop + 1;
      }
      return {html: `<div class="tex-quote">${blocks(lines.join('\n'), {...st, firstPara: true}, st)}</div>`, end: Math.min(k - 1, s.length)};
    }
    const bullet = MD_BULLET.exec(line), number = bullet ? null : MD_NUMBER.exec(line);
    if (bullet || number) {
      const rx = bullet ? MD_BULLET : MD_NUMBER, items = [];
      let k = i;
      while (k < s.length) {
        const e = s.indexOf('\n', k), stop = e < 0 ? s.length : e, m = rx.exec(s.slice(k, stop));
        if (!m) break;
        items.push(m[2]);
        k = stop + 1;
      }
      const tex = items.map((t) => '\\item ' + t).join('\n');
      return {html: environment(bullet ? 'itemize' : 'enumerate', null, tex, st), end: Math.min(k - 1, s.length)};
    }
    return null;
  }

  function blocks(s, st, root = null) {
    let out = '', para = '', i = 0, noindent = false;
    const flush = () => {
      const t = para.trim();
      if (t) {
        const cls = st.inList || st.firstPara || noindent || /^\\noindent(?![A-Za-z])/.test(t) ? ' class="noindent"' : '';
        out += `<p${cls}>${inline(t, st)}</p>`;
        st.firstPara = false;
      }
      para = '';
      noindent = false;
    };
    while (i < s.length) {
      if (i === 0 || s[i - 1] === '\n') {
        const end = s.indexOf('\n', i);
        const lineEnd = end < 0 ? s.length : end;
        const line = s.slice(i, lineEnd);
        if (/^\s*\|.*\|\s*$/.test(line) && lineEnd < s.length) {
          const next = s.slice(lineEnd + 1, (s.indexOf('\n', lineEnd + 1) + 1 || s.length + 1) - 1);
          if (PIPE_SEP.test(next) && next.includes('-')) {
            const lines = [line, next];
            let k = lineEnd + 1 + next.length;
            while (k < s.length) {
              const e2 = s.indexOf('\n', k + 1), stop = e2 < 0 ? s.length : e2;
              const l2 = s.slice(k + 1, stop);
              if (!/^\s*\|.*\|\s*$/.test(l2)) break;
              lines.push(l2); k = stop;
            }
            flush(); out += pipeTable(lines, st); i = k; noindent = true; st.firstPara = false;
            continue;
          }
        }
        const player = youtubeEmbed(line.trim());
        if (player) {
          flush(); out += player; i = lineEnd; noindent = true; st.firstPara = false;
          continue;
        }
        // Markdown conveniences, only at the start of a line: #-headings, - / 1. lists, > quotes,
        // --- rules and ``` code fences. LaTeX commands never start with these characters.
        const md = markdownLine(s, i, lineEnd, line, st);
        if (md) { flush(); out += md.html; i = md.end; noindent = true; st.firstPara = md.heading === true; continue; }
      }
      const c = s[i];
      if (c === '\n') {
        let j = i + 1;
        while (j < s.length && /[ \t\r]/.test(s[j])) j++;
        if (s[j] === '\n') {
          flush();
          while (j < s.length && /\s/.test(s[j])) j++;
          i = j;
          continue;
        }
      }
      if (c === '$' && s[i + 1] !== '$') {
        const e = mathEnd(s, i);
        if (e > 0) { para += s.slice(i, e); i = e; continue; }
      }
      if (c === '\\') {
        if (s.startsWith('\\(', i)) {
          const e = mathEnd(s, i);
          if (e > 0) { para += s.slice(i, e); i = e; continue; }
        }
        if (s.startsWith('\\[', i) && para.slice(-1) !== '\\') {
          const e = s.indexOf('\\]', i + 2);
          if (e >= 0) { flush(); out += display(s.slice(i + 2, e), null, st); i = e + 2; noindent = true; st.firstPara = false; continue; }
        }
        if (s.startsWith('\\\\', i)) { para += '\\\\'; i += 2; continue; }
        const h = /^\\(section|subsection|subsubsection|paragraph)(\*?)\s*(?=[[{])/.exec(s.slice(i));
        if (h) {
          const o = optArg(s, i + h[0].length);
          const a = reqArg(s, o.end);
          if (h[1] === 'paragraph') {
            flush();
            para = `\\textbf{${a.text}}\\quad `;
            noindent = true;
          } else {
            flush();
            out += heading(h[1], h[2], a.text, st);
            st.firstPara = true;
          }
          i = a.end;
          continue;
        }
        const b = /^\\begin\s*\{([A-Za-z]+\*?)\}/.exec(s.slice(i));
        if (b) {
          const env = b[1];
          let j = i + b[0].length;
          let opt = null;
          if (!MATH_ENVS.has(env.replace('*', ''))) { const o = optArg(s, j); if (o.text !== null) { opt = o.text; j = o.end; } }
          const end = findEnd(s, j, env);
          const body = end < 0 ? s.slice(j) : s.slice(j, end);
          flush();
          out += environment(env, opt, body, st);
          i = end < 0 ? s.length : end + `\\end{${env}}`.length;
          noindent = true;
          st.firstPara = false;
          continue;
        }
      }
      if (c === '$' && s[i + 1] === '$') {
        const e = s.indexOf('$$', i + 2);
        if (e >= 0) { flush(); out += display(s.slice(i + 2, e), null, st); i = e + 2; noindent = true; st.firstPara = false; continue; }
      }
      para += c;
      i++;
    }
    flush();
    if (root) { root.eq = st.eq; root.thm = st.thm; root.fn = st.fn; root.fig = st.fig; root.tab = st.tab; root.img = st.img; root.current = st.current; }
    return out;
  }

  function renderDoc(sources, opts = {}) {
    const macros = {};
    if (opts.preamble) extractMacros(stripComments(opts.preamble), macros);
    const cleaned = sources.map((s) => s == null ? null : extractMacros(stripComments(s), macros));
    const run = (dry, labels) => {
      const st = { dry, labels, macros, opts, sec: [0, 0, 0], eq: 0, thm: 0, fn: 0, fig: 0, tab: 0, img: 0, current: '', firstPara: true, inList: false };
      return cleaned.map((s) => {
        if (s == null) { st.firstPara = true; return ''; }
        st.img = 0;
        return blocks(s, st);
      });
    };
    const labels = Object.create(null);
    run(true, labels);           // pass 1: numbers and labels, no typesetting
    return run(false, labels);   // pass 2: typeset with every \ref resolvable
  }

  // The commands a preamble defines (for its status line).
  const macrosOf = (src) => { const m = {}; extractMacros(stripComments(src), m); return m; };

  return { renderDoc, macrosOf, esc };
})();
