"use strict";

// Zotero owns preference-control binding, persistence, and pane lifecycle.
var NoctuaNotesSettings = {
  THEME_PREF: "extensions.noctua-notes.theme",
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
    let paneID;
    try {
      paneID = await Zotero.PreferencePanes.register({
        pluginID,
        id: this.PANE_ID,
        label: "Noctua Notes",
        image: "chrome://noctuanotes/content/icons/noctua-notes.svg",
        src: rootURI + "content/preferences.xhtml"
      });
    } catch (error) {
      active = false;
      Zotero.Prefs.unregisterObserver(observer);
      throw error;
    }
    const appearance = {
      getTheme,
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
        Zotero.PreferencePanes.unregister(paneID);
      }
    };
  }
};
if (typeof module !== "undefined") module.exports = NoctuaNotesSettings;
