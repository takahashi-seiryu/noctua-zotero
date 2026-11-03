# Notes migration coverage

Version 0.2 compares the plugin with the sibling Noctua notes implementation
in `web/notes.js`, `web/figures.js`, `web/latex.js`, `web/ink.js`, and `src/notes.rs`.
This release migrates the standalone editor and supported source data. It does
not claim full parity with the Noctua application.

## Implemented in the Zotero plugin

- Original LaTeX renderer and KaTeX, preamble commands, equation labels/references.
- Pressure-sensitive vector drawing, resizing/growth, pen palette, eraser.
- Text, ink, raster image blocks; insertion between blocks and reordering/removal.
- Source keyboard pairing, formatting, finish-editing keys, focused drawing shortcut.
- Session undo/redo and text beside/below drawings.
- Zotero paper picker, author/year citations, clickable paper links, References.
- Original version-1 JSON import with local raster assets and legacy ink widths.
- Portable plugin-source import/export with independent identities.
- Zotero stored source attachments, autosave, local
  drafts, revision conflicts, native file sync, and download on demand.

Existing 0.1 source files remain schema-version 1 and need no conversion.
New optional `media`, `origin`, and text-block `beside` fields preserve migrated
content. Keep 0.2 installed on editing devices: 0.1 cannot preserve these fields
when it saves a source.

## Remaining Noctua capabilities

- Reader split view, annotation/figure drag insertion, and navigation to cited PDFs.
- Note-link search/picker and resolution of original Noctua note IDs.
- Search bar with regular expression/case/word options.
- Page geometry, paragraph layout controls, and custom note palettes beyond Light/Dark modes.
- Media crop/resize controls, SVG, local video, and embedded video playback.
- Persistent revision-history UI (session undo and local drafts are available).
- AI chat, handwriting-to-LaTeX/diagram conversion, and batch transcription.
- Noctua project tree/files, bibliography files, paper compilation, and workspace
  management. Zotero manages paper/collection organization instead.

Original metadata outside supported fields is reported during import. Imports
reject missing or unsupported media rather than produce a partial source.
Original author, tags, collection membership, and project metadata remain in the
original JSON; migration does not assign them to Zotero items.

Version 0.2.1 fixes blank menu labels and adds a real Tools-menu localization
regression check. The English commands explicitly name their Open, Import, or
New action.

Version 0.3 treats each saved source as a Noctua Note instance. Library
double-click and attachment activation open the exact source in the plugin;
related reading previews route to the same instance. Repeated and concurrent
opens share a tab. Activation hooks are removed on window unload or plugin
shutdown and pass ordinary items through to Zotero. Source and preview titles
identify their separate roles.

Version 0.4 adds a dedicated Noctua Notes right-sidebar section with an icon,
per-paper instance list, Open and New actions, and save notifications. It also
intercepts direct `Zotero.Notes.open` calls and uses the stable library pane,
fixing activation paths missed by the 0.3 implementation. Preview identity is
verified against the saved source; ordinary native notes retain native editing.
Preview headings explicitly identify their Noctua origin.

Version 0.5 retires generated native reading previews. A Noctua instance
uses one source attachment and opens in the plugin. Startup cleanup checks local
sources and moves only unchanged, verified generated companions to Zotero Trash.
Edited or unverified notes are preserved, and unavailable sources are not
downloaded solely for cleanup. New saves no longer depend on previews.

Version 0.5 also introduces an explicit white Light default, persisted Light/Dark
control, native Zotero appearance preferences, Follow system, an owl app identity,
and official Lucide action icons. The header shows autosave status; there is no
Save button. Source import/export is available only in Tools and item context
menus. Export from the active editor preserves pending edits.

The integrated review identified a first-save/tab-close race. Save locks now
retain the stable document ID and source alias; close persistence waits for the
pending save before writing its newer draft. Regression tests cover successful
and failed first commits, and the real Zotero test pauses after source creation
before closing with newer edits.

## Validation

Run `npm test` and `npm run build`. The isolated Zotero launcher
`python3 scripts/test-zotero.py` exercises actual attachment persistence, conflict
protection, on-demand download, tab lifecycle, KaTeX/canvas/image rendering,
insertion/undo/redo, citation resolution, original-file import, and reimport of a
portable source after its external image has been removed.

The launcher uses a separate test app and temporary unsigned-in library; it
does not use the user's Zotero profile. Integration does not verify live WebDAV
transfer, other Zotero versions, pen hardware, or multi-device conflicts.

## 0.5.1 UI refresh

The editor now reads as a note rather than a toolbar. The first screen shows a
slim header (status, undo, redo, theme, ⋯ menu), a large title and a page-width
writing column. LaTeX preamble, reload, guide and settings moved into the ⋯
menu. Block tools and between-block inserters appear on hover or focus; a quiet
Text/Drawing/Image/Citation row sits below the note. Text editing is stacked
above its live preview, and new notes start with the title focused (Enter moves
to the first block). Icons come from the official Lucide set (`content/icons.js`).

## 0.5.2 Notion-style block interaction

Blocks now sit tightly together. Each block has a left grip handle (visible on
hover): drag it to reorder, or click / right-click it for Move, Duplicate and
Delete (Alt+Up/Down moves from the keyboard; Undo restores a deleted block).
The Text/Drawing inserter between blocks and the trailing add row appear only
when the pointer is near them. Inline per-block toolbars were removed.

## 0.5.5 Sidebar notes list

The item-pane list now shows a clean title (no repeated "Noctua Note — "
prefix) clamped to two lines, with a quiet "modified" line beneath. Rows have no
Open button: double-click (or Enter on a focused row) opens the note in its tab.
Creation is a text-style "+ New note" button; an empty paper shows "No notes yet".
