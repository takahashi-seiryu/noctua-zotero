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
