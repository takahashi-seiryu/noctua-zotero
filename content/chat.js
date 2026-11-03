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

  mount({host, document, window, snapshot, apply, report, store, embedded = false}) {
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
      select.value = id; store.set("agent.provider", id); renderProviders(); closePopover();
    }
    // Icon-only segmented switch. The group is reused between renders so the
    // highlight slides to the chosen provider instead of being redrawn.
    function renderProviders() {
      refreshModelButton();
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
    // ------------------------------------------------------------ photos from the iPhone (over Tailscale)
    const phoneBtn = $("chat-phone"), phonePop = $("chat-phone-pop"), phoneNote = $("chat-phone-note"), phoneQR = $("chat-phone-qr");
    let phoneSession = null, phoneToken = 0;
    function drawQR(url) {
      const qr = qrcode(0, "M"); qr.addData(url); qr.make();
      const n = qr.getModuleCount(), quiet = 3, ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", `0 0 ${n + quiet * 2} ${n + quiet * 2}`); svg.setAttribute("shape-rendering", "crispEdges");
      svg.setAttribute("width", "184"); svg.setAttribute("height", "184");
      const back = document.createElementNS(ns, "rect"); back.setAttribute("width", "100%"); back.setAttribute("height", "100%"); back.setAttribute("fill", "#fff");
      let d = "";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      const path = document.createElementNS(ns, "path"); path.setAttribute("d", d); path.setAttribute("fill", "#000");
      svg.append(back, path); phoneQR.replaceChildren(svg);
    }
    function placePhonePopover() {
      const panel = $("chat").getBoundingClientRect(), anchor = phoneBtn.getBoundingClientRect();
      const width = Math.min(260, panel.width - 24);
      phonePop.style.width = width + "px";
      phonePop.style.left = Math.max(panel.left + 12, Math.min(anchor.left, panel.right - width - 12)) + "px";
      phonePop.style.bottom = (window.innerHeight - anchor.top + 6) + "px";
    }
    function closePhone() {
      phoneToken++;
      if (phoneSession) { try { phoneSession.stop(); } catch (_) {} phoneSession = null; }
      try { agent.phone?.stop(); } catch (_) {}
      phonePop.hidden = true; phoneBtn.setAttribute("aria-expanded", "false"); phoneQR.replaceChildren();
    }
    async function openPhone() {
      const mine = ++phoneToken;
      phonePop.hidden = false; phoneBtn.setAttribute("aria-expanded", "true"); placePhonePopover();
      phoneQR.replaceChildren(); phoneNote.textContent = "Starting…";
      let received = 0;
      try {
        const session = await agent.phone.start(photo => {
          if (attached.length >= MAX_FILES) { report(new Error(`Attach at most ${MAX_FILES} files per message.`)); return; }
          attached.push({name: photo.name, type: photo.type, data: photo.data, preview: `data:${photo.type};base64,${photo.data}`});
          renderAttachments(); received++;
          phoneNote.textContent = `${received} photo${received === 1 ? "" : "s"} received. Take more or close this.`;
        }, {onEnd: () => { if (mine === phoneToken) { phoneNote.textContent = "The session ended after 10 idle minutes."; phoneQR.replaceChildren(); } }});
        if (mine !== phoneToken) { session.stop(); return; }
        phoneSession = session;
        drawQR(session.url);
        phoneNote.textContent = "Scan with your iPhone camera, then take photos.";
      } catch (error) { if (mine === phoneToken) phoneNote.textContent = String(error.message || error); }
    }
    if (agent?.phone) {
      phoneBtn.hidden = false;
      phoneBtn.addEventListener("click", () => { if (phonePop.hidden) openPhone(); else closePhone(); });
      document.addEventListener("pointerdown", event => { if (!phonePop.hidden && !phonePop.contains(event.target) && !phoneBtn.contains(event.target)) closePhone(); });
      document.addEventListener("keydown", event => { if (event.key === "Escape" && !phonePop.hidden) { event.preventDefault(); closePhone(); phoneBtn.focus(); } }, true);
      window.addEventListener("resize", () => { if (!phonePop.hidden) placePhonePopover(); });
      window.addEventListener("pagehide", closePhone);
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

    // ------------------------------------------------------------ model and reasoning
    const EFFORT_LABEL = {minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra"};
    const modelBtn = $("chat-model"), pop = $("chat-model-pop"), modelList = $("chat-model-list"), effortList = $("chat-effort-list"), search = $("chat-model-search");
    const catalogs = new Map();
    let showAllModels = false;
    const savedChoice = provider => ({model: store.get(`agent.model.${provider}`) || "", effort: store.get(`agent.effort.${provider}`) || ""});
    const saveChoice = (provider, choice) => { store.set(`agent.model.${provider}`, choice.model); store.set(`agent.effort.${provider}`, choice.effort); };
    async function catalog(provider) {
      if (!catalogs.has(provider)) {
        let list = [];
        try { list = (await agent.models?.(provider)) || []; } catch (error) { report(error); }
        if (list.length) catalogs.set(provider, list); else return list;
      }
      return catalogs.get(provider);
    }
    const modelOf = (list, id) => list.find(model => model.id === id) || null;
    // Fast mode (Codex's priority tier) is a lightning button next to the model picker.
    const fastBtn = $("chat-fast");
    const fastOn = provider => store.get(`agent.fast.${provider}`) === "1";
    function renderFast(provider, list, model) {
      if (!fastBtn) return;
      const offered = provider === "codex" && list.some(entry => entry.fast);
      fastBtn.hidden = !offered;
      if (!offered) return;
      // With the CLI's default model we cannot know; the default is usually a Fast-capable one.
      const supported = model ? !!model.fast : true;
      const on = supported && fastOn(provider);
      fastBtn.disabled = !supported;
      fastBtn.setAttribute("aria-pressed", String(on));
      const note = model?.fastNote ? " (" + model.fastNote + ")" : "";
      fastBtn.title = !supported ? "This model has no Fast mode" : on ? "Fast mode on" + note + ". Click to turn off" : "Fast mode off. Click to turn on" + note;
      fastBtn.setAttribute("aria-label", "Fast mode " + (on ? "on" : "off"));
    }
    fastBtn?.addEventListener("click", () => {
      const provider = select.value;
      store.set(`agent.fast.${provider}`, fastOn(provider) ? "0" : "1");
      refreshModelButton();
    });
    async function refreshModelButton() {
      const provider = select.value;
      if (!provider) return;
      const list = await catalog(provider), choice = savedChoice(provider), model = modelOf(list, choice.model);
      renderFast(provider, list, model);
      const text = [model ? model.label : "Default", choice.effort ? EFFORT_LABEL[choice.effort] || choice.effort : ""].filter(Boolean).join(" · ");
      modelBtn.querySelector(".chat-model-name").textContent = text;
      modelBtn.title = "Model and reasoning: " + text;
    }
    function row(label, {selected, tag, provider}) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "cmp-row"; button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(!!selected));
      if (provider) { const mark = document.createElement("span"); mark.className = "chat-provider-icon"; mark.style.setProperty("--icon", `url("icons/${provider}.svg")`); button.append(mark); }
      const name = document.createElement("span"); name.className = "cmp-label"; name.textContent = label; button.append(name);
      if (tag) { const small = document.createElement("span"); small.className = "cmp-tag"; small.textContent = tag; button.append(small); }
      const check = icon("check"); check.classList.add("cmp-check"); button.append(check);
      return button;
    }
    async function renderPopover() {
      const provider = select.value, list = await catalog(provider), choice = savedChoice(provider), model = modelOf(list, choice.model);
      const needle = search.value.trim().toLowerCase();
      search.hidden = list.length < 7;
      modelList.replaceChildren();
      // The provider's headline models first; older versions sit behind "Show more" (searching looks at all).
      const hasOlder = list.some(entry => entry.older), expanded = showAllModels || !!needle;
      const entries = [{id: "", label: "Default"}, ...list].filter(entry => (!needle || entry.label.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle)) && (expanded || !entry.older || entry.id === choice.model));
      for (const entry of entries) {
        const button = row(entry.label, {selected: choice.model === entry.id, provider});
        button.addEventListener("click", () => {
          const next = {model: entry.id, effort: choice.effort};
          const picked = modelOf(list, entry.id);
          if (picked && next.effort && picked.efforts?.length && !picked.efforts.includes(next.effort)) next.effort = "";
          saveChoice(provider, next); refreshModelButton(); renderPopover();
        });
        modelList.append(button);
      }
      if (hasOlder && !expanded) {
        const more = document.createElement("button");
        more.type = "button"; more.className = "cmp-more"; more.textContent = "Show more";
        more.addEventListener("click", () => { showAllModels = true; renderPopover(); });
        modelList.append(more);
      }
      if (!entries.length) { const empty = document.createElement("div"); empty.className = "cmp-empty"; empty.textContent = "No matching models."; modelList.append(empty); }
      $("chat-model-current").textContent = model ? model.label : "Default";
      effortList.replaceChildren();
      const efforts = model ? model.efforts : [...new Set(list.flatMap(entry => entry.efforts || []))];
      // A model that takes no reasoning level (e.g. an older Haiku) offers only the default.
      const levels = model?.effortless ? [""] : ["", ...(efforts.length ? efforts : ["low", "medium", "high"])];
      for (const level of levels) {
        const button = row(level ? EFFORT_LABEL[level] || level : "Default", {selected: choice.effort === level, tag: model && level && model.defaultEffort === level ? "Default" : ""});
        button.addEventListener("click", () => { saveChoice(provider, {model: choice.model, effort: level}); refreshModelButton(); closePopover(); input.focus(); });
        effortList.append(button);
      }
    }
    function placePopover() {
      const panel = $("chat").getBoundingClientRect(), anchor = modelBtn.getBoundingClientRect();
      const width = Math.min(520, panel.width - 24);
      pop.style.width = width + "px";
      pop.style.left = Math.max(panel.left + 12, Math.min(anchor.right - width, panel.right - width - 12)) + "px";
      pop.style.bottom = (window.innerHeight - anchor.top + 6) + "px";
    }
    function closePopover() { pop.hidden = true; modelBtn.setAttribute("aria-expanded", "false"); }
    async function openPopover() {
      if (running) return;
      search.value = ""; showAllModels = false;
      pop.hidden = false; modelBtn.setAttribute("aria-expanded", "true");
      placePopover();
      await renderPopover();
      if (!search.hidden) search.focus();
    }
    modelBtn.addEventListener("click", () => { if (pop.hidden) openPopover(); else closePopover(); });
    search.addEventListener("input", () => renderPopover());
    document.addEventListener("pointerdown", event => { if (!pop.hidden && !pop.contains(event.target) && !modelBtn.contains(event.target)) closePopover(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !pop.hidden) { event.preventDefault(); closePopover(); modelBtn.focus(); } }, true);
    window.addEventListener("resize", () => { if (!pop.hidden) placePopover(); });

    // ------------------------------------------------------------ / commands and $ skills
    const COMMANDS = [
      {name: "new", description: "Start a new conversation", run: () => startConversation()},
      {name: "history", description: "Show this note's conversations", run: () => toggleHistory(historyBox.hidden)},
      {name: "model", description: "Choose the model and reasoning level", run: () => openPopover()},
      {name: "provider", description: "Switch between Claude and Codex", run: () => choose(nextAfter(select.value))}
    ];
    const skillCache = new Map();
    async function skillsFor(provider) {
      if (!skillCache.has(provider)) {
        try { skillCache.set(provider, (await agent.skills?.(provider)) || []); } catch (_) { skillCache.set(provider, []); }
        setTimeout(() => skillCache.delete(provider), 60000);
      }
      return skillCache.get(provider);
    }
    const slash = {box: null, items: [], active: 0, range: null, token: 0};
    const SLASH_TOKEN = /(^|\s)([\/$])([\w:.-]*)$/;
    function closeSlash() { slash.box?.remove(); slash.box = null; slash.items = []; slash.range = null; slash.token++; }
    function renderSlash() {
      slash.box.replaceChildren();
      slash.items.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "slash-row"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(index === slash.active));
        const name = document.createElement("span"); name.className = "slash-name"; name.textContent = slash.range.prefix + item.name;
        const text = document.createElement("span"); text.className = "slash-desc"; text.textContent = item.description || "";
        const tag = document.createElement("span"); tag.className = "slash-tag"; tag.textContent = item.run ? "command" : "skill";
        row.append(name, text, tag);
        row.addEventListener("mousedown", event => { event.preventDefault(); pickSlash(index); });
        row.addEventListener("mousemove", () => { if (slash.active !== index) { slash.active = index; markSlash(false); } });
        slash.box.append(row);
      });
    }
    function markSlash(reveal = true) {
      [...slash.box.children].forEach((row, index) => row.setAttribute("aria-selected", String(index === slash.active)));
      if (reveal) slash.box.children[slash.active]?.scrollIntoView({block: "nearest"});
    }
    function placeSlash() {
      const anchor = $("chat-form").getBoundingClientRect();
      slash.box.style.left = anchor.left + "px"; slash.box.style.width = anchor.width + "px";
      slash.box.style.bottom = (window.innerHeight - anchor.top + 6) + "px";
    }
    async function updateSlash() {
      const caret = input.selectionStart, found = input.selectionEnd === caret ? SLASH_TOKEN.exec(input.value.slice(0, caret)) : null;
      if (!found) return closeSlash();
      const prefix = found[2], query = found[3].toLowerCase(), start = caret - found[3].length - 1, mine = ++slash.token;
      const skills = await skillsFor(select.value);
      if (mine !== slash.token) return;
      const rank = item => item.name.toLowerCase().startsWith(query) ? 0 : item.name.toLowerCase().includes(query) ? 1 : (item.description || "").toLowerCase().includes(query) ? 2 : 3;
      const pool = [...(prefix === "/" ? COMMANDS : []), ...skills];
      const items = pool.filter(item => rank(item) < 3).sort((a, b) => rank(a) - rank(b));
      if (!items.length) return closeSlash();
      slash.items = items; slash.active = 0; slash.range = {start, end: caret, prefix};
      if (!slash.box) { slash.box = document.createElement("div"); slash.box.className = "slash-pop"; slash.box.setAttribute("role", "listbox"); slash.box.setAttribute("aria-label", "Commands and skills"); document.body.append(slash.box); }
      renderSlash(); placeSlash();
    }
    function pickSlash(index) {
      const item = slash.items[index];
      if (!item || !slash.range) return;
      const {start, end, prefix} = slash.range;
      closeSlash();
      if (item.run) {
        input.value = input.value.slice(0, start).replace(/\s+$/, "") + input.value.slice(end); grow();
        item.run();
      } else {
        const before = input.value.slice(0, start), after = input.value.slice(end);
        input.value = before + prefix + item.name + " " + after.replace(/^\s+/, "");
        const at = (before + prefix + item.name + " ").length;
        input.setSelectionRange(at, at); grow();
      }
      input.focus();
    }
    // Returns true when the key belongs to the open list.
    function slashKey(event) {
      if (!slash.box || event.isComposing || event.keyCode === 229) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        slash.active = (slash.active + (event.key === "ArrowDown" ? 1 : slash.items.length - 1)) % slash.items.length; markSlash(); return true;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); pickSlash(slash.active); return true; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSlash(); return true; }
      return false;
    }
    // Skills named in the message (/name or $name) that are installed; the host loads their instructions.
    const invokedSkills = text => {
      const names = [...text.matchAll(/(?:^|\s)[\/$]([\w:.-]{1,80})(?=\s|$)/g)].map(match => match[1]).filter(name => !COMMANDS.some(command => command.name === name));
      return [...new Set(names)].slice(0, 3);
    };
    input.addEventListener("input", () => { updateSlash(); });
    input.addEventListener("click", () => { updateSlash(); });
    input.addEventListener("blur", () => setTimeout(closeSlash, 120));
    window.addEventListener("resize", () => { if (slash.box) placeSlash(); });

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
      if (typeof closePhone === "function") closePhone();
      const text = input.value.trim();
      if (running || (!text && !attached.length)) return;
      let provider = select.value;
      if (!providers.find(p => p.id === provider)?.path) { await loadProviders().catch(report); provider = select.value; }
      if (!providers.find(p => p.id === provider)?.path) { bubble("error", `${select.selectedOptions[0]?.textContent || "The assistant"} is not installed. Install it, sign in from a terminal, or set its path in Noctua Notes settings.`); return; }
      clearProposal();
      const files = attached; attached = []; renderAttachments();
      input.value = ""; grow();
      bubble("user", text + (files.length ? (text ? "\n" : "") + files.map(file => "📎 " + file.name).join("\n") : ""), true);
      const status = bubble("status", "Working…");
      const {doc, stamp} = snapshot();
      let job;
      try {
        job = agent.run({provider, skills: invokedSkills(text), fast: provider === "codex" ? fastOn(provider) : null, model: savedChoice(provider).model, effort: savedChoice(provider).effort, message: text || "See the attached files.", attachments: files.map(({name, type, data}) => ({name, type, data})), doc, onProgress: value => { status.textContent = value; }});
        setRunning(job);
        const result = await job.promise;
        status.remove();
        bubble("assistant", result.reply, true);
        if (result.proposal?.changes?.length) showProposal(result, stamp);
        else if (!embedded) bubble("status", "No changes to the note.");
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
      if (slashKey(event)) return;
      // Enter confirms IME composition (e.g. Korean); only a plain Enter sends.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!running) submit(); }
    });
    select.addEventListener("change", () => { store.set("agent.provider", select.value); renderProviders(); });
    document.addEventListener("keydown", event => {
      if (!embedded && (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "k") { event.preventDefault(); toggle($("chat").hidden); }
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
    if (!embedded) initResizer();
    loadProviders().catch(report);
    setRunning(null);
    // The paper chat starts empty: its input already says what it is for.
    if (!embedded) bubble("status", "Ask me to edit, restructure, or explain this note." + (host?.hasPaper ? " I can read the paper's PDF too." : "") + " Changes appear as a proposal you can apply or discard.");
    if (embedded) { $("chat").hidden = false; document.body.classList.add("embedded"); input.focus(); }
    else if (store.get("agent.open") === "1") toggle(true);
    return {toggle};
  }
};
