"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const ctx=vm.createContext({window:{},katex:{renderToString:t=>`<span class="katex">${t}</span>`}});
vm.runInContext(fs.readFileSync(require.resolve("../content/noctua-latex.js"),"utf8")+";this.L=window.NoctuaLatex||NoctuaLatex;",ctx);
const render=(src,opts={})=>ctx.L.renderDoc([src],opts)[0];
test("tabular renders alignment, rules, multicolumn, escaped ampersands and math cells",()=>{
  const html=render(String.raw`\begin{tabular}{|l|c|r|}
\hline
Name & \multicolumn{2}{c}{Score} \\ \hline
A \& B & 1 & $x_1 & y$ \\ \hline
\end{tabular}`);
  assert.match(html,/<table class="tex-table rule-bottom">/);
  assert.match(html,/colspan="2" style="text-align:center">Score/);
  assert.match(html,/A &amp; B/);assert.match(html,/text-align:right"><span class="katex">x_1 & y/);
  assert.equal((html.match(/<tr/g)||[]).length,2);
});
test("table floats number captions and pipe tables render with alignment",()=>{
  const float=render(String.raw`\begin{table}\centering\caption{Results}\begin{tabular}{ll}a&b\end{tabular}\end{table}`);
  assert.match(float,/Table 1:<\/span> Results/);assert.match(float,/<td/);
  const md=render("| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n\nafter");
  assert.match(md,/<th style="text-align:left">a<\/th><th style="text-align:right">b<\/th>/);
  assert.equal((md.match(/<td/g)||[]).length,4);assert.match(md,/<p>after<\/p>/);
  assert.doesNotMatch(render("a | b | c"),/<table/);
});
test("a lone YouTube link becomes a player placeholder with a safe fallback link, never raw iframe HTML",()=>{
  const html=render("https://youtu.be/dQw4w9WgXcQ?t=90");
  assert.match(html,/class="tex-youtube" data-yt-id="dQw4w9WgXcQ" data-yt-start="90"/);
  assert.match(html,/href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&t=90"/);
  assert.doesNotMatch(html,/<iframe/);
  assert.doesNotMatch(render("https://evil.example/watch?v=dQw4w9WgXcQ"),/tex-youtube/);
  assert.doesNotMatch(render("see https://youtu.be/dQw4w9WgXcQ here"),/tex-youtube/);
});
test("SVG media is accepted only as a real base64 SVG image",()=>{
  const model=require("../lib/model.js");
  const svg="data:image/svg+xml;base64,"+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>').toString("base64");
  const base=media=>({format:model.FORMAT,schemaVersion:1,id:"n1",revision:"",title:"t",preamble:"",blocks:[{id:"b1",type:"text",src:"\\includegraphics{images/a.svg}"}],media});
  assert.equal(model.validate(base({"images/a.svg":svg})).media["images/a.svg"],svg);
  assert.throws(()=>model.validate(base({"images/a.svg":"data:image/svg+xml;base64,"+Buffer.from("not an image").toString("base64")})),/Invalid image/);
  assert.deepEqual(model.mediaPaths({version:1,id:"n",title:"t",blocks:[{id:"b",type:"text",src:"\\includegraphics{images/a.svg}"}]}),["images/a.svg"]);
  const block=data=>({...model.blank("x"),blocks:[{id:"i",type:"image",data,caption:""}]});
  assert.doesNotThrow(()=>model.validate(block(svg)));
  assert.throws(()=>model.validate(block("data:image/svg+xml;base64,bm90IGFuIGltYWdl")),/Images must be/);
});

test("markdown conveniences render at line starts without disturbing LaTeX or arithmetic",()=>{
  const md=render("# Title\n\n## Part\n\nSome **bold**, *italic*, ~~gone~~ and `code <b>` text.\n\n- one\n- two with $x$\n\n1. first\n2. second\n\n> quoted line\n\n---\n\n```\nlet a = 1;\n```");
  assert.match(md,/<h2 class="tex-h">Title<\/h2>/);assert.match(md,/<h3 class="tex-h">Part<\/h3>/);
  assert.match(md,/<b>bold<\/b>, <em>italic<\/em>, <s>gone<\/s>/);assert.match(md,/<code>code &lt;b&gt;<\/code>/);
  assert.match(md,/<ul class="tex-list"><li>.*one.*<\/li><li>.*two/s);assert.match(md,/<ol class="tex-list"><li>.*first/s);
  assert.match(md,/class="tex-quote"[^>]*>.*quoted line/s);assert.match(md,/<hr class="tex-rule">/);
  assert.match(md,/<pre class="tex-verbatim">let a = 1;<\/pre>/);
  const plain=render("Compute 2 * 3 * 4 and a*b, then ``quoted'' text's end, and \\emph{kept}.");
  assert.doesNotMatch(plain,/<em>(?!kept)/);assert.match(plain,/2 \* 3 \* 4/);assert.match(plain,/“quoted”/);assert.match(plain,/<em>kept<\/em>/);
  assert.doesNotMatch(render("\\section{A}\nplain # not a heading"),/<h2[^>]*># /);
});
test("eqnarray, spacing commands, colours, rules and the title block render instead of printing raw commands",()=>{
  const eq=render("\\begin{eqnarray} a&=&b \\\\ c&=&d \\end{eqnarray}");
  assert.doesNotMatch(eq,/tex-unknown/);assert.match(eq,/class="tex-display"/);
  const out=render("a\\vspace{1em}b \\hspace*{2cm}c \\textcolor{red}{R} \\colorbox{#ffee00}{H} {\\color{blue} B}\n\n\\hrule\n\n\\title{My \\emph{Note}}\\author{Ada}\\date{2026}\\maketitle");
  assert.doesNotMatch(out,/tex-unknown|vspace|hspace/);assert.match(out,/ab c/);
  assert.match(out,/<span style="color:red">R<\/span>/);assert.match(out,/<span style="background:#ffee00">H<\/span>/);assert.match(out,/<span style="color:blue">B<\/span>/);
  assert.match(out,/<hr class="tex-rule">/);assert.match(out,/<div class="tex-title"><h1>My <em>Note<\/em><\/h1><p class="tex-author">Ada<\/p><p class="tex-date">2026<\/p><\/div>/);
  assert.doesNotMatch(render("\\textcolor{red;background:url(x)}{bad}"),/style=/);
});
