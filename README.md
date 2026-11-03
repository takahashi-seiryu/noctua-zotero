# Noctua Notes for Zotero

LaTeX, handwriting and image notes for papers in Zotero, plus an AI assistant that reads the paper.

## Download, install, update

1. Download **`noctua-notes-<version>.xpi`** from the
   [latest release](https://github.com/takahashi-seiryu/noctua-zotero/releases/latest).
2. In Zotero: **Tools → Plugins → ⚙ → Install Plugin From File…** and pick the `.xpi`.
3. Updates are automatic: Zotero checks the latest release's `updates.json` and installs newer versions itself
   (**Tools → Plugins → ⚙ → Check for Updates** to force it).

Requires Zotero 8–10 on desktop (tested on 10.0.7). Zotero mobile cannot run plugins.
The assistant needs the [Claude](https://docs.claude.com/en/docs/claude-code) or Codex CLI installed and signed in.

## Use

- **Create**: right-click a paper → **New Item Noctua Note**, or **New Standalone Noctua Note** (in the selected collection).
  Open an existing one by double-clicking it or from the 🦉 **Noctua Notes** section in the right pane.
- **Edit**: click a block to edit its source with a live preview (beside or below, see Settings). `Esc` or `Cmd/Ctrl+Enter` finishes.
  Text blocks support LaTeX (equations, theorems, labels/references, `\cite{…}` with autocomplete) and basic Markdown
  (headings, lists, quotes, code, bold/italic). Drawings are pressure-sensitive vector ink; images (PNG/JPEG/WebP/GIF/SVG),
  tables and YouTube links work too. Press **Guide** in the editor for shortcuts and syntax.
- **Save**: automatic; the top bar shows the status and last-saved time. `Cmd/Ctrl+S` flushes at once.
- **Assistant**: the note editor has a Claude/Codex chat that edits the note and can read the paper as reference.
  In the PDF reader, the **✨ Noctua Chat** button (below Zotero's yellow Notes button) opens a read-only chat about the
  paper: full text with page markers, metadata and your highlights. Model, reasoning level, Codex Fast mode, attachments,
  `/` commands and `$` skills are supported.
- **Import/Export**: **Tools → Import / Export Noctua Source** (also in the item menu) reads original Noctua v1 JSON
  (keep its `images/` folder beside it) or writes a portable `.noctua.json` with inline images.

## Settings

Zotero Settings → **Noctua Notes**: theme (light default, dark, follow system), note width (50–100%), preview position,
drawing colours, author name, and the Claude/Codex provider paths. Settings survive updates.

## Storage and sync

Each note is one ordinary stored attachment `*.noctua.json` (text, preamble, strokes, inline images) under its paper,
or in a collection for standalone notes. Zotero's own file sync and WebDAV carry it; the plugin never contacts a server
except the AI CLIs you run. Saves check revisions so a stale copy cannot overwrite newer edits; unsaved work is kept in
`<Zotero data dir>/noctua-notes-drafts/`. Removing the plugin keeps the attachments. Group libraries are not supported.
Limits: 8 MB per image, 32 MB and 500 blocks per note.

## Development

```
npm test                          # unit tests
python3 scripts/build.py          # dist/noctua-notes-<version>.xpi
python3 scripts/test-zotero.py    # integration test in an isolated Zotero (never your library)
```

The integration test needs a separate copy of the Zotero app named `Noctua Notes Test.app` (recorded in `.test-app-path`).
To release: bump `version` in `manifest.json` and `package.json`, commit, push, run `scripts/release.sh`.
Vendored KaTeX and the LaTeX/ink code keep their upstream licences ([third-party notices](THIRD_PARTY_NOTICES.md)).
Not yet included: PDF-annotation drag-in, note-link search, handwriting recognition.
