const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Storage = require('../lib/storage.js');
const model = require('../lib/model.js');
const vm = require('node:vm');

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'noctua-storage-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let next=0,revision=0,downloads=0;
  const items=new Map();
  class Item {
    constructor(type) {this.type=type;this.libraryID=1;this.parentID=null;this.relatedItems=[];this.deleted=false;}
    async loadDataType(){}
    isNote(){return this.type==='note';}
    isStoredFileAttachment(){return this.type==='attachment';}
    isAttachment(){return this.isStoredFileAttachment();}
    isRegularItem(){return this.type==='journalArticle';}
    setCollections(ids){this.collections=ids;}
    getCollections(){return this.collections||[];}
    async removeRelatedItem(other){this.relatedItems=this.relatedItems.filter(key=>key!==other.key);}
    setField(key,value){this[key]=value;}
    setNote(html){this.html=html;}
    getNote(){return this.html||'';}
    addRelatedItem(other){if(!this.relatedItems.includes(other.key))this.relatedItems.push(other.key);}
    async save(){if(!this.id){this.id=++next;this.key=String(this.id).padStart(8,'A');items.set(this.key,this);}return this.id;}
    async saveTx(){return this.save();}
    async eraseTx(){items.delete(this.key);}
    async getFilePathAsync(){try{await fs.access(this.path);return this.path;}catch{return false;}}
  }
  const io={readUTF8:p=>fs.readFile(p,'utf8'),exists:async p=>{try{await fs.access(p);return true;}catch{return false;}},
    makeDirectory:p=>fs.mkdir(p,{recursive:true}),writeUTF8:async(p,text,opts)=>{
      await fs.writeFile(opts?.tmpPath||p,text);
      if(opts?.tmpPath) await fs.rename(opts.tmpPath,p);
    },
    remove:(p,opts)=>fs.rm(p,{force:opts?.ignoreAbsent})};
  const Z={Item,Libraries:{userLibraryID:1},DataDirectory:{dir:root},getTempDirectory:()=>({path:root}),
    Items:{getByLibraryAndKey:(lib,key)=>[...items.values()].find(x=>x.libraryID===lib&&x.key===key),
      get:id=>[...items.values()].find(x=>x.id===id),
      getAll:async lib=>[...items.values()].filter(x=>x.libraryID===lib&&!x.deleted),
      trash:async id=>{Z.Items.get(id).deleted=true;}},
    DB:{executeTransaction:fn=>fn()},logError:()=>{},
    Sync:{Storage:{Local:{SYNC_STATE_TO_DOWNLOAD:1,SYNC_STATE_FORCE_DOWNLOAD:4}},Runner:{setSyncTimeout(){},async downloadFile(item){downloads++;await fs.writeFile(item.path,item.remote);item.attachmentSyncState=2;}}},
    Attachments:{async importFromFile(opts){const item=new Item('attachment');await item.save();
      item.parentID=opts.parentItemID||null;item.collections=opts.collections;item.title=opts.title;
      item.attachmentFilename=path.basename(opts.file);item.path=path.join(root,item.key+'.noctua.json');
      await fs.copyFile(opts.file,item.path);return item;}}
  };
  const storage=new Storage({Zotero:Z,IOUtils:io,PathUtils:{join:path.join,parent:path.dirname},model,uuid:()=>`revision-${++revision}`});
  const session={id:'draft-1',libraryID:1,parentID:null,collectionID:10,item:null};
  return {root,storage,session,items,Z,io,downloads:()=>downloads};
}
async function bootstrapForStorage(f) {
  const Zotero=Object.assign(f.Z,{initializationPromise:Promise.resolve(),getMainWindows:()=>[],
    Prefs:{get:()=>undefined},MenuManager:{registerMenu(){}}});
  const context={Zotero,TextEncoder,TextDecoder,IOUtils:f.io,PathUtils:{join:path.join,parent:path.dirname},
    ChromeUtils:{importESModule:()=>({Subprocess:{}})},
    Cc:{'@mozilla.org/addons/addon-manager-startup;1':{getService:()=>({registerChrome:()=>({destruct(){}})})}},Ci:{},
    Services:{io:{newURI:uri=>uri},uuid:{},dirsvc:{get:()=>({path:'/tmp'})},env:{get:()=>''},scriptloader:{loadSubScript(uri,scope){
      if(uri.endsWith('/model.js'))scope.NoctuaNotesModel=model;
      if(uri.endsWith('/storage.js'))scope.NoctuaNotesStorage=function(){return f.storage;};
      if(uri.endsWith('/settings.js'))scope.NoctuaNotesSettings={create:async()=>({appearance:{}})};
      if(uri.endsWith('/activation.js'))scope.NoctuaNotesActivation={installNotes:()=>()=>{}};
      if(uri.endsWith('/agent.js'))scope.NoctuaAgent={create:()=>({cleanup:async()=>{},providers:async()=>[],run(){},forget(){}})};
      if(uri.endsWith('/pane.js'))scope.NoctuaNotesPane={register:()=>()=>{}};
    }}}};
  vm.createContext(context);
  vm.runInContext(await fs.readFile(path.join(__dirname,'../bootstrap.js'),'utf8'),context);
  await context.startup({id:'noctua@test',version:'test',rootURI:'file:///plugin/'});
  await context.NoctuaNotes.previewCleanup;
  return context.NoctuaNotes;
}
for(const fails of [false,true])test(`closing during first source save preserves latest edits when the pending save ${fails?'fails':'succeeds'}`,async t=>{
  const f=await fixture(t),notes=await bootstrapForStorage(f);
  let release,reached;
  const gate=new Promise(resolve=>{release=resolve;}),paused=new Promise(resolve=>{reached=resolve;});
  t.after(()=>release());
  let first=true;
  f.Z.DB.executeTransaction=async fn=>{
    if(first){first=false;reached();await gate;if(fails)throw new Error('First commit failed');}
    return fn();
  };
  const doc=model.blank(f.session.id);doc.title='First snapshot';
  const firstSave=f.storage.save(f.session,doc,'');
  await paused;
  assert.ok(f.session.item,'Test must pause after the new attachment is assigned');
  assert.equal(f.storage.pendingSave(f.session),f.storage.saves.get(f.session.id));
  assert.equal(f.storage.pendingSave(f.session),f.storage.saves.get(f.session.item.key));
  await assert.rejects(f.storage.save({...f.session,id:'another-session'},doc,''),/already in progress/);
  const latest={...doc,title:'Latest close snapshot'};
  const entry={session:f.session,editorWindow:{NoctuaNotesEditor:{takeCloseSnapshot:()=>({doc:latest,baseRevision:'',dirty:true,conflict:false})}}};
  const closing=notes.flushEntry(entry);assert.equal(notes.flushEntry(entry),closing);
  release();
  const [saved,closed]=await Promise.allSettled([firstSave,closing]);
  assert.equal(closed.status,'fulfilled');assert.equal(f.storage.saves.size,0);
  if(fails) {
    assert.equal(saved.status,'rejected');assert.equal(f.session.item,null);
    assert.equal((await f.storage.getDraft(f.session.id)).doc.title,'Latest close snapshot');
  } else {
    assert.equal(saved.status,'fulfilled');assert.equal(f.items.size,1);
    assert.equal((await f.storage.load(f.session.item)).doc.title,'Latest close snapshot');
    assert.equal(await f.storage.getDraft(f.session.id),null);
  }
});
test('saving creates only a synced source attachment and reopens it', async t=>{
  const f=await fixture(t);const doc=model.blank(f.session.id);doc.title='Control notes';
  doc.previewNoteKey='ABCD1234';doc.blocks[0].src='$x^2$';
  const first=await f.storage.save(f.session,doc,'');
  assert.ok(first.sourceKey);
  assert.equal(first.doc.previewNoteKey,null);
  assert.equal(f.session.item.attachmentSyncState,'to_upload');
  assert.deepEqual(f.session.item.collections,[10]);
  assert.deepEqual(f.session.item.relatedItems,[]);
  const reopened=await f.storage.load(f.session.item);
  assert.equal(reopened.doc.blocks[0].src,'$x^2$');
  assert.equal(await f.storage.getDraft(f.session.id),null);
  reopened.doc.blocks[0].src='Edited';
  const second=await f.storage.save(f.session,reopened.doc,reopened.doc.revision);
  assert.equal(f.items.size,1);
  assert.notEqual(second.doc.revision,first.doc.revision);
  assert.equal((await f.storage.load(f.session.item)).doc.blocks[0].src,'Edited');
});
test('conflicting save preserves draft and leaves remote source untouched', async t=>{
  const f=await fixture(t);const first=await f.storage.save(f.session,model.blank(f.session.id),'');
  const remote=structuredClone(first.doc);remote.revision='changed-remotely';remote.title='Remote';
  await fs.writeFile(f.session.item.path,JSON.stringify(remote));
  const local=structuredClone(first.doc);local.title='Local';
  await assert.rejects(f.storage.save(f.session,local,first.doc.revision),{code:'NOCTUA_CONFLICT'});
  assert.equal((await f.storage.load(f.session.item)).doc.title,'Remote');
  assert.equal((await f.storage.getDraft(f.session.id)).doc.title,'Local');
});
test('a missing or outdated source uses Zotero download-on-demand before parsing', async t=>{
  const f=await fixture(t);const first=await f.storage.save(f.session,model.blank(f.session.id),'');
  f.session.item.remote=JSON.stringify(first.doc);
  await fs.unlink(f.session.item.path);
  assert.equal((await f.storage.load(f.session.item)).doc.revision,first.doc.revision);
  assert.equal(f.downloads(),1);
  f.session.item.attachmentSyncState=1;
  await f.storage.load(f.session.item);
  assert.equal(f.downloads(),2);
});
test('a forged legacy preview key cannot modify an ordinary related note or block saves', async t=>{
  const f=await fixture(t);const first=await f.storage.save(f.session,model.blank(f.session.id),'');
  const unrelated=new f.Z.Item('note');unrelated.setNote('My real note');await unrelated.saveTx();
  unrelated.setCollections([10]);unrelated.addRelatedItem(f.session.item);f.session.item.addRelatedItem(unrelated);
  const remote=structuredClone(first.doc);remote.previewNoteKey=unrelated.key;
  await fs.writeFile(f.session.item.path,JSON.stringify(remote));
  const summary=await f.storage.cleanupLegacyPreviews();
  assert.equal(summary.trashed,0);assert.equal(summary.skipped,1);
  const saved=await f.storage.save(f.session,remote,remote.revision);
  assert.equal(saved.doc.previewNoteKey,null);
  assert.equal(unrelated.getNote(),'My real note');assert.equal(unrelated.deleted,false);
  assert.deepEqual(f.session.item.relatedItems,[unrelated.key]);
});
test('group libraries and deleted sources are rejected before modification', async t=>{
  const f=await fixture(t);
  await assert.rejects(f.storage.save({...f.session,libraryID:99},model.blank('x'),''),/My Library/);
  await f.storage.save(f.session,model.blank(f.session.id),'');
  f.session.item.deleted=true;
  await assert.rejects(f.storage.load(f.session.item),/live Noctua/);
});
test('an imported original note saves and reloads its inline assets and layout without an original server', async t=>{
  const f=await fixture(t);
  const {doc}=model.importSource({version:1,id:'original',title:'Migrated',created:100,updated:200,blocks:[
    {id:'drawing',type:'ink',w:1000,h:.6,strokes:[]},
    {id:'latex',type:'text',beside:true,src:'\\includegraphics[width=.5\\textwidth]{images/a.png}'},
  ]},{id:f.session.id,media:{'images/a.png':'data:image/png;base64,aGVsbG8='}});
  await f.storage.save(f.session,doc,'');
  const loaded=(await f.storage.load(f.session.item)).doc;
  assert.deepEqual(loaded.blocks,doc.blocks);
  assert.deepEqual(loaded.media,doc.media);
  assert.deepEqual(loaded.origin,{id:'original',created:100,updated:200});
});

// Independent historical fixture: cleanup must recognize only the old output.
function generatedPreview(doc,key) {
  const esc=model.esc;
  const body=doc.blocks.map(b=>b.type==='text'?`<pre>${esc(b.src)}</pre>`
    :b.type==='image'?`<p><em>Image: ${esc(b.caption||'open Noctua Notes to view')}</em></p>`
    :`<p><em>Drawing (${b.strokes.length} strokes): open Noctua Notes to view.</em></p>`).join('\n');
  return `<div data-schema-version="9"><h1>Noctua Note — ${esc(doc.title||'Untitled note')} (Reading preview)</h1>`
    +`<p><a href="zotero://select/library/items/${esc(key)}">Noctua Notes editable source</a></p>`
    +`<p><em>Generated reading preview. Edit the source with Noctua Notes; this preview is replaced on save. Equations are shown as LaTeX source here.</em></p>`+body+'</div>';
}
async function legacy(f) {
  const first=await f.storage.save(f.session,model.blank(f.session.id),'');
  const preview=new f.Z.Item('note');await preview.saveTx();preview.setCollections([10]);
  const doc={...first.doc,previewNoteKey:preview.key};
  preview.setNote(generatedPreview(doc,f.session.item.key));
  f.session.item.addRelatedItem(preview);preview.addRelatedItem(f.session.item);
  await fs.writeFile(f.session.item.path,JSON.stringify(doc));
  return {doc,preview,source:f.session.item};
}
test('cleanup trashes only verified generated previews, detaches relations and is idempotent',async t=>{
  const f=await fixture(t);const {source,preview,doc}=await legacy(f);
  const original=await fs.readFile(source.path,'utf8');
  assert.equal((await f.storage.findSource(preview)).key,source.key);
  assert.deepEqual(await f.storage.cleanupLegacyPreviews(),{trashed:1,detached:1,skipped:0,errors:[]});
  assert.equal(preview.deleted,true);assert.equal(source.deleted,false);
  assert.deepEqual(source.relatedItems,[]);assert.deepEqual(preview.relatedItems,[]);
  assert.equal(await fs.readFile(source.path,'utf8'),original);
  assert.deepEqual(await f.storage.cleanupLegacyPreviews(),{trashed:0,detached:0,skipped:1,errors:[]});
  assert.equal((await f.storage.save(f.session,doc,doc.revision)).doc.previewNoteKey,null);
});
test('cleanup recognizes original 0.1 and 0.3 generated headings without trusting titles alone',async t=>{
  for(const mode of ['0.1','0.3']) {
    const f=await fixture(t);const {source,preview,doc}=await legacy(f);
    const title=model.esc(doc.title || 'Untitled note');
    preview.setNote(preview.getNote().replace(/<h1>.*?<\/h1>/,`<h1>${title}${mode==='0.3'?' — Reading preview':''}</h1>`));
    assert.equal((await f.storage.cleanupLegacyPreviews()).trashed,1);
    assert.equal(source.deleted,false);
  }
});
test('already-trashed verified previews are detached without being trashed again',async t=>{
  const f=await fixture(t);const {preview}=await legacy(f);preview.deleted=true;
  f.Z.Items.trash=()=>{throw new Error('must not trash again');};
  assert.deepEqual(await f.storage.cleanupLegacyPreviews(),{trashed:0,detached:1,skipped:0,errors:[]});
  assert.equal(preview.deleted,true);
  assert.equal((await f.storage.cleanupLegacyPreviews()).detached,0);
});
for(const state of ['missing','deleted','moved','edited']) {
  test(`legacy ${state} preview never blocks a source save`,async t=>{
    const f=await fixture(t);const {doc,preview}=await legacy(f);
    if(state==='missing') f.items.delete(preview.key);
    if(state==='deleted') preview.deleted=true;
    if(state==='moved') preview.parentID=999;
    if(state==='edited') preview.setNote(preview.getNote()+'<p>Keep my edits</p>');
    doc.blocks[0].src='New source';
    const saved=await f.storage.save(f.session,doc,doc.revision);
    assert.equal(saved.doc.previewNoteKey,null);
    assert.equal((await f.storage.load(f.session.item)).doc.blocks[0].src,'New source');
    if(state==='moved'||state==='edited') assert.equal(preview.deleted,false);
  });
}
for(const state of ['edited','parent','collection','one-way','library','title-only']) {
  test(`cleanup conservatively skips ${state} previews`,async t=>{
    const f=await fixture(t);const {preview,source}=await legacy(f);
    if(state==='edited') preview.setNote(preview.getNote()+'<p>User writing</p>');
    if(state==='parent') preview.parentID=99;
    if(state==='collection') preview.setCollections([99]);
    if(state==='one-way') preview.relatedItems=[];
    if(state==='library') preview.libraryID=2;
    if(state==='title-only') preview.setNote('<h1>Noctua Note — Untitled note (Reading preview)</h1>');
    const summary=await f.storage.cleanupLegacyPreviews();
    assert.equal(summary.trashed,0);assert.equal(summary.skipped,1);assert.deepEqual(summary.errors,[]);
    assert.equal(preview.deleted,false);assert.equal(source.deleted,false);
  });
}
test('cleanup skips unavailable and download-pending sources without downloading',async t=>{
  const f=await fixture(t);const {source,preview,doc}=await legacy(f);
  source.remote=JSON.stringify(doc);await fs.unlink(source.path);
  assert.equal((await f.storage.cleanupLegacyPreviews()).skipped,1);
  assert.equal(f.downloads(),0);assert.equal(preview.deleted,false);
  await fs.writeFile(source.path,JSON.stringify(doc));source.attachmentSyncState=1;
  assert.equal((await f.storage.cleanupLegacyPreviews()).skipped,1);assert.equal(f.downloads(),0);
  await f.storage.save(f.session,doc,doc.revision);
  assert.equal(f.downloads(),1);assert.equal(preview.deleted,true);
});
test('cleanup isolates failures, excludes other libraries/deleted sources, and never rejects discovery failure',async t=>{
  const f=await fixture(t);const {source,preview}=await legacy(f);
  source.libraryID=2;assert.deepEqual(await f.storage.cleanupLegacyPreviews(),{trashed:0,detached:0,skipped:0,errors:[]});
  source.libraryID=1;source.deleted=true;assert.equal((await f.storage.cleanupLegacyPreviews()).trashed,0);
  source.deleted=false;
  f.Z.Items.trash=async()=>{throw new Error('Sync/database unavailable');};
  const summary=await f.storage.cleanupLegacyPreviews();
  assert.equal(summary.errors.length,1);assert.equal(summary.errors[0].sourceKey,source.key);
  assert.equal(source.deleted,false);assert.equal(preview.deleted,false);
  f.Z.Items.getAll=async()=>{throw new Error('Database unavailable');};
  assert.equal((await f.storage.cleanupLegacyPreviews()).errors.length,1);
});
test('source saves succeed and clear legacy key even if preview cleanup fails',async t=>{
  const f=await fixture(t);const {doc}=await legacy(f);
  f.Z.Items.trash=async()=>{throw new Error('Trash unavailable');};
  const saved=await f.storage.save(f.session,doc,doc.revision);
  assert.equal(saved.doc.previewNoteKey,null);assert.equal(await f.storage.getDraft(f.session.id),null);
});
test('failed source transaction restores saved bytes and preserves the draft',async t=>{
  const f=await fixture(t);const first=await f.storage.save(f.session,model.blank(f.session.id),'');
  const original=await fs.readFile(f.session.item.path,'utf8');
  const changed={...first.doc,title:'Changed'};
  f.session.item.save=async()=>{throw new Error('Cannot commit');};
  await assert.rejects(f.storage.save(f.session,changed,first.doc.revision),/Cannot commit/);
  assert.equal(await fs.readFile(f.session.item.path,'utf8'),original);
  assert.equal((await f.storage.getDraft(f.session.id)).doc.title,'Changed');
});
test('new source failure removes the imported attachment but retains the draft',async t=>{
  const f=await fixture(t);f.Z.DB.executeTransaction=async()=>{throw new Error('Cannot commit');};
  await assert.rejects(f.storage.save(f.session,model.blank(f.session.id),''),/Cannot commit/);
  assert.equal(f.session.item,null);assert.equal(f.items.size,0);
  assert.ok(await f.storage.getDraft(f.session.id));
});
test('child sources retain parent placement without a native note',async t=>{
  const f=await fixture(t);f.session.parentID=99;
  await f.storage.save(f.session,model.blank(f.session.id),'');
  assert.equal(f.session.item.parentID,99);assert.equal(f.session.item.collections,undefined);
  assert.equal(f.items.size,1);
});

test('transaction commit failure also rolls back source bytes',async t=>{
  const f=await fixture(t);const first=await f.storage.save(f.session,model.blank(f.session.id),'');
  const original=await fs.readFile(f.session.item.path,'utf8');
  f.Z.DB.executeTransaction=async fn=>{await fn();throw new Error('Commit failed');};
  await assert.rejects(f.storage.save(f.session,{...first.doc,title:'Draft'},first.doc.revision),/Commit failed/);
  assert.equal(await fs.readFile(f.session.item.path,'utf8'),original);
  assert.equal((await f.storage.getDraft(f.session.id)).doc.title,'Draft');
});
test('cleanup loads local note/relations/collections metadata before inspecting previews',async t=>{
  const f=await fixture(t);const {source,preview}=await legacy(f);const loaded=new Set();
  source.loadDataType=async type=>loaded.add('source:'+type);
  preview.loadDataType=async type=>loaded.add('preview:'+type);
  const getNote=preview.getNote.bind(preview);
  preview.getNote=()=>{assert.ok(loaded.has('preview:note'));return getNote();};
  assert.equal((await f.storage.cleanupLegacyPreviews()).trashed,1);
  assert.deepEqual([...loaded].sort(),['preview:collections','preview:note','preview:relations','source:collections','source:relations']);
});

test('downloaded remote conflicts preserve the draft and leave legacy previews alone',async t=>{
  const f=await fixture(t);const {doc,source,preview}=await legacy(f);
  source.remote=JSON.stringify({...doc,revision:'remote',title:'Remote'});source.attachmentSyncState=1;
  await assert.rejects(f.storage.save(f.session,{...doc,title:'Local'},doc.revision),{code:'NOCTUA_CONFLICT'});
  assert.equal(f.downloads(),1);assert.equal(preview.deleted,false);
  assert.equal((await f.storage.load(source)).doc.title,'Remote');
  assert.equal((await f.storage.getDraft(f.session.id)).doc.title,'Local');
});
test('failed downloads preserve the source and draft without attempting preview cleanup',async t=>{
  const f=await fixture(t);const {doc,source,preview}=await legacy(f);
  const original=await fs.readFile(source.path,'utf8');source.attachmentSyncState=1;
  f.Z.Sync.Runner.downloadFile=async()=>{throw new Error('Offline');};
  await assert.rejects(f.storage.save(f.session,{...doc,title:'Local'},doc.revision),/Offline/);
  assert.equal(await fs.readFile(source.path,'utf8'),original);assert.equal(preview.deleted,false);
  assert.equal((await f.storage.getDraft(f.session.id)).doc.title,'Local');
});
test('cleanup preserves unrelated relations and continues after a malformed source',async t=>{
  const f=await fixture(t);const {source,preview}=await legacy(f);
  const ordinary=new f.Z.Item('note');ordinary.setNote('Ordinary');await ordinary.save();
  source.addRelatedItem(ordinary);ordinary.addRelatedItem(source);preview.addRelatedItem(ordinary);
  const otherSession={...f.session,item:null,id:'other'};
  await f.storage.save(otherSession,model.blank('other'),'');
  await fs.writeFile(otherSession.item.path,'invalid JSON');
  // Visit malformed input before the valid source to exercise failure isolation.
  f.Z.Items.getAll=async()=>[otherSession.item,source,preview,ordinary];
  const summary=await f.storage.cleanupLegacyPreviews();
  assert.equal(summary.trashed,1);assert.equal(summary.errors.length,1);
  assert.deepEqual(source.relatedItems,[ordinary.key]);assert.deepEqual(preview.relatedItems,[ordinary.key]);
  assert.equal(ordinary.deleted,false);assert.equal(ordinary.getNote(),'Ordinary');
});
