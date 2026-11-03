"use strict";

// The source is a normal stored Zotero attachment; no credentials or absolute
// device paths are serialized. Inline raster media travel with that one file.
var NoctuaNotesModel = (() => {
  const FORMAT = "noctua-notes";
  const MAX_BYTES = 32 * 1024 * 1024;
  const MAX_IMAGE_CHARS = 12 * 1024 * 1024;
  const IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
  const esc = value => String(value ?? "").replace(/[&<>"']/g,
    c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
  const cleanString = (value, max, label) => {
    if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${label}`);
    return value;
  };
  function validate(value) {
    if (!value || value.format !== FORMAT || value.schemaVersion !== 1) {
      throw new Error("This file is not a supported Noctua Notes source (version 1).");
    }
    const doc = {
      format: FORMAT, schemaVersion: 1,
      id: cleanString(value.id, 80, "document ID"),
      revision: cleanString(value.revision, 100, "revision"),
      title: cleanString(value.title, 500, "title"),
      preamble: cleanString(value.preamble || "", 20000, "preamble"),
      // Deprecated schema v1 migration input; successful saves/imports clear it.
      previewNoteKey: value.previewNoteKey || null,
      updated: cleanString(value.updated || "", 80, "updated time"),
      blocks: []
    };
    if (value.media !== undefined) {
      if (!value.media || typeof value.media !== "object" || Array.isArray(value.media)) throw new Error("Invalid note media");
      const entries = Object.entries(value.media);
      if (entries.length > 500) throw new Error("Too many note media files");
      doc.media = {};
      for (const [path, data] of entries) {
        assertMediaPath(path);
        if (typeof data !== "string" || data.length > MAX_IMAGE_CHARS || !IMAGE.test(data)) throw new Error(`Invalid raster media: ${path}`);
        doc.media[path] = data;
      }
    }
    if (value.origin !== undefined) {
      const origin = value.origin;
      if (!origin || typeof origin !== "object") throw new Error("Invalid original note information");
      doc.origin = {id:cleanString(origin.id, 80, "original document ID")};
      for (const field of ["created", "updated"]) {
        if (origin[field] !== undefined) {
          if (!Number.isSafeInteger(origin[field]) || origin[field] < 0) throw new Error(`Invalid original ${field} time`);
          doc.origin[field] = origin[field];
        }
      }
    }
    if (doc.previewNoteKey !== null && !/^[A-Z0-9]{8}$/.test(doc.previewNoteKey)) {
      throw new Error("Invalid preview note key");
    }
    if (!Array.isArray(value.blocks) || value.blocks.length > 500) throw new Error("Too many note blocks");
    const ids = new Set();
    for (const input of value.blocks) {
      if (!input || typeof input !== "object") throw new Error("Invalid note block");
      const id = cleanString(input.id, 100, "block ID");
      if (!id || ids.has(id)) throw new Error("Duplicate or empty block ID");
      ids.add(id);
      if (input.type === "text") {
        const block = {id, type: "text", src: cleanString(input.src, 500000, "LaTeX source")};
        if (input.beside !== undefined) {
          if (typeof input.beside !== "boolean") throw new Error("Invalid drawing text layout");
          block.beside = input.beside;
        }
        doc.blocks.push(block);
      } else if (input.type === "image") {
        const data = cleanString(input.data, MAX_IMAGE_CHARS, "image size");
        if (!IMAGE.test(data)) throw new Error("Images must be inline PNG, JPEG, WebP or GIF data.");
        doc.blocks.push({id, type: "image", data, caption: cleanString(input.caption || "", 2000, "caption")});
      } else if (input.type === "ink") {
        const w = Number(input.w), h = Number(input.h);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < 300 || w > 6000 || h < .06 || h > 8) {
          throw new Error("Invalid drawing dimensions");
        }
        if (!Array.isArray(input.strokes) || input.strokes.length > 10000) throw new Error("Drawing is too large");
        let total = 0;
        const strokes = input.strokes.map(s => {
          if (!/^#[0-9a-f]{6}$/i.test(s.c) || !Number.isFinite(s.w) || s.w <= 0 || s.w > 100) {
            throw new Error("Invalid pen style");
          }
          if (!Array.isArray(s.p) || !s.p.length || (total += s.p.length) > 250000) {
            throw new Error("Drawing has too many points");
          }
          const p = s.p.map(q => {
            if (!Array.isArray(q) || q.length !== 3 || !q.every(Number.isFinite)
              || Math.abs(q[0]) > 100000 || Math.abs(q[1]) > 100000 || q[2] < 0 || q[2] > 1) {
              throw new Error("Invalid drawing point");
            }
            return [...q];
          });
          return {c:s.c, w:s.w, p};
        });
        doc.blocks.push({id, type:"ink", w, h, strokes});
      } else {
        throw new Error(`Unsupported block type: ${input.type}`);
      }
    }
    if (new TextEncoder().encode(JSON.stringify(doc)).length > MAX_BYTES) {
      throw new Error("The source exceeds the prototype's 32 MB limit. Use smaller images or split the note.");
    }
    return doc;
  }
  function blank(id) {
    return {format:FORMAT, schemaVersion:1, id, revision:"", title:"Untitled note", preamble:"",
      previewNoteKey:null, updated:"", blocks:[{id:"b1", type:"text", src:""}]};
  }
  function parse(text) {
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("The source exceeds 32 MB");
    return validate(JSON.parse(text));
  }
  function assertMediaPath(path) {
    if (!/^(?:images|media)\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif)$/i.test(path)) {
      throw new Error(`Unsupported media path: ${path}. Import supports note-relative raster files in images/ or media/; SVG and video are not supported.`);
    }
  }
  function sourceValue(value) {
    if (typeof value === "string") {
      if (new TextEncoder().encode(value).length > MAX_BYTES) throw new Error("The source exceeds 32 MB");
      value = JSON.parse(value);
    }
    if (!value || typeof value !== "object" || !Array.isArray(value.blocks)) throw new Error("Invalid Noctua note source");
    return value;
  }
  // Return only literal local assets. Never fetch URLs or resolve arbitrary paths.
  function mediaPaths(value) {
    value = sourceValue(value);
    const paths = new Set();
    for (const block of value.blocks) {
      if (!block || block.type !== "text" || typeof block.src !== "string") continue;
      const source = block.src.replace(/(?<!\\)%[^\n]*/g, "");
      const pattern = /\\(includegraphics|includevideo)(?![A-Za-z])\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g;
      for (const match of source.matchAll(pattern)) {
        if (match[1] === "includevideo") throw new Error("Video cannot be imported into Noctua Notes for Zotero. Keep the original source.");
        const path = match[2].trim();
        assertMediaPath(path);
        paths.add(path);
      }
    }
    return [...paths];
  }
  function importSource(value, {id, media = {}} = {}) {
    value = sourceValue(value);
    let doc, warnings = [];
    if (value.format === FORMAT) {
      doc = validate(value);
      // An import is a separate note; it must never adopt a legacy preview or revision.
      doc.id = cleanString(id, 80, "new document ID");
    } else {
      if (value.format !== undefined || value.version !== 1) throw new Error("This file is not a supported original Noctua note (version 1).");
      doc = blank(cleanString(id, 80, "new document ID"));
      doc.title = value.title;
      doc.preamble = value.preamble || "";
      doc.blocks = value.blocks.map(block => block?.type === "ink" && block.w === undefined ? {...block,w:1000} : block);
      doc.origin = {id:cleanString(value.id, 80, "original document ID")};
      for (const field of ["created", "updated"]) if (value[field] !== undefined) doc.origin[field] = value[field];
      const ignored = Object.keys(value).filter(key => !["version", "id", "title", "preamble", "blocks", "created", "updated"].includes(key));
      if (ignored.length) warnings.push(`Original metadata is not imported: ${ignored.join(", ")}. Keep the original source for this information.`);
    }
    for (const block of doc.blocks) {
      const fields = block?.type === "text" ? ["id", "type", "src", "beside"]
        : block?.type === "ink" ? ["id", "type", "w", "h", "strokes"] : ["id", "type", "data", "caption"];
      if (block && Object.keys(block).some(key => !fields.includes(key))) {
        warnings.push(`Unsupported properties on block ${block.id} are not imported. Keep the original source.`);
      }
    }
    const assets = Object.assign(Object.create(null), doc.media || {});
    for (const path of mediaPaths(value)) {
      if (!Object.hasOwn(assets, path)) {
        if (!Object.hasOwn(media, path)) throw new Error(`Missing image: ${path}. Keep the images/ folder beside the original note JSON when importing.`);
        assets[path] = media[path];
      }
    }
    if (Object.keys(assets).length) doc.media = assets;
    doc.revision = ""; doc.previewNoteKey = null; doc.updated = "";
    if (doc.blocks.some(block => block.type === "text" && /\\(?:cite[a-zA-Z]*|noteref)\s*(?:\[[^\]]*\]\s*)?\{/.test(block.src))) {
      warnings.push("Citation and note-reference keys are preserved as source; original Noctua library links are not imported.");
    }
    return {doc:validate(doc), warnings};
  }
  function assertRevision(current, expected) {
    if (current.revision !== expected) {
      const error = new Error("This note changed in another session or device. Your draft is preserved. Reload the saved note or export your draft before merging.");
      error.code = "NOCTUA_CONFLICT";
      throw error;
    }
  }
  return {FORMAT, MAX_BYTES, validate, parse, blank, importSource, mediaPaths, assertRevision, esc};
})();
if (typeof module !== "undefined") module.exports = NoctuaNotesModel;
