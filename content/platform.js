"use strict";
// The original Noctua ink module uses this tiny settings adapter.
var store = {
  // chrome:// pages have no localStorage, so the plugin supplies a backend (see bootstrap.js uiState);
  // until then, and as a last resort, values live in memory for the life of the editor.
  backend: null, memory: new Map(),
  attach(backend) { if (backend && typeof backend.get === "function" && typeof backend.set === "function") this.backend = backend; },
  get(key) {
    try { if (this.backend) { const value = this.backend.get("ui." + key); if (value !== null && value !== undefined) return value; } } catch (_) {}
    try { const value = localStorage.getItem("noctua-zotero." + key); if (value !== null) return value; } catch (_) {}
    return this.memory.has(key) ? this.memory.get(key) : null;
  },
  set(key, value) {
    this.memory.set(key, String(value));
    try { if (this.backend) { this.backend.set("ui." + key, String(value)); return; } } catch (_) {}
    try { localStorage.setItem("noctua-zotero." + key, String(value)); } catch (_) {}
  }
};

// Appearance is a plugin preference, independent of note content and undo history.
// Only an explicitly saved "system" mode follows the operating system.
var NoctuaAppearance = {
  normalize(value) { return ["light", "dark", "system"].includes(value) ? value : "light"; },
  mount({ appearance, document, window, refresh = () => {}, onError = () => {} }) {
    const toggle = document.getElementById("theme-toggle");
    const settings = document.getElementById("open-settings");
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    let mode = "light", disposed = false;
    function read() {
      try { return NoctuaAppearance.normalize(appearance?.getTheme?.()); }
      catch (error) { onError(error); return "light"; }
    }
    function apply() {
      if (disposed) return;
      const theme = mode === "system" ? (media?.matches ? "dark" : "light") : mode;
      const changed = document.documentElement.dataset.theme !== theme;
      document.documentElement.dataset.theme = theme;
      const dark = theme === "dark";
      toggle.setAttribute("aria-pressed", String(dark));
      toggle.title = dark ? "Switch to light theme" : "Switch to dark theme";
      toggle.querySelector("[data-theme-label]").textContent = dark ? "Dark" : "Light";
      toggle.querySelector("[data-theme-icon='light']").hidden = dark;
      toggle.querySelector("[data-theme-icon='dark']").hidden = !dark;
      if (changed) refresh();
    }
    function readPreview() {
      try { return appearance?.getPreviewPosition?.() === "below" ? "below" : "right"; } catch (_) { return "right"; }
    }
    function sync() { mode = read(); apply(); document.documentElement.dataset.preview = readPreview();
      try {
        const width = appearance?.getContentWidth?.() ?? 60, style = document.documentElement.style;
        style.setProperty("--note-width", width + "%");
        style.setProperty("--note-vw", String(width));
        const stacks = {times: '"Times New Roman",Times,serif', georgia: 'Georgia,"Times New Roman",serif', palatino: '"Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif',
          sans: 'system-ui,-apple-system,"Segoe UI",sans-serif'};
        style.setProperty("--note-font", stacks[appearance?.getFontFamily?.()] || stacks.times);
        style.setProperty("--note-size", (appearance?.getFontSize?.() ?? 18) + "px");
        style.setProperty("--note-title-size", (appearance?.getTitleSize?.() ?? 38) + "px");
        style.setProperty("--note-line", String((appearance?.getLineSpacing?.() ?? 175) / 100));
        // The block being edited beside its preview may grow to this share of the window, whatever the note width.
        style.setProperty("--note-grow", String(Math.max(1, 90 / width)));
      } catch (_) {}
      try { if (typeof Ink !== "undefined" && appearance?.getInkColors) Ink.setPalette(appearance.getInkColors()); } catch (error) { onError(error); } }
    function osChanged() { if (mode === "system") apply(); }
    function toggleTheme() {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try {
        appearance?.setTheme?.(next);
        mode = next;
        apply();
      } catch (error) { onError(error); }
    }
    function openSettings() {
      try { Promise.resolve(appearance.openPreferences()).catch(onError); }
      catch (error) { onError(error); }
    }
    settings.disabled = typeof appearance?.openPreferences !== "function";
    settings.title = settings.disabled ? "Settings are available when opened from Zotero" : "Open Noctua Notes settings";
    toggle.addEventListener("click", toggleTheme);
    settings.addEventListener("click", openSettings);
    media?.addEventListener("change", osChanged);
    sync();
    const unsubscribe = appearance?.subscribe?.(sync);
    function destroy() {
      if (disposed) return;
      disposed = true;
      toggle.removeEventListener("click", toggleTheme);
      settings.removeEventListener("click", openSettings);
      media?.removeEventListener("change", osChanged);
      if (typeof unsubscribe === "function") unsubscribe();
      window.removeEventListener("unload", destroy);
    }
    window.addEventListener("unload", destroy);
    return destroy;
  }
};
