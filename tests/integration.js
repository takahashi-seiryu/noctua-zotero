"use strict";
// Only loaded when test-zotero.py sets an explicit isolated-profile preference.
(async () => {
  const resultPath = Zotero.Prefs.get("extensions.noctua-notes.testResult", true);
  const result = {passed:[],failed:[],finished:false};
  const checkpoint = () => IOUtils.writeUTF8(resultPath, JSON.stringify(result,null,2));
  const assert = (value, message) => {if(!value)throw new Error(message);};
  const clone = value => JSON.parse(JSON.stringify(value));
  try {
    await Zotero.uiReadyPromise;
    assert(!Zotero.Users.getCurrentUserID(), "Integration test must not be signed into a user account");
    assert(Zotero.DataDirectory.dir.includes("noctua-zotero-test-"), "Refusing to use a real library");
    const mainWindow=Zotero.getMainWindow();
    assert(mainWindow.document.querySelector('link[rel="localization"][href="noctua-notes.ftl"]'),"Plugin menu translations were not loaded into the main window");
    const toolsPopup=mainWindow.document.getElementById("menu_ToolsPopup");
    assert(toolsPopup,"Tools menu popup not found");
    toolsPopup.dispatchEvent(new mainWindow.Event("popupshowing",{bubbles:true}));
    const menuItems=[...toolsPopup.querySelectorAll('[data-l10n-id^="noctua-notes-"]')];
    await mainWindow.document.l10n.translateElements(menuItems);
    assert(menuItems.some(item=>item.getAttribute("label")==="Open Noctua Notes…"),"Open Noctua Notes menu label is blank or missing");
    assert(menuItems.some(item=>item.getAttribute("label")==="Import Noctua Source…"),"Import Noctua Source menu label is blank or missing");
    toolsPopup.dispatchEvent(new mainWindow.Event("popuphidden",{bubbles:true}));
    result.passed.push("Tools menu loads plugin localization and displays explicit English Open/Import labels");
    const storage=NoctuaNotes.storage, model=NoctuaNotes.model;
    await NoctuaNotes.previewCleanup;
    const paper=new Zotero.Item("journalArticle");
    paper.libraryID=Zotero.Libraries.userLibraryID;
    paper.setField("title","NOCTUA PROTOTYPE TEST — Control notes");
    paper.setField("date","2026");
    paper.setCreators([{firstName:"Ada",lastName:"Lovelace",creatorType:"author"}]);
    await paper.saveTx();
    const session={id:"isolated-integration-note",item:null,libraryID:paper.libraryID,parentID:paper.id,collectionID:null};
    const doc=model.blank(session.id);
    doc.title="Noctua Notes — integration source";
    doc.blocks[0].src="\\section{Control intuition}\nWe study $x_{t+1}=Ax_t+Bu_t$.\n\\begin{equation}J=\\sum_{t=0}^{T}\\|x_t\\|^2\\end{equation}";
    doc.blocks.push({id:"drawing1",type:"ink",w:1000,h:.35,strokes:[
      {c:"#8b85ff",w:4.5,p:[[100,170,.5],[200,90,.6],[300,170,.6],[400,90,.5],[500,170,.5]]}
    ]});
    doc.blocks.push({id:"image1",type:"image",caption:"Inline image source round-trip",data:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0b8AAAAASUVORK5CYII="});
    const first=await storage.save(session,doc,"");
    assert(session.item.isStoredFileAttachment(),"Source must be a stored attachment");
    assert(session.item.attachmentSyncState===Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD,"Source must be queued for native file sync");
    assert(first.doc.previewNoteKey===null&&paper.getNotes().length===0,"Saving must create only a source, without a reading preview");
    result.passed.push("Real Zotero source attachment created without a native preview; queued for file sync");
    await checkpoint();
    const reopened=await storage.load(session.item);
    assert(reopened.doc.blocks[1].strokes[0].p.length===5,"Vector strokes lost");
    assert(reopened.doc.blocks[2].data===doc.blocks[2].data,"Inline image lost");
    result.passed.push("Saved source reopened with LaTeX, vector strokes and image bytes intact");
    const second=await storage.save(session,reopened.doc,reopened.doc.revision);
    assert(second.doc.revision!==first.doc.revision,"Save must advance revision");
    assert(paper.getAttachments().length===1,"Repeated saves must not duplicate sources");
    result.passed.push("Repeated save updates existing source without creating duplicate attachments");
    const stale=clone(second.doc);stale.title="Unsaved conflicting local draft";
    const path=await session.item.getFilePathAsync();
    const remote=clone(second.doc);remote.revision="simulated-remote-change";
    await IOUtils.writeUTF8(path,JSON.stringify(remote));
    let conflicted=false;
    try {await storage.save(session,stale,second.doc.revision);}catch(error){conflicted=error.code==="NOCTUA_CONFLICT";}
    assert(conflicted,"Stale revision must be rejected");
    assert((await storage.getDraft(session.id)).doc.title===stale.title,"Conflict draft must be preserved");
    assert((await storage.load(session.item)).doc.revision===remote.revision,"Remote revision overwritten");
    result.passed.push("Remote revision conflict rejected and local draft preserved");
    await IOUtils.writeUTF8(path,JSON.stringify(second.doc));
    await IOUtils.remove(storage.draftPath(session.id),{ignoreAbsent:true});
    // Simulate native download delivery without using any real account or service.
    const originalDownload=Zotero.Sync.Runner.downloadFile;
    let requested=false;
    try {
      await IOUtils.remove(path);
      Zotero.Sync.Runner.downloadFile=async item=>{
        assert(item.key===session.item.key,"Wrong attachment requested");requested=true;
        await IOUtils.writeUTF8(path,JSON.stringify(second.doc));
        item.attachmentSyncState="in_sync";
      };
      assert((await storage.load(session.item)).doc.title===doc.title,"Downloaded source did not reopen");
      assert(requested,"Missing source did not request native download");
    } finally {Zotero.Sync.Runner.downloadFile=originalDownload;}
    result.passed.push("Missing source requests Zotero download-on-demand and reopens delivered content");
    result.passed.push("Preparing the in-app Noctua Notes tab");
    await checkpoint();
    const ordinaryNote=new Zotero.Item("note");ordinaryNote.libraryID=paper.libraryID;ordinaryNote.parentID=paper.id;
    ordinaryNote.setNote("<h1>Noctua Note — a normal Zotero note with a similar title</h1><p>This is not a Noctua instance.</p>");
    await ordinaryNote.saveTx();
    const instanceCount=NoctuaNotes.tabs.size;
    await Zotero.Notes.open(ordinaryNote.id);
    assert(mainWindow.Zotero_Tabs.selectedType.startsWith("note")&&NoctuaNotes.tabs.size===instanceCount,"Ordinary Zotero note was wrongly opened as a Noctua instance");
    mainWindow.Zotero_Tabs.close(mainWindow.Zotero_Tabs.selectedID);
    result.passed.push("Ordinary native notes remain in Zotero's editor even when their titles resemble Noctua notes");
    // Exercise the same activation path as a library-row double-click.
    await mainWindow.ZoteroPane.viewItems([session.item],new mainWindow.MouseEvent("dblclick",{bubbles:true,detail:2}));
    let win=[...NoctuaNotes.tabs.values()].find(entry=>entry.session.item?.key===session.item.key)?.editorWindow;
    assert(win,"Activating a Noctua source did not open its editor tab");
    for(let n=0;n<100&&!win.NoctuaNotesEditor;n++)await new Promise(resolve=>setTimeout(resolve,100));
    assert(win.NoctuaNotesEditor,"Editor failed to initialize");
    assert(!win.document.getElementById("save")&&!win.document.getElementById("import")&&!win.document.getElementById("export"),"Save/Import/Export buttons must not appear on the note page");
    assert(win.document.querySelector("header #save-status"),"Autosave status is missing from the top bar");
    assert(win.document.querySelector(".brand-mark").textContent==="🦉","Noctua app identity must use the owl emoji");
    assert(NoctuaNotes.appearance.getTheme()==="light"&&win.document.documentElement.dataset.theme==="light","Default editor theme must be explicitly light");
    assert(win.getComputedStyle(win.document.body).backgroundColor==="rgb(255, 255, 255)","Default editor background must be white");
    const initialRevision=win.NoctuaNotesEditor.getDocument().revision;
    win.document.getElementById("theme-toggle").click();
    assert(NoctuaNotes.appearance.getTheme()==="dark"&&win.document.documentElement.dataset.theme==="dark","Top-right theme toggle did not persist dark mode");
    const secondThemeWindow=await NoctuaNotes.open({create:true,item:paper});
    assert(secondThemeWindow.document.documentElement.dataset.theme==="dark","New tabs did not use saved appearance");
    assert(!secondThemeWindow.noctuaSession.item,"Untouched editor was unexpectedly saved");
    win.document.getElementById("open-settings").click();
    let prefsWindow;
    for(let n=0;n<100;n++) {
      prefsWindow=Services.wm.getMostRecentWindow("zotero:pref");
      if(prefsWindow?.document.getElementById("noctua-notes-theme")?.value==="dark")break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const themeControl=prefsWindow?.document.getElementById("noctua-notes-theme");
    assert(themeControl?.value==="dark","Native plugin settings failed to load the saved theme");
    themeControl.value="light";themeControl.dispatchEvent(new prefsWindow.Event("command",{bubbles:true}));
    assert(NoctuaNotes.appearance.getTheme()==="light"&&win.document.documentElement.dataset.theme==="light"&&secondThemeWindow.document.documentElement.dataset.theme==="light","Settings change did not update all open note tabs");
    themeControl.value="system";themeControl.dispatchEvent(new prefsWindow.Event("command",{bubbles:true}));
    const systemTheme=win.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
    assert(NoctuaNotes.appearance.getTheme()==="system"&&win.document.documentElement.dataset.theme===systemTheme,"Explicit system theme did not follow the OS");
    themeControl.value="light";themeControl.dispatchEvent(new prefsWindow.Event("command",{bubbles:true}));
    prefsWindow.close();
    assert(win.NoctuaNotesEditor.getDocument().revision===initialRevision,"Theme changes altered note content/revisions");
    const secondThemeEntry=[...NoctuaNotes.tabs.values()].find(entry=>entry.editorWindow===secondThemeWindow);
    secondThemeEntry.owner.Zotero_Tabs.close(secondThemeEntry.id);
    result.passed.push("White light default, persisted top-right theme toggle, native settings and cross-tab theme propagation work without changing note content");
    assert(Zotero.getMainWindow().Zotero_Tabs.selectedType==="noctuanotes","Editor must open inside a Zotero tab");
    assert(win.document.querySelector(".katex"),"Real Noctua LaTeX renderer did not render math");
    assert(win.document.querySelectorAll("canvas").length===2,"Original Noctua drawing pad did not mount");
    assert(win.document.querySelector(".nb-image img"),"Image block did not render");
    result.passed.push("Real Zotero tab renders KaTeX equations, drawing canvas and image block");
    const tabCount=NoctuaNotes.tabs.size;
    const same=await NoctuaNotes.open({item:session.item});
    assert(same===win&&NoctuaNotes.tabs.size===tabCount,"Opening the same source must reuse its tab");
    await mainWindow.ZoteroPane.viewAttachment(session.item.id);
    assert(NoctuaNotes.tabs.size===tabCount,"Attachment activation must reuse the instance tab");
    result.passed.push("Library source activation opens the exact Noctua instance; attachment opens reuse its tab");
    toolsPopup.dispatchEvent(new mainWindow.Event("popupshowing",{bubbles:true}));
    const exportMenu=toolsPopup.querySelector('[data-l10n-id="noctua-notes-export"]');
    await mainWindow.document.l10n.translateElements([exportMenu]);
    assert(exportMenu?.getAttribute("label")==="Export Noctua Source…"&&!exportMenu.hidden&&!exportMenu.disabled,"Tools source export is missing for the active editor");
    toolsPopup.dispatchEvent(new mainWindow.Event("popuphidden",{bubbles:true}));
    const exportTitle=win.document.getElementById("title");exportTitle.value="Unsaved source export";
    exportTitle.dispatchEvent(new win.Event("input",{bubbles:true}));
    const originalExport=NoctuaNotes.writeExport;let exportedDoc;
    try {NoctuaNotes.writeExport=async document=>{exportedDoc=clone(document);};await NoctuaNotes.exportSource({item:session.item});}
    finally {NoctuaNotes.writeExport=originalExport;}
    assert(exportedDoc?.title==="Unsaved source export","Menu export omitted pending editor changes");
    result.passed.push("Source transfer is menu-only; Tools export includes unsaved editor content");
    const titleInput=win.document.getElementById("title");
    titleInput.value="Control notes saved from the Zotero tab";
    titleInput.dispatchEvent(new win.Event("input",{bubbles:true}));
    for(let n=0;n<80;n++) {
      if((await storage.load(session.item)).doc.title===titleInput.value)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert((await storage.load(session.item)).doc.title===titleInput.value,"Editor save did not reach source attachment");
    result.passed.push("Editing autosaves to the stored source without a Save button; duplicate opens reuse the tab");
    titleInput.value="Control notes — preserved on tab close";
    titleInput.dispatchEvent(new win.Event("input",{bubbles:true}));
    const entry=[...NoctuaNotes.tabs.values()].find(t=>t.session.item.key===session.item.key);
    entry.owner.Zotero_Tabs.close(entry.id);
    for(let n=0;n<100;n++) {
      if((await storage.load(session.item)).doc.title==="Control notes — preserved on tab close")break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert((await storage.load(session.item)).doc.title==="Control notes — preserved on tab close","Closing a dirty tab lost its last edit");
    const beforeReopen=NoctuaNotes.tabs.size;
    // The item-tree handler doesn't return its async work. Wait via the same
    // source's in-flight open; simultaneous activation must create one tab.
    mainWindow.ZoteroPane.onItemTreeActivate(new mainWindow.MouseEvent("dblclick",{detail:2}),[session.item]);
    const concurrent=await Promise.all([NoctuaNotes.open({item:session.item}),NoctuaNotes.open({item:session.item})]);
    win=concurrent[0];
    assert(concurrent[1]===win&&NoctuaNotes.tabs.size===beforeReopen+1,"Concurrent double-click/open created duplicate instance tabs");
    assert(win.NoctuaNotesEditor.getDocument().title==="Control notes — preserved on tab close","Reopened tab lost saved title");
    result.passed.push("Closing a dirty tab commits the last edit and reopening restores the source");
    result.passed.push("Item-tree double-click and simultaneous opens create one tab per saved Noctua instance");
    const countBefore=win.NoctuaNotesEditor.getDocument().blocks.length;
    win.document.querySelectorAll(".block-inserter")[1].querySelector("button").click();
    let edited=win.NoctuaNotesEditor.getDocument();
    assert(edited.blocks.length===countBefore+1&&edited.blocks[1].type==="text","Between-block insertion lost its position");
    win.document.getElementById("undo").click();
    assert(win.NoctuaNotesEditor.getDocument().blocks.length===countBefore,"Whole-note undo did not remove insertion");
    win.document.getElementById("redo").click();
    assert(win.NoctuaNotesEditor.getDocument().blocks.length===countBefore+1,"Whole-note redo did not restore insertion");
    const addedID=win.NoctuaNotesEditor.getDocument().blocks[1].id;
    const added=win.document.querySelector(`[data-block-id="${addedID}"] textarea`);
    added.value="\\cite{"+paper.key+"}";
    added.dispatchEvent(new win.Event("input",{bubbles:true}));
    assert(win.document.querySelector("[data-noctua-cite]")?.textContent.includes("Lovelace 2026"),"Zotero citation did not resolve author/year");
    assert(win.document.getElementById("references").textContent.includes(paper.getField("title")),"References list missing cited title");
    {const cs=sel=>{const n=win.document.querySelector(sel);return n?win.getComputedStyle(n):null;};
      const info={bg:cs("body")?.backgroundColor,pill:cs(".ins-pill")?.opacity,handle:cs(".nb-handle")?.opacity,sr:cs(".sr-only")?.position,addRow:cs(".add-row")?.opacity,iconBorder:cs("#undo")?.borderTopColor,sheets:[...win.document.styleSheets].map(x=>x.href)};
      result.styleProbe=info;
      assert(info.pill==="0"&&info.handle==="0"&&info.sr==="absolute",
        "Editor stylesheet is not applied as designed: "+JSON.stringify(info));}
    {const t=win.document.getElementById("title"),original=t.value,one=t.getBoundingClientRect().height;
      t.value="A very long note title ".repeat(12);t.dispatchEvent(new win.Event("input",{bubbles:true}));
      const many=t.getBoundingClientRect().height;
      assert(many>one*1.8&&t.scrollHeight<=Math.ceil(many),"Long titles must wrap onto multiple lines: "+one+" -> "+many);
      t.value=original;t.dispatchEvent(new win.Event("input",{bubbles:true}));}
    const handleCount=win.document.querySelectorAll(".nb-handle").length, total=win.NoctuaNotesEditor.getDocument().blocks.length;
    assert(handleCount===total&&!win.document.querySelector(".nb-tools"),"Each block needs one drag handle and no inline tool buttons");
    win.document.querySelectorAll(".nb-handle")[1].click();assert(win.document.querySelector(".ctx-menu"),"Clicking the handle did not open the block menu");win.document.querySelectorAll(".nb-handle")[1].dispatchEvent(new win.Event("contextmenu",{bubbles:true,cancelable:true}));
    const ctx=win.document.querySelector(".ctx-menu");
    assert(ctx&&["up","down","duplicate","delete"].every(a=>ctx.querySelector(`[data-action="${a}"]`)),"Handle right-click menu is incomplete: "+(ctx?ctx.outerHTML.slice(0,400):"no menu; msg="+win.document.getElementById("message").textContent+" handles="+handleCount+" body="+win.document.body.lastElementChild?.outerHTML?.slice(0,120)));
    ctx.querySelector('[data-action="duplicate"]').click();
    assert(win.NoctuaNotesEditor.getDocument().blocks.length===total+1&&!win.document.querySelector(".ctx-menu"),"Duplicate from handle menu failed");
    win.document.querySelectorAll(".nb-handle")[2].dispatchEvent(new win.Event("contextmenu",{bubbles:true,cancelable:true}));
    win.document.querySelector('.ctx-menu [data-action="delete"]').click();
    assert(win.NoctuaNotesEditor.getDocument().blocks.length===total,"Delete from handle menu failed");
    result.passed.push("Block handle right-click menu duplicates and deletes without inline tool buttons");
    result.passed.push("Real editor inserts at position, undoes/redoes blocks and resolves Zotero citations with References");
    await win.NoctuaNotesEditor.save();

    const fixtureDir=PathUtils.join(Zotero.DataDirectory.dir,"original-note-fixture");
    await IOUtils.makeDirectory(PathUtils.join(fixtureDir,"images"),{ignoreExisting:true});
    const imageData=doc.blocks[2].data;
    const encoded=imageData.split(",")[1];
    // Known tiny PNG fixture bytes; importDocument exercises the native file resolver.
    const imageBytes=Uint8Array.from(Zotero.getMainWindow().atob(encoded),c=>c.charCodeAt(0));
    await IOUtils.write(PathUtils.join(fixtureDir,"images","pixel.png"),imageBytes);
    const original={version:1,id:"original-note",title:"Imported original Noctua note",created:1,updated:2,
      blocks:[{id:"drawing",type:"ink",h:.35,strokes:doc.blocks[1].strokes},
        {id:"beside",type:"text",beside:true,src:"$x^2$\n\\includegraphics[width=0.5\\textwidth]{images/pixel.png}"}]};
    const originalPath=PathUtils.join(fixtureDir,"original.json");
    await IOUtils.writeUTF8(originalPath,JSON.stringify(original));
    const importedWin=await NoctuaNotes.importDocument(originalPath,{item:paper});
    const migrated=importedWin.NoctuaNotesEditor.getDocument();
    assert(migrated.origin.id===original.id && migrated.blocks[0].w===1000,"Original identity or legacy drawing width lost");
    assert(migrated.blocks[1].beside && importedWin.document.querySelector(".beside-text"),"Original beside layout lost");
    assert(importedWin.document.querySelector(".tex-view img")?.src===imageData,"Original raster image did not render inline");
    const importedEntry=[...NoctuaNotes.tabs.values()].find(t=>t.editorWindow===importedWin);
    const persisted=await storage.load(importedEntry.session.item);
    assert(persisted.doc.media["images/pixel.png"]===imageData,"Imported image was not saved in the attachment");
    const portablePath=PathUtils.join(fixtureDir,"portable.noctua.json");
    await IOUtils.writeUTF8(portablePath,JSON.stringify(persisted.doc));
    await IOUtils.remove(PathUtils.join(fixtureDir,"images","pixel.png"));
    const portableWin=await NoctuaNotes.importDocument(portablePath,{item:paper});
    assert(portableWin.NoctuaNotesEditor.getDocument().id!==migrated.id,"Import reused source identity");
    assert(portableWin.document.querySelector(".tex-view img")?.src===imageData,"Portable import unexpectedly required external images");
    result.passed.push("Original JSON imports legacy ink width, beside text and local images; portable export reimports without external assets");
    mainWindow.Zotero_Tabs.select("zotero-pane");
    await mainWindow.ZoteroPane_Local.selectItem(paper.id);
    const details=[...mainWindow.document.querySelectorAll("item-details")].find(node=>node.item?.id===paper.id);
    assert(details,"Selected paper's item details not found");
    await details.render();
    const customPane=[...details.querySelectorAll("item-pane-custom-section")].find(node=>node.paneID?.includes("noctua-notes"));
    assert(customPane&&!customPane.hidden,"Noctua Notes section is missing or hidden for a paper");
    const nav=[...details.sidenav.querySelectorAll(".btn[data-pane]")].find(button=>button.dataset.pane===customPane.paneID);
    assert(nav,"Noctua Notes sidebar icon not registered");
    await mainWindow.document.l10n.translateElements([nav]);
    assert(nav.getAttribute("tooltiptext")==="Noctua Notes","Noctua sidebar entry has no visible English name");
    await details.scrollToPane(customPane.paneID,"instant");
    await customPane.asyncRender();
    const openFromPane=customPane.querySelector(`[data-noctua-open="${session.item.key}"]`);
    assert(openFromPane,"Sidebar did not list the paper's exact Noctua source");
    assert(!customPane.textContent.includes("a normal Zotero note with a similar title"),"Ordinary note leaked into Noctua-only sidebar list");
    {const icon=mainWindow.document.querySelector('.tab-icon[data-item-type="noctuanote"]');
      assert(icon,"Noctua tab does not use its own icon name");
      assert(mainWindow.getComputedStyle(icon).backgroundImage.includes("noctua-notes.svg"),"Noctua tab icon artwork is not applied");}
    const beforePaneOpen=NoctuaNotes.tabs.size;
    openFromPane.click();await new Promise(resolve=>setTimeout(resolve,150));
    assert(NoctuaNotes.tabs.size===beforePaneOpen&&mainWindow.Zotero_Tabs.selectedID==="zotero-pane","A single click must not open the note");
    assert(!openFromPane.textContent.includes("Noctua Note —")&&openFromPane.querySelectorAll("button").length===0,"Sidebar row should show a clean title and no Open button");
    openFromPane.dispatchEvent(new mainWindow.Event("dblclick",{bubbles:true}));
    const expected=[...NoctuaNotes.tabs.values()].find(entry=>entry.session.item?.key===session.item.key);
    for(let n=0;n<100&&mainWindow.Zotero_Tabs.selectedID!==expected.id;n++)await new Promise(resolve=>setTimeout(resolve,50));
    assert(mainWindow.Zotero_Tabs.selectedID===expected.id&&NoctuaNotes.tabs.size===beforePaneOpen,"Sidebar Open did not select the exact existing instance");
    result.passed.push("Right sidebar has named Noctua entry, lists only Noctua instances and opens the exact source");
    mainWindow.Zotero_Tabs.select("zotero-pane");
    const createFromPane=customPane.querySelector("[data-noctua-create]");
    assert(createFromPane&&!createFromPane.disabled,"Sidebar cannot create a Noctua note for the paper");
    const beforeCreate=NoctuaNotes.tabs.size;createFromPane.click();
    for(let n=0;n<100&&NoctuaNotes.tabs.size===beforeCreate;n++)await new Promise(resolve=>setTimeout(resolve,50));
    const fresh=[...NoctuaNotes.tabs.values()].find(entry=>!entry.session.item&&entry.session.parentID===paper.id);
    assert(fresh,"Sidebar New did not create a separate editor for the selected paper");
    for(let n=0;n<100&&!fresh.editorWindow?.NoctuaNotesEditor;n++)await new Promise(resolve=>setTimeout(resolve,50));
    const newTitle=fresh.editorWindow.document.getElementById("title");
    newTitle.value="Created through Noctua sidebar";newTitle.dispatchEvent(new fresh.editorWindow.Event("input",{bubbles:true}));
    await fresh.editorWindow.NoctuaNotesEditor.save();
    assert(fresh.session.item?.parentID===paper.id,"Sidebar-created instance did not save under its selected paper");
    mainWindow.Zotero_Tabs.select("zotero-pane");await mainWindow.ZoteroPane_Local.selectItem(paper.id);
    for(let n=0;n<100&&!customPane.querySelector(`[data-source-key="${fresh.session.item.key}"]`);n++)await new Promise(resolve=>setTimeout(resolve,50));
    assert(customPane.querySelector(`[data-source-key="${fresh.session.item.key}"]`),"Sidebar did not refresh after a new instance was saved");
    result.passed.push("Right sidebar creates an independent note under the paper and refreshes after its save");
    const raceWindow=await NoctuaNotes.open({create:true,item:paper});
    const raceEntry=[...NoctuaNotes.tabs.values()].find(entry=>entry.editorWindow===raceWindow);
    const executeTransaction=Zotero.DB.executeTransaction;
    let releaseFirst,reachedFirst,pausedFirst=false;
    const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
    const firstReached=new Promise(resolve=>{reachedFirst=resolve;});
    try {
      Zotero.DB.executeTransaction=async function(...args) {
        if(!pausedFirst&&raceEntry.session.item) {
          pausedFirst=true;reachedFirst();await firstGate;
        }
        return executeTransaction.apply(this,args);
      };
      const title=raceWindow.document.getElementById("title");
      title.value="First autosave snapshot";title.dispatchEvent(new raceWindow.Event("input",{bubbles:true}));
      raceWindow.NoctuaNotesEditor.save().catch(error=>Zotero.logError(error));
      await Promise.race([firstReached,new Promise((_,reject)=>setTimeout(()=>reject(new Error("First-save checkpoint was not reached")),5000))]);
      assert(raceEntry.session.item,"Race checkpoint must be after source assignment");
      title.value="Latest edits while first autosave was pending";title.dispatchEvent(new raceWindow.Event("input",{bubbles:true}));
      const pendingFirst=storage.pendingSave(raceEntry.session);
      raceEntry.owner.Zotero_Tabs.close(raceEntry.id);
      Zotero.DB.executeTransaction=executeTransaction;releaseFirst();
      await pendingFirst;await raceEntry.closingPromise;
      assert((await storage.load(raceEntry.session.item)).doc.title==="Latest edits while first autosave was pending","Closing during the first autosave lost the latest edits");
      assert(!(await storage.getDraft(raceEntry.session.id)),"Successfully committed close snapshot left an obsolete draft");
    } finally {Zotero.DB.executeTransaction=executeTransaction;releaseFirst();}
    result.passed.push("Closing a new note during its first source commit preserves the latest edits and uses the committed revision");
    const legacyPreviews=[];
    for(const mode of ["0.1","0.3","0.4","edited"]) {
      const legacySession={id:"legacy-"+mode,item:null,libraryID:paper.libraryID,parentID:paper.id,collectionID:null};
      const legacyDoc=model.blank(legacySession.id);legacyDoc.title="Legacy "+mode;legacyDoc.blocks[0].src="$x^2$";
      const saved=await storage.save(legacySession,legacyDoc,"");
      const native=new Zotero.Item("note");native.libraryID=paper.libraryID;native.parentID=paper.id;await native.saveTx();
      saved.doc.previewNoteKey=native.key;
      let html=storage._legacyPreviewHTML(saved.doc,legacySession.item.key);
      if(mode==="0.1")html=html.replace(/<h1>.*?<\/h1>/,"<h1>"+model.esc(saved.doc.title)+"</h1>");
      if(mode==="0.3")html=html.replace(/<h1>.*?<\/h1>/,"<h1>"+model.esc(saved.doc.title)+" — Reading preview</h1>");
      if(mode==="edited")html=html.replace("</div>","<p>Personal edit to preserve</p></div>");
      native.setNote(html);native.addRelatedItem(legacySession.item);legacySession.item.addRelatedItem(native);
      await native.saveTx();await legacySession.item.saveTx();
      await IOUtils.writeUTF8(await legacySession.item.getFilePathAsync(),JSON.stringify(saved.doc));
      legacyPreviews.push({native,source:legacySession.item,doc:saved.doc,mode});
    }
    const cleanup=await storage.cleanupLegacyPreviews();
    assert(cleanup.trashed===3&&cleanup.errors.length===0,"Unchanged legacy previews were not safely moved to Trash: "+JSON.stringify(cleanup));
    assert(legacyPreviews.slice(0,3).every(entry=>entry.native.deleted&&!entry.source.deleted),"Cleanup removed a source or retained a generated preview");
    assert(!legacyPreviews[3].native.deleted&&!ordinaryNote.deleted,"Cleanup removed an edited preview or ordinary native note");
    assert((await storage.cleanupLegacyPreviews()).trashed===0,"Legacy cleanup is not idempotent");
    result.passed.push("Legacy 0.1/0.3/0.4 previews move to Trash; sources, edited companions and ordinary notes remain intact");
    result.sourceKey=session.item.key;
    result.windowTitle=win.document.title;
    result.dataDirectory=Zotero.DataDirectory.dir;
  } catch(error) {
    result.failed.push({message:String(error),stack:error.stack});
    const main=Zotero.getMainWindow();
    result.ui={mainWindow:!!main,closed:main?.closed,location:main?.location?.href,
      tabs:main?.Zotero_Tabs?._tabs?.map(t=>({id:t.id,type:t.type,title:t.title})),
      editors:[...NoctuaNotes.tabs.values()].map(e=>({src:e.frame.src,
        frameURL:e.frame.contentWindow?.location?.href,readyState:e.frame.contentDocument?.readyState}))};
    result.console=Services.console.getMessageArray().map(m=>m.message).filter(m=>/noctua|denied|CSP|Content Security|iframe/i.test(m)).slice(-8);
    result.panes=[...main.document.querySelectorAll("item-details")].map(details=>({itemID:details.item?.id,tabType:details.tabType,
      panes:[...details.querySelectorAll("item-pane-custom-section")].map(pane=>({id:pane.paneID,hidden:pane.hidden,text:pane.textContent.slice(0,200)})),
      sidenavContainerID:details.sidenav?.container?.item?.id,buttons:[...(details.sidenav?.querySelectorAll(".btn[data-pane]")||[])].map(button=>button.dataset.pane)}));
    Zotero.logError(error);
  }
  result.finished=true;
  await checkpoint();
})().catch(error=>Zotero.logError(error));
