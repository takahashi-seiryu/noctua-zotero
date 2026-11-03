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
  // Shows the note-width slider's value (e.g. "60%") to its right.
  const showWidth = () => {
    const slider = document.getElementById("noctua-notes-width"), label = document.getElementById("noctua-notes-width-value");
    if (!slider || !label) return;
    label.value = slider.value + "%";
    if (!slider.dataset.wired) {
      slider.dataset.wired = "1";
      slider.addEventListener("input", showWidth);
      slider.addEventListener("change", showWidth);
    }
  };
  wire();
  showWidth();
  document.addEventListener("DOMContentLoaded", showWidth);
  window.addEventListener("load", showWidth);
  setTimeout(showWidth, 300);
  setTimeout(showWidth, 1200);
  document.addEventListener("DOMContentLoaded", wire);
  window.addEventListener("load", wire);
  setTimeout(wire, 300);
})();
