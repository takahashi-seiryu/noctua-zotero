"use strict";

var NoctuaNotesStorage = class {
  constructor({Zotero, IOUtils, PathUtils, model, uuid}) {
    Object.assign(this, {Z:Zotero, io:IOUtils, paths:PathUtils, model, uuid});
    this.saves = new Map();
  }
  assertLibrary(libraryID) {
    if (libraryID !== this.Z.Libraries.userLibraryID) {
      throw new Error("This prototype supports My Library only. WebDAV does not support group libraries.");
    }
  }
  isSource(item) {
    return item && item.isStoredFileAttachment()
      && item.attachmentFilename.endsWith(".noctua.json");
  }
  async ensureFile(item) {
    const local = this.Z.Sync.Storage.Local;
    if ([local.SYNC_STATE_TO_DOWNLOAD, local.SYNC_STATE_FORCE_DOWNLOAD].includes(item.attachmentSyncState)
      || !(await item.getFilePathAsync())) {
      await this.Z.Sync.Runner.downloadFile(item);
    }
    const path = await item.getFilePathAsync();
    if (!path) throw new Error("The note source is not downloaded. Connect to your WebDAV server and sync Zotero, then retry.");
    return path;
  }
  async load(item) {
    this.assertLibrary(item.libraryID);
    if (!this.isSource(item) || item.deleted) throw new Error("Select a live Noctua Notes source attachment");
    const path = await this.ensureFile(item);
    return {doc:this.model.parse(await this.io.readUTF8(path)), item, path};
  }
  async findSource(item) {
    if (this.isSource(item)) return item;
    if (!item) return null;
    if (item.isNote()) {
      for (const key of item.relatedItems || []) {
        const candidate = this.Z.Items.getByLibraryAndKey(item.libraryID, key);
        if (this.isSource(candidate) && !candidate.deleted) return candidate;
      }
    }
    if (item.isAttachment() && item.parentID) item = this.Z.Items.get(item.parentID);
    if (item.isRegularItem()) {
      for (const id of item.getAttachments()) {
        const candidate = this.Z.Items.get(id);
        if (this.isSource(candidate) && !candidate.deleted) return candidate;
      }
    }
    return null;
  }
  draftPath(id) {
    const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "");
    if (!safe) throw new Error("Invalid draft ID");
    return this.paths.join(this.Z.DataDirectory.dir, "noctua-notes-drafts", safe + ".json");
  }
  async writeDraft(id, doc, baseRevision) {
    this.model.validate(doc);
    const path = this.draftPath(id);
    await this.io.makeDirectory(this.paths.parent(path), {ignoreExisting:true, permissions:0o700});
    await this.io.writeUTF8(path, JSON.stringify({doc, baseRevision}), {tmpPath:path+".tmp", permissions:0o600});
  }
  async getDraft(id) {
    const path = this.draftPath(id);
    if (!(await this.io.exists(path))) return null;
    const value = JSON.parse(await this.io.readUTF8(path));
    return {doc:this.model.validate(value.doc), baseRevision:String(value.baseRevision || "")};
  }
  // Historical output is kept private solely to recognize unchanged generated
  // notes. Exact content matching deliberately preserves edited/stale previews.
  _legacyPreviewHTML(doc, sourceKey, heading = null) {
    const esc = this.model.esc;
    const body = doc.blocks.map(b => b.type === "text"
      ? `<pre>${esc(b.src)}</pre>`
      : b.type === "image"
        ? `<p><em>Image: ${esc(b.caption || "open Noctua Notes to view")}</em></p>`
        : `<p><em>Drawing (${b.strokes.length} strokes): open Noctua Notes to view.</em></p>`).join("\n");
    const title=esc(doc.title || "Untitled note");
    return (`<div data-schema-version="9"><h1>${heading ?? `Noctua Note — ${title} (Reading preview)`}</h1>`
      + `<p><a href="zotero://select/library/items/${esc(sourceKey)}">Noctua Notes editable source</a></p>`
      + `<p><em>Generated reading preview. Edit the source with Noctua Notes; this preview is replaced on save. Equations are shown as LaTeX source here.</em></p>`
      + body + "</div>").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  }
  _matchesLegacyPreview(html,doc,sourceKey) {
    const title=this.model.esc(doc.title || "Untitled note");
    return [null,title,`${title} — Reading preview`].some(heading=>html===this._legacyPreviewHTML(doc,sourceKey,heading));
  }
  async _cleanupLegacyPreview(source, doc) {
    if (!doc.previewNoteKey) return false;
    const preview = this.Z.Items.getByLibraryAndKey(source.libraryID, doc.previewNoteKey);
    if (!preview || !preview.isNote() || preview.libraryID !== source.libraryID) return false;
    // Startup may only have primary item data cached. Load local metadata only.
    await source.loadDataType("relations");
    await source.loadDataType("collections");
    await preview.loadDataType("note");
    await preview.loadDataType("relations");
    await preview.loadDataType("collections");
    let removed = false;
    await this.Z.DB.executeTransaction(async () => {
      if (!preview || !preview.isNote() || source.deleted
        || preview.libraryID !== source.libraryID
        || (preview.parentID || null) !== (source.parentID || null)
        || !(source.relatedItems || []).includes(preview.key)
        || !(preview.relatedItems || []).includes(source.key)
        || !this._matchesLegacyPreview(preview.getNote(),doc,source.key)) return;
      if (!source.parentID) {
        const collections = item => [...item.getCollections()].sort((a, b) => a - b).join(",");
        if (collections(source) !== collections(preview)) return;
      }
      // Keep Zotero's native Trash behavior and sync bookkeeping. Never erase.
      if (!preview.deleted) await this.Z.Items.trash(preview.id);
      await source.removeRelatedItem(preview);
      await preview.removeRelatedItem(source);
      await source.save();
      await preview.save();
      removed = true;
    });
    return removed;
  }
  // Explicit opt-in for startup/Tools callers. No downloads, source rewrites, or
  // thrown per-source failures: unavailable sources can migrate on a later save.
  // trashed counts newly trashed notes; detached counts verified companions,
  // including already-trashed notes. errors contains {sourceKey, message}.
  async cleanupLegacyPreviews() {
    const summary = {trashed:0, detached:0, skipped:0, errors:[]};
    try {
      const libraryID = this.Z.Libraries.userLibraryID;
      const items = await this.Z.Items.getAll(libraryID, false, false);
      for (const source of items) {
        if (source.libraryID !== libraryID || source.deleted || !this.isSource(source)) continue;
        try {
          const local = this.Z.Sync.Storage.Local;
          if (this.saves.has(source.key)
            || (source.parentID && this.Z.Items.get(source.parentID)?.deleted)
            || [local.SYNC_STATE_TO_DOWNLOAD, local.SYNC_STATE_FORCE_DOWNLOAD].includes(source.attachmentSyncState)) {
            summary.skipped++; continue;
          }
          const path = await source.getFilePathAsync();
          if (!path) { summary.skipped++; continue; }
          const doc = this.model.parse(await this.io.readUTF8(path));
          const preview = doc.previewNoteKey && this.Z.Items.getByLibraryAndKey(libraryID, doc.previewNoteKey);
          const alreadyDeleted = preview?.deleted;
          if (await this._cleanupLegacyPreview(source, doc)) {
            summary.detached++;
            if (!alreadyDeleted) summary.trashed++;
          } else summary.skipped++;
        } catch (error) {
          summary.errors.push({sourceKey:source.key, message:String(error.message || error)});
        }
      }
    } catch (error) {
      summary.errors.push({sourceKey:null, message:String(error.message || error)});
    }
    return summary;
  }
  pendingSave(session) {
    return this.saves.get(session.id) || this.saves.get(session.item?.key);
  }
  async save(session, input, expectedRevision) {
    if (this.pendingSave(session)) throw new Error("A save is already in progress for this note");
    const promise = this._save(session, input, expectedRevision);
    // The document identity remains stable when the first save creates its item.
    // Keep the source-key alias too for other sessions and migration checks.
    this.saves.set(session.id, promise);
    if(session.item)this.saves.set(session.item.key,promise);
    try { return await promise; } finally {
      for(const [key,value] of this.saves)if(value===promise)this.saves.delete(key);
    }
  }
  async _save(session, input, expectedRevision) {
    this.assertLibrary(session.libraryID);
    const doc = this.model.validate(input);
    await this.writeDraft(session.id, doc, expectedRevision);
    let path, oldText, legacyDoc;
    if (session.item) {
      ({path} = await this.load(session.item));
      oldText = await this.io.readUTF8(path);
      const current = this.model.parse(oldText);
      this.model.assertRevision(current, expectedRevision);
      legacyDoc = current;
    } else if (expectedRevision) {
      throw new Error("A new note cannot have an existing revision");
    }
    doc.revision = this.uuid();
    doc.updated = new Date().toISOString();
    doc.previewNoteKey = null;
    let newSource = false;
    try {
      if (!session.item) {
        const temp = this.paths.join(this.Z.getTempDirectory().path, this.uuid() + ".noctua.json");
        await this.io.writeUTF8(temp, JSON.stringify(doc, null, 2), {permissions:0o600});
        try {
          session.item = await this.Z.Attachments.importFromFile({
            file:temp, libraryID:session.libraryID,
            parentItemID:session.parentID || undefined,
            collections:!session.parentID && session.collectionID ? [session.collectionID] : undefined,
            title:"Noctua Note — " + (doc.title || "Untitled note"), contentType:"application/json"
          });
          const pending=this.saves.get(session.id);
          if(pending)this.saves.set(session.item.key,pending);
          newSource = true;
          path = await session.item.getFilePathAsync();
        } finally { await this.io.remove(temp, {ignoreAbsent:true}); }
      }
      const source = session.item;
      await this.Z.DB.executeTransaction(async () => {
        await this.io.writeUTF8(path, JSON.stringify(doc, null, 2), {tmpPath:path+".tmp", permissions:0o600});
        source.setField("title", "Noctua Note — " + (doc.title || "Untitled note"));
        source.attachmentSyncState = "to_upload";
        await source.save();
      });
    } catch (error) {
      // File writes are outside SQLite's rollback, including commit failures.
      if (oldText !== undefined) await this.io.writeUTF8(path, oldText, {tmpPath:path+".tmp", permissions:0o600});
      if (newSource) {
        await session.item.eraseTx();
        session.item = null;
      }
      throw error;
    }
    // Retire a verified legacy companion only after the source has committed.
    // Missing, edited or moved previews and migration failures cannot block saves.
    if (legacyDoc?.previewNoteKey) {
      try { await this._cleanupLegacyPreview(session.item, legacyDoc); }
      catch (error) { this.Z.logError(error); }
    }
    // The source is now committed. A cleanup/scheduling error must
    // not turn a committed revision into a false failed-save/conflict loop.
    try { await this.io.remove(this.draftPath(session.id), {ignoreAbsent:true}); }
    catch (error) { this.Z.logError(error); }
    try { this.Z.Sync.Runner.setSyncTimeout(2); }
    catch (error) { this.Z.logError(error); }
    return {doc, sourceKey:session.item.key, sourceID:session.item.id};
  }
};
if (typeof module !== "undefined") module.exports = NoctuaNotesStorage;
