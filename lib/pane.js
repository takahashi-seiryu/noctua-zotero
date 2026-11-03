"use strict";

// A separate item-pane section keeps Noctua sources distinct from native notes.
// Zotero supplies the reader's paper/attachment through the same item hooks.
var NoctuaNotesPane = {
  displayTitle(title) {
    return String(title || "").replace(/^Noctua Note(?:\s*[\u2014-]\s*|$)/i,"").trim() || "Untitled";
  },
  // Zotero stores dateModified as UTC "YYYY-MM-DD HH:MM:SS".
  relativeTime(sql, now=Date.now()) {
    if(!sql)return "";
    const time=Date.parse(String(sql).replace(" ","T")+"Z");
    if(Number.isNaN(time))return "";
    const minutes=Math.floor((now-time)/60000);
    if(minutes<1)return "Just now";
    if(minutes<60)return minutes+" min ago";
    if(minutes<1440)return Math.floor(minutes/60)+" h ago";
    if(minutes<2880)return "Yesterday";
    if(minutes<10080)return Math.floor(minutes/1440)+" days ago";
    return new Date(time).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});
  },
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
          const status=make("p","");status.setAttribute("role","status");status.hidden=true;
          const owner=doc.defaultView?.ZoteroPane ? doc.defaultView : Zotero.getMainWindow();
          const run=async(node,task)=>{
            if(!active||node.busy)return;
            node.busy=true;status.hidden=true;
            try {await task();}
            catch(error) {status.textContent=error.message || String(error);status.hidden=false;Zotero.logError(error);}
            finally {node.busy=false;}
          };
          if(!value.sources.length) {
            const empty=make("p","No notes yet");
            empty.style.cssText="margin:4px 0 8px;color:var(--fill-secondary,#777)";
          }
          const list=make("div","");list.setAttribute("role","list");list.style.cssText="margin:0 -4px";
          for(const note of value.sources) {
            const label=NoctuaNotesPane.displayTitle(note.getField("title"));
            const row=make("div","",list);
            row.setAttribute("role","listitem");row.setAttribute("tabindex","0");
            row.setAttribute("data-source-key",note.key);row.setAttribute("data-noctua-open",note.key);
            row.setAttribute("aria-label",label+". Double-click or press Enter to open in a new tab.");
            row.title="Double-click to open in a new tab";
            row.style.cssText="padding:5px 6px;border-radius:5px;cursor:default;user-select:none";
            const rest=()=>{row.style.background="";row.style.outline="";};
            row.addEventListener("mouseenter",()=>{row.style.background="var(--fill-quinary,#0000000d)";});
            row.addEventListener("mouseleave",rest);
            row.addEventListener("focus",()=>{row.style.background="var(--fill-quinary,#0000000d)";row.style.outline="2px solid var(--accent-blue,#4072e5)";});
            row.addEventListener("blur",rest);
            const open_=()=>run(row,()=>open({item:note,owner}));
            row.addEventListener("dblclick",open_);
            row.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();open_();}});
            const title=make("div",label,row);
            title.style.cssText="overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere;line-height:1.35";
            const when=NoctuaNotesPane.relativeTime(note.dateModified);
            if(when) {
              const meta=make("div",when,row);
              meta.style.cssText="margin-top:1px;font-size:.85em;color:var(--fill-secondary,#777)";
            }
          }
          const add=make("button","+ New note");add.type="button";add.setAttribute("data-noctua-create","true");
          add.style.cssText=value.sources.length
            ? "margin:2px 0 0 -2px;padding:3px 6px;background:none;border:0;color:var(--fill-secondary,#777);cursor:pointer;border-radius:5px"
            : "margin:0";
          add.disabled=editable===false;
          if(editable!==false)add.addEventListener("click",()=>run(add,()=>create({item:value.target,owner})));
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
