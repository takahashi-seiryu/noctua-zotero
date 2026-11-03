# Repository conventions

Write code, interface text, and documentation in English.

## Icons and design

Use the owl emoji (🦉) as Noctua's app/brand icon. This is the explicit exception
to the Lucide rule below; keep action icons distinct from the app identity.
Get action icons from the official Lucide icon catalog: https://lucide.dev/icons/.
Use the catalog to select each icon and obtain its official SVG from Lucide's
linked source or official distribution. Do not draw approximate replacements.
Keep the applicable icon license and attribution in the repository.
Use consistent icon dimensions, stroke widths, accessible names, spacing,
typography, and theme colors throughout the editor and plugin settings.
The default editor theme is light with a white background.

## Development

Use separate Git worktrees for parallel implementation tasks. Keep each change
focused and validate integrations in the isolated Zotero test profile.
Never launch integration tests against the user's normal Zotero library.
Keep implementation, meaningful tests, and user documentation in sync.
Preserve Zotero's native item, attachment, collection, preference, and sync APIs.
Do not invent custom Zotero database item types.

## Git and pull requests

`main` accepts changes only through pull requests, merged with **squash**. The PR title becomes the
commit on `main`, so one PR is one feature-sized commit. Early development: keep commits few and large.

Title (PR and commit), imperative, lower-case after the type, no trailing period, no version number:

```
<type>: <what changed>        e.g. feat: paper reading chat in the PDF reader
```

Types: `feat` (new behavior), `fix` (bug), `docs`, `test`, `refactor`, `chore` (build, release, tooling), `ci` (workflows).
Use an optional scope for a narrow change, e.g. `fix(chat): keep the Fast button background`.
Append `!` after the type for a breaking change to saved notes or settings.

PR body follows `.github/pull_request_template.md`, kept compact:

- **Summary**: one or two sentences, what and why.
- **Main changes**: the few changes that matter.
- **Minor changes**: small fixes, docs, tests; "None" if empty.
- **Validation**: commands run and results, plus any manual check.

Releases are separate and never part of a feature PR: after merging, run **Actions → Release → Run workflow**
(default bump: patch, e.g. 0.1.0 → 0.1.1) or push a `vX.Y.Z` tag on a `main` commit. Do not edit `version` by hand.
