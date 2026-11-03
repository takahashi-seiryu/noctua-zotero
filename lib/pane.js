"use strict";

// A separate item-pane section keeps Noctua sources distinct from native notes.
// Zotero supplies the reader's paper/attachment through the same item hooks.
var NoctuaNotesPane = {
  register({Zotero, pluginID, storage, open, create}) {
    const refreshers=new Map(), generations=new WeakMap();
    let active=true;
    const source=item=>!!item && !item.deleted && storage.isSource(item);
    function relatedSources(item) {
      if(!item?.isNote())return [];
      return (item.relatedItems || []).map(key=>Zotero.Items.getByLibraryAndKey(item.libraryID,key))
        .filter(candidate=>source(candidate) && (candidate.relatedItems || []).includes(item.key));
    }
    function eligible(item) {
      if(!item || item.deleted || item.libraryID!==Zotero.Libraries.userLibraryID)return false;
      return item.isRegularItem() || source(item)
        || (item.isAttachment() && !!item.parentID)
        || relatedSources(item).length>0;
    }
    async function context(item) {
      if(!eligible(item))return null;
      if(item.isNote()) {
        // Ordinary notes retain their native behavior, even if manually related
        // to a source. Only the source's own generated preview is recognized.
        for(const candidate of relatedSources(item)) {
          const {doc}=await storage.load(candidate);
          if(doc.previewNoteKey===item.key) {
            const parent=candidate.parentID ? Zotero.Items.get(candidate.parentID) : null;
            return {parent,sources:parent ? paperSources(parent) : [candidate],target:parent || candidate};
          }
        }
        return null;
      }
      if(source(item) && !item.parentID)return {parent:null,sources:[item],target:item};
      const parent=item.isRegularItem() ? item : Zotero.Items.get(item.parentID);
      if(!parent || parent.deleted || !parent.isRegularItem())return null;
      return {parent,sources:paperSources(parent),target:parent};
    }
    function paperSources(item) {
      return item.getAttachments().map(id=>Zotero.Items.get(id)).filter(source);
    }
    const icon="chrome://noctuanotes/content/icons/noctua-notes.svg";
    const registered=Zotero.ItemPaneManager.registerSection({
      paneID:"noctua-notes",pluginID,
      header:{l10nID:"noctua-notes-pane-header",icon},
      sidenav:{l10nID:"noctua-notes-pane-sidenav",icon},
      onInit({body,refresh}) { if(refresh)refreshers.set(body,refresh); },
      onDestroy({body}) {refreshers.delete(body);generations.delete(body);},
      onItemChange({item,setEnabled}) {setEnabled(eligible(item));},
      onRender({doc,body}) {
        generations.set(body,{});
        body.replaceChildren();
        body.setAttribute("data-noctua-pane","true");
        const loading=doc.createElementNS("http://www.w3.org/1999/xhtml","p");
        loading.textContent="Loading Noctua notes…";body.append(loading);
      },
      async onAsyncRender({doc,body,item,editable,setEnabled,setSectionSummary}) {
        const token=generations.get(body);
        const current=()=>active && generations.get(body)===token;
        try {
          const value=await context(item);
          if(!current())return;
          if(!value) {body.replaceChildren();setEnabled(false);return;}
          body.replaceChildren();
          setSectionSummary?.(String(value.sources.length));
          const make=(tag,text,parent=body)=>{
            const node=doc.createElementNS("http://www.w3.org/1999/xhtml",tag);
            if(text)node.textContent=text;parent.append(node);return node;
          };
          const intro=make("p",value.parent ? "Noctua notes for this paper" : "Standalone Noctua note");
          intro.style.margin="0 0 8px";
          const status=make("p","");status.setAttribute("role","status");status.hidden=true;
          const owner=doc.defaultView?.ZoteroPane ? doc.defaultView : Zotero.getMainWindow();
          const action=(button,run)=>button.addEventListener("click",async()=>{
            if(!active)return;
            button.disabled=true;status.hidden=true;
            try {await run();}
            catch(error) {status.textContent=error.message || String(error);status.hidden=false;Zotero.logError(error);}
            finally {button.disabled=false;}
          });
          if(!value.sources.length)make("p","No Noctua notes yet. Native Zotero notes are listed in Notes.");
          for(const note of value.sources) {
            const row=make("div","");row.setAttribute("data-source-key",note.key);row.style.cssText="display:flex;align-items:center;gap:8px;margin:8px 0";
            const title=make("span",note.getField("title") || "Noctua Note",row);
            title.style.cssText="flex:1;min-width:0;overflow-wrap:anywhere";
            const button=make("button","Open",row);button.type="button";button.setAttribute("data-noctua-open",note.key);
            button.setAttribute("aria-label","Open "+title.textContent);
            action(button,()=>open({item:note,owner}));
          }
          const button=make("button","New Noctua Note");button.type="button";button.setAttribute("data-noctua-create","true");
          button.disabled=editable===false;
          if(editable!==false)action(button,()=>create({item:value.target,owner}));
        } catch(error) {
          if(!current())return;
          body.replaceChildren();
          const message=doc.createElementNS("http://www.w3.org/1999/xhtml","p");
          message.textContent="Unable to load Noctua notes: "+(error.message || error);
          message.setAttribute("role","status");body.append(message);Zotero.logError(error);
        }
      }
    });
    if(!registered)throw new Error("Could not register the Noctua Notes item pane");
    const refreshAll=() => {
      if(!active)return;
      const pending=[];
      for(const refresh of refreshers.values()) {
        try {pending.push(Promise.resolve(refresh()).catch(error=>Zotero.logError(error)));}
        catch(error) {Zotero.logError(error);}
      }
      return Promise.all(pending);
    };
    const observer={notify(event,type) {
      // Saving happens in the editor tab while the library's pane skips
      // rendering. Refresh again after tab selection updates pane visibility.
      if(type==="tab"&&event==="select")return Zotero.Promise.delay(0).then(refreshAll);
      return refreshAll();
    }};
    const observerID=Zotero.Notifier.registerObserver(observer,["item","tab"],"noctua-notes-pane");
    const cleanup=() => {
      if(!active)return;
      active=false;refreshers.clear();
      Zotero.Notifier.unregisterObserver(observerID);
      Zotero.ItemPaneManager.unregisterSection(registered);
    };
    // Item notifications can fire while a save is still committing children.
    // The host can request one definitive refresh after a source save finishes.
    cleanup.refresh=refreshAll;
    return cleanup;
  }
};
if(typeof module!=="undefined")module.exports=NoctuaNotesPane;
