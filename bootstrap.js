"use strict";
var NoctuaNotes;
var chromeHandle;

async function startup({id, version, rootURI}) {
  await Zotero.initializationPromise;
  const aom = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  chromeHandle = aom.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "noctuanotes", "content/"]
  ]);
  const scope = {TextEncoder, TextDecoder};
  Services.scriptloader.loadSubScript(rootURI + "lib/model.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "lib/storage.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "lib/references.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "lib/activation.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "lib/pane.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "lib/readerchat.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "lib/splitview.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "lib/settings.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "lib/agent.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "lib/phonecam.js", scope);
  // Editor UI state (assistant width, history, last provider and model, pen…). The chrome:// editor
  // page has no localStorage, so the plugin keeps these values in one small file in the data directory.
  const uiPath = Zotero.DataDirectory?.dir ? PathUtils.join(Zotero.DataDirectory.dir, "noctua-notes-ui.json") : null;
  let uiData = {}, uiTimer = null;
  try { if (!uiPath) throw new Error("no data directory"); const parsed = JSON.parse(await IOUtils.readUTF8(uiPath)); if (parsed && typeof parsed === "object") uiData = parsed; } catch (_) {}
  const uiState = {
    get: key => Object.hasOwn(uiData, key) ? uiData[key] : null,
    set(key, value) {
      if (typeof key !== "string" || key.length > 200 || typeof value !== "string" || value.length > 2000000) return;
      uiData[key] = value;
      clearTimeout(uiTimer);
      uiTimer = setTimeout(() => this.flush(), 400);
    },
    async flush() {
      clearTimeout(uiTimer); uiTimer = null;
      if (!uiPath) return;
      try { await IOUtils.writeUTF8(uiPath, JSON.stringify(uiData), {tmpPath: uiPath + ".tmp"}); } catch (error) { Zotero.logError(error); }
    }
  };
  const settings = await scope.NoctuaNotesSettings.create({Zotero, pluginID:id, rootURI});
  const uuid = () => Services.uuid.generateUUID().toString().slice(1,-1);
  const storage = new scope.NoctuaNotesStorage({Zotero, IOUtils, PathUtils, model:scope.NoctuaNotesModel, uuid});
  NoctuaNotes = {
    id, version, rootURI, storage, model:scope.NoctuaNotesModel, tabs:new Map(), owners:new Set(), localizationWindows:new Set(), activationHooks:new Map(), opening:new Map(),
    settings,
    agent: scope.NoctuaAgent.create({
      Subprocess: ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess,
      IOUtils, PathUtils, Zotero,
      realpath: path => { const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile); file.initWithPath(path); file.normalize(); return file.path; },
      tempBase: Services.dirsvc.get("TmpD", Ci.nsIFile).path,
      home: Services.dirsvc.get("Home", Ci.nsIFile).path,
      env: {PATH: Services.env.get("PATH") || ""},
      makeId: () => "b" + uuid()
    }),
    // Photos from the iPhone arrive over Tailscale and become chat attachments.
    makePhone: extra => scope.NoctuaPhoneCamera.create({
      Cc, Ci, Services, Zotero, IOUtils,
      Subprocess: ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess, ...extra
    }),
    phoneModule: scope.NoctuaPhoneCamera,
    getPhone() { return this.phone ||= this.makePhone({}); },
    appearance: settings.appearance,
    uiState,
    selectedLibraryID(owner) {
      const pane=owner.ZoteroPane_Local || owner.ZoteroPane;
      if(typeof pane.getSelectedLibraryIDs==="function")return pane.getSelectedLibraryIDs()[0] ?? Zotero.Libraries.userLibraryID;
      return pane.getSelectedLibraryID?.() ?? Zotero.Libraries.userLibraryID;
    },
    loadLocalization(window) {
      window.MozXULElement.insertFTLIfNeeded("noctua-notes.ftl");
      this.localizationWindows.add(window);
      this.installTabIcon(window);
      if(!this.activationHooks.has(window)) {
        this.activationHooks.set(window,scope.NoctuaNotesActivation.install({window,Zotero,storage,open:args=>this.open(args)}));
      }
    },
    // Zotero draws tab icons from the tab's item-type name. A distinct name keeps
    // Noctua tabs apart from native note tabs; the rule below supplies its artwork.
    tabIconName: "noctuanote",
    installTabIcon(window) {
      const document=window.document;
      if(document.getElementById("noctua-notes-tab-icon"))return;
      const style=document.createElementNS("http://www.w3.org/1999/xhtml","style");
      style.id="noctua-notes-tab-icon";
      style.textContent=`.icon.icon-item-type[data-item-type="${this.tabIconName}"], .icon-item-type[data-item-type="${this.tabIconName}"]{background:url("chrome://noctuanotes/content/icons/noctua-notes.svg") no-repeat center/contain !important}`;
      document.documentElement.append(style);
    },
    // The text of a paper's PDF with its metadata and the reader's highlights, for the reading assistant.
    async paperContext(item) {
      const attachment = item.isPDFAttachment?.() ? item
        : item.getAttachments().map(id => Zotero.Items.get(id)).find(a => a && !a.deleted && a.isPDFAttachment());
      if (!attachment) throw new Error("This item has no PDF to read.");
      const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : (item.isRegularItem() ? item : null);
      const result = await Zotero.PDFWorker.getFullText(attachment.id, null, true);
      if (!result?.text?.trim()) throw new Error("This PDF has no text layer to read (it may be a scan).");
      const field = name => { try { return parent?.getField(name) || ""; } catch (_) { return ""; } };
      const annotations = [];
      try {
        for (const note of attachment.getAnnotations().slice(0, 300)) {
          annotations.push({page: note.annotationPageLabel || "", type: note.annotationType,
            text: (note.annotationText || "").slice(0, 600), comment: (note.annotationComment || "").slice(0, 600)});
        }
      } catch (_) {}
      return {
        title: field("title") || attachment.getField("title"),
        authors: (parent?.getCreators?.() || []).map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")).filter(Boolean).slice(0, 30),
        year: field("date").match(/\b\d{4}\b/)?.[0] || "", venue: field("publicationTitle") || field("proceedingsTitle"),
        doi: field("DOI"), abstract: field("abstractNote").slice(0, 3000),
        text: result.text, annotations
      };
    },
    // What the paper assistant page needs from the plugin (it is a plain page inside Zotero's side pane).
    paperHost(item, owner) {
      const parent = item.isAttachment() && item.parentID ? Zotero.Items.get(item.parentID) : null;
      const sessionId = "paper-" + item.libraryID + "-" + (parent?.key || item.key);
      return {
        session: {id: sessionId}, appearance: this.appearance, ui: this.uiState,
        agent: {
          providers: () => this.agent.providers(),
          models: provider => this.agent.models(provider),
          skills: provider => this.agent.skills(provider),
          reset: () => this.agent.forget(sessionId),
          phone: {start: (onPhoto, options) => this.getPhone().start(onPhoto, options), stop: () => this.getPhone().stop()},
          run: options => this.agent.run({...options, mode: "paper", sessionKey: sessionId, paper: () => this.paperContext(item), context: {}})
        },
        openURL: url => { if (/^(https?:|mailto:)/i.test(url)) Zotero.launchURL(url); },
        onError: error => Zotero.logError(error)
      };
    },
    async referenceIndex(libraryID) {
      const items = await Zotero.Items.getAll(libraryID, true, false, false);
      return scope.NoctuaNotesReferences.index(items.filter(item=>item.isRegularItem() && !item.deleted).map(item=>({
        key:item.key, title:item.getField("title"), creators:item.getCreators(),
        year:item.getField("date").match(/\b\d{4}\b/)?.[0] || "n.d.", extra:item.getField("extra"),
        citeKeys:[]
      })));
    },
    async importDocument(path, {owner=Zotero.getMainWindow(), item=null}={}) {
      const text=await IOUtils.readUTF8(path);
      const value=JSON.parse(text);
      const media={};
      let mediaBytes=0;
      for (const relative of this.model.mediaPaths(text)) {
        if(value.format===this.model.FORMAT && Object.hasOwn(value.media || {},relative)) continue;
        // mediaPaths permits only Noctua's images/name.ext and media/name.ext.
        // Canonicalize to also reject symlinks escaping the selected folder.
        const folder=Zotero.File.pathToFile(PathUtils.parent(path));folder.normalize();
        const assetFile=Zotero.File.pathToFile(PathUtils.join(folder.path,...relative.split("/")));assetFile.normalize();
        if (!folder.contains(assetFile)) throw new Error("An imported image is outside the note folder: "+relative);
        const asset=assetFile.path;
        const stat=await IOUtils.stat(asset);
        if(stat.size>8*1024*1024) throw new Error("An imported image exceeds 8 MB: "+relative);
        mediaBytes+=Math.ceil(stat.size/3)*4;
        if(mediaBytes>this.model.MAX_BYTES) throw new Error("The imported images exceed the 32 MB source limit. Split the note or use smaller images.");
        const bytes=await IOUtils.read(asset);
        let binary="";
        for(let n=0;n<bytes.length;n+=32768) binary+=String.fromCharCode(...bytes.subarray(n,n+32768));
        const ext=relative.split(".").pop().toLowerCase();
        media[relative]="data:image/"+({jpg:"jpeg",jpeg:"jpeg",png:"png",gif:"gif",webp:"webp",svg:"svg+xml"}[ext])+";base64,"+btoa(binary);
      }
      const imported=this.model.importSource(text,{id:uuid(),media});
      return this.open({create:true,item,owner,imported});
    },
    async importSource({owner=Zotero.getMainWindow(),item=null}={}) {
      try {
        const {FilePicker}=ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
        const picker=new FilePicker();
        picker.init(owner,"Import Noctua note",picker.modeOpen);
        picker.appendFilter("Noctua note JSON","*.json");
        if(await picker.show()!==picker.returnOK) return;
        return await this.importDocument(picker.file,{owner,item});
      } catch(error) {
        Zotero.logError(error);
        Services.prompt.alert(owner,"Import Noctua note",error.message);
      }
    },
    async writeExport(document, owner) {
      const {FilePicker} = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
      const picker = new FilePicker();
      picker.init(owner, "Export Noctua Notes source", picker.modeSave);
      picker.defaultString = Zotero.File.getValidFileName(document.title || "note") + ".noctua.json";
      picker.appendFilter("Noctua Notes source", "*.noctua.json");
      const result = await picker.show();
      if (result === picker.returnOK || result === picker.returnReplace) {
        await IOUtils.writeUTF8(picker.file, JSON.stringify(document, null, 2), {tmpPath:picker.file+".tmp"});
      }
    },
    exportTarget({owner=Zotero.getMainWindow(), item=null}={}) {
      if (item) {
        // Never resolve a regular paper to one of its potentially many sources.
        if (item.deleted || !storage.isSource(item)) return null;
        const entry = [...this.tabs.values()].find(entry =>
          entry.session.item?.key === item.key && entry.session.libraryID === item.libraryID);
        return {entry, item};
      }
      const entry = this.tabs.get(owner.Zotero_Tabs?.selectedID);
      return entry?.owner === owner ? {entry} : null;
    },
    async exportSource({owner=Zotero.getMainWindow(), item=null}={}) {
      const target = this.exportTarget({owner,item});
      if (!target) return;
      if (target.entry) {
        // The editor completes pending handwriting and exports its current doc,
        // including edits that autosave has not persisted yet.
        return target.entry.editorWindow?.NoctuaNotesEditor?.exportSource();
      }
      const {doc} = await storage.load(target.item);
      return this.writeExport(doc, owner);
    },
    flushEntry(entry) {
      if (entry.closingPromise) return entry.closingPromise;
      // Capture synchronously before Zotero removes/nukes the iframe. All
      // asynchronous persistence must then run in the plugin scope, not the
      // destroyed editor's JavaScript realm.
      let snapshot;
      try {snapshot=JSON.parse(JSON.stringify(entry.editorWindow?.NoctuaNotesEditor?.takeCloseSnapshot()));}
      catch(error) {Zotero.logError(error);return Promise.resolve();}
      if (!snapshot || !snapshot.dirty) return Promise.resolve();
      const session=entry.session;
      const doc=scope.NoctuaNotesModel.validate(snapshot.doc);
      const pending=storage.pendingSave(session);
      entry.closingPromise=(async()=>{
        let revision=snapshot.baseRevision;
        if (pending) {
          try {revision=(await pending).doc.revision;}
          catch(_) {
            // The failed first save may remove its newly created attachment.
            // Preserve the latest close snapshot after that save has settled.
            await storage.writeDraft(session.id,doc,revision);
            return;
          }
        }
        // An older save must finish its draft cleanup before this newer draft
        // is written. Otherwise it can delete the close snapshot underneath us.
        await storage.writeDraft(session.id,doc,revision);
        if (snapshot.conflict) return;
        await storage.save(session,doc,revision);
      })();
      return entry.closingPromise;
    },
    async open({create=false, standalone=false, item=null, owner=Zotero.getMainWindow(), imported=null} = {}) {
      let pendingKey, pending;
      try {
        const activeTab = owner.Zotero_Tabs._getTab(owner.Zotero_Tabs.selectedID).tab;
        if (!item && activeTab?.data?.sourceKey) {
          item = Zotero.Items.getByLibraryAndKey(activeTab.data.libraryID, activeTab.data.sourceKey);
        }
        if (!item && activeTab?.type?.startsWith("reader") && activeTab.data.itemID) {
          item = Zotero.Items.get(activeTab.data.itemID);
        }
        item ||= owner.ZoteroPane.getSelectedItems()[0];
        let source = !create ? await storage.findSource(item) : null;
        if (source) {
          const key=source.libraryID+"/"+source.key;
          if(this.opening.has(key))return await this.opening.get(key).promise;
          for (const entry of this.tabs.values()) {
            if (entry.session.item?.key === source.key) {
              entry.owner.Zotero_Tabs.select(entry.id);
              return entry.editorWindow;
            }
          }
          pendingKey=key;pending=Zotero.Promise.defer();
          pending.promise.catch(()=>{});
          this.opening.set(key,pending);
        }
        const libraryID = item?.libraryID || this.selectedLibraryID(owner);
        storage.assertLibrary(libraryID);
        let parent = item;
        if (parent && !parent.isRegularItem()) parent = parent.parentID ? Zotero.Items.get(parent.parentID) : null;
        // Standalone notes never attach to the selected paper, only to the collection.
        if (standalone && !source) parent = null;
        const session = {id:source?.key || uuid(), item:source, libraryID,
          parentID:source?.parentID || parent?.id || null,
          collectionID:owner.ZoteroPane.getSelectedCollections?.()[0]?.id || null};
        let doc = imported?.doc || (source ? (await storage.load(source)).doc : scope.NoctuaNotesModel.blank(session.id));
        session.id = doc.id;
        const draft = await storage.getDraft(session.id);
        this.owners.add(owner);
        const tab = owner.Zotero_Tabs.add({type:"noctuanotes", title:"Noctua Notes — "+doc.title,
          data:{icon:this.tabIconName, sourceKey:source?.key, libraryID}, select:true,
          onClose:() => {
            const entry=this.tabs.get(tab.id);
            if (!entry) return;
            this.flushEntry(entry).catch(error=>Zotero.logError(error));
            try { splitView?.destroy(); } catch (error) { Zotero.logError(error); }
            this.agent.cleanup(session.id).catch(error=>Zotero.logError(error));
            this.tabs.delete(tab.id);
          }});
        const frame = owner.document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
        frame.setAttribute("title", "Noctua Notes editor");
        frame.style.cssText="flex:1;width:100%;height:100%;min-height:0;border:0;";
        tab.container.style.cssText="display:flex;min-height:0;";
        const entry={id:tab.id, owner, frame, session, title:"Noctua Notes — "+doc.title};
        this.tabs.set(tab.id,entry);
        owner.Zotero_Tabs.tabHooks.getTitle.noctuanotes = async current => this.tabs.get(current.id)?.title || "Noctua Notes";
        owner.Zotero_Tabs.tabHooks.refocus.noctuanotes = current => this.tabs.get(current.id)?.editorWindow?.focus();
        const references=await this.referenceIndex(libraryID);
        // The note assistant may read the paper's PDF too (a setting; off keeps the text on this computer).
        const readsPaper = !!parent?.isRegularItem?.() && Zotero.Prefs.get("extensions.noctua-notes.agent.notePaper", true) !== false
          && parent.getAttachments().some(id => { const a = Zotero.Items.get(id); return a && !a.deleted && a.isPDFAttachment(); });
        // Split view: the paper's PDF (or any library PDF) beside the note. Built on first use.
        let splitView = null;
        const ensureSplit = () => splitView ||= scope.NoctuaSplitView.create({Zotero, owner, tabID:tab.id, container:tab.container, frame, parent,
          libraryID, store:this.uiState, noteID:session.id, onChange:open => { try { split.onChange?.(open); } catch (error) { Zotero.logError(error); } }});
        const split = {
          onChange: null,
          toggle: () => ensureSplit().toggle(),
          // Show a cited paper's PDF beside the note. False when it has none (the editor then points at the reference list).
          showItem: async item => {
            const pdf = scope.NoctuaSplitView.pdfsOf(Zotero, item)[0];
            if (!pdf) return false;
            await ensureSplit().showItem(pdf);
            return true;
          },
          // The paper the note belongs to: its PDF in the split view, or the item in the library without one.
          openParent: async () => {
            if (!parent || await ensureSplit().showPaper()) return;
            await owner.ZoteroPane.selectItem(parent.id);
          },
          isOpen: () => !!splitView?.isOpen
        };
        entry.split = split;
        const args = {session, doc, draft, split, storage, model:scope.NoctuaNotesModel, references, imported:!!imported, hasPaper:readsPaper,
          appearance:this.appearance, ui:this.uiState,
          agent:{
            providers:() => this.agent.providers(),
            models:provider => this.agent.models(provider),
            skills:provider => this.agent.skills(provider),
            reset:() => this.agent.forget(session.id),
            phone:{start:(onPhoto, options) => this.getPhone().start(onPhoto, options), stop:() => this.getPhone().stop()},
            run:options => this.agent.run({...options, sessionKey:session.id,
              paper: readsPaper ? () => this.paperContext(parent) : null, context:{
              paperTitle:parent?.getField("title") || "",
              authors:(parent?.getCreators?.() || []).map(creator => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" ")).filter(Boolean).slice(0, 12)
            }})
          },
          importSource:()=>this.importSource({owner,item:parent}),
          async openCitation(key) {
            const cited=Zotero.Items.getByLibraryAndKey(libraryID,key);
            return !!cited && !cited.deleted && await split.showItem(cited);
          },
          parentTitle:parent?.getField("title") || "My Library",
          exportSource:(document, editorWindow) => this.writeExport(document, editorWindow),
          // Remote pages must live in an unprivileged content <browser>; a plain <iframe> inside
          // this chrome:// page stays blank. Only validated YouTube URLs are ever loaded.
          loadRemote:(player,url) => {
            if(!/^https:\/\/www\.youtube\.com\/watch\?app=desktop&v=[\w-]{11}(&t=\d+s)?$/.test(url))throw new Error("Refusing to load an unexpected player URL");
            player.fixupAndLoadURIString(url,{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});
          },
          openURL:url => { if (/^(https?:|mailto:)/i.test(url)) Zotero.launchURL(url); },
          onTitle:title => {
            entry.title="Noctua Notes — "+title;
            owner.Zotero_Tabs.rename(tab.id,entry.title);
          },
          onSaved:result => {
            const current=owner.Zotero_Tabs._getTab(tab.id)?.tab;
            if (current) {current.data.sourceKey=result.sourceKey; current.data.itemID=result.sourceID;}
            this.unregisterPane?.refresh?.();
          },
          onError:error => Zotero.logError(error)};
        frame.src="chrome://noctuanotes/content/editor.html?tab="+encodeURIComponent(tab.id);
        tab.container.append(frame);
        // Gecko Xray wrappers hide JS expandos on subframe windows. Initialize
        // the local editor explicitly through its unwrapped window after load.
        for (let attempt=0; attempt<200; attempt++) {
          const win=frame.contentWindow?.wrappedJSObject || frame.contentWindow;
          if (win?.startNoctuaNotes) {
            entry.editorWindow=win;
            win.startNoctuaNotes(args);
            // Keyboard shortcuts (⌘E, ⌘S, ⇧⌘K…) only reach the editor once it has focus; a new tab leaves it on the tab strip.
            try { win.focus(); } catch (_) {}
            if(imported) {
              await win.NoctuaNotesEditor.save();
              if(imported.warnings.length) win.document.getElementById("message").textContent=imported.warnings.join("\n");
              if(imported.warnings.length) win.document.getElementById("message").hidden=false;
            }
            pending?.resolve(win);
            return win;
          }
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        owner.Zotero_Tabs.close(tab.id);
        throw new Error("The Noctua Notes tab could not initialize. Reload the plugin and retry.");
      } catch (error) {
        pending?.reject(error);
        Zotero.logError(error);
        Services.prompt.alert(owner, "Noctua Notes", error.message);
        throw error;
      } finally {
        if(pendingKey)this.opening.delete(pendingKey);
      }
    }
  };
  // Run migration outside startup's awaited path so editors remain available.
  NoctuaNotes.previewCleanup = Promise.resolve().then(() => storage.cleanupLegacyPreviews()).then(summary => {
    for (const error of summary.errors || []) Zotero.logError(error);
    return summary;
  }).catch(error => {
    Zotero.logError(error);
    return {trashed:0,detached:0,skipped:0,errors:[error]};
  });
  NoctuaNotes.uninstallNativeNotes=scope.NoctuaNotesActivation.installNotes({Zotero,storage,open:args=>NoctuaNotes.open(args)});
  NoctuaNotes.unregisterPane=scope.NoctuaNotesPane.register({Zotero,pluginID:id,storage,
    open:args=>NoctuaNotes.open(args),create:args=>NoctuaNotes.open({...args,create:true}),
    chat:{
      host:(item,owner)=>NoctuaNotes.paperHost(item,owner),
      // When the reader side bar has its own Noctua Chat view, the item-pane section stays out of the way.
      separate:()=>NoctuaNotes.readerChats.size>0
    }});
  NoctuaNotes.readerChats = new Map();
  NoctuaNotes.installReaderChat = window => {
    if (NoctuaNotes.readerChats.has(window) || window.closed) return;
    try {
      const handle = scope.NoctuaReaderChat.install({window, Zotero, host:(item, owner) => NoctuaNotes.paperHost(item, owner),
        icon:"chrome://noctuanotes/content/icons/noctua-chat.svg", darkIcon:"chrome://noctuanotes/content/icons/noctua-chat-dark.svg", title:"Noctua Chat"});
      if (handle) NoctuaNotes.readerChats.set(window, handle);
    } catch (error) { Zotero.logError(error); }
  };
  Zotero.uiReadyPromise?.then(() => { for (const window of Zotero.getMainWindows()) NoctuaNotes?.installReaderChat(window); });
  Zotero.NoctuaNotes = NoctuaNotes;
  // Zotero picks an item-tree icon from getItemTypeIconName(); give Noctua sources their own.
  const itemProto = Zotero.Item?.prototype;
  if (itemProto) {
    const original = itemProto.getItemTypeIconName;
    const patched = function(...args) {
      try {if (storage.isSource(this)) return NoctuaNotes.tabIconName;} catch (_) {}
      return original.apply(this, args);
    };
    // Rows already drawn keep their old icon until the tree repaints.
    const repaint = () => {for (const window of Zotero.getMainWindows()) try {window.ZoteroPane?.itemsView?.tree?.invalidate();} catch (_) {}};
    itemProto.getItemTypeIconName = patched;
    repaint();
    NoctuaNotes.restoreItemIcon = () => {
      if (itemProto.getItemTypeIconName === patched) itemProto.getItemTypeIconName = original;
      repaint();
    };
  }
  Promise.resolve().then(() => storage.stripTitlePrefix?.()).then(() => storage.tagExisting?.()).catch(error => Zotero.logError(error));
  for (const window of Zotero.getMainWindows()) NoctuaNotes.loadLocalization(window);
  for (const [target, menuID, l10nID, create, standalone] of [
    ["main/library/item", "noctua-notes-item", "noctua-notes-open", false, false],
    ["main/library/addNote", "noctua-notes-new", "noctua-notes-new-item", true, false],
    ["main/library/addNote", "noctua-notes-new-standalone", "noctua-notes-new-standalone", true, true]
  ]) {
    Zotero.MenuManager.registerMenu({menuID, pluginID:id, target, menus:[{
      menuType:"menuitem", l10nID,
      onShowing:create && !standalone ? (event, context) => {
        const owner = context.menuElem?.ownerGlobal || event?.target?.ownerGlobal || Zotero.getMainWindow();
        // An item note needs a selected paper (or one of its attachments).
        context.setEnabled(owner.ZoteroPane.getSelectedItems().some(item => !item.isNote()));
      } : undefined,
      onCommand:(_event, context) => NoctuaNotes.open({create, standalone, item:context.items?.[0]}).catch(Zotero.logError)
    }]});
  }
  for (const [target, suffix] of [["main/menubar/tools", ""], ["main/library/item", "-item"]]) {
    const isContext = target === "main/library/item";
    const menuOwner = (event, context) => context.menuElem?.ownerGlobal || event?.target?.ownerGlobal || Zotero.getMainWindow();
    const exportArgs = (event, context) => {
      const owner = menuOwner(event,context);
      // Tools uses the active editor first; context menus always use exactly
      // their selected item and never fall back to a different active editor.
      if (!isContext && NoctuaNotes.exportTarget({owner})) return {owner};
      return context.items?.length === 1 ? {owner,item:context.items[0]} : null;
    };
    Zotero.MenuManager.registerMenu({menuID:"noctua-notes-import"+suffix,pluginID:id,target,menus:[{
      menuType:"menuitem",l10nID:"noctua-notes-import",
      onShowing:(event,context) => {
        const owner = menuOwner(event,context);
        const libraryID = context.items?.[0]?.libraryID || NoctuaNotes.selectedLibraryID(owner);
        const allowed = libraryID === Zotero.Libraries.userLibraryID;
        context.setEnabled(allowed);
        context.setVisible(allowed);
      },
      onCommand:(event,context)=>NoctuaNotes.importSource({owner:menuOwner(event,context),item:context.items?.[0]})
    }]});
    Zotero.MenuManager.registerMenu({menuID:"noctua-notes-export"+suffix,pluginID:id,target,menus:[{
      menuType:"menuitem",l10nID:"noctua-notes-export",
      onShowing:(event,context) => {
        const args = exportArgs(event,context);
        const allowed = !!(args && NoctuaNotes.exportTarget(args));
        context.setEnabled(allowed);
        context.setVisible(allowed);
      },
      onCommand:(event,context) => {
        const args = exportArgs(event,context);
        if (args) NoctuaNotes.exportSource(args).catch(error=>Zotero.logError(error));
      }
    }]});
  }
  if (Zotero.Prefs.get("extensions.noctua-notes.testScript", true)) {
    const testScope = {Zotero, NoctuaNotes, Services, IOUtils, PathUtils, TextEncoder, TextDecoder, setTimeout, ChromeUtils, Ci};
    Services.scriptloader.loadSubScript(Zotero.Prefs.get("extensions.noctua-notes.testScript", true), testScope);
  }
}
function install() {}
function uninstall() {}
function onMainWindowLoad({window}) {
  NoctuaNotes?.loadLocalization(window);
  Zotero.uiReadyPromise?.then(() => NoctuaNotes?.installReaderChat(window));
}
async function shutdown() {
  if (NoctuaNotes) {
    NoctuaNotes.settings?.destroy();
    NoctuaNotes.unregisterPane?.();
    for (const handle of NoctuaNotes.readerChats?.values() || []) { try { handle.destroy(); } catch (error) { Zotero.logError(error); } }
    NoctuaNotes.readerChats?.clear();
    NoctuaNotes.uninstallNativeNotes?.();
    try {NoctuaNotes.phone?.stop();} catch(error) {Zotero.logError(error);}
    try {await NoctuaNotes.agent?.cleanup();} catch(error) {Zotero.logError(error);}
    for(const uninstall of NoctuaNotes.activationHooks.values())uninstall();
    NoctuaNotes.activationHooks.clear();
    for (const entry of [...NoctuaNotes.tabs.values()]) {
      try {await NoctuaNotes.flushEntry(entry);} catch(error) {Zotero.logError(error);}
      entry.owner.Zotero_Tabs.close(entry.id);
    }
    for (const owner of NoctuaNotes.owners) {
      delete owner.Zotero_Tabs.tabHooks.getTitle.noctuanotes;
      delete owner.Zotero_Tabs.tabHooks.refocus.noctuanotes;
    }
    for (const window of NoctuaNotes.localizationWindows) {
      if (!window.closed) {
        window.document.querySelector('link[rel="localization"][href="noctua-notes.ftl"]')?.remove();
        window.document.getElementById("noctua-notes-tab-icon")?.remove();
      }
    }
    NoctuaNotes.restoreItemIcon?.();
    NoctuaNotes.uiState?.flush();
    delete Zotero.NoctuaNotes;
    NoctuaNotes = undefined;
  }
  chromeHandle?.destruct();
  chromeHandle = null;
}
function onMainWindowUnload({window}) {
  if (!NoctuaNotes) return;
  for (const entry of [...NoctuaNotes.tabs.values()]) {
    if (entry.owner === window) {
      NoctuaNotes.flushEntry(entry).catch(error=>Zotero.logError(error));
      NoctuaNotes.tabs.delete(entry.id);
    }
  }
  NoctuaNotes.owners.delete(window);
  NoctuaNotes.localizationWindows.delete(window);
  try { NoctuaNotes.readerChats?.get(window)?.destroy(); } catch (_) {}
  NoctuaNotes.readerChats?.delete(window);
  NoctuaNotes.activationHooks.get(window)?.();
  NoctuaNotes.activationHooks.delete(window);
}
