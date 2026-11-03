"use strict";
// Citation autocomplete for \cite{…} in text blocks: a list under the caret that filters the
// user's Zotero library by title, author, year, item key or citation key as they type.
var NoctuaCiteSuggest = (() => {
  const OPEN = /\\cite[a-zA-Z]*\*?(?:\[[^\]\n]*\]){0,2}\{([^{}\n]*)$/;

  // Finds the key fragment the caret is in, or null outside a \cite{…} argument.
  // `start`/`end` delimit the text a chosen item replaces (the fragment, up to the next , or }).
  function context(value, caret) {
    const before = value.slice(0, caret), match = OPEN.exec(before);
    if (!match) return null;
    const group = match[1], comma = group.lastIndexOf(",");
    const lead = group.slice(comma + 1).match(/^\s*/)[0].length;
    const start = caret - group.length + comma + 1 + lead;
    let end = caret;
    while (end < value.length && !/[,}\n]/.test(value[end])) end++;
    return {start, end, query: value.slice(start, caret)};
  }

  // Pixel position of a caret inside a textarea, measured with a hidden mirror element.
  function caretPoint(ta, position) {
    const doc = ta.ownerDocument, style = doc.defaultView.getComputedStyle(ta), mirror = doc.createElement("div");
    for (const name of ["boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "wordSpacing",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "tabSize"]) mirror.style[name] = style[name];
    mirror.style.cssText += ";position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;top:0;left:-9999px;";
    mirror.textContent = ta.value.slice(0, position);
    const marker = doc.createElement("span");
    marker.textContent = "​";
    mirror.append(marker);
    doc.body.append(mirror);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    const point = {left: marker.offsetLeft, top: marker.offsetTop, height: lineHeight};
    mirror.remove();
    const box = ta.getBoundingClientRect();
    return {x: box.left + point.left - ta.scrollLeft, y: box.top + point.top - ta.scrollTop, height: point.height};
  }

  const label = item => {
    const names = item.creators || [];
    const who = names.length > 2 ? `${names[0]} et al.` : names.join(" & ");
    return [who, item.year].filter(Boolean).join(", ");
  };
  const keyFor = item => item.citeKeys?.[0] || item.key;

  function attach(ta, {references, report = () => {}}) {
    const doc = ta.ownerDocument, win = doc.defaultView;
    let box = null, items = [], active = 0, range = null;

    function close() { box?.remove(); box = null; items = []; range = null; }
    function render() {
      box.replaceChildren();
      items.forEach((item, index) => {
        const row = doc.createElement("div");
        row.className = "cite-row"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(index === active));
        const title = doc.createElement("div"); title.className = "cite-title"; title.textContent = item.title || "(untitled)";
        const meta = doc.createElement("div"); meta.className = "cite-meta";
        const key = doc.createElement("span"); key.className = "cite-key"; key.textContent = keyFor(item);
        meta.append(label(item) + "  ·  ", key);
        row.append(title, meta);
        row.addEventListener("mousedown", event => { event.preventDefault(); pick(index); });
        row.addEventListener("mousemove", () => { if (active !== index) { active = index; mark(false); } });
        box.append(row);
      });
    }
    // `reveal` scrolls the list to the chosen row; only the keyboard needs that, hovering must not move it.
    function mark(reveal = true) {
      [...box.children].forEach((row, index) => row.setAttribute("aria-selected", String(index === active)));
      if (reveal) box.children[active]?.scrollIntoView({block: "nearest"});
    }
    function place() {
      const point = caretPoint(ta, ta.selectionStart);
      const width = Math.min(480, win.innerWidth - 24);
      box.style.width = width + "px";
      box.style.left = Math.max(12, Math.min(point.x, win.innerWidth - width - 12)) + "px";
      const room = win.innerHeight - (point.y + point.height);
      if (room < 260 && point.y > room) { box.style.top = ""; box.style.bottom = (win.innerHeight - point.y + 4) + "px"; }
      else { box.style.bottom = ""; box.style.top = (point.y + point.height + 4) + "px"; }
    }
    function update() {
      if (ta.selectionStart !== ta.selectionEnd) return close();
      const found = context(ta.value, ta.selectionStart);
      if (!found || !references?.search) return close();
      const results = references.search(found.query, 8);
      if (!results.length) return close();
      range = found; items = results; active = Math.min(active, results.length - 1);
      if (!box) {
        box = doc.createElement("div");
        box.className = "cite-suggest"; box.setAttribute("role", "listbox"); box.setAttribute("aria-label", "Citations in your library");
        doc.body.append(box);
      }
      active = 0;
      render(); place();
    }
    function pick(index) {
      const item = items[index];
      if (!item || !range) return;
      const key = keyFor(item), {start, end} = range;
      const closing = ta.value[end] === "}";
      const text = closing ? key : key + "}";
      const caret = start + key.length + 1;  // just past the closing brace
      close();
      ta.focus();
      if (typeof texEdit === "function") texEdit(ta, start, end, text, caret);
      else { ta.setRangeText(text, start, end, "end"); ta.dispatchEvent(new win.Event("input")); }
    }

    ta.addEventListener("input", update);
    ta.addEventListener("click", update);
    ta.addEventListener("keyup", event => { if (/^(Arrow(Left|Right)|Home|End)$/.test(event.key)) update(); });
    ta.addEventListener("blur", () => setTimeout(close, 120));
    // Scrolling the list itself (arrow keys, wheel) must not dismiss it; scrolling the page moves it with the caret.
    win.addEventListener("scroll", event => {
      if (!box || box.contains(event.target)) return;
      const point = caretPoint(ta, ta.selectionStart);
      if (point.y + point.height < 0 || point.y > win.innerHeight) close(); else place();
    }, true);
    // Runs before the editor's own key handling; returns true when the key was consumed.
    return {
      handleKey(event) {
        if (!box || event.isComposing || event.keyCode === 229) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          active = (active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; mark(); return true;
        }
        if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(active); return true; }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return true; }
        return false;
      },
      close
    };
  }
  return {context, caretPoint, attach, keyFor, label};
})();
if (typeof module !== "undefined") module.exports = NoctuaCiteSuggest;
