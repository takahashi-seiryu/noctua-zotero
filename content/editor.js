"use strict";
const PAIRS = { '(': ')', '[': ']', '{': '}', '$': '$' };
const WRAPS = { ...PAIRS, '"': ['``', "''"], "'": ['`', "'"] };

// Replaces [start, end) with text and selects [s0, s1). execCommand keeps ⌘Z working.
let texBusy = false;  // our own insertion re-enters the input events; never pair that again
function texEdit(ta, start, end, text, s0, s1 = s0) {
  ta.setSelectionRange(start, end);
  texBusy = true;
  const before = ta.value;
  // execCommand reports success but edits nothing while another frame (e.g. a playing video) owns focus.
  try { if (!document.execCommand(text ? 'insertText' : 'delete', false, text) || ta.value === before) ta.setRangeText(text, start, end); }
  finally { texBusy = false; }
  ta.setSelectionRange(s0, s1);
  ta.dispatchEvent(new Event('input'));  // again, now the caret is in place (\cite{ picker)
}

// Same pairing rules for characters delivered by an input method instead of keydown.
function texBeforeInput(e, ta) {
  if (texBusy || e.isComposing || e.inputType !== 'insertText' || typeof e.data !== 'string' || e.data.length !== 1) return false;
  return texKeys({key: e.data, isComposing: false, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false,
    preventDefault: () => e.preventDefault()}, ta);
}

// "just now", "5 min ago", "3 h ago", "Yesterday", "3 days ago", then a date. Empty for a note never saved.
function timeAgo(iso, now = Date.now()) {
  const time = Date.parse(iso || '');
  if (!iso || Number.isNaN(time)) return '';
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  if (minutes < 1440) return Math.floor(minutes / 60) + ' h ago';
  if (minutes < 2880) return 'Yesterday';
  if (minutes < 10080) return Math.floor(minutes / 1440) + ' days ago';
  return new Date(time).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
}

// Maps a caret position in the rendered preview to a source offset. Rendered text and LaTeX only
// partly agree (commands, math, citations), so look for the text around the click in the source and
// fall back to the same relative position.
function mapCaret(rendered, offset, src) {
  const squash = text => {
    let out = '';const map = [];
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) { if (out && out[out.length - 1] !== ' ') { out += ' '; map.push(i); } }
      else { out += text[i]; map.push(i); }
    }
    return {text: out, map};
  };
  const r = squash(rendered), s = squash(src);
  if (!s.text) return 0;
  let at = 0;
  while (at < r.map.length && r.map[at] < offset) at++;
  const before = r.text.slice(Math.max(0, at - 10), at), after = r.text.slice(at, at + 10);
  const guess = r.text.length ? Math.round(at / r.text.length * s.text.length) : 0;
  const nearest = (needle, shift) => {
    let best = -1, from = 0, index;
    while ((index = s.text.indexOf(needle, from)) >= 0) {
      if (best < 0 || Math.abs(index - guess) < Math.abs(best - guess)) best = index;
      from = index + 1;
    }
    return best < 0 ? -1 : best + shift;
  };
  let pos = -1;
  if (before.length + after.length >= 6) pos = nearest(before + after, before.length);
  // Shorter and shorter neighbours until something in the source matches.
  for (const n of [10, 7, 5, 3]) if (pos < 0 && before.length >= n) pos = nearest(before.slice(-n), n);
  for (const n of [10, 7, 5, 3]) if (pos < 0 && after.length >= n) pos = nearest(after.slice(0, n), 0);
  if (pos < 0) pos = guess;
  pos = Math.min(Math.max(pos, 0), s.map.length);
  return pos >= s.map.length ? src.length : s.map[pos];
}

function texKeys(e, ta) {
  // keyCode 229 means an input method (e.g. Korean) owns this key and will insert the
  // character itself; texBeforeInput handles it instead, or the character is doubled.
  if (texBusy || e.isComposing || e.altKey || e.keyCode === 229) return false;
  // Typed characters are paired from `beforeinput` only. Handling them on keydown as well gave two
  // routes to the same bracket (and `{{}}`); keydown keeps shortcuts and Backspace.
  if (e.type === 'keydown' && e.key.length === 1 && !e.metaKey && !e.ctrlKey) return false;
  const { selectionStart: s, selectionEnd: t, value: v } = ta;
  const k = e.key;
  if (k === 'Tab' && !e.metaKey && !e.ctrlKey) {
    // Tab indents inside the source instead of moving focus out of the block (Esc, then Tab, leaves).
    e.preventDefault();
    const IND = '  ', shift = e.shiftKey;
    const from = v.lastIndexOf('\n', s - 1) + 1;
    if (!shift && !v.slice(s, t).includes('\n')) { texEdit(ta, s, t, IND, s + IND.length); return true; }
    const last = t > s && v[t - 1] === '\n' ? t - 1 : t;
    let to = v.indexOf('\n', last);
    if (to < 0) to = v.length;
    const lines = v.slice(from, to).split('\n');
    const removed = [];
    const out = lines.map(line => {
      if (!shift) { removed.push(line ? -IND.length : 0); return line ? IND + line : line; }
      const lead = /^( {1,2}|\t)/.exec(line)?.[0].length || 0;
      removed.push(lead);
      return line.slice(lead);
    });
    const newStart = Math.max(from, s - removed[0]);
    const newEnd = s === t ? newStart : Math.max(newStart, t - removed.reduce((a, b) => a + b, 0));
    texEdit(ta, from, to, out.join('\n'), newStart, newEnd);
    return true;
  }
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
  store.attach?.(host?.ui);
  NoctuaIcons.hydrate();
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
  let reading = false;
  let focusBlock = null, editing = null, historyGroup = null, historyTime = 0;
  const undo = [], redo = [];
  const contentSnapshot = () => JSON.stringify({title:doc.title,preamble:doc.preamble,blocks:doc.blocks});
  let lastSnapshot = contentSnapshot();
  function updateHistory() { $("undo").disabled=!undo.length; $("redo").disabled=!redo.length; }
  function resetHistory() { undo.length=0;redo.length=0;historyGroup=null;lastSnapshot=contentSnapshot();updateHistory(); }
  function restoreHistory(forward=false) {
    pads.forEach(p=>p.finish());
    const from=forward ? redo : undo, to=forward ? undo : redo;
    if(reading||!from.length)return;
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

  // The time of the last save sits left of the status and keeps itself current.
  function updateSaveTime() { const el=$("save-time"); if(el)el.textContent=timeAgo(doc.updated); }
  if(typeof setInterval==="function")setInterval(updateSaveTime,20000);
  function status(text, error=false) {
    updateSaveTime();
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
          const html=views[i] || '<p class="empty">Start writing…</p>', writing=editing===b.id;
          // Unchanged views keep their live players; a block being typed in shows
          // a plain link instead and gets its player back when editing ends.
          if(view._key===html+"|"+writing) return;
          view._key=html+"|"+writing;
          view.innerHTML=html;
          view.closest(".nb")?.classList.toggle("has-video",!!view.querySelector(".tex-youtube"));
          view.querySelectorAll("iframe,video,audio,object,embed,script").forEach(el=>el.remove());
          if(!writing) view.querySelectorAll(".tex-youtube[data-yt-id]").forEach(box=>{
            const id=box.dataset.ytId,start=Number(box.dataset.ytStart)||0;
            if(!/^[\w-]{11}$/.test(id)||!Number.isSafeInteger(start))return;
            // A thumbnail card instead of a live player: YouTube refuses to play embeds opened from
            // an app page (no valid referrer), so the card opens the video in the default browser.
            const watch="https://www.youtube.com/watch?v="+id+(start>0?"&t="+start:"");
            const poster=document.createElement("button");
            poster.type="button";poster.className="yt-poster";poster.setAttribute("aria-label","Play on YouTube");poster.title="Open on YouTube";
            const image=document.createElement("img");
            image.alt="";image.referrerPolicy="no-referrer";image.loading="lazy";
            // Best first (1280x720); older or low-resolution videos have no maxres file, so step down.
            const sizes=["maxresdefault","sddefault","hqdefault"];let step=0;
            const load=()=>{image.src="https://i.ytimg.com/vi/"+id+"/"+sizes[step]+".jpg";};
            // YouTube answers a missing maxres/sd file with a 120px grey stand-in rather than an error.
            image.addEventListener("load",()=>{if(image.naturalWidth<=120&&step<sizes.length-1){step++;load();}});
            image.addEventListener("error",()=>{if(step<sizes.length-1){step++;load();}else image.remove();});
            load();
            const play=document.createElement("span");play.className="yt-play";play.setAttribute("aria-hidden","true");
            poster.append(image,play);
            // The embed endpoints refuse to play here (error 153: no valid referrer), but the regular
            // watch page plays fine. Show only its player by cropping the page header and the rest.
            poster.addEventListener("click",()=>{
              // Created in this document: an element made in the main window loses its browser behaviour here.
              if(!document.createXULElement||!host.loadRemote){host.openURL?.(watch);return;}
              const player=document.createXULElement("browser");
              for(const [name,value] of Object.entries({type:"content",remote:"true",maychangeremoteness:"true",disablehistory:"true",disableglobalhistory:"true"}))player.setAttribute(name,value);
              player.classList.add("yt-player");player.setAttribute("aria-label","YouTube video player");
              const frame=document.createElement("div");frame.className="yt-frame";
              frame.append(player);poster.replaceWith(frame);
              host.loadRemote?.(player,"https://www.youtube.com/watch?app=desktop&v="+id+(start>0?"&t="+start+"s":""));
            });
            box.prepend(poster);
          });
          view.querySelectorAll("[data-tex-label]").forEach(el=>{el.id="note-label-"+el.dataset.texLabel;});
        }
      });
    } catch(error) {message("Preview: "+error.message,true);}
  }
  function insert(type, image=null, index=doc.blocks.length) {
    if(reading)return null;
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
  function edit(id, caret=null) {
    if(reading)return;
    const block=document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
    if(editing && editing!==id) document.querySelector(`[data-block-id="${CSS.escape(editing)}"]`)?.classList.remove("editing");
    editing=id;focusBlock=id;
    block?.classList.add("editing");
    const ta=block?.querySelector("textarea");
    if(!ta)return;
    // Focusing a textarea scrolls its caret (at the end of the text) into view, and the source
    // column is still opening, so a tall block would fling the page to its bottom. Keep the view
    // where the click happened while the layout settles.
    const scroller=document.scrollingElement,y=scroller.scrollTop;
    ta.focus({preventScroll:true});ta._grow?.();
    if(caret!==null)ta.setSelectionRange(caret,caret);
    const until=performance.now()+500;
    let moved=false;const mark=()=>{moved=true;};
    for(const type of ["wheel","touchmove","keydown"])window.addEventListener(type,mark,{once:true,passive:true});
    (function hold(){
      if(!moved&&Math.abs(scroller.scrollTop-y)>1)scroller.scrollTop=y;
      if(!moved&&performance.now()<until)requestAnimationFrame(hold);
    })();
  }
  function growTitle() {
    const t=$("title");
    if(!t.style)return;
    t.style.height="auto";
    if(t.scrollHeight)t.style.height=t.scrollHeight+"px";
  }
  let dragId=null,menuEl=null;
  function clearDrop() {document.querySelectorAll(".drop-before,.drop-after").forEach(n=>n.classList.remove("drop-before","drop-after"));}
  function closeMenu() {menuEl?.remove();menuEl=null;}
  function blockAction(id, action, after) {
    pads.forEach(p=>p.finish());
    const i=doc.blocks.findIndex(v=>v.id===id);
    if(i<0)return;
    const b=doc.blocks[i];
    if(action==="beside") b.beside=!b.beside;
    else if(action==="delete") doc.blocks.splice(i,1);
    else if(action==="duplicate") {const copy=clone(b);copy.id=uid();doc.blocks.splice(i+1,0,copy);}
    else {
      const j=action==="up" ? i-1 : i+1;
      if(j<0||j>=doc.blocks.length)return;
      [doc.blocks[i],doc.blocks[j]]=[doc.blocks[j],doc.blocks[i]];
    }
    editing=null;render();change();after?.();
  }
  function moveBlock(id, target, after) {
    pads.forEach(p=>p.finish());
    const from=doc.blocks.findIndex(v=>v.id===id), to=doc.blocks.findIndex(v=>v.id===target);
    if(from<0||to<0||id===target)return;
    const [b]=doc.blocks.splice(from,1);
    const at=doc.blocks.findIndex(v=>v.id===target)+(after?1:0);
    doc.blocks.splice(at,0,b);
    editing=null;render();change();
  }
  function blockMenu(id, x, y) {
    closeMenu();
    const i=doc.blocks.findIndex(v=>v.id===id);
    if(i<0)return;
    const b=doc.blocks[i];
    const items=[["Move up","up","arrow-up",i===0],["Move down","down","arrow-down",i===doc.blocks.length-1],["Duplicate","duplicate","copy"]];
    if(b.type==="text"&&doc.blocks[i-1]?.type==="ink")items.push([b.beside?"Show below drawing":"Show beside drawing","beside",b.beside?"rows-2":"columns-2"]);
    items.push(["Delete","delete","trash-2"]);
    const menu=document.createElement("div");menu.className="ctx-menu";menu.setAttribute("role","menu");
    for(const [label,action,icon,disabled] of items) {
      const button=document.createElement("button");button.type="button";button.setAttribute("role","menuitem");
      button.dataset.action=action;button.disabled=!!disabled;
      if(action==="delete")button.classList.add("danger");
      button.append(NoctuaIcons.create(icon,15),label);
      button.addEventListener("click",()=>{closeMenu();blockAction(id,action);});
      menu.append(button);
    }
    document.body.append(menu);menuEl=menu;
    const w=menu.offsetWidth||180,h=menu.offsetHeight||180;
    menu.style.left=Math.max(4,Math.min(x,window.innerWidth-w-4))+"px";
    menu.style.top=Math.max(4,Math.min(y,window.innerHeight-h-4))+"px";
    menu.querySelector("button:not(:disabled)")?.focus();
  }
  function render() {
    pads.forEach(p=>p.finish());
    pads.forEach(p=>p.destroy());pads.clear();
    $("title").value=doc.title;growTitle();
    $("preamble").value=doc.preamble;
    $("blocks").replaceChildren();
    function inserter(index) {
      const bar=document.createElement("div");bar.className="block-inserter";
      bar.setAttribute("role","group");bar.setAttribute("aria-label",`Insert at position ${index+1}`);
      const pill=document.createElement("div");pill.className="ins-pill";bar.append(pill);
      for(const [type,label,icon] of [["text","Text","type"],["ink","Drawing","pen-line"],["image","Image","image"]] ) {
        const button=document.createElement("button");button.type="button";
        button.append(NoctuaIcons.create(icon,13),label);button.setAttribute("aria-label",`Add ${label.toLowerCase()} here`);
        button.addEventListener("click",()=>{
          if(type==="image"){imageIndex=index;$("image-input").click();}
          else insert(type,null,index);
        });
        pill.append(button);
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
      const handle=document.createElement("button");handle.type="button";handle.className="nb-handle";
      handle.append(NoctuaIcons.create("grip-vertical",16));
      handle.title="Drag to move · Click or right-click for options";handle.setAttribute("aria-label","Block options");
      handle.addEventListener("pointerdown",()=>{el.draggable=true;});
      handle.addEventListener("pointerup",()=>{el.draggable=false;});
      handle.addEventListener("click",e=>{const r=handle.getBoundingClientRect();blockMenu(b.id,r.left,r.bottom+4);e.stopPropagation();});
      handle.addEventListener("contextmenu",e=>{e.preventDefault();try{blockMenu(b.id,e.clientX,e.clientY);}catch(error){report(error);}});
      handle.addEventListener("keydown",e=>{
        if(e.altKey&&(e.key==="ArrowUp"||e.key==="ArrowDown")){e.preventDefault();blockAction(b.id,e.key==="ArrowUp"?"up":"down",()=>document.querySelector(`[data-block-id="${CSS.escape(b.id)}"] .nb-handle`)?.focus());}
      });
      el.addEventListener("dragstart",e=>{dragId=b.id;el.classList.add("dragging");e.dataTransfer?.setData("text/plain","noctua-block");if(e.dataTransfer)e.dataTransfer.effectAllowed="move";});
      el.addEventListener("dragend",()=>{dragId=null;el.draggable=false;clearDrop();el.classList.remove("dragging");});
      el.append(handle);
      if(b.type==="text") {
        const wrap=document.createElement("div");wrap.className="text-layout";
        const textarea=document.createElement("textarea");textarea.value=b.src;textarea.spellcheck=false;
        textarea.setAttribute("aria-label","LaTeX block source");
        textarea.placeholder="Write text, $inline math$, or \\section{A heading}";
        const grow=()=>{if(!textarea.clientWidth)return;textarea.style.height="auto";textarea.style.height=Math.max(96,textarea.scrollHeight+2)+"px";};
        textarea.addEventListener("input",()=>{b.src=textarea.value;grow();renderPreviews();change("text:"+b.id);});
        textarea._grow=grow;
        // The source column animates open, so the first measurement can happen at a sliver of its
        // final width and overshoot the height. Re-measure whenever its real width changes.
        if(typeof ResizeObserver==="function") {
          let lastWidth=0;
          new ResizeObserver(()=>{const w=textarea.clientWidth;if(w&&w!==lastWidth){lastWidth=w;grow();}}).observe(textarea);
        }
        const suggest=typeof NoctuaCiteSuggest!=="undefined" ? NoctuaCiteSuggest.attach(textarea,{references:host.references,report}) : null;
        textarea.addEventListener("beforeinput",e=>texBeforeInput(e,textarea));
        textarea.addEventListener("keydown",e=>{
          if(suggest?.handleKey(e))return;
          if(texKeys(e,textarea))return;
          if(e.key==="Escape" || (e.key==="Enter"&&(e.metaKey||e.ctrlKey))) {
            e.preventDefault();editing=null;el.classList.remove("editing");view.focus();
          }
        });
        textarea.addEventListener("blur",()=>{el.classList.remove("editing");if(editing===b.id){editing=null;renderPreviews();}});
        const view=document.createElement("div");view.className="nb-view tex-view";view.tabIndex=0;
        view.setAttribute("aria-label","Rendered text block; activate to edit source");
        view.addEventListener("click",e=>{
          // Links and the video card do their own thing; they must not drop the block into editing.
          if(e.target.closest("a,.yt-poster,.yt-frame") || !window.getSelection().isCollapsed)return;
          // Put the source caret where the click landed in the rendered text.
          let caret=null;
          try {
            const hit=document.caretPositionFromPoint?.(e.clientX,e.clientY);
            if(hit && view.contains(hit.offsetNode)) {
              let offset=0;
              const walker=document.createTreeWalker(view,NodeFilter.SHOW_TEXT);
              for(let node=walker.nextNode();node&&node!==hit.offsetNode;node=walker.nextNode())offset+=node.nodeValue.length;
              offset+=hit.offsetNode.nodeType===Node.TEXT_NODE?hit.offset:0;
              caret=mapCaret(view.textContent,offset,b.src);
            }
          } catch(_) {caret=null;}
          edit(b.id,caret);
        });
        view.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();edit(b.id);}});
        wrap.append(textarea,view);el.append(wrap);
      } else if(b.type==="image") {
        const image=document.createElement("img");image.src=b.data;image.alt=b.caption || "Note image";
        const caption=document.createElement("input");caption.value=b.caption;caption.placeholder="Image caption";caption.readOnly=reading;
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
  let imageIndex=null;
  async function addImages(files,index=doc.blocks.length) {
    for(const file of files) {
      if(!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, GIF or SVG image.");
      if(file.size>8*1024*1024) throw new Error("Each image must be 8 MB or smaller in this prototype.");
      const data=await new Promise((resolve,reject)=>{
        const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file);
      });
      insert("image",data,index++);
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
  if(host.split?.openParent && session.parentID) {
    const link=$("parent-title");
    link.classList.add("parent-link");link.tabIndex=0;link.setAttribute("role","link");
    link.title="Show this paper's PDF in the split view";
    const go=()=>Promise.resolve(host.split.openParent()).catch(report);
    link.addEventListener("click",go);
    link.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();go();}});
  }
  $("blocks").addEventListener("dragover",e=>{
    if(!dragId)return;
    const target=e.target.closest?.(".nb");
    if(!target||target.dataset.blockId===dragId)return;
    e.preventDefault();clearDrop();
    const r=target.getBoundingClientRect();
    target.classList.add(e.clientY>r.top+r.height/2?"drop-after":"drop-before");
  });
  $("blocks").addEventListener("drop",e=>{
    if(!dragId)return;
    const target=e.target.closest?.(".nb");
    if(!target)return;
    e.preventDefault();e.stopPropagation();
    const r=target.getBoundingClientRect(),id=dragId;
    dragId=null;clearDrop();
    moveBlock(id,target.dataset.blockId,e.clientY>r.top+r.height/2);
  },true);
  document.addEventListener("pointerdown",e=>{if(menuEl&&!e.target.closest?.(".ctx-menu"))closeMenu();});
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&menuEl)closeMenu();});
  window.addEventListener("blur",closeMenu);
  $("notes-stage").addEventListener("click",e=>{
    const citation=e.target.closest("[data-noctua-cite]");
    if(citation) {
      e.preventDefault();e.stopPropagation();
      const key=citation.dataset.noctuaCite;
      // A cited paper with a PDF opens in the split view; otherwise show its entry in the reference list.
      Promise.resolve(host.openCitation?.(key)).then(opened=>{
        if(opened)return;
        const entry=[...$("references").querySelectorAll("[data-ref-key]")].find(el=>el.dataset.refKey===key);
        if(!entry)return;
        entry.scrollIntoView({block:"center",behavior:"smooth"});
        entry.classList.remove("tex-flash");void entry.offsetWidth;entry.classList.add("tex-flash");setTimeout(()=>entry.classList.remove("tex-flash"),1600);
      }).catch(report);
      return;
    }
    const anchor=e.target.closest("a[href]");
    if(!anchor)return;
    e.preventDefault();e.stopPropagation();
    const href=anchor.getAttribute("href");
    if(anchor.dataset.texRef) {
      const target=[...$("blocks").querySelectorAll("[data-tex-label]")].find(el=>el.dataset.texLabel===anchor.dataset.texRef);
      if(target) {
        target.scrollIntoView({block:"center",behavior:"smooth"});
        // Flash what was referenced (equation, heading, theorem, table…) so it is easy to spot.
        const mark=target.closest(".tex-display,.tex-h,.tex-thm,.tex-figure,.tex-table-wrap,li,p")||target.parentElement;
        if(mark) {mark.classList.remove("tex-flash");void mark.offsetWidth;mark.classList.add("tex-flash");setTimeout(()=>mark.classList.remove("tex-flash"),1600);}
      }
    } else if(href.startsWith("#")) document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
    else host.openURL?.(href);
  },true);
  $("title").addEventListener("input",()=>{const t=$("title");if(/[\r\n]/.test(t.value))t.value=t.value.replace(/\s*[\r\n]+\s*/g," ");growTitle();doc.title=t.value;document.title="Noctua Notes — "+doc.title;host.onTitle?.(doc.title);change("title");});
  window.addEventListener("resize",growTitle);
  $("title").addEventListener("keydown",e=>{
    if(e.key!=="Enter"||e.isComposing)return;
    e.preventDefault();
    const first=doc.blocks.find(v=>v.type==="text");
    if(first)edit(first.id);else insert("text",null,0);
  });
  $("preamble").addEventListener("input",()=>{doc.preamble=$("preamble").value;renderPreviews();change("preamble");});
  $("preamble").addEventListener("beforeinput",e=>texBeforeInput(e,$("preamble")));
  $("preamble").addEventListener("keydown",e=>{if(texKeys(e,$("preamble")))return;if(e.key==="Escape")$("preamble-panel").open=false;});
  $("undo").addEventListener("click",()=>restoreHistory());
  $("redo").addEventListener("click",()=>restoreHistory(true));
  $("help").addEventListener("click",()=>$("note-help").showModal());
  $("close-help").addEventListener("click",()=>$("note-help").close());
  $("image-input").addEventListener("change",()=>{
    const at=imageIndex ?? doc.blocks.length;imageIndex=null;
    addImages([...$("image-input").files],at).catch(report);$("image-input").value="";
  });
  $("reload").addEventListener("click",()=>reload().catch(report));
  const menu=$("more-menu"), more=$("more");
  function setMenu(open) {menu.hidden=!open;more.setAttribute("aria-expanded",String(open));}
  more.addEventListener("click",e=>{e.stopPropagation();setMenu(menu.hidden);if(!menu.hidden&&e.detail===0)menu.querySelector("button:not(:disabled)")?.focus();});
  menu.addEventListener("click",()=>setMenu(false));
  document.addEventListener("click",e=>{if(!menu.hidden&&!e.target.closest(".menu-wrap"))setMenu(false);});
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!menu.hidden){setMenu(false);more.focus();}});
  $("toggle-preamble").addEventListener("click",()=>{
    const panel=$("preamble-panel"),show=panel.hidden;panel.hidden=!show;panel.open=show;
    if(show)$("preamble").focus();
  });
  if(doc.preamble.trim()){$("preamble-panel").hidden=false;$("preamble-panel").open=true;}
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
    if(key==="\\"&&!e.shiftKey&&!e.altKey&&!splitButton.hidden){e.preventDefault();splitButton.click();}
    if(key==="e"&&!e.shiftKey&&!e.altKey){e.preventDefault();setReading(!reading);}
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
  function applyProposal(proposal, stamp) {
    if(reading){message("Switch to editing mode to apply the assistant's proposal.");return false;}
    if(stamp!==contentSnapshot() && !window.confirm("The note changed while the assistant was working. Apply its proposal anyway? Undo restores your current version."))return false;
    pads.forEach(p=>p.finish());
    doc.title=proposal.title;doc.preamble=proposal.preamble;doc.blocks=clone(proposal.blocks);
    editing=null;render();change();
    document.title="Noctua Notes — "+doc.title;host.onTitle?.(doc.title);
    if(doc.preamble.trim()){$("preamble-panel").hidden=false;$("preamble-panel").open=true;}
    return true;
  }
  // Reading mode: the note can be scrolled, selected and cited from, but nothing can be changed by accident.
  const modeButton=$("mode-toggle");
  function setReading(on,persist=true) {
    pads.forEach(p=>p.finish());
    reading=!!on;editing=null;
    document.body.classList.toggle("reading",reading);
    $("title").readOnly=reading;$("preamble").readOnly=reading;
    modeButton.setAttribute("aria-pressed",String(reading));
    modeButton.title=reading?"Reading mode is on. Click to edit (⌘E)":"Switch to reading mode (⌘E)";
    // Update in place: rebuilding every block would reset the scroll position and make the page jump.
    const scroller=document.scrollingElement,y=scroller.scrollTop;
    document.querySelectorAll(".nb.editing").forEach(el=>el.classList.remove("editing"));
    document.querySelectorAll(".nb-image input").forEach(input=>{input.readOnly=reading;});
    if(reading)document.activeElement?.blur?.();
    renderPreviews();
    scroller.scrollTop=y;
    if(persist)store.set("editor.reading",reading?"1":"0");
  }
  modeButton.addEventListener("click",()=>setReading(!reading));
  const splitButton=$("split-toggle");
  if(host.split && splitButton) {
    splitButton.hidden=false;
    const mark=open=>{splitButton.setAttribute("aria-pressed",String(!!open));splitButton.title=open?"Close split view (⌘\\)":"Split view: read a paper beside this note (⌘\\)";};
    host.split.onChange=mark;
    splitButton.addEventListener("click",()=>{Promise.resolve(host.split.toggle()).then(mark).catch(report);});
  }
  NoctuaChat.mount({host,document,window,store,report,apply:applyProposal,
    snapshot:()=>{pads.forEach(p=>p.finish());return {doc:clone(doc),stamp:contentSnapshot()};}});
  render();
  // A brand-new note opens for writing whatever mode was last used; saved notes open in the remembered mode.
  if(session.item&&store.get("editor.reading")==="1")setReading(true,false);
  updateHistory();document.title="Noctua Notes — "+doc.title;
  status(session.item ? "Saved" : "New note");
  if(!session.item && !host.draft && doc.blocks.length===1 && doc.blocks[0].type==="text" && !doc.blocks[0].src) {
    $("title").focus();
  }
  // A narrow, explicit surface for the isolated Zotero integration tests.
  window.NoctuaNotesEditor={getDocument:()=>clone(doc),save,reload,exportSource,takeCloseSnapshot};
};
