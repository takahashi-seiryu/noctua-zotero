"use strict";
// The assistant for reading a paper. It lives in Zotero's right-hand pane (next to the PDF reader), so it
// is a slim page of its own that reuses the note editor's chat panel. The host supplies the paper.
window.startPaperChat = function (host) {
  store.attach?.(host?.ui);
  NoctuaIcons.hydrate();
  const root = document.documentElement;
  const applyTheme = () => {
    let mode = "light";
    try { mode = host?.appearance?.getTheme?.() || "light"; } catch (_) {}
    root.dataset.theme = mode === "system" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
  };
  applyTheme();
  try { host?.appearance?.subscribe?.(applyTheme); } catch (_) {}
  const report = error => { try { host?.onError?.(error); } catch (_) {} };
  return NoctuaChat.mount({
    host, document, window, store, report, embedded: true,
    // There is no note to propose edits to: the assistant only reads the paper.
    snapshot: () => ({doc: {id: host.session.id}, stamp: ""}),
    apply: () => false
  });
};
