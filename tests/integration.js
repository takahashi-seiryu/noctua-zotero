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
    assert(!menuItems.some(item=>/^Open Noctua Notes/.test(item.getAttribute("label")||"")),"Tools menu must not offer Open Noctua Notes");
    assert(menuItems.some(item=>item.getAttribute("label")==="Import Noctua Source"),"Import Noctua Source menu label is blank or missing");
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
    session.item.setField("title","Noctua Note — legacy");await session.item.saveTx();
    assert(session.item.getItemTypeIconName()==="noctuanote","Noctua sources must use their own icon name");
    assert(await storage.stripTitlePrefix()===1&&session.item.getField("title")==="legacy","Legacy title prefix must be stripped");
    await mainWindow.ZoteroPane.itemsView.expandAllRows();
    await new Promise(resolve=>setTimeout(resolve,1500));
    const icon=mainWindow.document.querySelector('#item-tree-main-default .icon-item-type[data-item-type="noctuanote"]');
    assert(icon&&mainWindow.getComputedStyle(icon).backgroundImage.includes("noctua-notes.svg"),"Item-tree row must draw the Noctua icon");
    result.passed.push("Noctua sources show their own icon in the item tree; legacy title prefix is stripped");
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
    assert(exportMenu?.getAttribute("label")==="Export Noctua Source"&&!exportMenu.hidden&&!exportMenu.disabled,"Tools source export is missing for the active editor");
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
    {const keep=added.value;
      added.value="https://youtu.be/dQw4w9WgXcQ\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\\begin{tabular}{|l|r|}\\hline x & y \\\\ \\hline\\end{tabular}";
      added.dispatchEvent(new win.Event("input",{bubbles:true}));
      const view=added.closest(".nb").querySelector(".nb-view");
      const poster=view.querySelector(".tex-youtube .yt-poster img");
      assert(poster&&/^https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/(maxres|sd|hq)default\.jpg$/.test(poster.getAttribute("src")),"YouTube thumbnail card was not rendered");
      assert(view.querySelectorAll("table.tex-table").length===2&&view.querySelectorAll("td").length>=4,"Pipe and LaTeX tables did not render");
      await new Promise(resolve=>setTimeout(resolve,3000));
      result.youtubeProbe={thumbnailLoaded:poster.complete&&poster.naturalWidth>0,naturalWidth:poster.naturalWidth,src:poster.getAttribute('src')};
      assert(poster.naturalWidth>=1280,'Expected the HD thumbnail, got '+poster.naturalWidth+'px from '+poster.getAttribute('src'));
      {view.querySelector(".tex-youtube .yt-poster").click();
        const frame=view.querySelector(".tex-youtube .yt-frame"),player=frame?.querySelector("browser");
        assert(player,"Clicking the thumbnail did not open an inline player");
        await new Promise(resolve=>setTimeout(resolve,9000));
        assert(/^https:\/\/www\.youtube\.com\/watch\?app=desktop&v=dQw4w9WgXcQ$/.test(String(player.currentURI?.spec)),"Inline player did not load the watch page: "+player.currentURI?.spec);
        const w=Math.round(frame.getBoundingClientRect().width),h=Math.round(frame.getBoundingClientRect().height);
        const bmp=await player.drawSnapshot(0,56,w,h,1,"white");
        const canvas=win.document.createElement("canvas");canvas.width=w;canvas.height=h;canvas.getContext("2d").drawImage(bmp,0,0);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
        await IOUtils.write(PathUtils.join(PathUtils.parent(Zotero.Prefs.get("extensions.noctua-notes.testResult",true)),"youtube-player.png"),new Uint8Array(await blob.arrayBuffer()));
        result.youtubePlayer={w,h,url:player.currentURI?.spec};}
      {added.value="Alpha beta $x$ **plain** gamma delta epsilon.";added.dispatchEvent(new win.Event("input",{bubbles:true}));
        const v=added.closest(".nb").querySelector(".nb-view");
        const walker=win.document.createTreeWalker(v,4);let range=null;
        for(let n=walker.nextNode();n;n=walker.nextNode()){const i=n.nodeValue.indexOf("delta");if(i>=0){range=win.document.createRange();range.setStart(n,i+2);range.setEnd(n,i+3);break;}}
        assert(range,"Could not find the word to click in the preview");
        const box=range.getBoundingClientRect();
        added.closest(".nb").classList.remove("editing");
        v.dispatchEvent(new win.MouseEvent("click",{bubbles:true,cancelable:true,clientX:box.left+1,clientY:box.top+box.height/2}));
        const from=added.value.indexOf("delta");
        assert(added.selectionStart>=from&&added.selectionStart<=from+5,"Clicking a rendered word should put the source caret there: caret "+added.selectionStart+", word at "+from);
        result.passed.push("Clicking rendered text places the source caret at the matching position");}
      {added.value="# Heading\n\nSome **bold**, *italic* and `code` with $x^2$.\n\n- one\n- two\n\n\\begin{align} a&=b \\\\ c&=d \\end{align}";
        added.dispatchEvent(new win.Event("input",{bubbles:true}));added.closest(".nb").classList.remove("editing");
        await new Promise(resolve=>setTimeout(resolve,800));
        const v=added.closest(".nb").querySelector(".nb-view");
        assert(v.querySelector("h2")&&v.querySelector("b")&&v.querySelector("em")&&v.querySelector("code")&&v.querySelectorAll("li").length===2,"Markdown basics did not render");
        assert(v.querySelectorAll(".katex").length>=2&&!v.querySelector(".katex-error,.tex-unknown"),"Math did not render with KaTeX");}
      {const filler=Array.from({length:40},(_,i)=>"Filler paragraph number "+i+" with some text to take up room.").join("\n\n");
        added.value="Jump to \\ref{eq:far} and \\ref{sec:far}.\n\n"+filler+"\n\n\\section{Far section}\\label{sec:far}\n\\begin{equation}\\label{eq:far} x=1 \\end{equation}\n\nEnd.";
        added.dispatchEvent(new win.Event("input",{bubbles:true}));added.closest(".nb").classList.remove("editing");
        await new Promise(resolve=>setTimeout(resolve,1200));
        const v=added.closest(".nb").querySelector(".nb-view"),link=v.querySelector('a.tex-ref[data-tex-ref="eq:far"]'),target=v.querySelector('[data-tex-label="eq:far"]');
        assert(link&&target,"Reference and its target must both render");
        const before=target.getBoundingClientRect().top;
        link.dispatchEvent(new win.MouseEvent("click",{bubbles:true,cancelable:true}));
        await new Promise(resolve=>setTimeout(resolve,900));
        const after=target.getBoundingClientRect().top;
        assert(before>win.innerHeight&&after>=0&&after<=win.innerHeight,"Clicking a reference should scroll its target into view: "+before+" -> "+after);
        assert(!added.closest(".nb").classList.contains("editing"),"Clicking a reference must not start editing");
        win.document.scrollingElement.scrollTop=0;await new Promise(resolve=>setTimeout(resolve,300));
        result.passed.push("Clicking a reference scrolls to its label");}
      added.value=keep;added.dispatchEvent(new win.Event("input",{bubbles:true}));}
    {const fake=PathUtils.join(PathUtils.tempDir,"noctua-fake-claude-"+Date.now()+".py");
      await IOUtils.writeUTF8(fake,`#!/usr/bin/python3
import sys,json,os
open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"noctua-fake-args.json"),"w").write(json.dumps(sys.argv))
sys.stdin.read()
t=open("note.tex").read().split("\\n")
for i,l in enumerate(t):
    if l.startswith("%%% block") and l.endswith(" text"):
        t[i+1]+=" [AI]"+(" [ATT]" if os.path.exists("attachments/ref.txt") and open("attachments/ref.txt").read()=="hello" else "");break
open("note.tex","w").write("\\n".join(t))
print(json.dumps({"type":"system","session_id":"s1"}))
print(json.dumps({"type":"assistant","message":{"content":[{"type":"text","text":"Appended a marker."}]}}))
print(json.dumps({"type":"result","subtype":"success","result":"Appended a marker.","session_id":"s1"}))
`);
      await IOUtils.setPermissions(fake,0o755);
      Zotero.Prefs.set("extensions.noctua-notes.agent.claudePath",fake,true);
      const d=win.document,wait=async(test,ms=15000)=>{for(let n=0;n<ms/100&&!test();n++)await new Promise(resolve=>setTimeout(resolve,100));return test();};
      {const ta=d.querySelector(".nb-text textarea"),original=ta.value;
        ta.focus();ta.value="\\cite{Love";ta.setSelectionRange(ta.value.length,ta.value.length);ta.dispatchEvent(new win.Event("input",{bubbles:true}));
        assert(await wait(()=>d.querySelector(".cite-suggest .cite-row")),"\\cite{ did not open the citation list");
        assert(d.querySelector(".cite-suggest").textContent.includes("NOCTUA PROTOTYPE"),"Citation list did not match the author prefix");
        {const box=d.querySelector(".cite-suggest");
          box.dispatchEvent(new win.Event("scroll"));
          ta.dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));
          ta.dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true}));
          await new Promise(r=>setTimeout(r,200));
          assert(d.querySelector(".cite-suggest"),"Scrolling or arrowing through the citation list must not close it");}
        ta.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
        assert(/^\\cite\{[A-Z0-9]{8}\}$/.test(ta.value),"Enter did not insert the item key: "+ta.value);
        assert(!d.querySelector(".cite-suggest"),"Citation list stayed open after choosing");
        ta.value=original;ta.dispatchEvent(new win.Event("input",{bubbles:true}));}
      {const pad=d.querySelector(".nb-ink .ink");
        if(pad){const col=pad.closest(".nb").clientWidth;
          assert(await wait(()=>Math.abs(pad.getBoundingClientRect().width-col)<=2),"Drawing is not as wide as the note column: "+pad.getBoundingClientRect().width+" vs "+col);}}
      {const when=d.getElementById("save-time");
        assert(when&&/^(just now|\d+ min ago|\d+ h ago|Yesterday|\d+ days ago)$/.test(when.textContent),"Header should show when the note was last saved, got: "+when?.textContent);}
      {const ta=d.querySelector(".nb-text textarea"),original=ta.value;
        // One keystroke as the engine delivers it: keydown first, then the text insertion as beforeinput.
        const type=ch=>{ta.value="";ta.setSelectionRange(0,0);ta.focus();
          ta.dispatchEvent(new win.KeyboardEvent("keydown",{key:ch,bubbles:true,cancelable:true}));
          ta.dispatchEvent(new win.InputEvent("beforeinput",{inputType:"insertText",data:ch,bubbles:true,cancelable:true}));
          return [ta.value,ta.selectionStart];};
        const [brace,bracePos]=type("{"),[paren]=type("("),[dollar]=type("$");
        assert(brace==="{}"&&bracePos===1,"One { keystroke must make exactly one pair, got: "+brace);
        assert(paren==="()"&&dollar==="$$","Brackets and dollars must pair once: "+paren+" "+dollar);
        ta.value=original;ta.dispatchEvent(new win.Event("input",{bubbles:true}));}
      {const fakeCodex=PathUtils.join(PathUtils.tempDir,"noctua-fake-codex-"+Date.now()+".py");
        await IOUtils.writeUTF8(fakeCodex,`#!/usr/bin/python3
import sys,json,os
if len(sys.argv)>2 and sys.argv[1]=="debug":
    print(json.dumps({"models":[
      {"slug":"cx-fast","display_name":"CX Fast","visibility":"list","priority":1,"default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"},{"effort":"ultra"}],"service_tiers":[{"id":"priority","name":"Fast","description":"2x speed"}]},
      {"slug":"cx-slow","display_name":"CX Slow","visibility":"list","priority":2,"default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"medium"}],"service_tiers":[]}]}))
    sys.exit(0)
sys.stdin.read()
open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"noctua-fake-codex-args.json"),"w").write(json.dumps(sys.argv))
print(json.dumps({"type":"thread.started","thread_id":"t1"}))
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"CODEX-OK"}}))
print(json.dumps({"type":"turn.completed"}))
`);
        await IOUtils.setPermissions(fakeCodex,0o755);
        Zotero.Prefs.set("extensions.noctua-notes.agent.codexPath",fakeCodex,true);
        d.getElementById("chat-toggle").click();
        assert(await wait(()=>d.querySelectorAll(".chat-provider-seg button").length===2),"Both providers should show a switch");
        const seg=d.querySelector(".chat-provider-seg"),btn=id=>seg.querySelector(`button[data-provider="${id}"]`),sel=()=>d.getElementById("chat-provider").value;
        assert(sel()==="claude","Claude should be selected first, got "+sel());
        btn("claude").click();assert(sel()==="codex","Pressing the selected provider should flip to the other one");
        btn("codex").click();assert(sel()==="claude","Pressing the selected provider again should flip back");
        btn("codex").click();assert(sel()==="codex","Pressing the other provider should select it");
        // Codex: the model list comes from its catalog and Fast mode is a lightning button.
        assert(sel()==="codex");
        const bolt=d.getElementById("chat-fast");
        assert(await wait(()=>!bolt.hidden),"Codex should offer a Fast mode button");
        assert(bolt.getAttribute("aria-pressed")==="false","Fast mode should start off");
        d.getElementById("chat-model").click();
        assert(await wait(()=>[...d.querySelectorAll("#chat-model-list .cmp-row")].some(r=>r.textContent.includes("CX Slow"))),"The Codex model list should come from its catalog");
        [...d.querySelectorAll("#chat-model-list .cmp-row")].find(r=>r.textContent.includes("CX Slow")).click();
        assert(await wait(()=>bolt.disabled),"A model without a Fast tier should disable the button");
        [...d.querySelectorAll("#chat-model-list .cmp-row")].find(r=>r.textContent.includes("CX Fast")).click();
        assert(await wait(()=>!bolt.disabled),"A Fast-capable model should enable the button");
        assert(await wait(()=>[...d.querySelectorAll("#chat-effort-list .cmp-row")].some(r=>r.textContent.includes("Ultra"))),"Codex reasoning levels should include Ultra");
        d.getElementById("chat-model").click();
        bolt.click();assert(await wait(()=>bolt.getAttribute("aria-pressed")==="true"),"Clicking the lightning button should turn Fast mode on");
        assert(win.getComputedStyle(bolt).backgroundColor==="rgba(0, 0, 0, 0)","The Fast button must keep a transparent background when on: "+win.getComputedStyle(bolt).backgroundColor);
        assert(win.getComputedStyle(bolt).color!==win.getComputedStyle(d.getElementById("chat-attach")).color,"The icon colour should show that Fast mode is on");
        d.getElementById("chat-input").value="hello codex";
        d.getElementById("chat-form").dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true}));
        assert(await wait(()=>d.getElementById("chat-log").textContent.includes("CODEX-OK")),"Codex did not answer: "+d.getElementById("chat-log").textContent);
        {const args=JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.tempDir,"noctua-fake-codex-args.json")));
          assert(args.includes('service_tier="priority"')&&args[args.indexOf("-m")+1]==="cx-fast","Codex did not receive Fast mode and the chosen model: "+JSON.stringify(args));}
        bolt.click();assert(await wait(()=>bolt.getAttribute("aria-pressed")==="false"),"Clicking again should turn Fast mode off");
        Zotero.NoctuaNotes.uiState.set("ui.agent.model.codex","");Zotero.NoctuaNotes.uiState.set("ui.agent.fast.codex","0");
        await IOUtils.remove(fakeCodex,{ignoreAbsent:true});
        btn("claude").click();
        seg.dispatchEvent(new win.MouseEvent("click",{bubbles:true}));assert(sel()==="codex","Pressing the switch itself should flip it");
        seg.dispatchEvent(new win.MouseEvent("click",{bubbles:true}));assert(sel()==="claude","Pressing the switch again should flip back");
        d.getElementById("chat-toggle").click();
        Zotero.Prefs.clear("extensions.noctua-notes.agent.codexPath",true);}
      {const ta=d.querySelector(".nb-text textarea"),original=ta.value;
        ta.focus();ta.value="item";ta.setSelectionRange(0,0);
        const tab=new win.KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true});
        ta.dispatchEvent(tab);
        assert(tab.defaultPrevented&&ta.value==="  item","Tab should indent inside the block instead of moving focus: "+JSON.stringify(ta.value));
        ta.value=original;ta.dispatchEvent(new win.Event("input",{bubbles:true}));}
      Zotero.Prefs.set("extensions.noctua-notes.contentWidth",60,true);
      assert(await wait(()=>d.documentElement.style.getPropertyValue("--note-width")==="60%"),"Note width setting did not reach the open editor");
      Zotero.Prefs.clear("extensions.noctua-notes.contentWidth",true);
      assert(await wait(()=>d.documentElement.style.getPropertyValue("--note-width")==="60%"),"Resetting the note width did not restore the default");
      Zotero.Prefs.set("extensions.noctua-notes.ink.color2","#112233",true);
      assert(await wait(()=>d.querySelector('.ink-tools [data-color="#112233"]')),"Pen colour setting did not reach open drawing toolbars");
      assert(d.querySelectorAll(".ink-tools")[0].querySelectorAll("[data-color]").length===5&&d.querySelector('.ink-tools [data-color]').dataset.color==="#e8e6e1","Palette should be the adaptive Ink pen plus four accents");
      Zotero.Prefs.clear("extensions.noctua-notes.ink.color2",true);
      assert(await wait(()=>d.querySelector('.ink-tools [data-color="#e5484d"]')),"Resetting the pen colour did not restore the default");
      d.getElementById("chat-toggle").click();
      assert(!d.getElementById("chat").hidden&&d.body.classList.contains("chat-open"),"Assistant panel did not open");
      assert(await wait(()=>![...d.querySelectorAll("#chat-provider option")].find(o=>o.value==="claude")?.textContent.includes("not found")),"Provider list did not pick up the configured CLI");
      d.getElementById("chat-provider").value="claude";
      const before=win.NoctuaNotesEditor.getDocument(),at=before.blocks.findIndex(b=>b.type==="text");
      {const dt=new win.DataTransfer();dt.items.add(new win.File(["hello"],"ref.txt",{type:"text/plain"}));
        d.getElementById("chat-form").dispatchEvent(new win.DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:dt}));}
      assert(await wait(()=>d.querySelector("#chat-attachments .chat-chip")),"Dropped file did not appear as an attachment chip");
      {const input=d.getElementById("chat-input");
        input.focus();input.value="/mo";input.setSelectionRange(3,3);input.dispatchEvent(new win.Event("input",{bubbles:true}));
        assert(await wait(()=>d.querySelector(".slash-pop .slash-row")),"Typing / should list commands");
        assert([...d.querySelectorAll(".slash-pop .slash-name")].some(n=>n.textContent==="/model"),"The /model command should be listed");
        input.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
        assert(await wait(()=>!d.getElementById("chat-model-pop").hidden),"Choosing /model should open the model picker");
        assert(input.value==="","The command text should be removed from the message: "+JSON.stringify(input.value));
        assert(!d.querySelector(".slash-pop"),"The list should close after choosing");
        d.getElementById("chat-model").click();await wait(()=>d.getElementById("chat-model-pop").hidden);
        input.value="$";input.setSelectionRange(1,1);input.dispatchEvent(new win.Event("input",{bubbles:true}));
        await new Promise(r=>setTimeout(r,400));
        assert([...d.querySelectorAll(".slash-pop .slash-tag")].every(t=>t.textContent==="skill"),"$ should list skills only");
        input.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));input.value="";}
      {const modelBtn=d.getElementById("chat-model");
        assert(modelBtn&&modelBtn.textContent.includes("Default"),"Model button should start at Default");
        modelBtn.click();
        assert(await wait(()=>d.querySelectorAll("#chat-model-list .cmp-row").length>=5),"Model list did not open");
        const pick=(listId,text)=>[...d.querySelectorAll(`#${listId} .cmp-row`)].find(r=>r.textContent.includes(text));
        {const search=d.getElementById("chat-model-search");
          if(!search.hidden){search.focus();const cs=win.getComputedStyle(search);
            assert(cs.outlineStyle==="none"||cs.outlineWidth==="0px","The model search box should show no focus outline: "+cs.outline);}}
        pick("chat-model-list","Claude Opus").click();
        assert(await wait(()=>pick("chat-effort-list","Extra High")),"Reasoning levels did not appear");
        pick("chat-effort-list","High").click();
        assert(await wait(()=>modelBtn.textContent.includes("Claude Opus")&&modelBtn.textContent.includes("High")),"Button did not show the choice: "+modelBtn.textContent);
        assert(d.getElementById("chat-model-pop").hidden,"Popover should close after choosing a reasoning level");
        assert(/^(opus|claude-opus[\w.-]*)$/.test(Zotero.NoctuaNotes.uiState.get("ui.agent.model.claude"))&&Zotero.NoctuaNotes.uiState.get("ui.agent.effort.claude")==="high","The choice was not persisted by the plugin");
        await Zotero.NoctuaNotes.uiState.flush();
        const saved=JSON.parse(await IOUtils.readUTF8(PathUtils.join(Zotero.DataDirectory.dir,"noctua-notes-ui.json")));
        assert(/^(opus|claude-opus[\w.-]*)$/.test(saved["ui.agent.model.claude"]),"The choice did not reach the settings file");}
      d.getElementById("chat-input").value="Polish the first paragraph";
      d.getElementById("chat-form").dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true}));
      assert(await wait(()=>d.getElementById("chat-apply")),"Assistant proposal never appeared: "+d.getElementById("chat-log").textContent);
      {const args=JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.tempDir,"noctua-fake-args.json")));
        const at=flag=>args[args.indexOf(flag)+1];
        assert(/^(opus|claude-opus[\w.-]*)$/.test(at("--model"))&&at("--effort")==="high","The CLI did not receive the chosen model and reasoning: "+JSON.stringify(args));}
      assert(d.getElementById("chat-proposal").textContent.includes("[ATT]")&&d.getElementById("chat-log").textContent.includes("ref.txt"),"The assistant did not receive the attached file");
      assert(d.getElementById("chat-log").textContent.includes("Appended a marker.")&&d.getElementById("chat-proposal").textContent.includes("Edited block "+(at+1)),"Reply or proposal summary missing");
      assert(win.NoctuaNotesEditor.getDocument().blocks[at].src===before.blocks[at].src,"Note changed before the proposal was approved");
      d.getElementById("chat-apply").click();
      const applied=win.NoctuaNotesEditor.getDocument().blocks[at].src;
      assert(applied.split("\n")[0]===before.blocks[at].src.split("\n")[0]+" [AI] [ATT]"&&applied.split("\n").slice(1).join("\n")===before.blocks[at].src.split("\n").slice(1).join("\n"),"Applying the proposal did not update only the first line: "+JSON.stringify(applied));
      d.getElementById("undo").click();
      assert(win.NoctuaNotesEditor.getDocument().blocks[at].src===before.blocks[at].src,"One Undo did not revert the assistant's edit");
      d.getElementById("chat-close").click();
      Zotero.Prefs.clear("extensions.noctua-notes.agent.claudePath",true);await IOUtils.remove(fake,{ignoreAbsent:true});
      result.passed.push("Assistant panel runs the configured CLI, proposes block edits and applies them as one undoable step");}
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
    // ---- Paper reading assistant (PDF full text + chat in the side pane)
    {const scriptURI=Zotero.Prefs.get("extensions.noctua-notes.testScript",true);
      const scriptPath=Services.io.newURI(scriptURI).QueryInterface(Ci.nsIFileURL).file.path;
      const pdfPath=PathUtils.join(PathUtils.parent(scriptPath),"fixtures","paper.pdf");
      const attachment=await Zotero.Attachments.importFromFile({file:pdfPath,parentItemID:paper.id});
      assert(attachment.isPDFAttachment(),"The fixture should import as a PDF attachment");
      const info=await Zotero.NoctuaNotes.paperContext(paper);
      assert(info.title.includes("NOCTUA PROTOTYPE")&&info.authors.includes("Ada Lovelace")&&info.year==="2026","Paper metadata was not collected");
      assert(info.text.includes("Latent world models")&&info.text.includes("48x faster")&&info.text.split("\f").length>=2,"PDF text was not extracted by page: "+JSON.stringify(info.text.slice(0,120)));
      result.passed.push("Paper text and metadata are extracted from the PDF");
      // Chat page, hosted like the side pane does, against a fake CLI that reads the paper files.
      const fake=PathUtils.join(PathUtils.tempDir,"noctua-fake-paper-"+Date.now()+".py");
      await IOUtils.writeUTF8(fake,`#!/usr/bin/python3
import sys,json,os
req=sys.stdin.read()
paper=open("paper.txt").read()
tools=sys.argv[sys.argv.index("--tools")+1]
print(json.dumps({"type":"result","subtype":"success","result":"PAPER-OK tools="+tools+" page2="+str("[Page 2]" in paper)+" claim="+str("48x faster" in paper)+" note="+str(os.path.exists("note.tex")),"session_id":"p1"}))
`);
      await IOUtils.setPermissions(fake,0o755);
      Zotero.Prefs.set("extensions.noctua-notes.agent.claudePath",fake,true);
      const frame=mainWindow.document.createElementNS("http://www.w3.org/1999/xhtml","iframe");
      frame.style.cssText="position:fixed;right:0;top:0;width:420px;height:560px;z-index:99998;border:1px solid #888;background:#fff";
      frame.src="chrome://noctuanotes/content/paper-chat.html";
      mainWindow.document.documentElement.append(frame);
      let chatWin=null;
      for(let n=0;n<200&&!chatWin?.startPaperChat;n++){await new Promise(r=>setTimeout(r,50));chatWin=frame.contentWindow?.wrappedJSObject||frame.contentWindow;}
      assert(chatWin?.startPaperChat,"The paper chat page did not load");
      chatWin.startPaperChat(Zotero.NoctuaNotes.paperHost(attachment,mainWindow));
      const cd=chatWin.document,waitFor=async(test,ms=15000)=>{for(let n=0;n<ms/100&&!test();n++)await new Promise(r=>setTimeout(r,100));return test();};
      assert(!cd.getElementById("chat").hidden&&cd.getElementById("chat-input").placeholder.includes("paper"),"The paper chat should be open and about the paper");
      cd.getElementById("chat-input").value="What is the main claim?";
      cd.getElementById("chat-form").dispatchEvent(new chatWin.Event("submit",{bubbles:true,cancelable:true}));
      assert(await waitFor(()=>cd.getElementById("chat-log").textContent.includes("PAPER-OK")),"No answer from the paper assistant: "+cd.getElementById("chat-log").textContent);
      const answer=cd.getElementById("chat-log").textContent;
      assert(answer.includes("tools=Read,Glob,Grep")&&answer.includes("page2=True")&&answer.includes("claim=True")&&answer.includes("note=False"),"The assistant did not get the paper read-only: "+answer);
      assert(!cd.getElementById("chat-proposal")||cd.getElementById("chat-proposal").hidden,"A paper chat must not offer note edits");
      frame.remove();
      Zotero.Prefs.clear("extensions.noctua-notes.agent.claudePath",true);await IOUtils.remove(fake,{ignoreAbsent:true});
      result.passed.push("The paper assistant reads the PDF text through read-only tools and answers in the side-pane chat page");
      // A note under a paper with a PDF: the note assistant reads the paper too.
      {const noteFake=PathUtils.join(PathUtils.tempDir,"noctua-fake-notepaper-"+Date.now()+".py");
        await IOUtils.writeUTF8(noteFake,`#!/usr/bin/python3
import sys,json,os
req=sys.stdin.read()
paper=open("paper.txt").read() if os.path.exists("paper.txt") else ""
note=open("note.tex").read()
print(json.dumps({"type":"result","subtype":"success","result":"NOTE-PAPER-OK paper="+str("48x faster" in paper)+" note="+str("%%% block" in note)+" prompt="+str("paper.txt: the full text" in req),"session_id":"n1"}))
`);
        await IOUtils.setPermissions(noteFake,0o755);
        Zotero.Prefs.set("extensions.noctua-notes.agent.claudePath",noteFake,true);
        const noteWin=await Zotero.NoctuaNotes.open({create:true,item:paper});
        const nd=noteWin.document,waitNote=async(test,ms=15000)=>{for(let n=0;n<ms/100&&!test();n++)await new Promise(r=>setTimeout(r,100));return test();};
        assert(await waitNote(()=>nd.getElementById("chat-toggle")&&noteWin.NoctuaNotesEditor),"The new note editor did not load");
        if(nd.getElementById("chat").hidden)nd.getElementById("chat-toggle").click();
        assert(await waitNote(()=>nd.getElementById("chat-log").textContent.includes("paper's PDF")),"The note chat should say it can read the paper's PDF: "+nd.getElementById("chat-log").textContent);
        nd.getElementById("chat-input").value="Summarize the paper's claim";
        nd.getElementById("chat-form").dispatchEvent(new noteWin.Event("submit",{bubbles:true,cancelable:true}));
        assert(await waitNote(()=>nd.getElementById("chat-log").textContent.includes("NOTE-PAPER-OK")),"No answer from the note assistant: "+nd.getElementById("chat-log").textContent);
        assert(nd.getElementById("chat-log").textContent.includes("paper=True note=True prompt=True"),"The note assistant did not get the paper text: "+nd.getElementById("chat-log").textContent);
        Zotero.Prefs.clear("extensions.noctua-notes.agent.claudePath",true);await IOUtils.remove(noteFake,{ignoreAbsent:true});
        result.passed.push("A note's assistant reads the paper's PDF as reference alongside the note");}
      // The reading chat belongs to the PDF reader only: the library's item pane does not show it.
      await mainWindow.ZoteroPane_Local.selectItem(paper.id);
      const details=mainWindow.document.querySelector("#zotero-item-pane item-details")||[...mainWindow.document.querySelectorAll("item-details")][0];
      const notesPane=[...details.querySelectorAll("item-pane-custom-section")].find(node=>node.paneID?.includes("noctua-notes"));
      const libraryChat=[...details.querySelectorAll("item-pane-custom-section")].find(node=>node.paneID?.includes("noctua-chat"));
      await new Promise(r=>setTimeout(r,500));
      assert(!libraryChat||libraryChat.hidden,"The Noctua Chat section must not show in the library item pane");
      assert(![...details.sidenav.querySelectorAll(".btn[data-pane]")].some(button=>button.dataset.pane?.includes("noctua-chat")&&!button.hidden&&button.offsetParent),"The library side nav must not offer the chat button");
      assert(!notesPane.querySelector("[data-noctua-tab]"),"The notes section should not carry chat tabs");
      await notesPane.asyncRender();
      for(let n=0;n<100&&!notesPane.querySelector("[data-noctua-create]");n++)await new Promise(r=>setTimeout(r,50));
      assert(notesPane.querySelector("[data-noctua-create]"),"The notes section should still list notes");
      // In the reader it has its own button below Zotero's Notes button, and its own full-pane view.
      {const reader=await Zotero.Reader.open(attachment.id);
        const tabID=reader.tabID;
        let readerDetails=null;
        for(let n=0;n<200&&!readerDetails;n++){await new Promise(r=>setTimeout(r,100));
          readerDetails=[...(mainWindow.ZoteroContextPane?.context?._itemPaneDeck?.children||[])].find(el=>el.tabID===tabID);}
        assert(readerDetails,"The reader's side pane did not appear");
        const sidenav=mainWindow.document.getElementById("zotero-context-pane-sidenav");
        const deck=mainWindow.document.getElementById("zotero-context-pane-deck");
        let wrapper=null;
        for(let n=0;n<100&&!(wrapper&&!wrapper.hidden);n++){await new Promise(r=>setTimeout(r,100));wrapper=sidenav.querySelector(".noctua-chat-wrapper");}
        assert(wrapper&&!wrapper.hidden,"The reader side bar should show the Noctua Chat button");
        const order=[...sidenav.children];
        const notesAt=order.indexOf(sidenav.querySelector('.btn[data-pane="context-notes"]').parentElement),chatAt=order.indexOf(wrapper),locateAt=order.indexOf(sidenav.querySelector('.btn[data-action="locate"]').parentElement);
        assert(notesAt<chatAt&&chatAt<locateAt,"The chat button belongs below Notes and above Locate: "+[notesAt,chatAt,locateAt]);
        assert(order[chatAt-1].classList.contains("divider")&&order[chatAt+1].classList.contains("divider"),"The chat button needs its own divider on both sides");
        assert(![...readerDetails.querySelectorAll("item-pane-custom-section")].some(node=>node.paneID?.includes("noctua-chat")&&!node.hidden),"The item pane must not repeat the chat once it has its own view");
        mainWindow.ZoteroContextPane.collapsed=false;
        wrapper.querySelector(".btn").click();
        const view=mainWindow.document.getElementById("noctua-chat-view");
        assert(deck.selectedPanel===view,"Pressing the button should swap the pane for the chat");
        assert(wrapper.classList.contains("highlight"),"The chat button should look selected");
        let readerFrame=null;
        for(let n=0;n<150&&!readerFrame;n++){await new Promise(r=>setTimeout(r,100));readerFrame=view.querySelector("iframe");}
        assert(readerFrame&&readerFrame.src.endsWith("paper-chat.html"),"The chat view should host the paper assistant");
        let paneChat=null;for(let n=0;n<200&&!paneChat?.document?.getElementById("chat-log");n++){await new Promise(r=>setTimeout(r,50));paneChat=readerFrame.contentWindow?.wrappedJSObject||readerFrame.contentWindow;}
        assert(paneChat?.document?.getElementById("chat-input")?.placeholder.includes("paper")&&paneChat.document.getElementById("chat-log").textContent==="","The reader's chat did not start empty");
        {const phoneBtn=paneChat.document.getElementById("chat-phone"),phonePop=paneChat.document.getElementById("chat-phone-pop");
          assert(phoneBtn&&!phoneBtn.hidden,"The chat should offer the iPhone camera button");
          phoneBtn.click();
          for(let n=0;n<100&&paneChat.document.getElementById("chat-phone-note").textContent==="Starting…";n++)await new Promise(r=>setTimeout(r,50));
          assert(!phonePop.hidden,"The iPhone popover should open");
          assert(phonePop.querySelector("svg")||/Tailscale/.test(phonePop.textContent),"The popover shows a QR code, or explains that Tailscale is missing");
          phoneBtn.click();assert(phonePop.hidden,"Pressing the iPhone button again should close the popover");}
        const frameBox=readerFrame.getBoundingClientRect(),deckBox=deck.getBoundingClientRect();
        result.readerView={frame:[Math.round(frameBox.width),Math.round(frameBox.height)],deck:[Math.round(deckBox.width),Math.round(deckBox.height)]};
        await new Promise(r=>setTimeout(r,500));
        {const canvas=mainWindow.document.createElementNS("http://www.w3.org/1999/xhtml","canvas");canvas.width=mainWindow.innerWidth;canvas.height=mainWindow.innerHeight;
          canvas.getContext("2d").drawWindow(mainWindow,0,0,canvas.width,canvas.height,"white");
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
          await IOUtils.write(PathUtils.join(PathUtils.parent(Zotero.Prefs.get("extensions.noctua-notes.testResult",true)),"readerview.png"),new Uint8Array(await blob.arrayBuffer()));}
        {const other=sidenav.querySelector('.highlight-notes-inactive .btn:not([data-pane="context-notes"])');
          assert(other,"Zotero's own side bar buttons were not found");
          other.click();
          assert(deck.selectedPanel!==view&&!wrapper.classList.contains("highlight"),"Pressing one of Zotero's own buttons should leave the chat");
          wrapper.querySelector(".btn").click();assert(deck.selectedPanel===view,"The chat button should open the chat again");}
        wrapper.querySelector(".btn").click();
        assert(deck.selectedPanel!==view&&!wrapper.classList.contains("highlight"),"Pressing the button again should bring the item pane back");
        mainWindow.Zotero_Tabs.close(tabID);
        for(let n=0;n<50&&sidenav.querySelector(".noctua-chat-wrapper:not([hidden])");n++)await new Promise(r=>setTimeout(r,100));}
      result.passed.push("The reading chat has its own button below Zotero's Notes button and its own full-pane view in the PDF reader");}
    // Photos from an iPhone arrive over a token-protected local server and become chat attachments.
    {const win2=Zotero.getMainWindow();
      const phone=NoctuaNotes.makePhone({address:"127.0.0.1",allowPeer:NoctuaNotes.phoneModule.isLoopback});
      const got=[];let ended=false;
      const session=await phone.start(photo=>got.push(photo),{onEnd:()=>{ended=true;}});
      assert(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/.test(session.url),"Unexpected session address: "+session.url);
      const root=session.url,base=root.slice(0,root.indexOf("/",8));
      const page=await win2.fetch(root);
      assert(page.status===200&&(await page.text()).includes('capture="environment"'),"The camera page was not served");
      assert((await win2.fetch(base+"/wrongtoken/")).status===404,"A wrong token must be refused");
      const jpeg=new Uint8Array([0xff,0xd8,0xff,0xe0,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0,0xff,0xd9]);
      assert((await win2.fetch(root+"up?name=a.jpg",{method:"POST",body:jpeg})).status===200,"A JPEG upload should be accepted");
      assert(got.length===1&&got[0].type==="image/jpeg"&&got[0].data===btoa(String.fromCharCode(...jpeg)),"The photo did not reach the chat");
      {const big=new Uint8Array(1500000);big.set(jpeg);for(let i=jpeg.length;i<big.length;i++)big[i]=(i*31)%251;
        const response=await win2.fetch(root+"up?name=big.jpg",{method:"POST",body:new Blob([big])});
        assert(response.status===200&&got.length===2&&got[1].data.length===Math.ceil(big.length/3)*4,"A large photo did not arrive: "+response.status+" "+got.length);}
      {const {Subprocess}=ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
        const tmp=PathUtils.join(Services.dirsvc.get("TmpD",Ci.nsIFile).path,"noctua-probe.jpg");
        const blob=new Uint8Array(900000);blob.set(jpeg);for(let i=jpeg.length;i<blob.length;i++)blob[i]=(i*17)%253;await IOUtils.write(tmp,blob);
        const codes=[];
        for(let n=0;n<12;n++){const proc=await Subprocess.call({command:"/usr/bin/curl",arguments:["-sS","-o","/dev/null","-w","%{http_code} exit=%{exitcode}","--data-binary","@"+tmp,"-H","Content-Type: image/jpeg",root+"up?name=c"+n+".jpg"],stderr:"stdout"});
          let out="",chunk;while((chunk=await proc.stdout.readString()))out+=chunk;codes.push(out.trim());}
        assert(codes.every(code=>code.startsWith("200")),"Repeated curl uploads should all succeed: "+codes.join(" | "));}
      assert((await win2.fetch(root+"up",{method:"POST",body:new Uint8Array([0x89,0x50,0x4e,0x47,0,0,0,0])})).status===415,"Only JPEG photos are accepted");
      assert((await win2.fetch(base+"/wrongtoken/up",{method:"POST",body:jpeg})).status===404&&got.length===14,"Uploads without the token must be refused");
      session.stop();
      let refused=false;try{await win2.fetch(root);}catch(_){refused=true;}
      assert(refused,"The server should stop listening when the session stops");
      result.passed.push("The iPhone camera server serves a page, enforces the token, accepts only JPEG photos, and stops");}
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
  // The isolated test instance must not linger once its result is written.
  if(Zotero.DataDirectory.dir.includes("noctua-zotero-test-"))setTimeout(()=>Services.startup.quit(Services.startup.eForceQuit),500);
})().catch(error=>Zotero.logError(error));
