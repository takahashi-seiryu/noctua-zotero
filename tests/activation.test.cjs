"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const activation=require("../lib/activation.js");
function setup() {
  const make=(id,type,fields={})=>({id,key:"KEY"+id,libraryID:1,type,relatedItems:[],isNote(){return this.type==="note";},...fields});
  const source=make(1,"source",{relatedItems:["KEY2"]});
  const preview=make(2,"note",{relatedItems:[source.key]});
  const pdf=make(3,"pdf",{parentID:9}),note=make(4,"note"),paper=make(9,"paper");
  const items=[source,preview,pdf,note,paper], calls=[];
  const originals={viewItems:async function(...args){calls.push(["native-items",this,...args]);},
    viewAttachment:async function(...args){calls.push(["native-attachment",this,...args]);}};
  const pane={...originals},window={ZoteroPane:pane};
  const Zotero={Items:{getAsync:async id=>items.find(item=>item.id===id),getByLibraryAndKey:(lib,key)=>items.find(item=>item.libraryID===lib&&item.key===key)},getMainWindow:()=>window,
    Notes:{open:async function(...args){calls.push(["native-note",this,...args]);}}};
  const storage={isSource:item=>item?.type==="source",load:async()=>({doc:{previewNoteKey:preview.key}})};
  const open=async args=>calls.push(["noctua",args]);
  const uninstall=activation.install({window,Zotero,storage,open});
  return {source,preview,pdf,note,paper,calls,pane,originals,uninstall,window,Zotero,storage,open};
}
test("activates the exact Noctua source or reciprocal preview in the owning window",async()=>{
  const f=setup();
  await f.pane.viewItems([f.source,f.preview]);
  assert.equal(f.calls.length,2);
  for(const [type,args] of f.calls){assert.equal(type,"noctua");assert.equal(args.item,f.source);assert.equal(args.owner,f.window);}
});
test("native Notes.open routes verified previews while ordinary notes retain their options",async()=>{
  const f=setup(),original=f.Zotero.Notes.open;
  const uninstall=activation.installNotes(f);
  await f.Zotero.Notes.open(f.preview.id);
  assert.equal(f.calls[0][0],"noctua");assert.equal(f.calls[0][1].item,f.source);
  const location={position:3},options={openInWindow:true,allowDuplicate:true};
  await f.Zotero.Notes.open(f.note.id,location,options);
  assert.deepEqual(f.calls[1].slice(2),[f.note.id,location,options]);
  assert.equal(f.calls[1][1],f.Zotero.Notes);
  const retained=f.Zotero.Notes.open;uninstall();assert.equal(f.Zotero.Notes.open,original);
  await retained.call(f.Zotero.Notes,f.preview.id);assert.equal(f.calls[2][0],"native-note");
});
test("title resemblance cannot turn a normal Zotero note into a Noctua instance",async()=>{
  const f=setup();f.note.title="Noctua Note — copied title (Reading preview)";
  const uninstall=activation.installNotes(f);
  await f.Zotero.Notes.open(f.note.id);assert.equal(f.calls[0][0],"native-note");uninstall();
});
test("activation follows the stable library pane when the current pane changes",async()=>{
  const f=setup();f.uninstall();
  const readerPane={viewItems:async()=>{throw new Error("Reader pane must not be patched");}};
  f.window.ZoteroPane_Local=f.pane;f.window.ZoteroPane=readerPane;
  const uninstall=activation.install(f);
  await f.pane.viewItems([f.preview]);assert.equal(f.calls[0][0],"noctua");uninstall();
});
test("ordinary papers, PDFs and notes keep native behavior and activation arguments",async()=>{
  const f=setup(),event={shiftKey:true},options={location:{pageIndex:2}};
  await f.pane.viewItems([f.pdf,f.source,f.note,f.paper],event,options);
  assert.deepEqual(f.calls.map(call=>call[0]),["native-items","noctua","native-items","native-items"]);
  assert.deepEqual(f.calls[0].slice(2),[[f.pdf],event,options]);assert.equal(f.calls[0][1],f.pane);
  f.calls.length=0;
  await f.pane.viewAttachment([f.pdf.id,f.source.id],event,true,options);
  assert.equal(f.calls[0][0],"native-attachment");assert.deepEqual(f.calls[0].slice(2),[f.pdf.id,event,true,options]);
  assert.equal(f.calls[1][0],"noctua");
});
test("one-way related notes and deleted sources are not treated as Noctua instances",async()=>{
  const f=setup();f.note.relatedItems=[f.source.key];
  await f.pane.viewItems([f.note]);assert.equal(f.calls[0][0],"native-items");
  f.source.relatedItems.push(f.note.key);
  await f.pane.viewItems([f.note]);assert.equal(f.calls[1][0],"native-items");
  f.source.deleted=true;
  await f.pane.viewItems([f.preview]);assert.equal(f.calls[2][0],"native-items");
});
test("uninstall restores originals and retained wrappers become pass-through",async()=>{
  const f=setup(),retained=f.pane.viewItems;
  f.uninstall();assert.equal(f.pane.viewItems,f.originals.viewItems);assert.equal(f.pane.viewAttachment,f.originals.viewAttachment);
  await retained.call(f.pane,[f.source]);assert.equal(f.calls[0][0],"native-items");
  const g=setup(),laterWrapper=()=>{};g.pane.viewItems=laterWrapper;g.uninstall();assert.equal(g.pane.viewItems,laterWrapper);
});
