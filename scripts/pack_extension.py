"""Zip extension/ for the Chrome Web Store, or for loading unpacked.

    python scripts/pack_extension.py dist/ocean-of-jobs-extension.zip [--unpacked]

Leaves out extension/test/. For the store it also drops the manifest's
`key`: that pins the id for unpacked installs (so an update keeps the
connection and the CV), and the store assigns its own id and rejects a
package that carries one. --unpacked keeps it and nests the files in an
ocean-of-jobs-extension/ folder, the way they have been sent by hand.
"""
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "extension"


def pack(out: Path, unpacked: bool = False) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if not unpacked:
        manifest.pop("key", None)
    prefix = Path("ocean-of-jobs-extension") if unpacked else Path()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(ROOT.rglob("*")):
            rel = f.relative_to(ROOT)
            if not f.is_file() or rel.parts[0] == "test":
                continue
            if rel == Path("manifest.json"):
                z.writestr(str(prefix / rel), json.dumps(manifest, indent=2) + "\n")
            else:
                z.write(f, prefix / rel)
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = pack(Path(sys.argv[1]), "--unpacked" in sys.argv)
    print(f"{path} ({path.stat().st_size} bytes)")
