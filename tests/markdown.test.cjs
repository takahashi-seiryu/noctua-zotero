"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const md=require("../content/chat-markdown.js");

// A tiny DOM, enough to serialize what render() builds (text is escaped like the browser would).
function fakeDocument() {
  const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  class Node {
    constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.dataset={};this.style={};this.className="";this.listeners={};}
    append(...nodes){for(const n of nodes){if(n.fragment)this.children.push(...n.children);else this.children.push(n);}}
    setAttribute(k,v){this.attrs[k]=v;}
    addEventListener(type,fn){this.listeners[type]=fn;}
    set textContent(v){this.children=[{text:String(v)}];}
    get html(){
      const inner=this.children.map(c=>c.text!==undefined?esc(c.text):c.html).join("");
      if(this.fragment)return inner;
      const attrs=(this.className?` class="${this.className}"`:"")+Object.entries(this.attrs).map(([k,v])=>` ${k}="${v}"`).join("")+(this.style.textAlign?` style="text-align:${this.style.textAlign}"`:"");
      return `<${this.tag}${attrs}>${inner}</${this.tag}>`;
    }
  }
  return {createElement:tag=>new Node(tag),createTextNode:text=>({text}),createDocumentFragment:()=>Object.assign(new Node("#"),{fragment:true})};
}
const html=(src,opts)=>md.render(fakeDocument(),src,opts).html;

test("the reply from the paper chat renders bold, lists, code and paragraphs",()=>{
  const reply=`이 글은 "Platonic Representation Hypothesis" 논문의 한계(limitations) 부분입니다.

**1. 첫 두 문장: 논증의 전제와 한계**
- Section 4는 이상화된 세상을 가정합니다. 각 모달리티는 Z를 **bijective**(일대일 대응)하게 관찰한 결과라는 가정입니다.
- 그래서 논문은 \`Pcoor(xa, xb) = Pcoor(za, zb)\`, \`KPMI(xa, xb) = KPMI(za, zb)\`가 성립한다고 봅니다 (p. 9).
- 현실의 관찰은 **lossy**(정보 손실)하거나 **stochastic**(확률적)합니다.

**2. "그럼에도(Nonetheless)" 이후: 이론적·실증적 근거**
저자들은 실제 학습기에서도 비슷한 현상이 나타난다는 기존 연구를 듭니다.
- **대조 학습(contrastive)**: Wang & Isola (2020), Zimmermann et al. (2021)

**요약하면** 수학적 증명은 이상적인 조건에서만 엄밀하게 성립합니다.`;
  const out=html(reply);
  assert.doesNotMatch(out,/\*\*|`/,"no raw Markdown markers may remain: "+out);
  assert.match(out,/<p><strong>1\. 첫 두 문장: 논증의 전제와 한계<\/strong><\/p><ul><li><p>Section 4는/);
  assert.match(out,/<strong>bijective<\/strong>\(일대일 대응\)/);
  assert.match(out,/<code>Pcoor\(xa, xb\) = Pcoor\(za, zb\)<\/code>/);
  assert.equal((out.match(/<ul>/g)||[]).length,2);assert.equal((out.match(/<li>/g)||[]).length,4);
  // a paragraph line directly followed by a list still starts the list
  assert.match(out,/기존 연구를 듭니다\.<\/p><ul><li><p><strong>대조 학습\(contrastive\)<\/strong>: Wang &amp; Isola/);
  assert.match(out,/<p><strong>요약하면<\/strong> 수학적 증명은/);
});

test("headings, ordered and nested lists, quotes, rules, fences and tables",()=>{
  const out=html(`## Title
1. one
2. two
   - nested *a*
   - nested b
3. three

> quoted **bold**

---
\`\`\`python
x = "<b>"  # **not bold**
\`\`\`
| Model | Score |
|:------|------:|
| A | **0.9** |
| B \\| C | 0.8 |`);
  assert.match(out,/<h4>Title<\/h4>/);
  assert.match(out,/<ol><li><p>one<\/p><\/li><li><p>two<\/p><ul><li><p>nested <em>a<\/em><\/p><\/li><li><p>nested b<\/p><\/li><\/ul><\/li><li><p>three<\/p><\/li><\/ol>/);
  assert.match(out,/<blockquote><p>quoted <strong>bold<\/strong><\/p><\/blockquote><hr><\/hr>/);
  assert.match(out,/<pre><code>x = "&lt;b&gt;"  # \*\*not bold\*\*<\/code><\/pre>/);
  assert.match(out,/<th style="text-align:left">Model<\/th><th style="text-align:right">Score<\/th>/);
  assert.match(out,/<td style="text-align:right"><strong>0\.9<\/strong><\/td>/);
  assert.match(out,/<td style="text-align:left">B \| C<\/td>/);
  assert.match(html("5. five\n6. six"),/<ol start="5">/);
});

test("inline edge cases: emphasis rules, escapes, dollars, links",()=>{
  assert.equal(html("snake_case_name and 2 * 3 * 4"),"<p>snake_case_name and 2 * 3 * 4</p>");
  assert.equal(html("_em_ and *em* and ~~gone~~"),"<p><em>em</em> and <em>em</em> and <del>gone</del></p>");
  assert.equal(html("\\*not em\\*"),"<p>*not em*</p>");
  assert.equal(html("costs $5 and $10"),"<p>costs $5 and $10</p>");
  assert.equal(html("``a ` b``"),"<p><code>a ` b</code></p>");
  assert.equal(html("line one\nline two"),"<p>line one<br></br>line two</p>");
  assert.equal(html("<script>alert(1)</script>"),"<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  const opened=[];
  const doc=fakeDocument(),frag=md.render(doc,"[site](https://example.com) and https://x.org/a.",{openURL:url=>opened.push(url)});
  assert.equal(frag.html,'<p><a href="#">site</a> and <a href="#">https://x.org/a</a>.</p>');
  const links=[];const walk=n=>{if(n.tag==="a")links.push(n);(n.children||[]).forEach(walk);};walk(frag);
  links[0].listeners.click({preventDefault(){}});assert.deepEqual(opened,["https://example.com"]);
  // a javascript: link is shown but never opened
  const bad=md.render(doc,"[x](javascript:alert(1))",{openURL:url=>opened.push(url)});const badLinks=[];(function w(n){if(n.tag==="a")badLinks.push(n);(n.children||[]).forEach(w);})(bad);
  badLinks[0]?.listeners.click({preventDefault(){}});assert.equal(opened.length,1);
});

test("math goes through KaTeX when available and falls back to the source",()=>{
  const katex={render:(tex,node,opts)=>{node.textContent=(opts.displayMode?"D:":"I:")+tex;}};
  assert.equal(html("Let $x_t$ be\n$$\\sum_i a_i$$",{katex}),'<p>Let <span class="md-math">I:x_t</span> be</p><div class="md-math-display">D:\\sum_i a_i</div>');
  assert.equal(html("\\(a+b\\) and\n\\[\nE=mc^2\n\\]",{katex}),'<p><span class="md-math">I:a+b</span> and</p><div class="md-math-display">D:\nE=mc^2\n</div>');
  assert.equal(html("$x$"),'<p><span class="md-math">$x$</span></p>');
  const broken={render:()=>{throw new Error("bad");}};
  assert.equal(html("$\\frac$",{katex:broken}),'<p><span class="md-math">$\\frac$</span></p>');
});
