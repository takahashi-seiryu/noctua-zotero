"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const settings=require("../lib/settings.js");

async function fixture(value, failPane=false) {
  let observer, previewObserver, previewValue="right", inkValues={}, inkObservers=[], widthValue=undefined, registration, removed=0, unregistered=0;
  const writes=[],opened=[],errors=[];
  const Zotero={
    Prefs:{get(key,global){assert.equal(global,true);if(key===settings.WIDTH_PREF)return widthValue;if(settings.INK_PREFS.includes(key))return inkValues[key];return key===settings.PREVIEW_PREF?previewValue:(assert.equal(key,settings.THEME_PREF),value);},
      set(key,next,global){assert.equal(key,settings.THEME_PREF);assert.equal(global,true);value=next;writes.push(next);observer?.();},
      registerObserver(key,fn,global){assert.equal(global,true);if(key===settings.PREVIEW_PREF){previewObserver=fn;return 18;}if(settings.INK_PREFS.includes(key)||key===settings.WIDTH_PREF){inkObservers.push(fn);return 19;}assert.equal(key,settings.THEME_PREF);observer=fn;return 17;},
      unregisterObserver(token){if(token===19){inkObservers.pop();return;}if(token===18){previewObserver=null;return;}assert.equal(token,17);observer=null;removed++;}},
    PreferencePanes:{async register(options){registration=options;if(failPane)throw Error("Registration failed");return options.id;},
      unregister(id){assert.equal(id,settings.PANE_ID);unregistered++;}},
    Utilities:{Internal:{openPreferences:id=>opened.push(id)}},logError:error=>errors.push(error)
  };
  const service=await settings.create({Zotero,pluginID:"noctua@test",rootURI:"file:///plugin/"}).catch(error=>error);
  return {service,Zotero,writes,opened,errors,get registration(){return registration;},get removed(){return removed;},get unregistered(){return unregistered;},external(next){value=next;observer?.();},externalPreview(next){previewValue=next;previewObserver?.();},setWidth(next){widthValue=next;inkObservers.forEach(fn=>fn());},setInk(key,next){inkValues[key]=next;inkObservers.forEach(fn=>fn());}};
}
test("missing and invalid preferences use light; system requires an explicit selection",async()=>{
  for(const value of [undefined,null,"",false,1,"auto","DARK","system "]) {
    const f=await fixture(value);assert.equal(f.service.appearance.getTheme(),"light");assert.deepEqual(f.writes,[]);f.service.destroy();
  }
  const f=await fixture("system");assert.equal(f.service.appearance.getTheme(),"system");
  for(const value of ["auto",undefined,null,0])assert.throws(()=>f.service.appearance.setTheme(value),TypeError);
  assert.deepEqual(f.writes,[]);f.service.destroy();
});
test("native pref changes propagate across tabs and isolate failing subscribers",async()=>{
  const f=await fixture("light"),a=[],b=[];
  const first=f.service.appearance.subscribe(value=>a.push(value));
  f.service.appearance.subscribe(()=>{throw Error("Closed tab");});
  f.service.appearance.subscribe(value=>b.push(value));
  f.service.appearance.setTheme("dark");f.external("system");f.external("invalid");f.external("also invalid");
  assert.deepEqual(a,["dark","system","light"]);assert.deepEqual(b,a);assert.equal(f.errors.length,3);
  first();first();f.external("dark");assert.equal(a.length,3);assert.equal(b.length,4);
  f.service.destroy();f.external("light");assert.equal(b.length,4);
});
test("pane registration, targeted navigation, and observer/pane cleanup happen once",async()=>{
  const f=await fixture("dark");
  assert.equal(f.registration.pluginID,"noctua@test");assert.equal(f.registration.src,"file:///plugin/content/preferences.xhtml");
  assert.equal(f.registration.image,"chrome://noctuanotes/content/icons/noctua-notes.svg");
  f.service.appearance.openPreferences();assert.deepEqual(f.opened,[settings.PANE_ID]);
  f.service.destroy();f.service.destroy();
  assert.equal(f.removed,1);assert.equal(f.unregistered,1);
  f.service.appearance.setTheme("light");f.service.appearance.openPreferences();
  assert.deepEqual(f.writes,[]);assert.equal(f.opened.length,1);
});
test("pane registration failure releases the native observer",async()=>{
  const f=await fixture("light",true);assert.match(f.service.message,/Registration failed/);
  assert.equal(f.removed,1);assert.equal(f.unregistered,0);
});
test("native XHTML controls bind directly to the persistent plugin preference",()=>{
  const {spawnSync}=require("node:child_process");
  const result=spawnSync("python3",["-c",`import xml.etree.ElementTree as E
p=E.parse('content/preferences.xhtml').getroot()
n={'x':'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul'}
assert p.attrib['id']=='noctua-notes-preferences'
assert [e.attrib['value'] for e in p.findall('.//x:menuitem',n)]==['light','dark','system','right','below']
assert p.find('.//x:label[@control="noctua-notes-theme"]',n) is not None
assert [m.attrib['preference'] for m in p.findall('.//x:menulist',n)]==['extensions.noctua-notes.theme','extensions.noctua-notes.previewPosition']
`],{cwd:require("node:path").join(__dirname,".."),encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
});

async function bootstrapFixture(cleanup=async()=>({trashed:0,detached:0,skipped:0,errors:[]})) {
  const menus=[],loaded=[],exported=[],errors=[];
  const owner={Zotero_Tabs:{selectedID:"active"},ZoteroPane:{getSelectedLibraryID:()=>1}};
  const storage={cleanupLegacyPreviews:cleanup,isSource:item=>!!item.source,load:async item=>{loaded.push(item);return {doc:{title:item.key}};}};
  const scope={TextEncoder,TextDecoder,IOUtils:{},PathUtils:{},ChromeUtils:{importESModule:()=>({Subprocess:{}})},
    Cc:{"@mozilla.org/addons/addon-manager-startup;1":{getService:()=>({registerChrome:()=>({destruct(){}})})}},Ci:{},
    Services:{io:{newURI:uri=>uri},uuid:{},dirsvc:{get:()=>({path:"/tmp"})},env:{get:()=>""},scriptloader:{loadSubScript(uri,target){
      if(uri.endsWith("agent.js"))target.NoctuaAgent={create:()=>({cleanup:async()=>{},providers:async()=>[],run(){},forget(){}})};
      if(uri.endsWith("settings.js"))target.NoctuaNotesSettings={create:async()=>({appearance:{},destroy(){}})};
      if(uri.endsWith("storage.js"))target.NoctuaNotesStorage=function(){return storage;};
      if(uri.endsWith("activation.js"))target.NoctuaNotesActivation={installNotes:()=>()=>{}};
      if(uri.endsWith("pane.js"))target.NoctuaNotesPane={register:()=>()=>{}};
    }}},
    Zotero:{initializationPromise:Promise.resolve(),getMainWindows:()=>[],getMainWindow:()=>owner,
      Libraries:{userLibraryID:1},Prefs:{get:()=>undefined},MenuManager:{registerMenu:menu=>menus.push(menu)},logError:error=>errors.push(error)}};
  vm.createContext(scope);vm.runInContext(fs.readFileSync(require.resolve("../bootstrap.js"),"utf8"),scope);
  await scope.startup({id:"noctua@test",rootURI:"file:///plugin/",version:"test"});
  const notes=scope.NoctuaNotes;notes.writeExport=async doc=>exported.push(doc);
  return {menus,owner,notes,loaded,exported,errors};
}
test("export routing uses the exact source and active editor's unsaved export method",async()=>{
  const f=await bootstrapFixture(),calls=[];
  const a={key:"A",libraryID:1,source:true},b={key:"B",libraryID:1,source:true};
  f.notes.tabs.set("active",{owner:f.owner,session:{item:a,libraryID:1},editorWindow:{NoctuaNotesEditor:{exportSource:()=>calls.push("unsaved A")}}});
  await f.notes.exportSource({owner:f.owner});await f.notes.exportSource({item:a});
  assert.deepEqual(calls,["unsaved A","unsaved A"]);
  await f.notes.exportSource({item:b});assert.deepEqual(f.loaded,[b]);assert.equal(f.exported[0].title,"B");
  await f.notes.exportSource({item:{key:"paper",libraryID:1}});
  await f.notes.exportSource({item:{...b,deleted:true}});assert.equal(f.loaded.length,1);
  f.owner.Zotero_Tabs.selectedID="library";await f.notes.exportSource();assert.equal(calls.length,2);
});
test("Tools/context menus gate export and context selection never exports another active tab",async()=>{
  const f=await bootstrapFixture(),calls=[];
  const a={key:"A",libraryID:1,source:true},b={key:"B",libraryID:1,source:true};
  f.notes.tabs.set("active",{owner:f.owner,session:{item:a,libraryID:1},editorWindow:{NoctuaNotesEditor:{exportSource:()=>calls.push("A")}}});
  const menu=(id)=>f.menus.find(menu=>menu.menuID===id).menus[0];
  let enabled,visible;
  const context={items:[b],menuElem:{ownerGlobal:f.owner},setEnabled:value=>enabled=value,setVisible:value=>visible=value};
  menu("noctua-notes-export-item").onShowing(null,context);assert.equal(enabled,true);assert.equal(visible,true);
  await menu("noctua-notes-export-item").onCommand(null,context);assert.equal(f.loaded[0],b);assert.deepEqual(calls,[]);
  await menu("noctua-notes-export").onCommand(null,context);assert.deepEqual(calls,["A"]);
  for(const items of [[],[a,b],[{key:"paper",libraryID:1}]]) {
    menu("noctua-notes-export-item").onShowing(null,{...context,items});assert.equal(enabled,false);assert.equal(visible,false);
  }
  menu("noctua-notes-import-item").onShowing(null,{...context,items:[{libraryID:1}]});assert.equal(enabled,true);
  menu("noctua-notes-import-item").onShowing(null,{...context,items:[{libraryID:2}]});assert.equal(enabled,false);
});

test("startup exposes nonblocking preview cleanup and reports summary or rejected errors",async()=>{
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const f=await bootstrapFixture(()=>pending);
  assert.equal(f.menus.length,7);
  const error=Error("One legacy note could not be checked");
  const summary={trashed:1,detached:2,skipped:3,errors:[error]};
  finish(summary);assert.equal(await f.notes.previewCleanup,summary);assert.deepEqual(f.errors,[error]);
  const failed=await bootstrapFixture(async()=>{throw error;});
  const result=await failed.notes.previewCleanup;assert.equal(result.errors[0],error);assert.deepEqual(failed.errors,[error]);
});

test("preview position defaults to right, accepts only below, and notifies subscribers",async()=>{
  const f=await fixture("light");
  assert.equal(f.service.appearance.getPreviewPosition(),"right");
  const seen=[];f.service.appearance.subscribe(()=>seen.push(f.service.appearance.getPreviewPosition()));
  f.externalPreview("below");f.externalPreview("sideways");
  assert.deepEqual(seen,["below","right"]);
  f.service.destroy();f.externalPreview("below");assert.equal(seen.length,2);
});

test("pen accent colours fall back to the defaults, accept only #rrggbb and notify subscribers",async()=>{
  const f=await fixture("light"),colors=()=>f.service.appearance.getInkColors();
  assert.deepEqual(colors(),settings.INK_DEFAULTS);
  const seen=[];f.service.appearance.subscribe(()=>seen.push(colors()[0]));
  f.setInk(settings.INK_PREFS[0],"#101010");f.setInk(settings.INK_PREFS[1],"#AABBCC");f.setInk(settings.INK_PREFS[2],"red");f.setInk(settings.INK_PREFS[3],"#12345");
  assert.deepEqual(colors(),["#101010","#aabbcc",...settings.INK_DEFAULTS.slice(2)]);
  assert.ok(seen.length>=3);
  const count=seen.length;f.service.destroy();f.setInk(settings.INK_PREFS[1],"#000000");assert.equal(seen.length,count);
});
test("pen colour defaults agree across prefs.js, the reset script and the settings module",()=>{
  const prefs=fs.readFileSync(require.resolve("../prefs.js"),"utf8"),reset=fs.readFileSync(require.resolve("../content/preferences.js"),"utf8");
  settings.INK_DEFAULTS.forEach((color,index)=>{
    assert.match(prefs,new RegExp(`ink\\.color${index}", "${color}"`));
    assert.ok(reset.includes(`"${color}"`),color||"(Ink)");
  });
});

test("note width defaults to 60%, snaps to steps of 5 within 50-100 and notifies subscribers",async()=>{
  const f=await fixture("light"),width=()=>f.service.appearance.getContentWidth();
  assert.equal(width(),60);
  const seen=[];f.service.appearance.subscribe(()=>seen.push(width()));
  for(const [input,expected] of [[70,70],[43,50],[250,100],[72,70],["80",80],["wide",60],[null,50]]){
    f.setWidth(input);assert.equal(width(),expected,String(input));
  }
  assert.ok(seen.length>=7);
  assert.match(fs.readFileSync(require.resolve("../prefs.js"),"utf8"),/contentWidth", 60\)/);
  f.service.destroy();
});

test("the pane script keeps the note-width value label in step with the slider",()=>{
  const script=fs.readFileSync(require.resolve("../content/preferences.js"),"utf8");
  const slider={value:"60",dataset:{},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}},label={value:""};
  const document={getElementById:id=>id==="noctua-notes-width"?slider:id==="noctua-notes-width-value"?label:null,addEventListener(){}};
  vm.runInNewContext(script,{document,window:{addEventListener(){}},setTimeout(){},Zotero:{Prefs:{set(){}}}});
  assert.equal(label.value,"60%");
  slider.value="75";slider.listeners.input();assert.equal(label.value,"75%");
});
