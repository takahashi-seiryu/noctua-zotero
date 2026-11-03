"use strict";

// The reading assistant gets its own button and view in the PDF reader's side bar, below Zotero's own
// "Notes" button and separated from it by a divider, exactly like the Notes view: pressing the button swaps
// the whole side pane for the chat, pressing it again (or any other button) swaps back.
//
// Zotero's plugin API only places custom sections in the first group of buttons, so this adds its own
// elements to Zotero's reader side bar. It touches nothing it cannot put back, and if the expected
// elements are missing (a different Zotero layout) it does nothing, leaving the regular item-pane
// section in place.
var NoctuaReaderChat = {
  install({window, Zotero, host, icon, darkIcon, title}) {
    const doc = window.document, HTML = "http://www.w3.org/1999/xhtml";
    const sidenav = doc.getElementById("zotero-context-pane-sidenav");
    const deck = doc.getElementById("zotero-context-pane-deck");
    const locate = sidenav?.querySelector('.btn[data-action="locate"]')?.parentElement;
    const itemDeck = doc.getElementById("zotero-context-pane-item-deck");
    if (!sidenav || !deck || !locate || !itemDeck || typeof doc.createXULElement !== "function") return null;

    // ---- button (after the Notes group, before Locate)
    const wrapper = doc.createElementNS(HTML, "div");
    wrapper.className = "pin-wrapper noctua-chat-wrapper";
    const button = doc.createElementNS(HTML, "div");
    button.className = "btn";
    button.setAttribute("custom", "true");
    button.setAttribute("tabindex", "0");
    button.setAttribute("role", "tab");
    button.setAttribute("aria-label", title);
    button.title = title;
    button.style = `--custom-sidenav-icon-light: url('${icon}'); --custom-sidenav-icon-dark: url('${darkIcon || icon}');`;
    wrapper.append(button);
    const divider = doc.createElementNS(HTML, "div");
    divider.className = "divider noctua-chat-divider";
    locate.before(wrapper, divider);

    // ---- view: one more panel in the deck that already holds the item pane and the notes pane
    const view = doc.createXULElement("vbox");
    view.id = "noctua-chat-view";
    view.setAttribute("flex", "1");
    deck.append(view);

    const frames = new Map();  // tab id -> {frame, key}
    const readerOf = tabID => { try { return Zotero.Reader.getByTabID(tabID); } catch (_) { return null; } };
    const paperOf = tabID => {
      const reader = readerOf(tabID);
      const item = reader ? Zotero.Items.get(reader.itemID) : null;
      return item && !item.deleted && item.isPDFAttachment() ? item : null;
    };
    const paperKey = item => (item.parentID ? Zotero.Items.get(item.parentID)?.key : null) || item.key;
    const active = () => deck.selectedPanel === view;
    const selectedTab = () => window.Zotero_Tabs?.selectedID;

    function frameFor(tabID) {
      const item = paperOf(tabID);
      if (!item) return null;
      const known = frames.get(tabID);
      if (known && known.key === paperKey(item) && known.frame.isConnected) return known.frame;
      known?.frame.remove();
      const frame = doc.createElementNS(HTML, "iframe");
      frame.setAttribute("title", "Noctua paper assistant");
      frame.style.cssText = "flex:1;min-height:0;width:100%;border:0;display:block";
      frame.src = "chrome://noctuanotes/content/paper-chat.html";
      view.append(frame);
      frames.set(tabID, {frame, key: paperKey(item)});
      const started = Date.now();
      (function start() {
        const win = frame.contentWindow?.wrappedJSObject || frame.contentWindow;
        if (win?.startPaperChat) { try { win.startPaperChat(host(item, window)); } catch (error) { Zotero.logError(error); } return; }
        if (frame.isConnected && Date.now() - started < 15000) window.setTimeout(start, 50);
      })();
      return frame;
    }

    // Safety net: Zotero's own sidebar code also reacts to changes, so if two parties ever ping-pong,
    // stop watching instead of spinning the UI thread.
    let calls = 0, windowStart = Date.now(), tripped = false;
    function sync(reason = "sync") {
      if (tripped) return;
      if (Date.now() - windowStart > 1000) { calls = 0; windowStart = Date.now(); }
      if (++calls > 60) {
        tripped = true;
        try { deckWatch.disconnect(); } catch (_) {}
        Zotero.debug("Noctua reader chat: watching stopped after a change loop (last: " + reason + ")");
        return;
      }
      const tabID = selectedTab(), item = tabID ? paperOf(tabID) : null;
      wrapper.hidden = divider.hidden = !item;
      const on = active();
      wrapper.classList.toggle("highlight", on);
      if (on !== (wrapper.dataset.on === "1")) { wrapper.dataset.on = on ? "1" : "0"; }
      button.setAttribute("aria-selected", String(on));
      // While our view is up, Zotero's own "item panes" group must not look selected as well.
      if (on) sidenav.querySelector(".highlight-notes-inactive")?.classList.remove("highlight");
      for (const [id, entry] of frames) entry.frame.hidden = id !== tabID;
      if (on && item) frameFor(tabID);
      if (on && !item) deck.selectedPanel = itemDeck;
    }

    function show() {
      const tabID = selectedTab();
      if (!tabID || !paperOf(tabID)) return;
      try { if (window.ZoteroContextPane?.collapsed) window.ZoteroContextPane.collapsed = false; } catch (_) {}
      frameFor(tabID);
      deck.selectedPanel = view;
      sync();
    }
    function hide() {
      deck.selectedPanel = itemDeck;
      sync();
      try { sidenav.render?.(); } catch (_) {}
    }
    const toggle = () => (active() ? hide() : show());
    button.addEventListener("click", toggle);
    button.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } });

    // Keep the highlight right when Zotero switches the deck itself (another button, another tab).
    const deckWatch = new window.MutationObserver(() => sync("deck"));
    deckWatch.observe(deck, {attributes: true, attributeFilter: ["selectedIndex"]});

    const notifierID = Zotero.Notifier.registerObserver({
      notify(event, type, ids) {
        if (type !== "tab") return;
        if (event === "close") for (const id of ids.flat()) { frames.get(id)?.frame.remove(); frames.delete(id); }
        window.setTimeout(() => sync("tab " + event), 0);
      }
    }, ["tab"], "noctua-reader-chat-view");
    sync("install");

    return {
      get active() { return active(); },
      show, hide, button, view, wrapper,
      destroy() {
        Zotero.Notifier.unregisterObserver(notifierID);
        deckWatch.disconnect();
        if (active()) deck.selectedPanel = itemDeck;
        wrapper.remove(); divider.remove(); view.remove();
        frames.clear();
      }
    };
  }
};
if (typeof module !== "undefined") module.exports = NoctuaReaderChat;
