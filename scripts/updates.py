#!/usr/bin/env python3
"""Write dist/updates.json for the XPI matching manifest.json (Zotero update manifest)."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "manifest.json").read_text())
zotero = manifest["applications"]["zotero"]
version = manifest["version"]
xpi = root / "dist" / f"noctua-notes-{version}.xpi"
repo = zotero["update_url"].split("github.com/")[1].split("/releases/")[0]
data = {"addons": {zotero["id"]: {"updates": [{
    "version": version,
    "update_link": f"https://github.com/{repo}/releases/download/v{version}/{xpi.name}",
    "update_hash": "sha256:" + hashlib.sha256(xpi.read_bytes()).hexdigest(),
    "applications": {"zotero": {"strict_min_version": zotero["strict_min_version"]}},
}]}}}
(root / "dist" / "updates.json").write_text(json.dumps(data, indent=2) + "\n")
print(root / "dist" / "updates.json")
