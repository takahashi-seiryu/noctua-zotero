"use strict";

// Split view for a Noctua note tab: a real Zotero PDF reader on the left, the note editor on the right.
//
// The reader is Zotero's own ReaderTab, opened into the note tab's container (Zotero supports opening
// a reader into an existing tab id). Everything else here is a small HTML bar with a paper picker and a
// draggable divider, laid out with a CSS grid on the tab container:
//
//   | bar          | | editor |
//   | PDF reader   | | editor |
//
// Switching papers tears the current reader down (without closing the tab) and opens another one.
var NoctuaSplitView = {
  pdfsOf(Zotero, item) {
    if (!item || item.deleted) return [];
    if (item.isPDFAttachment?.()) return [item];
    if (!item.isRegularItem?.()) return [];
    return item.getAttachments().map(id => Zotero.Items.get(id)).filter(a => a && !a.deleted && a.isPDFAttachment());
  },

  create({Zotero, owner, tabID, container, frame, parent = null, libraryID, store = null, noteID = "", onChange = () => {}}) {
    const HTML = "http://www.w3.org/1999/xhtml", SVG = "http://www.w3.org/2000/svg";
    const doc = owner.document;
    const pdfsOf = item => NoctuaSplitView.pdfsOf(Zotero, item);
    const h = (tag, props = {}, ...children) => {
      const node = doc.createElementNS(HTML, tag);
      for (const [key, value] of Object.entries(props)) {
        if (key === "style") node.style.cssText = value;
        else if (key === "text") node.textContent = value;
        else node.setAttribute(key, value);
      }
      node.append(...children);
      return node;
    };
    // Official Lucide geometry (ISC, see content/icons/LICENSE).
    const ICONS = {
      "chevron-down": [["path", {d: "m6 9 6 6 6-6"}]],
      x: [["path", {d: "M18 6 6 18"}], ["path", {d: "m6 6 12 12"}]],
      search: [["circle", {cx: "11", cy: "11", r: "8"}], ["path", {d: "m21 21-4.34-4.34"}]]
    };
    const icon = (name, size = 14) => {
      const svg = doc.createElementNS(SVG, "svg");
      for (const [k, v] of Object.entries({width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true"})) svg.setAttribute(k, v);
      for (const [tag, attrs] of ICONS[name]) {
        const node = doc.createElementNS(SVG, tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        svg.append(node);
      }
      return svg;
    };

    const FG = "var(--fill-primary,#222)", FG2 = "var(--fill-secondary,#666)", BG = "var(--material-background,#fff)";
    const LINE = "1px solid var(--fill-quarternary,#0000001f)";
    const buttonCSS = `display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:${FG};border-radius:5px;padding:4px 7px;font:inherit;cursor:pointer`;

    // ---- elements
    const bar = h("div", {style: `grid-column:1;grid-row:1;display:flex;align-items:center;gap:6px;min-width:0;padding:4px 8px;border-bottom:${LINE};background:${BG};color:${FG}`});
    const titleButton = h("button", {type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Choose a paper",
      style: buttonCSS + ";flex:1;min-width:0;justify-content:space-between"});
    const titleText = h("span", {style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", text: "Choose a paper"});
    titleButton.append(titleText, icon("chevron-down"));
    const closeButton = h("button", {type: "button", "aria-label": "Close split view", title: "Close split view", style: buttonCSS}, icon("x"));
    bar.append(titleButton, closeButton);

    const picker = h("div", {style: `grid-column:1;grid-row:2;display:flex;flex-direction:column;min-height:0;min-width:0;background:${BG};color:${FG};z-index:2`});
    const searchBox = h("div", {style: `display:flex;align-items:center;gap:6px;margin:8px;padding:5px 8px;border:${LINE};border-radius:6px;color:${FG2}`}, icon("search"));
    const query = h("input", {type: "search", placeholder: "Search your library", "aria-label": "Search your library", spellcheck: "false",
      style: `flex:1;min-width:0;border:0;outline:0;background:transparent;color:${FG};font:inherit`});
    searchBox.append(query);
    const list = h("div", {role: "listbox", "aria-label": "Papers", style: "flex:1;min-height:0;overflow:auto;padding:0 6px 8px"});
    const note = h("p", {role: "status", style: `margin:0;padding:6px 14px;color:${FG2};font-size:12px`});
    picker.append(searchBox, list, note);

    const divider = h("div", {role: "separator", "aria-orientation": "vertical", "aria-label": "Resize split view", tabindex: "0",
      style: `grid-column:2;grid-row:1 / span 2;cursor:col-resize;background:var(--fill-quarternary,#0000001f);width:5px;z-index:3`});
    frame.style.gridColumn = "3";
    frame.style.gridRow = "1 / span 2";

    // ---- state
    let lastOwn = null;
    const state = {open: false, current: null, token: 0, built: false};
    const clamp = (width) => {
      const total = container.getBoundingClientRect().width || 1200;
      return Math.max(280, Math.min(width, total - 360));
    };
    const savedFraction = () => {
      const value = parseFloat(store?.get?.("split.width"));
      return value > 0.15 && value < 0.85 ? value : 0.5;
    };
    let fraction = savedFraction();
    function layout() {
      const total = container.getBoundingClientRect().width || 1200;
      container.style.gridTemplateColumns = `${clamp(total * fraction)}px 5px minmax(0,1fr)`;
    }
    function setNote(text) { note.textContent = text || ""; note.hidden = !text; }

    // ---- reader
    function dropReader() {
      const entry = state.current;
      state.current = null;
      if (!entry) return;
      const reader = entry.reader;
      // Zotero's listeners on the tab container still hold this reader; make them harmless.
      for (const name of ["_updateLayout", "setBottomPlaceholderHeight", "setContextPaneOpen"]) {
        try { Object.defineProperty(reader, name, {value: () => {}, configurable: true}); } catch (_) {}
      }
      try { reader.uninit(); } catch (error) { Zotero.logError(error); }
      const index = Zotero.Reader._readers.indexOf(reader);
      if (index >= 0) Zotero.Reader._readers.splice(index, 1);
      try { reader._iframe?.remove(); reader._popupset?.remove(); } catch (_) {}
    }
    // Open fitted to the pane's width (pdf.js keeps it fitted while the divider moves), not at the last saved zoom.
    async function fitWidth(reader) {
      try {
        if (reader._type !== "pdf") return;
        let viewer = null;
        for (let n = 0; n < 300 && !viewer; n++) {
          viewer = reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
          if (!viewer?.firstPagePromise) { viewer = null; await Zotero.Promise.delay(50); }
        }
        if (!viewer) return;
        await viewer.firstPagePromise;
        if (state.current?.reader === reader) viewer.currentScaleValue = "page-width";
      } catch (error) { Zotero.debug("Noctua split view: could not fit the PDF: " + error); }
    }
    // A PDF that only exists in file storage (Zotero or WebDAV) is fetched first, as Zotero does when opening it.
    async function ensureLocal(attachment) {
      if (await attachment.getFilePathAsync()) return true;
      const linked = attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE;
      let syncing = false;
      try { syncing = !linked && !!Zotero.Sync.Storage.Local.getEnabledForLibrary(attachment.libraryID); } catch (_) {}
      if (!syncing) { setNote(linked ? "The linked PDF file could not be found." : "This PDF is not on this computer and file syncing is off."); return false; }
      setNote("Downloading PDF…");
      try { await Zotero.Sync.Runner.downloadFile(attachment); }
      catch (error) { Zotero.logError(error); setNote("Could not download the PDF: " + (error.message || error)); return false; }
      if (await attachment.getFilePathAsync()) return true;
      setNote("The PDF could not be downloaded. Check file syncing, then try again.");
      return false;
    }
    async function show(attachment) {
      if (!attachment || attachment.deleted) return;
      if (state.current?.item.id === attachment.id) { setPicker(false); return; }
      const token = ++state.token;
      setNote("");
      if (own().some(a => a.id === attachment.id)) lastOwn = attachment;
      if (!(await ensureLocal(attachment))) { if (token === state.token) setPicker(true, true); return; }
      if (token !== state.token) return;
      setNote("");
      dropReader();
      let reader;
      try {
        reader = await Zotero.Reader.open(attachment.id, null, {tabID, allowDuplicate: true});
      } catch (error) {
        Zotero.logError(error);
        setPicker(true);
        setNote("Could not open this PDF: " + (error.message || error));
        return;
      }
      if (!reader) { setPicker(true); setNote("Could not open this PDF."); return; }
      state.current = {reader, item: attachment};
      fitWidth(reader);
      // Keep Zotero's "open this item" lookups from jumping to the note tab instead of a reader tab.
      reader._isTabClosed = true;
      const view = reader._iframe;
      if (view) { view.style.gridColumn = "1"; view.style.gridRow = "2"; view.style.minWidth = "0"; view.hidden = !state.open; }
      if (token !== state.token) return;
      store?.set?.("split.pdf." + noteID, attachment.libraryID + "/" + attachment.key);
      setTitle(attachment);
      setPicker(false);
    }
    function labelOf(attachment) {
      const top = attachment.parentID ? Zotero.Items.get(attachment.parentID) : attachment;
      return (top?.getField?.("title") || attachment.getField("title") || "Untitled").trim();
    }
    function setTitle(attachment) {
      titleText.textContent = attachment ? labelOf(attachment) : "Choose a paper";
      titleButton.title = titleText.textContent;
    }

    // ---- picker
    function row(attachment, {multiple = false} = {}) {
      const top = attachment.parentID ? Zotero.Items.get(attachment.parentID) : attachment;
      const selected = state.current?.item.id === attachment.id;
      const secondary = [top?.firstCreator, (top?.getField?.("date", true, true) || "").slice(0, 4)].filter(Boolean).join(", ");
      const extra = multiple ? (attachment.getField("title") || attachment.attachmentFilename || "PDF") : "";
      const title = h("div", {style: "overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere;line-height:1.35", text: labelOf(attachment)});
      const meta = h("div", {style: `color:${FG2};font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`,
        text: [secondary, extra].filter(Boolean).join(" · ")});
      const node = h("div", {role: "option", tabindex: "0", "aria-selected": String(selected), "data-noctua-split-pdf": attachment.key,
        style: `padding:6px 8px;border-radius:6px;cursor:default;${selected ? "background:var(--fill-quinary,#0000000d);" : ""}`}, title);
      if (meta.textContent) node.append(meta);
      node.addEventListener("mouseenter", () => { node.style.background = "var(--fill-quinary,#0000000d)"; });
      node.addEventListener("mouseleave", () => { node.style.background = selected ? "var(--fill-quinary,#0000000d)" : ""; });
      const choose = () => show(attachment);
      node.addEventListener("click", choose);
      node.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } });
      return node;
    }
    const heading = text => h("div", {style: `padding:8px 8px 3px;color:${FG2};font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase`, text});

    const own = () => pdfsOf(parent);
    let searchToken = 0;
    async function search(text) {
      const query_ = String(text || "").trim();
      const search_ = new Zotero.Search();
      search_.libraryID = libraryID;
      search_.addCondition("libraryID", "is", libraryID);
      if (query_) search_.addCondition("quicksearch-titleCreatorYear", "contains", query_);
      search_.addCondition("itemType", "isNot", "note");
      const ids = await search_.search();
      const found = await Zotero.Items.getAsync(ids);
      const tops = new Map();
      for (const item of found) {
        const top = item.isAttachment() && item.parentID ? Zotero.Items.get(item.parentID) : item;
        if (top && !top.deleted && !top.isNote() && !tops.has(top.id)) tops.set(top.id, top);
      }
      let result = [...tops.values()].filter(top => pdfsOf(top).length);
      if (!query_) result.sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)));
      return result.slice(0, 60);
    }
    async function refreshList() {
      const token = ++searchToken;
      const text = query.value;
      let results = [];
      try { results = await search(text); }
      catch (error) { Zotero.logError(error); setNote("Search failed: " + (error.message || error)); }
      if (token !== searchToken) return;
      list.replaceChildren();
      const mine = own();
      const mineIDs = new Set(mine.map(a => a.id));
      if (mine.length && !text.trim()) {
        list.append(heading("This note's paper"));
        for (const attachment of mine) list.append(row(attachment, {multiple: mine.length > 1}));
      }
      const rest = [];
      for (const top of results) for (const attachment of pdfsOf(top)) {
        if (!mineIDs.has(attachment.id) || text.trim()) rest.push([attachment, pdfsOf(top).length > 1]);
      }
      if (rest.length) {
        list.append(heading(text.trim() ? "Results" : "Library"));
        for (const [attachment, multiple] of rest) list.append(row(attachment, {multiple}));
      }
      if (!list.children.length) setNote(text.trim() ? "No papers with a PDF match your search." : "No papers with a PDF in this library.");
      else setNote("");
    }
    let typing = null;
    query.addEventListener("input", () => { clearTimeout(typing); typing = owner.setTimeout(refreshList, 180); });
    query.addEventListener("keydown", event => {
      if (event.key === "Escape" && state.current) { event.preventDefault(); setPicker(false); }
      if (event.key === "Enter") { event.preventDefault(); list.querySelector('[role="option"]')?.click(); }
    });
    function setPicker(open, keepNote = false) {
      picker.style.display = open ? "flex" : "none";
      titleButton.setAttribute("aria-expanded", String(open));
      if (state.current && state.current.reader._iframe) state.current.reader._iframe.style.visibility = open ? "hidden" : "";
      if (open) { if (!keepNote) refreshList(); owner.setTimeout(() => query.focus(), 0); }
    }
    titleButton.addEventListener("click", () => setPicker(picker.style.display === "none"));
    closeButton.addEventListener("click", () => toggle(false));

    // ---- divider
    divider.addEventListener("pointerdown", event => {
      event.preventDefault();
      divider.setPointerCapture?.(event.pointerId);
      const start = event.clientX, startWidth = clamp((container.getBoundingClientRect().width || 1200) * fraction);
      const total = container.getBoundingClientRect().width || 1200;
      frame.style.pointerEvents = "none";
      if (state.current?.reader._iframe) state.current.reader._iframe.style.pointerEvents = "none";
      const move = e => { fraction = clamp(startWidth + e.clientX - start) / total; layout(); };
      const up = () => {
        divider.removeEventListener("pointermove", move);
        divider.removeEventListener("pointerup", up);
        frame.style.pointerEvents = "";
        if (state.current?.reader._iframe) state.current.reader._iframe.style.pointerEvents = "";
        store?.set?.("split.width", String(fraction));
      };
      divider.addEventListener("pointermove", move);
      divider.addEventListener("pointerup", up);
    });
    divider.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      fraction = Math.max(0.2, Math.min(0.8, fraction + (event.key === "ArrowLeft" ? -0.03 : 0.03)));
      layout();
      store?.set?.("split.width", String(fraction));
    });
    const resizeObserver = new owner.ResizeObserver(() => { if (state.open) layout(); });

    // ---- open / close
    async function initialPaper() {
      const remembered = String(store?.get?.("split.pdf." + noteID) || "");
      if (remembered) {
        const [lib, key] = remembered.split("/");
        const item = Zotero.Items.getByLibraryAndKey(Number(lib), key);
        if (item && !item.deleted && item.isPDFAttachment()) return item;
      }
      const mine = own();
      return mine.length === 1 ? mine[0] : null;
    }
    async function toggle(open = !state.open, {skipInitial = false} = {}) {
      if (open === state.open) return state.open;
      state.open = open;
      if (open) {
        if (!state.built) { container.append(bar, picker, divider); state.built = true; }
        bar.style.display = "flex"; divider.hidden = false;
        container.style.display = "grid";
        container.style.gridTemplateRows = "auto minmax(0,1fr)";
        frame.style.minWidth = "0";
        layout();
        resizeObserver.observe(container);
        const reader = state.current?.reader._iframe;
        if (reader) reader.hidden = false;
        if (state.current) setPicker(false);
        else {
          setPicker(true);
          const first = skipInitial ? null : await initialPaper();
          if (first && state.open) await show(first);
        }
      } else {
        resizeObserver.disconnect();
        bar.style.display = picker.style.display = "none"; divider.hidden = true;
        if (state.current?.reader._iframe) state.current.reader._iframe.hidden = true;
        // Closing the reader leaves the keyboard focus nowhere; give it back to the note so shortcuts keep working.
        try { frame.contentWindow?.focus(); } catch (_) {}
        container.style.display = "flex";
        container.style.gridTemplateColumns = container.style.gridTemplateRows = "";
        frame.style.gridColumn = frame.style.gridRow = "";
      }
      if (open) { frame.style.gridColumn = "3"; frame.style.gridRow = "1 / span 2"; }
      onChange(state.open);
      return state.open;
    }

    return {
      toggle,
      get isOpen() { return state.open; },
      get current() { return state.current?.item || null; },
      show,
      // Back to this note's own paper: the PDF last read from it, else its first one.
      async showPaper() {
        const target = lastOwn && !lastOwn.deleted ? lastOwn : own()[0];
        if (!target) return false;
        if (!state.open) await toggle(true, {skipInitial: true});
        await show(target);
        return true;
      },
      // Open the split view (if needed) straight on this PDF, e.g. from a citation.
      async showItem(attachment) {
        if (!state.open) await toggle(true, {skipInitial: true});
        await show(attachment);
      },
      show,
      destroy() {
        resizeObserver.disconnect();
        clearTimeout(typing);
        // On tab close Zotero uninitializes the reader and removes the container itself.
        state.current = null;
        for (const node of [bar, picker, divider]) node.remove();
      }
    };
  }
};
if (typeof module !== "undefined") module.exports = NoctuaSplitView;
