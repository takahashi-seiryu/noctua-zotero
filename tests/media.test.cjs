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
