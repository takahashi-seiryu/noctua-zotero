"use strict";
const PAIRS = { '(': ')', '[': ']', '{': '}', '$': '$' };
const WRAPS = { ...PAIRS, '"': ['``', "''"], "'": ['`', "'"] };

// Replaces [start, end) with text and selects [s0, s1). execCommand keeps ⌘Z working.
function texEdit(ta, start, end, text, s0, s1 = s0) {
  ta.setSelectionRange(start, end);
  if (!document.execCommand(text ? 'insertText' : 'delete', false, text)) ta.setRangeText(text, start, end);
  ta.setSelectionRange(s0, s1);
  ta.dispatchEvent(new Event('input'));  // again, now the caret is in place (\cite{ picker)
}

function texKeys(e, ta) {
  if (e.isComposing || e.altKey) return false;
  const { selectionStart: s, selectionEnd: t, value: v } = ta;
  const k = e.key;
  if (e.metaKey || e.ctrlKey) {
    const cmd = { b: '\\textbf{', i: '\\textit{' }[k.toLowerCase()];
    if (!cmd || e.shiftKey) return false;
    e.preventDefault();
    if (v.slice(s - cmd.length, s) === cmd && v[t] === '}') texEdit(ta, s - cmd.length, t + 1, v.slice(s, t), s - cmd.length, t - cmd.length);
    else texEdit(ta, s, t, cmd + v.slice(s, t) + '}', s + cmd.length, t + cmd.length);
    return true;
  }
  if (s !== t) {
    if (!WRAPS[k]) return false;
    const [o, c] = Array.isArray(WRAPS[k]) ? WRAPS[k] : [k, WRAPS[k]];
    e.preventDefault();
    texEdit(ta, s, t, o + v.slice(s, t) + c, s + o.length, t + o.length);
    return true;
  }
  const prev = v[s - 1], next = v[s], escaped = v[s - 2] === '\\';
  if (k === 'Backspace') {
    if (!prev || PAIRS[prev] !== next || escaped) return false;
    e.preventDefault();
    texEdit(ta, s - 1, s + 1, '', s - 1);
    return true;
  }
  if (k === '$') {
    if (prev === '\\') return false;
    const inMath = (v.slice(0, s).match(/(?<!\\)\$\$?/g) || []).length % 2 === 1;  // $$ counts once
    e.preventDefault();
    if (inMath && prev === '$' && next === '$' && v[s - 2] !== '$') texEdit(ta, s, s, '$$', s + 1);  // $|$ → $$|$$
    else if (next === '$' && (inMath || prev === '$')) ta.setSelectionRange(s + 1, s + 1);
    else if (inMath || next === '$') texEdit(ta, s, s, '$', s + 1);
    else texEdit(ta, s, s, '$$', s + 1);
    return true;
  }
  if (')]}'.includes(k) && k === next && prev !== '\\') {
    e.preventDefault();
    ta.setSelectionRange(s + 1, s + 1);
    return true;
  }
  // Pair an opener only before whitespace, a closer or the end, and not after a backslash (\{, \().
  if ('([{'.includes(k) && prev !== '\\' && (!next || /[\s)\]}$.,;:]/.test(next))) {
    e.preventDefault();
    texEdit(ta, s, s, k + PAIRS[k], s + 1);
    return true;
  }
  return false;
}


window.startNoctuaNotes = function (host) {
  const $ = id => document.getElementById(id);
  NoctuaAppearance.mount({
    appearance: host?.appearance, document, window,
    refresh: () => Ink.refresh(),
    onError: error => { host?.onError?.(error); $("message").hidden=false; $("message").textContent="Appearance: "+error.message; }
  });
  if (!host) { $("message").hidden=false; $("message").textContent="Open this editor from Zotero → Tools → Noctua Notes."; return; }
  const {session, storage, model} = host;
  window.noctuaSession = session;
  let doc = structuredClone(host.doc);
  let baseRevision = doc.revision;
  let dirty = !!host.imported, generation = 0, saving = null, timer, draftTimer, conflict = false, closing = false;
  const pads = new Map();
  let focusBlock = null, editing = null, historyGroup = null, historyTime = 0;
  const undo = [], redo = [];
  const contentSnapshot = () => JSON.stringify({title:doc.title,preamble:doc.preamble,blocks:doc.blocks});
  let lastSnapshot = contentSnapshot();
  function updateHistory() { $("undo").disabled=!undo.length; $("redo").disabled=!redo.length; }
  function resetHistory() { undo.length=0;redo.length=0;historyGroup=null;lastSnapshot=contentSnapshot();updateHistory(); }
  function restoreHistory(forward=false) {
    pads.forEach(p=>p.finish());
    const from=forward ? redo : undo, to=forward ? undo : redo;
    if(!from.length)return;
    to.push(contentSnapshot());
    Object.assign(doc,JSON.parse(from.pop()));
    document.title="Noctua Notes — "+doc.title;host.onTitle?.(doc.title);
    lastSnapshot=contentSnapshot();historyGroup=null;editing=null;
    render();change(null,false);updateHistory();
    document.title="Noctua Notes — "+doc.title;host.onTitle?.(doc.title);
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => "b"+crypto.randomUUID();
  const esc = model.esc;

  function status(text, error=false) {
    $("save-status").textContent=text;
    $("save-status").classList.toggle("error",error);
  }
  function message(text, error=false) {
    $("message").hidden=!text;
    $("message").textContent=text;
    $("message").classList.toggle("error",error);
  }
  function report(error) {
    host.onError?.(error);
    status(error.code === "NOCTUA_CONFLICT" ? "Conflict — draft preserved" : "Save failed — draft preserved",true);
    message(error.message,true);
  }
  function change(group=null, record=true) {
    const next=contentSnapshot();
    if(record && next!==lastSnapshot) {
      if(!group || group!==historyGroup || Date.now()-historyTime>700) undo.push(lastSnapshot);
      redo.length=0;historyGroup=group;historyTime=Date.now();lastSnapshot=next;
      // Bound history memory when notes contain large inline images.
      let bytes=undo.reduce((n,v)=>n+v.length*2,0);
      while(undo.length>1 && (undo.length>40 || bytes>16*1024*1024)) bytes-=undo.shift().length*2;
      updateHistory();
    }
    dirty=true; generation++;
    status(conflict ? "Conflict — export your draft" : "Unsaved changes",conflict);
    clearTimeout(draftTimer);
    draftTimer=setTimeout(() => storage.writeDraft(session.id,clone(doc),baseRevision).catch(report),250);
    clearTimeout(timer);
    if (!conflict) timer=setTimeout(() => save().catch(report),1200);
  }
  async function save() {
    pads.forEach(p => p.finish());
    clearTimeout(timer); clearTimeout(draftTimer);
    if (saving) { await saving; if (!dirty) return; }
    if (conflict) throw Object.assign(new Error("Export your draft or reload the saved source to resolve the conflict."),{code:"NOCTUA_CONFLICT"});
    if (!dirty) return;
    const snapshot=model.validate(clone(doc)), stamp=generation;
    status("Saving…");
    saving=storage.save(session,snapshot,baseRevision);
    try {
      const result=await saving;
      baseRevision=result.doc.revision;
      doc.revision=baseRevision; doc.previewNoteKey=result.doc.previewNoteKey; doc.updated=result.doc.updated;
      host.onSaved?.(result);
      dirty=generation!==stamp;
      status(dirty ? "New changes pending…" : "Saved");
      if (dirty) {
        await storage.writeDraft(session.id,clone(doc),baseRevision);
        timer=setTimeout(() => save().catch(report),500);
      } else message("");
    } catch(error) {
      if(error.code==="NOCTUA_CONFLICT") conflict=true;
      throw error;
    } finally {saving=null;}
  }
  function renderPreviews() {
    try {
      const cited=new Set();
      const views=NoctuaLatex.renderDoc(doc.blocks.map(b=>b.type==="text" ? b.src : null),{
        preamble:doc.preamble,
        cite:(keys,opts)=>{
          keys.forEach(key=>cited.add(key));
          return host.references?.renderCitation(keys,opts) || keys.map(key=>`<span class="cite">[${esc(key)}]</span>`).join(", ");
        },
        image:path=>doc.media?.[path] || null
      });
      $("references").innerHTML=host.references?.references([...cited]) || "";
      doc.blocks.forEach((b,i)=>{
        if(b.type!=="text") return;
        const view=document.querySelector(`[data-block-id="${CSS.escape(b.id)}"] .nb-view`);
        if(view) {
          view.innerHTML=views[i] || '<p class="empty">Click to write text or LaTeX…</p>';
          view.querySelectorAll("iframe,video,audio,object,embed,script").forEach(el=>el.remove());
          view.querySelectorAll("[data-tex-label]").forEach(el=>{el.id="note-label-"+el.dataset.texLabel;});
        }
      });
    } catch(error) {message("Preview: "+error.message,true);}
  }
  function insert(type, image=null, index=doc.blocks.length) {
    pads.forEach(p=>p.finish());
    const b=type==="text" ? {id:uid(),type,src:""}
      : type==="ink" ? {id:uid(),type,w:Ink.defaultWidth(),h:.6,strokes:[]}
        : {id:uid(),type,data:image,caption:""};
    doc.blocks.splice(index,0,b);editing=null;render();change();
    focusBlock=b.id;
    if(type==="text") edit(b.id);
    else document.querySelector(`[data-block-id="${CSS.escape(b.id)}"] .ink`)?.focus();
    return b;
  }
  function edit(id) {
    const block=document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
    if(editing && editing!==id) document.querySelector(`[data-block-id="${CSS.escape(editing)}"]`)?.classList.remove("editing");
    editing=id;focusBlock=id;
    block?.classList.add("editing");
    block?.querySelector("textarea")?.focus();
  }
  function render() {
    pads.forEach(p=>p.finish());
    pads.forEach(p=>p.destroy());pads.clear();
    $("title").value=doc.title;
    $("preamble").value=doc.preamble;
    $("blocks").replaceChildren();
    function inserter(index) {
      const bar=document.createElement("div");bar.className="block-inserter";
      bar.setAttribute("role","group");bar.setAttribute("aria-label",`Insert at position ${index+1}`);
      for(const [type,label] of [["text","+ Text / LaTeX"],["ink","+ Drawing"]]) {
        const button=document.createElement("button");button.textContent=label;
        button.addEventListener("click",()=>insert(type,null,index));bar.append(button);
      }
      return bar;
    }
    $("blocks").append(inserter(0));
    for (const [blockIndex,b] of doc.blocks.entries()) {
      const el=document.createElement("section");
      el.className="nb nb-"+b.type;
      if(b.type==="text" && b.beside && doc.blocks[blockIndex-1]?.type==="ink") el.classList.add("beside-text");
      if(b.type==="ink" && doc.blocks[blockIndex+1]?.type==="text" && doc.blocks[blockIndex+1].beside) el.classList.add("beside-ink","nb-pair");
      el.dataset.blockId=b.id;
      el.addEventListener("focusin",()=>{focusBlock=b.id;});
      el.addEventListener("pointerdown",()=>{focusBlock=b.id;});
      const tools=document.createElement("div");tools.className="nb-tools";
      for (const [label,action] of [["Move up","up"],["Move down","down"],["Remove block","remove"]]) {
        const button=document.createElement("button");button.textContent=label;button.dataset.action=action;
        button.disabled=(action==="up" && blockIndex===0)||(action==="down" && blockIndex===doc.blocks.length-1);
        tools.append(button);
      }
      if(b.type==="text" && doc.blocks[blockIndex-1]?.type==="ink") {
        const button=document.createElement("button");button.textContent=b.beside ? "Show below" : "Show beside drawing";
        button.dataset.action="beside";tools.append(button);
      }
      tools.addEventListener("click",e=>{
        const action=e.target.closest("button")?.dataset.action;
        if(!action)return;
        pads.forEach(p=>p.finish());
        const i=doc.blocks.findIndex(v=>v.id===b.id);
        if(action==="beside") { b.beside=!b.beside; }
        else if(action==="remove") {
          if(!window.confirm("Remove this block? Saved source changes will sync to your other devices."))return;
          doc.blocks.splice(i,1);
        } else {
          const j=action==="up" ? i-1 : i+1;
          if(j<0||j>=doc.blocks.length)return;
          [doc.blocks[i],doc.blocks[j]]=[doc.blocks[j],doc.blocks[i]];
        }
        editing=null;render();change();
      });
      el.append(tools);
      if(b.type==="text") {
        const wrap=document.createElement("div");wrap.className="text-layout";
        const textarea=document.createElement("textarea");textarea.value=b.src;textarea.spellcheck=false;
        textarea.setAttribute("aria-label","LaTeX block source");
        textarea.placeholder="Write text, $inline math$, or \\section{A heading}";
        textarea.addEventListener("input",()=>{b.src=textarea.value;renderPreviews();change("text:"+b.id);});
        textarea.addEventListener("keydown",e=>{
          if(texKeys(e,textarea))return;
          if(e.key==="Escape" || (e.key==="Enter"&&(e.metaKey||e.ctrlKey))) {
            e.preventDefault();editing=null;el.classList.remove("editing");view.focus();
          }
        });
        textarea.addEventListener("blur",()=>{el.classList.remove("editing");if(editing===b.id)editing=null;});
        const view=document.createElement("div");view.className="nb-view tex-view";view.tabIndex=0;
        view.setAttribute("aria-label","Rendered text block; activate to edit source");
        view.addEventListener("click",e=>{
          if(e.target.closest("a") || !window.getSelection().isCollapsed)return;
          edit(b.id);
        });
        view.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();edit(b.id);}});
        wrap.append(textarea,view);el.append(wrap);
      } else if(b.type==="image") {
        const image=document.createElement("img");image.src=b.data;image.alt=b.caption || "Note image";
        const caption=document.createElement("input");caption.value=b.caption;caption.placeholder="Image caption";
        caption.setAttribute("aria-label","Image caption");caption.addEventListener("input",()=>{b.caption=caption.value;image.alt=b.caption;change();});
        el.append(image,caption);
      } else {
        const pad=document.createElement("div");el.append(pad);
        $("blocks").append(el);
        pads.set(b.id,Ink.mount(pad,b,()=>change(),{undo:()=>restoreHistory(),redo:()=>restoreHistory(true)}));
        $("blocks").append(inserter(blockIndex+1));
        continue;
      }
      $("blocks").append(el,inserter(blockIndex+1));
    }
    renderPreviews();
  }
  async function addImages(files) {
    for(const file of files) {
      if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
      if(file.size>8*1024*1024) throw new Error("Each image must be 8 MB or smaller in this prototype.");
      const data=await new Promise((resolve,reject)=>{
        const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file);
      });
      insert("image",data);
    }
  }
  async function reload() {
    if(!session.item){message("This note has not been saved yet. Make an edit to save automatically.");return;}
    if(dirty&&!window.confirm("Reload the saved version? Export your local draft first if you want to keep both versions."))return;
    clearTimeout(timer);clearTimeout(draftTimer);
    if(saving)await saving;
    const result=await storage.load(session.item);
    doc=clone(result.doc);baseRevision=doc.revision;dirty=false;conflict=false;
    editing=null;resetHistory();
    render();message("");status("Loaded saved source");
  }
  $("parent-title").textContent=host.parentTitle;
  $("notes-stage").addEventListener("click",e=>{
    const citation=e.target.closest("[data-noctua-cite]");
    if(citation) {e.preventDefault();e.stopPropagation();Promise.resolve(host.openCitation?.(citation.dataset.noctuaCite)).catch(report);return;}
    const anchor=e.target.closest("a[href]");
    if(!anchor)return;
    e.preventDefault();e.stopPropagation();
    const href=anchor.getAttribute("href");
    if(anchor.dataset.texRef) {
      const target=[...$("blocks").querySelectorAll("[data-tex-label]")].find(el=>el.dataset.texLabel===anchor.dataset.texRef);
      target?.scrollIntoView({block:"center"});
    } else if(href.startsWith("#")) document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
    else host.openURL?.(href);
  },true);
  $("title").addEventListener("input",()=>{doc.title=$("title").value;document.title="Noctua Notes — "+doc.title;host.onTitle?.(doc.title);change("title");});
  $("preamble").addEventListener("input",()=>{doc.preamble=$("preamble").value;renderPreviews();change("preamble");});
  $("preamble").addEventListener("keydown",e=>{if(texKeys(e,$("preamble")))return;if(e.key==="Escape")$("preamble-panel").open=false;});
  $("undo").addEventListener("click",()=>restoreHistory());
  $("redo").addEventListener("click",()=>restoreHistory(true));
  $("help").addEventListener("click",()=>$("note-help").showModal());
  $("close-help").addEventListener("click",()=>$("note-help").close());
  $("add-text").addEventListener("click",()=>insert("text"));
  $("add-ink").addEventListener("click",()=>insert("ink"));
  $("insert-citation").addEventListener("click",async()=>{
    try {
      const focused=doc.blocks.find(b=>b.id===focusBlock&&b.type==="text");
      const textarea=focused && document.querySelector(`[data-block-id="${CSS.escape(focused.id)}"] textarea`);
      const range=textarea ? [textarea.selectionStart,textarea.selectionEnd] : null;
      const key=await host.pickCitation?.();if(!key)return;
      const b=focused || insert("text");edit(b.id);
      const ta=document.querySelector(`[data-block-id="${CSS.escape(b.id)}"] textarea`);
      const [start,end]=range || [b.src.length,b.src.length];
      const text="\\cite{"+key+"}";texEdit(ta,start,end,text,start+text.length);
    } catch(error) {report(error);}
  });
  $("add-image").addEventListener("click",()=>$("image-input").click());
  $("image-input").addEventListener("change",()=>{addImages($("image-input").files).catch(report);$("image-input").value="";});
  $("reload").addEventListener("click",()=>reload().catch(report));
  document.addEventListener("paste",e=>{
    const images=[...(e.clipboardData?.files || [])].filter(f=>f.type.startsWith("image/"));
    if(images.length){e.preventDefault();addImages(images).catch(report);}
  });
  $("notes-stage").addEventListener("dragover",e=>{if(e.dataTransfer?.types.includes("Files"))e.preventDefault();});
  $("notes-stage").addEventListener("drop",e=>{
    if(e.dataTransfer?.files.length){e.preventDefault();addImages(e.dataTransfer.files).catch(report);}
  });
  document.addEventListener("keydown",e=>{
    if(e.defaultPrevented || !(e.metaKey||e.ctrlKey))return;
    const key=e.key.toLowerCase();
    if(key==="s"){e.preventDefault();save().catch(report);}
    if(key==="d"&&e.shiftKey) {
      e.preventDefault();const i=doc.blocks.findIndex(b=>b.id===focusBlock);
      insert("ink",null,i<0?doc.blocks.length:i+1);
    }
    // Native textarea undo preserves its caret; the toolbar also undoes whole-note edits.
    if((key==="z" || key==="y") && !e.target.matches("textarea,input")) {
      e.preventDefault();restoreHistory(key==="y"||e.shiftKey);
    }
  });
  function exportSource() {
    pads.forEach(p=>p.finish());
    return host.exportSource?.(model.validate(clone(doc)),window);
  }
  function takeCloseSnapshot() {
    closing=true;clearTimeout(timer);clearTimeout(draftTimer);pads.forEach(p=>p.finish());
    clearTimeout(timer);clearTimeout(draftTimer);
    return {doc:clone(doc),baseRevision,dirty,conflict};
  }
  window.addEventListener("unload",()=>{
    clearTimeout(timer);clearTimeout(draftTimer);pads.forEach(p=>p.destroy());
    if(dirty&&!closing)storage.writeDraft(session.id,clone(doc),baseRevision).catch(host.onError);
  });
  if(host.draft) {
    message("An unsaved local draft is available. Choose Recover draft below to review it, then use Zotero’s Tools or item menu to export a backup.");
    const bar=document.createElement("div");bar.className="draft-actions";
    const recover=document.createElement("button");recover.textContent="Recover draft";
    recover.addEventListener("click",()=>{
      doc=clone(host.draft.doc);baseRevision=host.draft.baseRevision;
      conflict=baseRevision!==host.doc.revision;resetHistory();render();change();
      message(conflict ? "The saved source changed after this draft. Export your draft and merge it manually." : "Recovered draft; saving…",conflict);
      bar.remove();
    });
    bar.append(recover);$("message").after(bar);
  }
  render();updateHistory();document.title="Noctua Notes — "+doc.title;
  status(session.item ? "Saved" : "New note · autosaves when edited");
  // A narrow, explicit surface for the isolated Zotero integration tests.
  window.NoctuaNotesEditor={getDocument:()=>clone(doc),save,reload,exportSource,takeCloseSnapshot};
};
