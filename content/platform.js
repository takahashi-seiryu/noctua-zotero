"use strict";
// The original Noctua ink module uses this tiny settings adapter.
var store = {
  get(key) { try { return localStorage.getItem("noctua-zotero."+key); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem("noctua-zotero."+key, value); } catch (_) {} }
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
    function sync() { mode = read(); apply(); }
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
