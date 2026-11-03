# Noctua Notes for Zotero — prototype 0.5

Noctua's text/LaTeX, handwriting, and image notes in a new Zotero desktop tab.
This is an extracted subset of Noctua Notes, not a replacement
for the entire Noctua app. No Noctua server is required.

## Install and open

Build with `python3 scripts/build.py`. In Zotero, choose **Tools → Plugins →
gear → Install Plugin From File…** and select `dist/noctua-notes-0.5.6.xpi`.
The prototype targets Zotero 8–10; the local runtime check uses Zotero 10.0.7.
Updates are manual for this draft. Zotero requires an `update_url`, so the
manifest uses a reserved `.invalid` placeholder until a real release channel
exists; it cannot supply automatic updates.

Select a paper in **My Library** and choose **Tools → Open Noctua Notes…**, or use
the paper's context menu. This opens that paper's first Noctua note or creates
a new editor if none exists. **New note (+) → New Noctua Note…** always creates
a new note. With no paper selected, notes are standalone in the selected
collection. Select a Noctua source attachment to reopen that specific editor. Group libraries are intentionally rejected in this version.
From a PDF tab, **Tools → Open Noctua Notes…** uses that PDF's parent paper. The
note opens in its own Zotero tab beside the PDF. Saved sources can be reopened
after restarting Zotero; automatic tab-session restoration is not implemented.

Version 0.3 includes the fix for blank plugin menu labels by loading the Fluent resource
in existing and newly opened Zotero main windows. Tools now shows
**Open Noctua Notes…**, **Import Noctua Source…**, and **Export Noctua Source…**.
Source transfer actions are also in the item right-click menu. Export is available
for the active editor or an explicitly selected source attachment.

## Noctua Note instances

Each saved source attachment represents one Noctua Note instance with a stable
document ID and Zotero item key. Double-click **Noctua Note — title** in the
library to open it in a Noctua editor tab. Repeated opens select the existing
tab; simultaneous opens share one initialization. **New Noctua Note…**
creates a separate instance. Zotero still manages paper and collection membership.

Each instance uses a single source attachment. No native reading-preview note
is created. The plugin uses ordinary Zotero attachments and does not add a custom
database item type. PDFs, ordinary notes, and papers retain Zotero activation.
Disabling the plugin restores native activation; install the plugin to edit
Noctua sources again.

## Right sidebar

Select a paper and click the 🦉 **Noctua Notes** icon in Zotero’s
right sidebar. This separate section lists only that paper’s Noctua source
instances, with **Open** for each instance and **New Noctua Note** to create
another one. The list refreshes when sources are saved. The section also
resolves a PDF to its parent paper and supports standalone Noctua sources.
Ordinary Zotero notes remain in Zotero’s built-in Notes section.

The sidebar manages instances and opens their editor tabs; it does not embed
the full editor inside the sidebar. Group libraries are not supported.

Ordinary notes are never classified as Noctua instances by their title. Legacy
preview routing only recognizes a verified source relationship and saved
preview key, while old generated previews are being retired.

## Appearance and settings

The editor starts in **Light** mode with a white background, including on devices
using a dark system appearance. Click the **Light / Dark** control at the top
right to switch modes. The selection persists as the plugin default and updates
all open Noctua tabs. It does not change note content or revisions.

Click **Settings** beside the theme control, or open Zotero Settings →
**Noctua Notes**, to select Light, Dark, or **Follow system**. Follow system only
tracks the device appearance when explicitly selected. Noctua uses 🦉 for its app
identity and official Lucide artwork for action icons.

## Editing

- Click rendered text to edit its LaTeX source with a live preview. Use inline
  and display equations, sections, theorem environments, labels, and references.
  Escape or Cmd/Ctrl+Enter finishes editing. Brackets and dollar signs pair
  automatically; select source and use Cmd/Ctrl+B or Cmd/Ctrl+I for bold/italic.
- The original Noctua `web/latex.js` is included unchanged. `web/ink.js` retains
  its original drawing algorithm, with toolbar creation adapted to Zotero's DOM.
  Handwriting has pressure-sensitive vector strokes, pen colors/widths, an
  eraser, undo/redo, and pads that grow near their edges.
- Add or paste/drop PNG, JPEG, WebP, or GIF images. Individual images are limited
  to 8 MB; a complete source is limited to 32 MB and 500 blocks. SVG and video
  are excluded from this prototype.
- Reorder or remove blocks; define shared LaTeX commands in the preamble.
- Insert text or drawings between blocks. Cmd/Ctrl+Shift+D inserts a drawing
  after the focused block. Text following a drawing can appear beside or below it.
- Undo/Redo restores note edits, block operations, and drawings during the
  current editor session. History is bounded to 40 entries and approximately
  16 MB (one large entry may exceed that limit); reloading clears history.
- **Insert citation** opens Zotero's paper picker. `\cite{ITEM_KEY}` and
  `\citet{ITEM_KEY}` resolve to author/year and generate References. Citation
  keys recorded as `Citation Key: key` or `citationKey: key` in Extra also work.
  Citation links select the paper in Zotero. Unresolved keys are marked visibly.
- Edits always autosave after a short delay. The top bar shows **Unsaved changes**,
  **Saving…**, **Saved**, or a visible conflict/error. There is no Save button.
  **Cmd/Ctrl+S** can flush pending changes immediately. A blank untouched editor
  does not create library entries. Closing a dirty tab preserves its last edit.

Use **Guide** in the editor for shortcuts and syntax. PDF-annotation insertion,
AI, handwriting recognition, a split editor beside the PDF within the same tab,
and Noctua project-file management are not included yet. See
[migration coverage](MIGRATION.md) for the remaining upstream differences.

## Import existing Noctua notes

Choose **Tools → Import Noctua Source…** or the item right-click command, then
select an original Noctua version-1 JSON file from `notes/<folder>/<id>.json`.
Keep its `images/` and `media/` folders beside the JSON. Text, preamble, vector
strokes, drawing/text layout, and referenced PNG/JPEG/GIF/WebP assets are imported.
Older drawings without a width use Noctua's original 1000-unit width. Referenced
images become inline bytes in the Zotero attachment; Noctua is not needed to
reopen the result. Each image is limited to 8 MB and the complete source to 32 MB.
Missing files, unsafe paths, SVG, video, and unsupported blocks abort import.

Import creates and saves a separate note under the selected paper or collection;
it does not modify the original file or replace the currently open editor.
Original identity and timestamps are retained as provenance, while Zotero source
identity and revisions are new. Metadata outside the supported note fields is
reported after import. Original citation and note-link keys stay in the source;
they require matching Zotero citation keys, and original note links do not resolve.
Collection membership, tags, author metadata, and project files are not migrated.

**Tools → Export Noctua Source…**, or the source attachment’s right-click
command, produces a portable `.noctua.json` file with inline images. Export from
an open editor includes pending unsaved edits and completes active ink strokes.
Import/export source buttons do not appear on the note page.
Importing that file makes a separate copy without needing the original image
folders. Existing 0.1 sources continue to open directly without conversion.

## Storage and WebDAV

Saving creates a normal **stored `.noctua.json` attachment** containing text,
preamble, vector strokes, and inline raster images. Sources follow the selected paper;
standalone notes and sources belong to the selected collection.

The source uses Zotero's existing file-sync configuration. With WebDAV enabled,
Zotero packages it into its usual `.zip`/`.prop` files, just like another stored
attachment. For the configured Platypus service, those files live under
`~/Dropbox/Zotero-WebDAV/zotero/`. The plugin neither contacts Dropbox directly
nor stores or changes WebDAV credentials. A save first commits **locally**;
Zotero then transfers the attachment during sync. Wait for sync to finish before
editing on another device. Missing sources are downloaded using Zotero's normal
on-demand download API.

Other desktop computers need this plugin to open and edit Noctua sources.
Zotero mobile does not run desktop plugins, and this plugin no longer produces
a separate native-note preview for mobile reading.

## Retiring old reading previews

On startup, the plugin checks locally available Noctua sources for historical
generated previews. A preview must match the source's stored preview key,
reciprocal relations, placement, and unchanged generated content. Verified
companions move to Zotero Trash and their source relations are detached. Sources
are preserved. Ordinary notes and edited, moved, or otherwise unverified
previews are left alone. Missing sources are not downloaded for this cleanup.
A source save can also retire a verified old companion.

Cleanup is reversible through Zotero Trash. It never permanently erases notes.
Missing or deleted previews no longer block source saves. New sources and
successful saves have no active preview key.

## Drafts, conflicts, and removal

Revision checks reject overwriting a source that changed since it was loaded.
The editor preserves a local draft under
`[Zotero data directory]/noctua-notes-drafts/`. Reopening a saved source offers
draft recovery. The **Export Noctua Source…** menu command preserves a copy before merging a
conflict; **Reload saved version** loads the current committed source. A never-saved
new note has a UUID-named draft file that can be recovered manually from this
folder. Drafts are local, not a substitute for syncing or backups. Conflicting
edits not yet downloaded from another device remain subject to Zotero's own
file-conflict handling.

Removing the plugin keeps its source attachments in Zotero.
It does not alter PDFs, existing notes, or Dropbox originals. Deleting a Noctua
source through Zotero is a library deletion, not a cache eviction.

## Development and validation

`node --test tests/*.test.cjs` checks import and source validation, hostile input,
LaTeX keyboard behavior, citation resolution, rendering, and storage/revision
handling, source-only saves, and guarded legacy-preview cleanup.
`python3 scripts/build.py` packages the
plugin without npm dependencies. `scripts/test-zotero.py` prepares an isolated
Zotero profile and launches the real app with the integration script; it never
signs into an account or loads the user's library. See `tests/integration.js` for
source-only save/reopen/conflict/download, autosave, theme/settings, block history,
citations, double-click activation, concurrent tab opens, source transfer, sidebar,
and guarded legacy cleanup checks and generated result file.

The original Noctua repository is a sibling named `noctua`. Vendored source is
copied from its `web/latex.js`, `web/ink.js`, and `web/vendor/katex/`. Keep upstream
licenses and notices when updating those copies. The test launcher requires a
separate copy of the Zotero app named `Noctua Notes Test.app`, with a distinct
bundle identifier, recorded in `.test-app-path`. It refuses to launch the user's
normal Zotero app. The supplied integration test checks the data-directory guard
before writing any fixture items.
