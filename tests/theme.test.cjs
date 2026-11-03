"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const platform=fs.readFileSync(require.resolve("../content/platform.js"),"utf8");
function target() {
  const listeners=new Map();
  return {listeners, addEventListener(type, fn) { if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type) { for(const fn of listeners.get(type) || [])fn(); },
    setAttribute(key,value) { this[key]=value; }};
}
function preference(initial) {
  let mode=initial;
  const listeners=new Set(), writes=[];
  return {writes,listeners,getTheme:()=>mode,setTheme(value){mode=value;writes.push(value);listeners.forEach(fn=>fn());},
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}};
}
function fixture(appearance, dark=true) {
  const context=vm.createContext({});vm.runInContext(platform,context);
  const toggle=target(), settings=target(), media=Object.assign(target(),{matches:dark}), window=target();
  const label={},light={},darkIcon={};
  toggle.querySelector=selector=>selector==='[data-theme-label]' ? label : selector.includes("'light'") ? light : darkIcon;
  const document={documentElement:{dataset:{}},getElementById:id=>id==='theme-toggle'?toggle:settings};
  window.matchMedia=()=>media;
  let refreshes=0;const errors=[];
  const destroy=context.NoctuaAppearance.mount({appearance,document,window,refresh:()=>refreshes++,onError:error=>errors.push(error)});
  return {toggle,settings,media,window,label,light,darkIcon,document,destroy,errors,get refreshes(){return refreshes;},get theme(){return document.documentElement.dataset.theme;}};
}
test("missing and invalid preferences default to light even on a dark OS",()=>{
  for(const appearance of [undefined,preference('invalid')]) {
    const f=fixture(appearance);
    assert.equal(f.theme,'light');assert.equal(f.label.textContent,'Light');assert.equal(f.toggle['aria-pressed'],'false');
    assert.equal(f.darkIcon.hidden,true);assert.equal(f.settings.disabled,true);
    f.media.emit('change');assert.equal(f.theme,'light');assert.equal(f.refreshes,1);
    f.toggle.emit('click');assert.equal(f.theme,'dark');assert.equal(f.toggle.title,'Switch to light theme');
  }
});
test("explicit system mode follows OS changes; toggling saves a fixed theme for all tabs",()=>{
  const appearance=preference('system'), first=fixture(appearance), second=fixture(appearance);
  assert.equal(first.theme,'dark');
  first.media.matches=false;first.media.emit('change');assert.equal(first.theme,'light');assert.equal(first.refreshes,2);
  first.toggle.emit('click');assert.deepEqual(appearance.writes,['dark']);assert.equal(first.theme,'dark');assert.equal(second.theme,'dark');
  first.media.emit('change');assert.equal(first.theme,'dark');assert.equal(first.refreshes,3);
  second.toggle.emit('click');assert.equal(first.theme,'light');assert.equal(second.theme,'light');
  first.window.emit('unload');first.destroy();assert.equal(appearance.listeners.size,1);
  assert.equal(first.media.listeners.get('change').size,0);assert.equal(first.toggle.listeners.get('click').size,0);
  appearance.setTheme('dark');assert.equal(first.theme,'light');assert.equal(second.theme,'dark');
  second.destroy();assert.equal(appearance.listeners.size,0);
});
test("settings opens through the host and reports failures",async()=>{
  const appearance=preference('light');let opened=0;
  appearance.openPreferences=async()=>{opened++;throw new Error('Preferences unavailable');};
  const f=fixture(appearance);assert.equal(f.settings.disabled,false);
  f.settings.emit('click');await new Promise(resolve=>setImmediate(resolve));assert.equal(opened,1);assert.equal(f.errors[0].message,'Preferences unavailable');
});
test("a failed preference write leaves the current theme intact",()=>{
  const appearance=preference('light');appearance.setTheme=()=>{throw new Error('Write failed');};
  const f=fixture(appearance);f.toggle.emit('click');assert.equal(f.theme,'light');assert.equal(f.errors.length,1);
});

// Exercise editor APIs without launching Zotero or touching a library.
function editorFixture(ink=false,imported=false) {
  function element() {
    return Object.assign(target(),{value:'',dataset:{},classList:{toggle(){},add(){},remove(){}},
      append(){},replaceChildren(){},querySelectorAll:()=>[],querySelector:()=>null});
  }
  const nodes=new Map(), window=target();
  const document=Object.assign(target(),{getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},
    createElement:()=>element(),querySelector:()=>null});
  const doc={title:'Untitled note',revision:'',preamble:'',blocks:ink?[{id:'ink',type:'ink',strokes:[]}]:[]};
  const calls={saved:[],exported:[],drafts:[],validated:[]};let pendingInk=ink;
  const host={session:{id:'session'},doc,imported,storage:{
    save:async(session,snapshot)=>{calls.saved.push(snapshot);return {doc:{...snapshot,revision:'r1'}};},
    writeDraft:async(...args)=>{calls.drafts.push(args);}},
    model:{esc:value=>value,validate(value){calls.validated.push(value);return value;}},
    exportSource:async(value,win)=>{calls.exported.push({value,win});}};
  const context=vm.createContext({window,document,structuredClone,NoctuaAppearance:{mount(){}},NoctuaIcons:{hydrate(){},create:()=>element()},NoctuaChat:{mount(){}},store:{get:()=>null,set(){}},
    NoctuaLatex:{renderDoc:()=>[]},Ink:{refresh(){},mount(el,block,change){return {
      finish(){if(pendingInk){pendingInk=false;block.strokes.push({c:'#e8e6e1',w:1,p:[[0,0,1]]});change();}},destroy(){}};}},
    setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(fs.readFileSync(require.resolve('../content/editor.js'),'utf8'),context);
  window.startNoctuaNotes(host);
  return {window,document,calls,api:window.NoctuaNotesEditor};
}
test("untouched blank editors do not create entries; edits save through the internal API",async()=>{
  const f=editorFixture();await f.api.save();assert.equal(f.calls.saved.length,0);
  const title=f.document.getElementById('title');title.value='Changed title';title.emit('input');
  assert.equal(f.document.getElementById('save-status').textContent,'Unsaved changes');
  await f.api.save();assert.equal(f.calls.saved.length,1);assert.equal(f.calls.saved[0].title,'Changed title');
  assert.equal(f.document.getElementById('save-status').textContent,'Saved');
});
test("imported documents persist immediately without requiring an additional edit",async()=>{
  const f=editorFixture(false,true);
  await f.api.save();assert.equal(f.calls.saved.length,1);
  await f.api.save();assert.equal(f.calls.saved.length,1);
  assert.equal(f.document.getElementById('save-status').textContent,'Saved');
});
test("menu export finishes active ink and validates a copy without marking the editor closing",async()=>{
  const f=editorFixture(true);await f.api.exportSource();
  assert.equal(f.calls.exported.length,1);assert.equal(f.calls.validated.length,1);
  assert.equal(f.calls.exported[0].value.blocks[0].strokes.length,1);
  assert.equal(f.calls.exported[0].win,f.window);
  f.calls.exported[0].value.title='External mutation';assert.equal(f.api.getDocument().title,'Untitled note');
  f.window.emit('unload');assert.equal(f.calls.drafts.length,1);
  assert.equal(f.calls.drafts[0][1].blocks[0].strokes.length,1);
});
