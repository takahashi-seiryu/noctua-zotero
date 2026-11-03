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
  Services.scriptloader.loadSubScript(rootURI + "lib/settings.js", scope);
  const settings = await scope.NoctuaNotesSettings.create({Zotero, pluginID:id, rootURI});
  const uuid = () => Services.uuid.generateUUID().toString().slice(1,-1);
  const storage = new scope.NoctuaNotesStorage({Zotero, IOUtils, PathUtils, model:scope.NoctuaNotesModel, uuid});
  NoctuaNotes = {
    id, version, rootURI, storage, model:scope.NoctuaNotesModel, tabs:new Map(), owners:new Set(), localizationWindows:new Set(), activationHooks:new Map(), opening:new Map(),
    settings,
    appearance: settings.appearance,
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
      style.textContent=`.icon-item-type[data-item-type="${this.tabIconName}"]{background:url("chrome://noctuanotes/content/icons/noctua-notes.svg") no-repeat center/contain}`;
      document.documentElement.append(style);
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
        media[relative]="data:image/"+({jpg:"jpeg",jpeg:"jpeg",png:"png",gif:"gif",webp:"webp"}[ext])+";base64,"+btoa(binary);
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
    async open({create=false, item=null, owner=Zotero.getMainWindow(), imported=null} = {}) {
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
        const args = {session, doc, draft, storage, model:scope.NoctuaNotesModel, references, imported:!!imported,
          appearance:this.appearance,
          importSource:()=>this.importSource({owner,item:parent}),
          async pickCitation() {
            const io={singleSelection:true, onlyRegularItems:true,filterLibraryIDs:[libraryID],
              deferred:Zotero.Promise.defer(), itemTreeID:"noctua-notes-citation-picker"};
            owner.openDialog("chrome://zotero/content/selectItemsDialog.xhtml","",
              "chrome,dialog=no,centerscreen,resizable=yes",io);
            await io.deferred.promise;
            const selected=io.dataOut?.length ? await Zotero.Items.getAsync(io.dataOut[0]) : null;
            if(!selected) return null;
            if(selected.libraryID!==libraryID || !selected.isRegularItem()) throw new Error("Choose a paper in this note's library.");
            // Refresh after a picker: papers may have been added since opening.
            Object.assign(references,await NoctuaNotes.referenceIndex(libraryID));
            return selected.key;
          },
          async openCitation(key) {
            const cited=Zotero.Items.getByLibraryAndKey(libraryID,key);
            if(cited && !cited.deleted) await owner.ZoteroPane.selectItem(cited.id);
          },
          parentTitle:parent?.getField("title") || "My Library",
          exportSource:(document, editorWindow) => this.writeExport(document, editorWindow),
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
    open:args=>NoctuaNotes.open(args),create:args=>NoctuaNotes.open({...args,create:true})});
  Zotero.NoctuaNotes = NoctuaNotes;
  for (const window of Zotero.getMainWindows()) NoctuaNotes.loadLocalization(window);
  for (const [target, menuID, create] of [
    ["main/menubar/tools", "noctua-notes-tools", false],
    ["main/library/item", "noctua-notes-item", false],
    ["main/library/addNote", "noctua-notes-new", true]
  ]) {
    Zotero.MenuManager.registerMenu({menuID, pluginID:id, target, menus:[{
      menuType:"menuitem", l10nID:create ? "noctua-notes-new" : "noctua-notes-open",
      onCommand:(_event, context) => NoctuaNotes.open({create, item:context.items?.[0]}).catch(Zotero.logError)
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
    const testScope = {Zotero, NoctuaNotes, Services, IOUtils, PathUtils, TextEncoder, TextDecoder, setTimeout};
    Services.scriptloader.loadSubScript(Zotero.Prefs.get("extensions.noctua-notes.testScript", true), testScope);
  }
}
function install() {}
function uninstall() {}
function onMainWindowLoad({window}) {
  NoctuaNotes?.loadLocalization(window);
}
async function shutdown() {
  if (NoctuaNotes) {
    NoctuaNotes.settings?.destroy();
    NoctuaNotes.unregisterPane?.();
    NoctuaNotes.uninstallNativeNotes?.();
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
  NoctuaNotes.activationHooks.get(window)?.();
  NoctuaNotes.activationHooks.delete(window);
}
