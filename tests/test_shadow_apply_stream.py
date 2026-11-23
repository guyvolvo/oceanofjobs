"""shadow_apply._read writes the batch one result per line, and the
loader reads back exactly what the fragments held, in order.

Run directly, no framework:  python tests/test_shadow_apply_stream.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("DATA_BUCKET", "test-bucket")
sys.path.insert(0, str(ROOT / "box"))
sys.path.insert(0, str(ROOT / "loader"))

import load_to_sqlite as lts  # noqa: E402
import shadow_apply  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    a = [{"domain": "a.com", "jobs": [{"title": "Line\nbreak   and שלום"}]},
         {"domain": "b.com", "unchanged": True}]
    b = [{"domain": "a.com", "jobs": []}]
    (tmp / "001.json").write_text(json.dumps(a), encoding="utf-8")
    (tmp / "002.json").write_text("{not json", encoding="utf-8")
    (tmp / "003.json").write_text(json.dumps(b), encoding="utf-8")
    out = tmp / "work.json"

    n = shadow_apply._read(sorted(tmp.glob("*.json")), out)
    back = list(lts.iter_resolved(out))

    check("counts every result", n == 3, str(n))
    check("reads back the same results in fragment order", back == a + b, repr(back))
    # Counted as "\n", not splitlines(): that also splits on U+2028, which
    # the loader's line-by-line read does not.
    check("one result per line", out.read_text(encoding="utf-8").count("\n") == 3)
    check("an unreadable fragment is set aside", (tmp / "002.bad").exists())

    # Gzipped fragments (the scrapers' format from 2026-11) read the same,
    # beside plain ones still in the spool, and budget by their JSON size.
    import gzip
    from deltas import unpacked_size
    g = tmp / "g"
    g.mkdir()
    (g / "001.json").write_bytes(gzip.compress(json.dumps(a).encode()))
    (g / "002.json").write_text(json.dumps(b), encoding="utf-8")
    n = shadow_apply._read(sorted(g.glob("*.json")), out)
    check("a gzipped fragment beside a plain one reads in order", n == 3 and list(lts.iter_resolved(out)) == a + b)
    check("budget size is the unpacked JSON, gzipped or plain",
          unpacked_size(g / "001.json") == len(json.dumps(a).encode()) and unpacked_size(g / "002.json") == len(json.dumps(b).encode()))

sys.exit(1 if failures else 0)
