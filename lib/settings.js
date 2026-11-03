"use strict";

// Zotero owns preference-control binding, persistence, and pane lifecycle.
var NoctuaNotesSettings = {
  THEME_PREF: "extensions.noctua-notes.theme",
  PREVIEW_PREF: "extensions.noctua-notes.previewPosition",
  WIDTH_PREF: "extensions.noctua-notes.contentWidth",
  // Pen 0 is Ink: empty means "adapt to the theme"; a chosen colour is used as it is. Pens 1-4 are the accents.
  INK_PREFS: [0, 1, 2, 3, 4].map(n => "extensions.noctua-notes.ink.color" + n),
  INK_DEFAULTS: ["", "#3e63dd", "#e5484d", "#30a46c", "#f76b15"],
  PANE_ID: "noctua-notes-preferences",

  async create({Zotero, pluginID, rootURI}) {
    const key = this.THEME_PREF;
    const listeners = new Set();
    let active = true;
    const normalize = value => ["light", "dark", "system"].includes(value) ? value : "light";
    const getTheme = () => normalize(Zotero.Prefs.get(key, true));
    let lastTheme = getTheme();
    const observer = Zotero.Prefs.registerObserver(key, () => {
      if (!active) return;
      const theme = getTheme();
      if (theme === lastTheme) return;
      lastTheme = theme;
      // A failing or already closed editor must not block other tabs.
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try { listener(theme); }
        catch (error) { Zotero.logError(error); }
      }
    }, true);
    const previewKey = this.PREVIEW_PREF;
    const getPreviewPosition = () => Zotero.Prefs.get(previewKey, true) === "below" ? "below" : "right";
    // Listeners re-read every appearance value, so they only need a nudge.
    const widthKey = this.WIDTH_PREF;
    // Share of the window the note column may use, 50-100 in steps of 5.
    const getContentWidth = () => {
      const value = Number(Zotero.Prefs.get(widthKey, true));
      return Number.isFinite(value) ? Math.min(100, Math.max(50, Math.round(value / 5) * 5)) : 60;
    };
    const inkKeys = this.INK_PREFS, inkDefaults = this.INK_DEFAULTS;
    const getInkColors = () => inkKeys.map((key, index) => {
      const value = Zotero.Prefs.get(key, true);
      return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : inkDefaults[index];
    });
    const nudge = () => {
      if (!active) return;
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try { listener(getTheme()); }
        catch (error) { Zotero.logError(error); }
      }
    };
    const previewObserver = Zotero.Prefs.registerObserver(previewKey, nudge, true);
    const inkObservers = inkKeys.map(key => Zotero.Prefs.registerObserver(key, nudge, true));
    inkObservers.push(Zotero.Prefs.registerObserver(widthKey, nudge, true));
    let paneID;
    try {
      paneID = await Zotero.PreferencePanes.register({
        pluginID,
        id: this.PANE_ID,
        label: "Noctua Notes",
        image: "chrome://noctuanotes/content/icons/noctua-notes.svg",
        src: rootURI + "content/preferences.xhtml",
        scripts: [rootURI + "content/preferences.js"]
      });
    } catch (error) {
      active = false;
      Zotero.Prefs.unregisterObserver(observer);
      Zotero.Prefs.unregisterObserver(previewObserver);
      inkObservers.forEach(token => Zotero.Prefs.unregisterObserver(token));
      throw error;
    }
    const appearance = {
      getTheme,
      getPreviewPosition,
      getInkColors,
      getContentWidth,
      setTheme(value) {
        if (!["light", "dark", "system"].includes(value)) {
          throw new TypeError("Theme must be light, dark, or system");
        }
        if (active) Zotero.Prefs.set(key, value, true);
      },
      // Call getTheme() for the initial value, then subscribe to changes.
      subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("Expected a theme listener");
        if (active) listeners.add(listener);
        return () => listeners.delete(listener);
      },
      openPreferences() {
        if (active) return Zotero.Utilities.Internal.openPreferences(paneID);
      }
    };
    return {
      appearance,
      destroy() {
        if (!active) return;
        active = false;
        listeners.clear();
        Zotero.Prefs.unregisterObserver(observer);
        Zotero.Prefs.unregisterObserver(previewObserver);
        inkObservers.forEach(token => Zotero.Prefs.unregisterObserver(token));
        Zotero.PreferencePanes.unregister(paneID);
      }
    };
  }
};
if (typeof module !== "undefined") module.exports = NoctuaNotesSettings;
