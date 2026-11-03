"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const suggest=require("../content/cite-suggest.js");
const at=(text,marker="|")=>{const caret=text.indexOf(marker);return suggest.context(text.replace(marker,""),caret);};
test("the caret context covers every \\cite flavour, optional arguments and comma-separated keys",()=>{
  assert.deepEqual(at("See \\cite{|}"),{start:10,end:10,query:""});
  assert.deepEqual(at("\\citep[p. 3]{lecun,  we|b}"),{start:21,end:24,query:"we"});
  assert.deepEqual(at("\\citet*{a,b,|c}"),{start:12,end:13,query:""});
  assert.deepEqual(at("\\cite{le|cun}"),{start:6,end:11,query:"le"});
});
test("no suggestions outside a \\cite argument",()=>{
  for(const text of ["x \\ref{a|}","\\cite{a}| text","\\cite{a} text {|","\\cite{a\nb|}","plain|"])assert.equal(at(text),null,text);
});
test("labels and the inserted key prefer the citation key and abbreviate authors",()=>{
  assert.equal(suggest.keyFor({key:"AAA111",citeKeys:["lecun2025"]}),"lecun2025");
  assert.equal(suggest.keyFor({key:"AAA111",citeKeys:[]}),"AAA111");
  assert.equal(suggest.label({creators:["LeCun","Ha","Vendrov"],year:"2025"}),"LeCun et al., 2025");
  assert.equal(suggest.label({creators:["LeCun","Ha"],year:"2025"}),"LeCun & Ha, 2025");
});
