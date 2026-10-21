"""shadow_apply drains the spool in batches within one run, stops for a
waiting job or the time budget, and leaves the archive purge out while a
backlog is queued.

Run directly, no framework:  python tests/test_apply_loop.py
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp())
for k, v in {"DATA_BUCKET": "test-bucket", "DATA_PATH": str(TMP / "jobs.db")}.items():
    os.environ[k] = v
sys.path.insert(0, str(ROOT / "box"))
import shadow_apply as sa  # noqa: E402

failed = 0


def check(name, ok, detail=""):
    global failed
    print(("PASS: " if ok else "FAIL: ") + name + ("" if ok else "  -- " + detail))
    failed += not ok


runs = []


def fake_loader(cmd, **kw):
    runs.append(cmd)
    return subprocess.CompletedProcess(cmd, 0, "", "")


sa.subprocess.run = fake_loader
sa.PRIMARY = True
sa.delete_fragments = lambda bucket, keys: len(keys)
sa._refresh_logos = lambda: None
sa._write_status = lambda *a: None
sa._run_alerts = lambda: ", alerts ran"
sa.MAX_APPLY_BYTES = 250


def spool(n):
    sa.SPOOL.mkdir(parents=True, exist_ok=True)
    for i in range(n):
        (sa.SPOOL / f"2026{i:04d}.json").write_text('[{"domain": "a.com", "ats": "x", "jobs": []}]' + " " * 60)


spool(12)
runs.clear()
sa._apply()
archived = ["--archive-bucket" in c for c in runs]
check("one run drains the whole spool", not list(sa.SPOOL.glob("*.json")))
check("in batches of MAX_APPLY_BYTES", len(runs) == 6, str(len(runs)))
check("no archive purge while more than another batch is queued",
      archived == [False, False, False, False, True, True], str(archived))

spool(12)
runs.clear()
waiting = iter([None, "publish"])
sa.someone_waiting = lambda but="": next(waiting)
sa._apply()
check("a job waiting for the disk stops the run after the batch in hand",
      len(runs) == 2 and len(list(sa.SPOOL.glob("*.json"))) == 8, str(len(runs)))

sa.someone_waiting = lambda but="": None
sa.APPLY_BUDGET_S = 0
runs.clear()
sa._apply()
check("the time budget stops the run after one batch", len(runs) == 1, str(len(runs)))

sys.exit(1 if failed else 0)
