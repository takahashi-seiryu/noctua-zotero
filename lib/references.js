"use strict";

// Library metadata stays in memory: sources store citation keys, not a snapshot
// of the user's bibliography. Exact Zotero item keys take priority over aliases.
var NoctuaNotesReferences = (() => {
  const esc = value => String(value ?? "").replace(/[&<>"']/g,
    c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
  function citationKeys(extra) {
    return String(extra || "").split(/\r?\n/)
      .map(line => /^\s*citation\s*key\s*:\s*(\S.*?)\s*$/i.exec(line)?.[1])
      .filter(Boolean);
  }
  function index(items) {
    const lookup = new Map(), normalized = [];
    for (const input of items || []) {
      if (!input || typeof input.key !== "string" || !input.key) continue;
      const fullNames = (Array.isArray(input.creators) ? input.creators : []).map(creator =>
        typeof creator === "string" ? creator.trim()
          : String(creator?.name || [creator?.firstName, creator?.lastName].filter(Boolean).join(" ")).trim()).filter(Boolean);
      const item = {key:input.key, title:String(input.title || ""), fullNames,
        creators:(Array.isArray(input.creators) ? input.creators : []).map(creator =>
          typeof creator === "string" ? creator.trim() : String(creator?.lastName || creator?.name || "").trim()).filter(Boolean),
        year:input.year === undefined || input.year === null || input.year === "" ? "n.d." : String(input.year),
        citeKeys:[...(Array.isArray(input.citeKeys) ? input.citeKeys : []), ...citationKeys(input.extra)]};
      if (!lookup.has(item.key)) {lookup.set(item.key,item);normalized.push(item);}
    }
    for (const item of normalized) for (const alias of item.citeKeys) {
      if (typeof alias === "string" && alias && !lookup.has(alias)) lookup.set(alias,item);
    }
    const resolve = key => lookup.get(key) || null;
    // Autocomplete: every word must match the title, an author, the year, the item key or a citation key.
    // Matches near the start of a field rank higher; ties show newer papers first.
    function search(query, limit = 8) {
      const words = String(query || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
      const scored = [];
      for (const item of normalized) {
        const fields = [
          [item.citeKeys.map(k => k.toLowerCase()), 5], [[item.key.toLowerCase()], 4],
          [item.fullNames.flatMap(name => name.toLowerCase().split(/\s+/)), 4], [[item.year.toLowerCase()], 3],
          [item.title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean), 2]
        ];
        const haystack = [item.title, item.fullNames.join(" "), item.year, item.key, item.citeKeys.join(" ")].join(" ").toLowerCase();
        let score = 0, ok = true;
        for (const word of words) {
          let best = 0;
          for (const [parts, weight] of fields) {
            if (parts.some(part => part === word)) best = Math.max(best, weight + 2);
            else if (parts.some(part => part.startsWith(word))) best = Math.max(best, weight + 1);
          }
          if (!best && haystack.includes(word)) best = 1;
          if (!best) { ok = false; break; }
          score += best;
        }
        if (ok) scored.push({item, score});
      }
      scored.sort((a, b) => b.score - a.score || (Number(b.item.year) || 0) - (Number(a.item.year) || 0) || a.item.title.localeCompare(b.item.title));
      return scored.slice(0, limit).map(entry => entry.item);
    }
    const last = name => name.trim().split(/\s+/).pop();
    const link = (item, text) => `<a class="cite" data-noctua-cite="${esc(item.key)}" href="zotero://select/library/items/${encodeURIComponent(item.key)}" title="${esc(item.title)}">${text}</a>`;
    const missing = key => `<span class="tex-missing" title="No item with this citation key in My Library">${esc(key)}?</span>`;
    function renderCitation(keys, opts = {}) {
      const tail = opts.note ? `, ${esc(opts.note)}` : "";
      const parts = keys.map(key => {
        const item=resolve(key);
        if (!item) return missing(key);
        const names=item.creators;
        const first=names.length ? last(names[0]) : item.title || "?";
        const who=names.length>2 ? `${first} et al.` : names.length===2 ? `${first} and ${last(names[1])}` : first;
        return link(item,opts.textual ? `${esc(who)} (${esc(item.year)}${tail})` : `${esc(who)} ${esc(item.year)}`);
      });
      return opts.textual ? parts.join("; ") : `(${parts.join("; ")}${tail})`;
    }
    function references(keys) {
      const seen=new Set(), entries=[];
      for (const key of keys) {
        const item=resolve(key), identity=item?.key || key;
        if(seen.has(identity))continue;
        seen.add(identity);
        if(!item) {
          entries.push({sort:String(key).toLowerCase(),html:`<li class="tex-missing" data-ref-key="${esc(key)}">${esc(key)} <span>(not in My Library)</span></li>`});
          continue;
        }
        const names=item.creators;
        const authors=!names.length ? "Unknown authors" : names.length>3 ? `${names.slice(0,3).join(", ")}, et al.`
          : names.length>1 ? `${names.slice(0,-1).join(", ")} and ${names.at(-1)}` : names[0];
        entries.push({sort:`${(names.length ? last(names[0]) : item.title || key).toLowerCase()} ${item.year}`,
          html:`<li data-ref-key="${esc(item.key)}">${link(item,`${esc(authors)} (${esc(item.year)}). ${esc(item.title || "(untitled)")}.`)}</li>`});
      }
      if(!entries.length)return "";
      entries.sort((a,b)=>a.sort.localeCompare(b.sort));
      return `<section class="note-references" aria-label="References"><h2>References</h2><ol>${entries.map(entry=>entry.html).join("")}</ol></section>`;
    }
    return {resolve,renderCitation,references,search};
  }
  return {index,citationKeys};
})();
if (typeof module !== "undefined") module.exports = NoctuaNotesReferences;
