"use strict";

// Intercept only the source attachment or its reciprocally related preview.
// In particular, activating a paper/PDF must retain Zotero's native behavior.
var NoctuaNotesActivation = {
  async resolve({item,Zotero,storage}) {
    if(!item || item.deleted)return null;
    if(storage.isSource(item))return item;
    if(!item.isNote())return null;
    for(const key of item.relatedItems || []) {
      const source=Zotero.Items.getByLibraryAndKey(item.libraryID,key);
      if(storage.isSource(source) && !source.deleted && (source.relatedItems || []).includes(item.key)) {
        const {doc}=await storage.load(source);
        if(doc.previewNoteKey===item.key)return source;
      }
    }
    return null;
  },
  installNotes({Zotero,storage,open}) {
    // Notes-pane cards, links, and restored native tabs can call Notes.open
    // directly, bypassing every ZoteroPane activation method.
    const original=Zotero.Notes.open;
    let active=true;
    const wrapped=async function(itemID,...args) {
      if(active) {
        const item=await Zotero.Items.getAsync(itemID);
        const source=await NoctuaNotesActivation.resolve({item,Zotero,storage});
        if(source)return open({item:source,owner:Zotero.getMainWindow()});
      }
      return original.call(this,itemID,...args);
    };
    Zotero.Notes.open=wrapped;
    return () => {
      active=false;
      if(Zotero.Notes.open===wrapped)Zotero.Notes.open=original;
    };
  },
  install({window, Zotero, storage, open}) {
    // ZoteroPane can point at a reader's pane while the library tree retains
    // the stable ZoteroPane_Local instance.
    const pane=window.ZoteroPane_Local || window.ZoteroPane;
    const originals={viewItems:pane.viewItems,viewAttachment:pane.viewAttachment};
    let active=true;
    async function instance(item) {
      return NoctuaNotesActivation.resolve({item,Zotero,storage});
    }
    const wrappers={
      async viewItems(items,...args) {
        if(!active)return originals.viewItems.call(this,items,...args);
        // Preserve selection order and the original arguments for ordinary items.
        for(const item of items) {
          const source=await instance(item);
          if(source) await open({item:source,owner:window});
          else await originals.viewItems.call(this,[item],...args);
        }
      },
      async viewAttachment(ids,...args) {
        if(!active)return originals.viewAttachment.call(this,ids,...args);
        const input=Array.isArray(ids)?ids:[ids];
        for(const id of input) {
          const item=await Zotero.Items.getAsync(id);
          const source=await instance(item);
          if(source)await open({item:source,owner:window});
          else await originals.viewAttachment.call(this,id,...args);
        }
      }
    };
    Object.assign(pane,wrappers);
    return () => {
      active=false;
      for(const name of Object.keys(originals)) {
        // Leave later plugin wrappers intact; retained references become pass-through.
        if(pane[name]===wrappers[name])pane[name]=originals[name];
      }
    };
  }
};
if(typeof module!=="undefined")module.exports=NoctuaNotesActivation;
