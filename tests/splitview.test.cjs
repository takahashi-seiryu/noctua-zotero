"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const view=require("../lib/splitview.js");
const pdf=(id,extra={})=>({id,deleted:false,isPDFAttachment:()=>true,isRegularItem:()=>false,...extra});
test("a PDF attachment is its own reader source",()=>{
  const a=pdf(1);
  assert.deepEqual(view.pdfsOf({},a),[a]);
});
test("a paper lists only live PDF attachments",()=>{
  const items=new Map([[2,pdf(2)],[3,pdf(3,{deleted:true})],[4,{id:4,deleted:false,isPDFAttachment:()=>false}]]);
  const paper={id:1,deleted:false,isPDFAttachment:()=>false,isRegularItem:()=>true,getAttachments:()=>[2,3,4]};
  assert.deepEqual(view.pdfsOf({Items:{get:id=>items.get(id)}},paper).map(a=>a.id),[2]);
});
test("missing, deleted and note items have no PDFs",()=>{
  assert.deepEqual(view.pdfsOf({},null),[]);
  assert.deepEqual(view.pdfsOf({},{deleted:true}),[]);
  assert.deepEqual(view.pdfsOf({},{deleted:false,isPDFAttachment:()=>false,isRegularItem:()=>false}),[]);
});
