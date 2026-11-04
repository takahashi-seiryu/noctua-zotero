"use strict";
// Drawing-colour reset for the Noctua Notes pane. Keep the defaults in step with prefs.js
// (the first, empty one is Ink, which follows the theme).
(() => {
  const defaults = ["", "#3e63dd", "#e5484d", "#30a46c", "#f76b15"];
  const keys = defaults.map((_, index) => "extensions.noctua-notes.ink.color" + index);
  const wire = () => {
    const button = document.getElementById("noctua-notes-ink-reset");
    if (!button || button.dataset.wired) return;
    button.dataset.wired = "1";
    button.addEventListener("click", () => {
      keys.forEach((key, index) => {
        Zotero.Prefs.set(key, defaults[index], true);
        const input = document.getElementById("noctua-notes-ink-color" + index);
        if (input) input.value = defaults[index] || "#000000";
      });
    });
  };
  // Shows a slider's value (e.g. "60%", "18 px") to its right.
  const show = (sliderID, labelID, format) => () => {
    const slider = document.getElementById(sliderID), label = document.getElementById(labelID);
    if (!slider || !label) return;
    label.value = format(slider.value);
    if (!slider.dataset.wired) {
      slider.dataset.wired = "1";
      const again = show(sliderID, labelID, format);
      slider.addEventListener("input", again);
      slider.addEventListener("change", again);
    }
  };
  const showWidth = show("noctua-notes-width", "noctua-notes-width-value", value => value + "%");
  const showSize = show("noctua-notes-font-size", "noctua-notes-font-size-value", value => value + " px");
  const showTitle = show("noctua-notes-title-size", "noctua-notes-title-size-value", value => value + " px");
  const showLine = show("noctua-notes-line", "noctua-notes-line-value", value => (value / 100).toFixed(2));
  const showAll = () => { showWidth(); showSize(); showTitle(); showLine(); };
  // Choosing a font also sets the text size, title size and line spacing that suit it (keep in step with
  // NoctuaNotesSettings.FONT_PROFILES). The sliders stay free to adjust afterwards.
  const profiles = {
    times: {fontSize: 18, titleSize: 38, lineSpacing: 175},
    georgia: {fontSize: 17, titleSize: 36, lineSpacing: 175},
    palatino: {fontSize: 17, titleSize: 36, lineSpacing: 170},
    sans: {fontSize: 16, titleSize: 34, lineSpacing: 165}
  };
  const sliders = {fontSize: "noctua-notes-font-size", titleSize: "noctua-notes-title-size", lineSpacing: "noctua-notes-line"};
  const wireFont = () => {
    const menu = document.getElementById("noctua-notes-font");
    if (!menu || menu.dataset.wired) return;
    menu.dataset.wired = "1";
    const apply = () => {
      const profile = profiles[menu.value];
      if (!profile) return;
      for (const [name, value] of Object.entries(profile)) {
        Zotero.Prefs.set("extensions.noctua-notes." + name, value, true);
        const slider = document.getElementById(sliders[name]);
        if (slider) { slider.value = String(value); slider.dispatchEvent(new Event("input")); }
      }
    };
    menu.addEventListener("command", apply);
  };
  wire();
  wireFont();
  showAll();
  document.addEventListener("DOMContentLoaded", showAll);
  window.addEventListener("load", showAll);
  setTimeout(showAll, 300);
  setTimeout(showAll, 1200);
  document.addEventListener("DOMContentLoaded", () => { wire(); wireFont(); });
  window.addEventListener("load", () => { wire(); wireFont(); });
  setTimeout(() => { wire(); wireFont(); }, 300);
})();
