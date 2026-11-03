# Third-party notices

- `content/noctua-latex.js` is copied unchanged from Noctua (`UW-CTRL/noctua`),
  version 0.3.10. `content/noctua-ink.js` is adapted from the same version: its
  toolbar uses DOM construction for Zotero's privileged document. The drawing
  algorithm is preserved. Copyright (c) 2026 Noctua contributors.
  MIT license; see the repository's `LICENSE`.
- `content/vendor/katex/` contains the KaTeX distribution vendored by Noctua.
  Its original MIT license is retained at `content/vendor/katex/LICENSE`.
- The handwriting styling is adapted from Noctua's MIT-licensed `web/style.css`.
- The plugin lifecycle and menu integration follow Zotero's documented APIs.
  No Zotero application source is bundled in this package.

- `content/icons/{sun,moon,settings}.svg` and the inline editor
  icons are official [Lucide](https://lucide.dev/icons/) artwork, obtained from
  `https://github.com/lucide-icons/lucide/tree/main/icons` on 2026-11-02.
  The `eraser`, `history` and `paperclip` icons come from lucide-static 1.66.0 (ISC), same source and treatment.
  Editor action icons are sized to 16px; all retain Lucide's 2-unit stroke and original paths.
- `content/icons/claude.svg` and `content/icons/codex.svg` are the colored Claude and Codex marks from
  @lobehub/icons-static-svg (MIT). Both are trademarks of their owners (Anthropic and OpenAI) and appear
  only to identify the matching assistant.
  Copyright (c) 2026 Lucide Icons and Contributors; ISC license. The moon icon
  also carries the Feather MIT attribution. Both licenses are retained in
  `content/icons/LICENSE`.
