#!/usr/bin/env python3
"""Build a Zotero XPI using only Python's standard library."""
from pathlib import Path
import json
import re
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "manifest.json").read_text())
target = root / "dist" / f"noctua-notes-{manifest['version']}.xpi"
target.parent.mkdir(exist_ok=True)
files = [root / n for n in ["manifest.json", "bootstrap.js", "prefs.js", "LICENSE", "THIRD_PARTY_NOTICES.md"]]
for folder in ["lib", "content", "locale"]:
    files.extend(p for p in (root / folder).rglob("*") if p.is_file() and not p.name.startswith("."))
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as out:
    for path in sorted(files):
        name = path.relative_to(root)
        if path.name == "editor.html":
            # Zotero keeps chrome:// stylesheets in memory across in-place plugin updates.
            # A per-version query makes an updated editor load its own CSS and scripts.
            html = re.sub(r'((?:href|src)="(?!vendor/)[\w.-]+\.(?:css|js))"', lambda m: m.group(1) + "?v=" + manifest["version"] + '"', path.read_text())
            out.writestr(str(name), html)
        else:
            out.write(path, name)
print(target)
print(f"{len(files)} files, {target.stat().st_size:,} bytes")
