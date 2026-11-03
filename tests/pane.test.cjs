"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const pane=require("../lib/pane.js");
function fixture() {
  let hooks,observer,removed=0,unregistered=0;
  const items=new Map(),opened=[],created=[],errors=[];
  const Zotero={Libraries:{userLibraryID:1},Items:{get:id=>items.get(id),getByLibraryAndKey:(lib,key)=>[...items.values()].find(i=>i.libraryID===lib&&i.key===key)},
    ItemPaneManager:{registerSection(options){hooks=options;return "registered-pane";},unregisterSection(id){assert.equal(id,"registered-pane");removed++;}},
    Notifier:{registerObserver(value){observer=value;return 8;},unregisterObserver(id){assert.equal(id,8);unregistered++;}},
    logError:error=>errors.push(error),getMainWindow:()=>owner,Promise:{delay:async()=>{}}};
  const owner={ZoteroPane:{}};
  const doc={defaultView:owner,createElementNS:(_ns,tag)=>new Element(tag)};
  const body=new Element("body");
  const storage={isSource:item=>!!item?.source,load:async item=>({doc:{previewNoteKey:item.previewKey}})};
  const cleanup=pane.register({Zotero,pluginID:"noctua@test",storage,open:args=>opened.push(args),create:args=>created.push(args)});
  function item(id,type,extra={}) {const value={id,key:"K"+id,libraryID:1,relatedItems:[],isRegularItem:()=>type==="paper",isAttachment:()=>type==="attachment",isNote:()=>type==="note",getAttachments:()=>value.attachments || [],getField:()=>value.title || "",...extra};items.set(id,value);return value;}
  async function render(item,editable=true) {let enabled,summary;const args={body,doc,item,editable,setEnabled:value=>enabled=value,setSectionSummary:value=>summary=value};hooks.onItemChange(args);hooks.onRender(args);await hooks.onAsyncRender(args);return {enabled,summary};}
  return {get hooks(){return hooks;},get observer(){return observer;},item,body,doc,render,opened,created,cleanup,errors,get removed(){return removed;},get unregistered(){return unregistered;}};
}
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.events={};this.attributes={};this.textContent="";}
  append(node){this.children.push(node);}
  replaceChildren(){this.children=[];}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(type,handler){this.events[type]=handler;}
  all(tag){return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.all(tag)]);}
  rows(){return this.children.flatMap(child=>[...(child.attributes?.["data-noctua-open"]?[child]:[]),...child.rows()]);}
  async click(){await this.events.click?.();}
}
test("paper pane lists each live Noctua source separately and uses its exact source when opening",async()=>{
  const f=fixture();const paper=f.item(1,"paper",{attachments:[2,3,4,5]});
  const first=f.item(2,"attachment",{source:true,parentID:1,title:"Noctua Note — First"});
  const second=f.item(3,"attachment",{source:true,parentID:1,title:"Noctua Note — Second"});
  f.item(4,"attachment",{parentID:1,title:"PDF"});f.item(5,"attachment",{source:true,parentID:1,deleted:true});
  const {enabled,summary}=await f.render(paper);assert.equal(enabled,true);assert.equal(summary,"2");
  const rows=f.body.rows(),buttons=f.body.all("button");
  assert.deepEqual(buttons.map(b=>b.textContent),["+ New note"]);
  assert.deepEqual(rows.map(r=>r.children[0].textContent),["First","Second"]);
  await rows[1].events.click?.();assert.equal(f.opened.length,0,"single click must not open");
  await rows[1].events.dblclick();assert.equal(f.opened[0].item,second);assert.notEqual(f.opened[0].item,first);
  await rows[0].events.keydown({key:"Enter",preventDefault(){}});assert.equal(f.opened[1].item,first);
  await buttons[0].click();assert.equal(f.created[0].item,paper);
});
test("PDF reader context resolves the parent while standalone source stays standalone",async()=>{
  const f=fixture();const paper=f.item(1,"paper",{attachments:[2]});const pdf=f.item(2,"attachment",{parentID:1});
  await f.render(pdf);await f.body.all("button")[0].click();assert.equal(f.created[0].item,paper);
  const standalone=f.item(3,"attachment",{source:true,title:"Standalone"});await f.render(standalone);
  await f.body.rows()[0].events.dblclick();assert.equal(f.opened[0].item,standalone);
  assert.equal(f.body.rows()[0].children[0].textContent,"Standalone");
});
test("ordinary native notes never show a paper's arbitrary source, and only a verified preview resolves",async()=>{
  const f=fixture();f.item(1,"paper",{attachments:[2]});
  const source=f.item(2,"attachment",{source:true,parentID:1,previewKey:"K3",relatedItems:["K3","K4"]});
  const preview=f.item(3,"note",{parentID:1,relatedItems:[source.key]});
  const ordinary=f.item(4,"note",{parentID:1,relatedItems:[source.key]});
  assert.equal((await f.render(ordinary)).enabled,false);assert.equal(f.body.all("button").length,0);
  assert.equal((await f.render(preview)).enabled,true);await f.body.rows()[0].events.dblclick();assert.equal(f.opened[0].item,source);
});
test("pane refreshes after item notifications and cleanup unregisters once",async()=>{
  const f=fixture();let refreshes=0;f.hooks.onInit({body:f.body,refresh:()=>refreshes++});
  f.observer.notify();assert.equal(refreshes,1);
  await f.observer.notify("select","tab");assert.equal(refreshes,2);
  await f.cleanup.refresh();assert.equal(refreshes,3);
  f.hooks.onDestroy({body:f.body});f.observer.notify();assert.equal(refreshes,3);
  f.cleanup();f.cleanup();assert.equal(f.removed,1);assert.equal(f.unregistered,1);
});
test("group/deleted contexts hide the pane and readonly contexts prohibit creation",async()=>{
  const f=fixture();assert.equal((await f.render(f.item(1,"paper",{libraryID:2}))).enabled,false);
  assert.equal((await f.render(f.item(2,"paper",{deleted:true}))).enabled,false);
  await f.render(f.item(3,"paper"),false);const button=f.body.all("button")[0];assert.equal(button.disabled,true);await button.click();assert.equal(f.created.length,0);
});

test("sidebar titles drop the repeated prefix and modified times read naturally",()=>{
  assert.equal(pane.displayTitle("Noctua Note — Long Name"),"Long Name");
  assert.equal(pane.displayTitle("Noctua Note"),"Untitled");assert.equal(pane.displayTitle(""),"Untitled");
  const now=Date.parse("2026-11-02T12:00:00Z");
  assert.equal(pane.relativeTime("2026-11-02 11:59:40",now),"Just now");
  assert.equal(pane.relativeTime("2026-11-02 11:55:00",now),"5 min ago");
  assert.equal(pane.relativeTime("2026-11-02 09:00:00",now),"3 h ago");
  assert.equal(pane.relativeTime("2026-11-01 08:00:00",now),"Yesterday");
  assert.equal(pane.relativeTime("2026-10-30 12:00:00",now),"3 days ago");
  assert.equal(pane.relativeTime("",now),"");assert.equal(pane.relativeTime("nonsense",now),"");
});
test("an empty paper shows a quiet empty state and a visible create button",async()=>{
  const f=fixture();await f.render(f.item(1,"paper",{attachments:[]}));
  assert.equal(f.body.rows().length,0);assert.equal(f.body.all("p").some(p=>p.textContent==="No notes yet"),true);
  assert.equal(f.body.all("button")[0].textContent,"+ New note");
});
