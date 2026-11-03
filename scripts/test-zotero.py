#!/usr/bin/env python3
"""Launch an isolated Zotero profile with this plugin and its integration test.

The path printed first contains the profile, app log and integration-result.json.
The normal Zotero profile and accounts are never copied or modified.
"""
from pathlib import Path
import json
import subprocess
import tempfile
import shutil

root = Path(__file__).resolve().parent.parent
app_path = root / ".test-app-path"
if not app_path.exists():
    raise SystemExit("Create a separately named Zotero test app and record its path in .test-app-path first. The normal app is never used by this launcher.")
app = Path(app_path.read_text().strip())
if app.name != "Noctua Notes Test.app" or not app.exists():
    raise SystemExit("Refusing to launch anything other than the separate Noctua Notes Test.app")
test = Path(tempfile.mkdtemp(prefix="noctua-zotero-test-"))
profile = test / "profile"
data = test / "data"
(profile / "extensions").mkdir(parents=True)
data.mkdir()
version = json.loads((root / "manifest.json").read_text())["version"]
shutil.copy2(root / f"dist/noctua-notes-{version}.xpi", profile / "extensions/noctua-notes@noctua.app.xpi")
prefs = {
    "extensions.zotero.dataDir": str(data),
    "extensions.zotero.useDataDir": True,
    "extensions.zotero.firstRun2": False,
    "extensions.zotero.firstRunGuidance": False,
    "extensions.zotero.sync.autoSync": False,
    "extensions.zotero.automaticScraperUpdates": False,
    "extensions.zotero.httpServer.enabled": False,
    "extensions.autoDisableScopes": 0,
    "extensions.startupScanScopes": 15,
    "extensions.zoteroMacWordIntegration.skipInstallation": True,
    "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
    "extensions.noctua-notes.testScript": (root / "tests/integration.js").as_uri(),
    "extensions.noctua-notes.testResult": str(test / "integration-result.json"),
}
(profile / "user.js").write_text("\n".join(
    f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in prefs.items()
) + "\n")
log = open(test / "app.log", "w")
process = subprocess.Popen([
    str(app / "Contents/MacOS/zotero"), "-no-remote",
    "-profile", str(profile), "-purgecaches", "-ZoteroDebugText",
], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
print(json.dumps({"test_dir": str(test), "pid": process.pid}))
