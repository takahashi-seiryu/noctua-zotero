"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const context=vm.createContext({window:{},document:{execCommand:()=>false},Event:class {constructor(type){this.type=type;}}});
vm.runInContext(fs.readFileSync(require.resolve("../content/editor.js"),"utf8"),context);
function field(value,start=value.length,end=start) {
  return {value,selectionStart:start,selectionEnd:end,events:[],
    setSelectionRange(s,t){this.selectionStart=s;this.selectionEnd=t;},
    setRangeText(text,s,t){this.value=this.value.slice(0,s)+text+this.value.slice(t);},
    dispatchEvent(event){this.events.push(event.type);}};
}
function key(ta,key,options={}) {
  const event={key,preventDefault(){this.prevented=true;},...options};
  const handled=context.texKeys(event,ta);
  return {handled,prevented:event.prevented};
}
test("LaTeX pairing preserves selection, steps over closers and removes empty pairs",()=>{
  const ta=field("energy",0,6);
  assert.equal(key(ta,"{").handled,true);
  assert.equal(ta.value,"{energy}");assert.deepEqual([ta.selectionStart,ta.selectionEnd],[1,7]);
  ta.setSelectionRange(7,7);key(ta,"}");assert.equal(ta.selectionStart,8);
  const pair=field("");key(pair,"(");assert.equal(pair.value,"()");
  key(pair,"Backspace");assert.equal(pair.value,"");assert.equal(pair.selectionStart,0);
});
test("LaTeX bold and italic toggle around selected source",()=>{
  const ta=field("word",0,4);
  key(ta,"b",{metaKey:true});assert.equal(ta.value,"\\textbf{word}");
  assert.equal(ta.value.slice(ta.selectionStart,ta.selectionEnd),"word");
  key(ta,"b",{metaKey:true});assert.equal(ta.value,"word");
  key(ta,"i",{ctrlKey:true});assert.equal(ta.value,"\\textit{word}");
});
test("inline math expands into display math and escaped delimiters stay literal",()=>{
  const ta=field("");key(ta,"$");assert.equal(ta.value,"$$");assert.equal(ta.selectionStart,1);
  key(ta,"$");assert.equal(ta.value,"$$$$");assert.equal(ta.selectionStart,2);
  const escaped=field("\\");assert.equal(key(escaped,"$").handled,false);
  assert.equal(key(escaped,"{").handled,false);
  assert.equal(key(field("abc"),"(",{isComposing:true}).handled,false);
});
test("input-method keystrokes defer pairing to beforeinput so a character is never doubled",()=>{
  const ta=field("");
  assert.equal(key(ta,"{",{keyCode:229}).handled,false);assert.equal(ta.value,"");
  const event={inputType:"insertText",data:"{",isComposing:false,preventDefault(){this.prevented=true;}};
  assert.equal(context.texBeforeInput(event,ta),true);assert.equal(event.prevented,true);
  assert.equal(ta.value,"{}");assert.equal(ta.selectionStart,1);
  assert.equal(context.texBeforeInput({inputType:"insertText",data:"a",preventDefault(){}},field("")),false);
  assert.equal(context.texBeforeInput({inputType:"insertCompositionText",data:"{",preventDefault(){}},field("")),false);
  assert.equal(context.texBeforeInput({inputType:"insertText",data:"{",isComposing:true,preventDefault(){}},field("")),false);
});
test("a browser that re-fires beforeinput for our own insertion cannot pair a bracket twice",()=>{
  const ta=field("");
  context.document.execCommand=(cmd,_,text)=>{
    // Re-entrant input events, one per inserted character, as some engines dispatch them.
    for(const ch of text){const nested={inputType:"insertText",data:ch,preventDefault(){}};context.texBeforeInput(nested,ta);}
    ta.setRangeText(text,ta.selectionStart,ta.selectionEnd);return true;
  };
  try {
    key(ta,"{");
    assert.equal(ta.value,"{}");assert.equal(ta.selectionStart,1);
  } finally { context.document.execCommand=()=>false; }
});
test("quotation wrapping uses LaTeX opening and closing quotes",()=>{
  const ta=field("quote",0,5);key(ta,'"');
  assert.equal(ta.value,"``quote''");assert.equal(ta.value.slice(ta.selectionStart,ta.selectionEnd),"quote");
});
test("every icon used by the editor exists in the bundled Lucide set and the first screen stays minimal",()=>{
  const ctx=vm.createContext({document:{}});
  vm.runInContext(fs.readFileSync(require.resolve("../content/icons.js"),"utf8")+";this.icons=NoctuaIcons;",ctx);
  const html=fs.readFileSync(require.resolve("../content/editor.html"),"utf8");
  const js=fs.readFileSync(require.resolve("../content/editor.js"),"utf8");
  const used=new Set([...html.matchAll(/data-icon="([\w-]+)"/g)].map(m=>m[1]));
  for(const m of js.matchAll(/"((?:[a-z]+-)*[a-z0-9]+)"(?=\])|,"((?:[a-z]+-)+[a-z0-9]+)"\]/g))if(ctx.icons.data[m[1]||m[2]])used.add(m[1]||m[2]);
  for(const name of ["rows-2","columns-2","chevron-up","chevron-down","trash-2","type","pen-line"])used.add(name);
  for(const name of used)assert.ok(ctx.icons.data[name],"missing icon "+name);
  const header=html.slice(html.indexOf("<header>"),html.indexOf("</header>"));
  const visible=header.replace(/<div id="more-menu"[\s\S]*?<\/div>/,"");
  assert.equal((visible.match(/<button/g)||[]).length,7,"header should show only reading mode, split view, assistant, undo, redo, theme and the menu trigger");
});

test("the header's last-saved time reads naturally and is empty for unsaved notes",()=>{
  const now=Date.parse("2026-11-02T12:00:00Z"),ago=ms=>new Date(now-ms).toISOString();
  assert.equal(context.timeAgo(ago(20e3),now),"just now");
  assert.equal(context.timeAgo(ago(5*60e3),now),"5 min ago");
  assert.equal(context.timeAgo(ago(3*3600e3),now),"3 h ago");
  assert.equal(context.timeAgo(ago(30*3600e3),now),"Yesterday");
  assert.equal(context.timeAgo(ago(3*86400e3),now),"3 days ago");
  assert.match(context.timeAgo(ago(30*86400e3),now),/2026|Oct/);
  assert.equal(context.timeAgo("",now),"");assert.equal(context.timeAgo("nonsense",now),"");assert.equal(context.timeAgo(undefined,now),"");
});

test("a click in the rendered text lands at the matching source position",()=>{
  const src="We study $x$ and the \\textbf{World Models} family.\n\nSecond paragraph about planning.";
  const rendered="We study x and the World Models family. Second paragraph about planning.";
  const at=(needle,delta=0)=>context.mapCaret(rendered,rendered.indexOf(needle)+delta,src);
  assert.equal(src.slice(0,at("Models",3)).endsWith("Mod"),true);
  assert.equal(src.slice(at("planning"),at("planning")+8),"planning");
  assert.equal(at("We study"),0);
  assert.equal(context.mapCaret("abc",3,""),0);
  const ratio=context.mapCaret("zzzz zzzz zzzz",7,"qqqq qqqq qqqq");
  assert.ok(ratio>=5&&ratio<=9,String(ratio));
  assert.equal(context.mapCaret(rendered,rendered.length,src),src.length);
});

test("typed characters are paired only from beforeinput, never from keydown as well",()=>{
  const ta=field("");
  assert.equal(key(ta,"{",{type:"keydown"}).handled,false);assert.equal(ta.value,"");
  assert.equal(key(ta,"$",{type:"keydown"}).handled,false);
  // Shortcuts and Backspace still use keydown.
  const bold=field("word",0,4);assert.equal(key(bold,"b",{type:"keydown",metaKey:true}).handled,true);assert.equal(bold.value,"\\textbf{word}");
  const pair=field("()",1);assert.equal(key(pair,"Backspace",{type:"keydown"}).handled,true);assert.equal(pair.value,"");
  // One keystroke reaching both listeners yields exactly one pair.
  const both=field("");
  key(both,"{",{type:"keydown"});
  context.texBeforeInput({inputType:"insertText",data:"{",preventDefault(){}},both);
  assert.equal(both.value,"{}");assert.equal(both.selectionStart,1);
});

test("Tab indents the source instead of leaving the block; Shift+Tab outdents",()=>{
  const ta=field("alpha\nbeta",3);
  const tab=key(ta,"Tab",{type:"keydown"});
  assert.equal(tab.handled,true);assert.equal(tab.prevented,true);
  assert.equal(ta.value,"alp  ha\nbeta");assert.equal(ta.selectionStart,5);
  const lines=field("one\ntwo\nthree",0,9);
  key(lines,"Tab",{type:"keydown"});
  assert.equal(lines.value,"  one\n  two\n  three");
  assert.deepEqual([lines.selectionStart,lines.selectionEnd],[2,15]);
  key(lines,"Tab",{type:"keydown",shiftKey:true});
  assert.equal(lines.value,"one\ntwo\nthree");
  const single=field("  indented",6);
  key(single,"Tab",{type:"keydown",shiftKey:true});
  assert.equal(single.value,"indented");assert.equal(single.selectionStart,4);
  const flush=field("flush",2);key(flush,"Tab",{type:"keydown",shiftKey:true});
  assert.equal(flush.value,"flush");assert.equal(flush.selectionStart,2);
  assert.equal(key(field(""),"Tab",{type:"keydown",metaKey:true}).handled,false);
  const blank=field("a\n\nb",0,5);key(blank,"Tab",{type:"keydown"});assert.equal(blank.value,"  a\n\n  b");
});
