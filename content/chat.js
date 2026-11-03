"use strict";
// Assistant side panel. It never touches the note directly: the editor hands in
// a snapshot, and a returned proposal is applied only after the user approves it.
var NoctuaChat = {
  KIND_LABEL: {modified: "Edited", added: "Added", removed: "Removed", title: "Title", preamble: "Preamble", moved: "Order"},

  summarize(change) {
    const n = change.index + 1;
    if (change.kind === "modified") return `Edited block ${n}`;
    if (change.kind === "added") return `Added block ${n}`;
    if (change.kind === "removed") return `Removed block ${n}`;
    if (change.kind === "title") return "Changed title";
    if (change.kind === "preamble") return "Changed LaTeX preamble";
    return "Reordered blocks";
  },

  mount({host, document, window, snapshot, apply, report, store}) {
    const $ = id => document.getElementById(id);
    const agent = host?.agent;
    if (!agent) { $("chat-toggle").hidden = true; return null; }
    const log = $("chat-log"), input = $("chat-input"), send = $("chat-send"), select = $("chat-provider"), proposalBox = $("chat-proposal");
    let running = null, providers = [], pending = null, current = null, attached = [];
    const providerUI = $("chat-provider-ui"), historyBox = $("chat-history"), historyToggle = $("chat-history-toggle");
    const noteID = () => host.session?.id || snapshot().doc.id;
    const historyKey = () => "chat.history." + noteID();
    const MAX_CONVERSATIONS = 20, MAX_MESSAGES = 200;

    function readHistory() {
      try { const list = JSON.parse(store.get(historyKey()) || "[]"); return Array.isArray(list) ? list : []; }
      catch (_) { return []; }
    }
    function writeHistory(list) { store.set(historyKey(), JSON.stringify(list.slice(0, MAX_CONVERSATIONS))); }
    // Keeps the active conversation at the top of this note's saved history.
    function persist() {
      if (!current) return;
      current.time = Date.now();
      writeHistory([current, ...readHistory().filter(item => item.id !== current.id)]);
    }
    function record(kind, text) {
      if (kind === "user" && !current) current = {id: String(Date.now()), title: text.replace(/\s+/g, " ").slice(0, 60), time: Date.now(), messages: []};
      if (!current) return;
      current.messages.push({kind, text});
      if (current.messages.length > MAX_MESSAGES) current.messages.splice(0, current.messages.length - MAX_MESSAGES);
      persist();
    }
    function bubble(kind, text, save = false) {
      const node = document.createElement("div");
      node.className = "chat-msg " + kind;
      node.textContent = text;
      log.append(node);
      log.scrollTop = log.scrollHeight;
      if (save) record(kind, text);
      return node;
    }
    function startConversation(message = "New conversation.") {
      running?.cancel(); clearProposal(); log.replaceChildren(); agent.reset?.();
      current = null;
      if (message) bubble("status", message);
    }
    function renderHistory() {
      historyBox.replaceChildren();
      const list = readHistory();
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "chat-history-empty"; empty.textContent = "No saved conversations for this note yet.";
        historyBox.append(empty); return;
      }
      for (const item of list) {
        const row = document.createElement("div"), open = document.createElement("button"), remove = document.createElement("button");
        row.className = "chat-history-row";
        open.type = remove.type = "button"; open.className = "chat-history-open"; remove.className = "icon-btn";
        const title = document.createElement("span"), time = document.createElement("span");
        title.className = "chat-history-title"; title.textContent = item.title || "Conversation";
        time.className = "chat-history-time"; time.textContent = new Date(item.time).toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
        open.append(title, time);
        remove.append(icon("trash-2")); remove.title = "Delete conversation"; remove.setAttribute("aria-label", "Delete conversation");
        open.addEventListener("click", () => {
          startConversation(null);
          current = item;
          for (const message of item.messages) bubble(message.kind, message.text);
          bubble("status", "Restored. Your next message starts with the note as it is now.");
          toggleHistory(false);
        });
        remove.addEventListener("click", () => {
          writeHistory(readHistory().filter(entry => entry.id !== item.id));
          if (current?.id === item.id) current = null;
          renderHistory();
        });
        row.append(open, remove);
        historyBox.append(row);
      }
    }
    function toggleHistory(open) {
      historyBox.hidden = !open;
      historyToggle.setAttribute("aria-expanded", String(open));
      if (open) renderHistory();
    }
    function nextAfter(id) {
      const usable = providers.filter(p => p.path), at = usable.findIndex(p => p.id === id);
      return usable[(at + 1) % usable.length]?.id || id;
    }
    function choose(id) {
      if (running) return;
      select.value = id; store.set("agent.provider", id); renderProviders();
    }
    // Icon-only segmented switch. The group is reused between renders so the
    // highlight slides to the chosen provider instead of being redrawn.
    function renderProviders() {
      const usable = providers.filter(p => p.path), key = usable.map(p => p.id).join();
      if (usable.length > 1) {
        let group = providerUI.querySelector(".chat-provider-seg");
        if (!group || group.dataset.key !== key) {
          providerUI.replaceChildren();
          group = document.createElement("div");
          group.className = "chat-provider-seg"; group.dataset.key = key;
          group.style.setProperty("--count", usable.length);
          const thumb = document.createElement("span");
          thumb.className = "chat-provider-thumb"; thumb.setAttribute("aria-hidden", "true");
          group.append(thumb);
          for (const provider of usable) {
            const button = document.createElement("button");
            button.type = "button"; button.dataset.provider = provider.id;
            button.title = provider.label; button.setAttribute("aria-label", provider.label);
            const mark = document.createElement("span");
            mark.className = "chat-provider-icon"; mark.style.setProperty("--icon", `url("icons/${provider.id}.svg")`);
            button.append(mark);
            // Like a switch: pressing the current provider flips to the other one, pressing the other selects it.
            button.addEventListener("click", () => choose(select.value === provider.id ? nextAfter(provider.id) : provider.id));
            group.append(button);
          }
          group.addEventListener("click", event => { if (!event.target.closest("button")) choose(nextAfter(select.value)); });
          providerUI.append(group);
        }
        usable.forEach((provider, index) => {
          const button = group.querySelector(`button[data-provider="${provider.id}"]`);
          button.setAttribute("aria-pressed", String(select.value === provider.id));
          button.disabled = !!running;
          if (select.value === provider.id) group.style.setProperty("--index", index);
        });
      } else {
        providerUI.replaceChildren();
        const name = document.createElement("span");
        name.className = "chat-provider-name";
        if (usable[0]) {
          const mark = document.createElement("span");
          mark.className = "chat-provider-icon"; mark.style.setProperty("--icon", `url("icons/${usable[0].id}.svg")`);
          name.append(mark, usable[0].label);
        } else name.textContent = "No assistant found";
        providerUI.append(name);
      }
    }
    const WIDTH_DEFAULT = 460, WIDTH_MIN = 320;
    const widthMax = () => Math.max(WIDTH_MIN, Math.floor(window.innerWidth * 0.7));
    function setWidth(value, save = true) {
      const width = Math.round(Math.min(widthMax(), Math.max(WIDTH_MIN, value)));
      document.documentElement.style.setProperty("--chat-width", width + "px");
      $("chat-resizer").setAttribute("aria-valuenow", String(width));
      if (save) store.set("agent.width", String(width));
      return width;
    }
    function initResizer() {
      const handle = $("chat-resizer");
      setWidth(Number(store.get("agent.width")) || WIDTH_DEFAULT, false);
      handle.setAttribute("aria-valuemin", String(WIDTH_MIN));
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        handle.classList.add("dragging"); document.body.classList.add("chat-resizing");
        const move = e => setWidth(window.innerWidth - e.clientX, false);
        const stop = e => {
          handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop);
          handle.classList.remove("dragging"); document.body.classList.remove("chat-resizing");
          setWidth(window.innerWidth - e.clientX);
        };
        handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", stop); handle.addEventListener("pointercancel", stop);
      });
      handle.addEventListener("dblclick", () => setWidth(WIDTH_DEFAULT));
      handle.addEventListener("keydown", event => {
        const step = event.shiftKey ? 48 : 16, now = $("chat").getBoundingClientRect().width;
        if (event.key === "ArrowLeft") { event.preventDefault(); setWidth(now + step); }
        else if (event.key === "ArrowRight") { event.preventDefault(); setWidth(now - step); }
      });
      window.addEventListener("resize", () => setWidth(Number(store.get("agent.width")) || WIDTH_DEFAULT, false));
    }
    // ------------------------------------------------------------ attachments
    const MAX_FILES = 8, MAX_BYTES = 10 * 1024 * 1024;
    const attachBox = $("chat-attachments"), fileInput = $("chat-file");
    function renderAttachments() {
      attachBox.replaceChildren();
      attachBox.hidden = !attached.length;
      attached.forEach((file, index) => {
        const chip = document.createElement("span");
        chip.className = "chat-chip";
        if (file.preview) { const img = document.createElement("img"); img.src = file.preview; img.alt = ""; chip.append(img); }
        else { const mark = document.createElement("span"); mark.className = "chat-chip-icon"; mark.append(icon("paperclip")); chip.append(mark); }
        const name = document.createElement("span"); name.className = "chat-chip-name"; name.textContent = file.name; name.title = file.name;
        const remove = document.createElement("button");
        remove.type = "button"; remove.title = "Remove"; remove.setAttribute("aria-label", "Remove " + file.name); remove.append(icon("x"));
        remove.addEventListener("click", () => { attached.splice(index, 1); renderAttachments(); input.focus(); });
        chip.append(name, remove);
        attachBox.append(chip);
      });
    }
    function readFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    }
    async function addFiles(list) {
      for (const file of [...list]) {
        if (attached.length >= MAX_FILES) { report(new Error(`Attach at most ${MAX_FILES} files per message.`)); break; }
        if (file.size > MAX_BYTES) { report(new Error(`${file.name} is larger than 10 MB.`)); continue; }
        try {
          const url = await readFile(file);
          attached.push({name: file.name || "pasted-image." + (file.type.split("/")[1] || "png"), type: file.type, data: url.slice(url.indexOf(",") + 1),
            preview: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? url : ""});
        } catch (error) { report(error); }
      }
      renderAttachments();
    }
    $("chat-attach").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => { addFiles(fileInput.files).catch(report); fileInput.value = ""; });
    const form = $("chat-form");
    form.addEventListener("dragover", event => { if (event.dataTransfer?.types?.includes("Files")) { event.preventDefault(); form.classList.add("dragging"); } });
    form.addEventListener("dragleave", event => { if (!form.contains(event.relatedTarget)) form.classList.remove("dragging"); });
    form.addEventListener("drop", event => {
      form.classList.remove("dragging");
      if (event.dataTransfer?.files?.length) { event.preventDefault(); addFiles(event.dataTransfer.files).catch(report); }
    });
    input.addEventListener("paste", event => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) { event.preventDefault(); addFiles(files).catch(report); }
    });

    function placePanel() {
      const header = document.querySelector("header");
      // The panel runs the full window height; its head lines up with the toolbar row.
      if (header) $("chat").style.setProperty("--chat-head", Math.round(header.getBoundingClientRect().height) + "px");
    }
    function icon(name) { return NoctuaIcons.create(name, 16); }
    function setRunning(value) {
      running = value;
      send.replaceChildren(icon(value ? "square" : "arrow-up"));
      send.setAttribute("aria-label", value ? "Stop" : "Send");
      send.title = value ? "Stop" : "Send (Enter)";
      input.disabled = false;
      select.disabled = !!value;
      renderProviders();
    }
    function clearProposal() { proposalBox.hidden = true; proposalBox.replaceChildren(); pending = null; }
    function showProposal(result, stamp) {
      clearProposal();
      pending = {result, stamp};
      const title = document.createElement("div");
      title.className = "chat-proposal-title";
      title.textContent = `Proposed changes (${result.proposal.changes.length})`;
      proposalBox.append(title);
      for (const change of result.proposal.changes) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = NoctuaChat.summarize(change);
        details.append(summary);
        for (const [label, text] of [["Before", change.before], ["After", change.after]]) {
          if (!text) continue;
          const caption = document.createElement("div"), pre = document.createElement("pre");
          caption.className = "chat-diff-label"; caption.textContent = label;
          pre.textContent = text.length > 1500 ? text.slice(0, 1500) + "…" : text;
          details.append(caption, pre);
        }
        proposalBox.append(details);
      }
      const row = document.createElement("div");
      row.className = "chat-proposal-actions";
      const accept = document.createElement("button"), discard = document.createElement("button");
      accept.type = discard.type = "button";
      accept.id = "chat-apply"; discard.id = "chat-discard";
      accept.className = "primary";
      accept.append(icon("check"), "Apply"); discard.append("Discard");
      accept.addEventListener("click", () => {
        try {
          if (apply(result.proposal, stamp)) { bubble("status", "Applied. Undo restores the previous version."); clearProposal(); }
        } catch (error) { report(error); }
      });
      discard.addEventListener("click", () => { clearProposal(); bubble("status", "Discarded."); });
      row.append(accept, discard);
      proposalBox.append(row);
      proposalBox.hidden = false;
      log.scrollTop = log.scrollHeight;
    }
    async function submit() {
      const text = input.value.trim();
      if (running || (!text && !attached.length)) return;
      const provider = select.value;
      if (!providers.find(p => p.id === provider)?.path) await loadProviders().catch(report);
      if (!providers.find(p => p.id === provider)?.path) { bubble("error", `${select.selectedOptions[0]?.textContent || "The assistant"} is not installed. Install it, sign in from a terminal, or set its path in Noctua Notes settings.`); return; }
      clearProposal();
      const files = attached; attached = []; renderAttachments();
      input.value = ""; grow();
      bubble("user", text + (files.length ? (text ? "\n" : "") + files.map(file => "📎 " + file.name).join("\n") : ""), true);
      const status = bubble("status", "Working…");
      const {doc, stamp} = snapshot();
      let job;
      try {
        job = agent.run({provider, message: text || "See the attached files.", attachments: files.map(({name, type, data}) => ({name, type, data})), doc, onProgress: value => { status.textContent = value; }});
        setRunning(job);
        const result = await job.promise;
        status.remove();
        bubble("assistant", result.reply, true);
        if (result.proposal.changes.length) showProposal(result, stamp);
        else bubble("status", "No changes to the note.");
      } catch (error) {
        status.remove();
        if (error.code === "NOCTUA_CANCELLED") bubble("status", "Stopped.");
        else { bubble("error", error.message || String(error), true); report(error); }
      } finally { setRunning(null); input.focus(); }
    }
    function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; }
    function toggle(open) {
      document.body.classList.toggle("chat-open", open);
      $("chat").hidden = !open;
      if (open) placePanel(); else toggleHistory(false);
      $("chat-toggle").setAttribute("aria-expanded", String(open));
      store.set("agent.open", open ? "1" : "0");
      if (open) { input.focus(); loadProviders().catch(report); }
    }

    $("chat-toggle").addEventListener("click", () => toggle($("chat").hidden));
    $("chat-close").addEventListener("click", () => toggle(false));
    $("chat-new").addEventListener("click", () => { startConversation(); toggleHistory(false); });
    historyToggle.addEventListener("click", () => toggleHistory(historyBox.hidden));
    window.addEventListener("resize", () => { if (!$("chat").hidden) placePanel(); });
    $("chat-form").addEventListener("submit", event => {
      event.preventDefault();
      if (running) running.cancel(); else submit();
    });
    input.addEventListener("input", grow);
    input.addEventListener("keydown", event => {
      // Enter confirms IME composition (e.g. Korean); only a plain Enter sends.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!running) submit(); }
    });
    select.addEventListener("change", () => { store.set("agent.provider", select.value); renderProviders(); });
    document.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "k") { event.preventDefault(); toggle($("chat").hidden); }
    });

    async function loadProviders() {
      const list = await agent.providers();
      providers = list;
      const keep = select.value;
      select.replaceChildren();
      for (const provider of list) {
        const option = document.createElement("option");
        option.value = provider.id;
        option.textContent = provider.path ? provider.label : provider.label + " (not found)";
        select.append(option);
      }
      const saved = keep || store.get("agent.provider");
      const usable = list.find(p => p.id === saved && p.path) || list.find(p => p.path) || list[0];
      if (usable) select.value = usable.id;
      renderProviders();
    }
    initResizer();
    loadProviders().catch(report);
    setRunning(null);
    bubble("status", "Ask me to edit, restructure, or explain this note. Changes appear as a proposal you can apply or discard.");
    if (store.get("agent.open") === "1") toggle(true);
    return {toggle};
  }
};
