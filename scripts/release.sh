#!/bin/sh
# Build the XPI, generate updates.json, and publish a GitHub Release (run after committing and pushing).
set -e
cd "$(dirname "$0")/.."
python3 scripts/build.py
python3 scripts/updates.py
V=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
gh release create "v$V" "dist/noctua-notes-$V.xpi" dist/updates.json --title "v$V" --generate-notes
