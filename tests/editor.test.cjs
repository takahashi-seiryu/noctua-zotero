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
test("quotation wrapping uses LaTeX opening and closing quotes",()=>{
  const ta=field("quote",0,5);key(ta,'"');
  assert.equal(ta.value,"``quote''");assert.equal(ta.value.slice(ta.selectionStart,ta.selectionEnd),"quote");
});
