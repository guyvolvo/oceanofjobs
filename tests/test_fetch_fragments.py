"""The fetcher clears fragments the box has finished with but S3 still holds.

A fragment whose S3 delete failed after its apply, one that held nothing,
and one set aside as .bad are all remembered as fetched and gone from the
spool. Nothing would ever delete them, so the backlog metric that counts
the bucket would stay high for good. A fragment still in the spool is
waiting for an apply and must stay.

Run directly, no framework:  python tests/test_fetch_fragments.py
"""
import importlib
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "box"))
sys.path.insert(0, str(ROOT / "loader"))

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class S3:
    def __init__(self, keys):
        self.keys = keys

    def list_objects_v2(self, **kw):
        return {"Contents": [{"Key": k} for k in self.keys], "IsTruncated": False}

    def download_file(self, bucket, key, path):
        Path(path).write_text("[]", encoding="utf-8")


def run(primary):
    with tempfile.TemporaryDirectory() as d:
        os.environ.update(DATA_BUCKET="test-bucket", DATA_PATH=str(Path(d) / "jobs.db"),
                          OTJ_PRIMARY="1" if primary else "")
        import boto3
        import fetch_fragments as ff
        ff = importlib.reload(ff)
        prefix = ff.PREFIX
        ff.SPOOL.mkdir(parents=True)
        (ff.SPOOL / "b.json").write_text("[]", encoding="utf-8")       # fetched, waiting for an apply
        (ff.SPOOL / "c.bad").write_text("not json", encoding="utf-8")  # set aside
        ff.SEEN.write_text(json.dumps([prefix + "a.json", prefix + "b.json", prefix + "c.json"]), encoding="utf-8")
        s3 = S3([prefix + "a.json", prefix + "b.json", prefix + "c.json", prefix + "d.json"])
        boto3.client = lambda name: s3
        deleted = []
        ff.delete_fragments = lambda bucket, keys: deleted.extend(keys) or len(keys)
        ff.main()
        return deleted, sorted(p.name for p in ff.SPOOL.glob("*.json")), prefix


deleted, spool, prefix = run(primary=True)
check("applied and set-aside leftovers are deleted from S3, the spooled one is not",
      sorted(deleted) == [prefix + "a.json", prefix + "c.json"], repr(deleted))
check("the new fragment is still fetched", spool == ["b.json", "d.json"], repr(spool))
deleted, _, _ = run(primary=False)
check("a box that is not the only applier deletes nothing", deleted == [], repr(deleted))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
