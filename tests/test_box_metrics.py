"""box/metrics.py: the freshness numbers the alarms watch."""
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "box"))

import metrics  # noqa: E402

failed = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failed.append(name)


NOW = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
ago = lambda h: (NOW - timedelta(hours=h)).isoformat()

with tempfile.TemporaryDirectory() as td:
    db = Path(td) / "jobs.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE jobs (ats TEXT, first_seen TEXT)")
    conn.executemany("INSERT INTO jobs VALUES (?, ?)", [
        ("greenhouse", ago(30)), ("greenhouse", ago(0.5)), ("greenhouse", ago(5)),
        ("ashby", ago(40)),
        ("smartrecruiters", (NOW - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")),
        ("apple", ago(0)),
    ])
    conn.commit()

    fresh = metrics.freshness_minutes(conn, NOW)
    check("each source's newest listing sets its age",
          fresh["greenhouse"] == 30 and fresh["ashby"] == 2400, repr(fresh))
    check("a Z-suffixed stamp is read as UTC", fresh["smartrecruiters"] == 10, repr(fresh))
    check("a source with no rows is left out, not reported as stale",
          "lever" not in fresh and "workday" not in fresh, repr(fresh))
    check("sources outside the watched list are ignored", "apple" not in fresh)
    conn.close()

    class FakeCW:
        def __init__(self):
            self.calls = []

        def put_metric_data(self, **kw):
            self.calls.append(kw)

    class FakeS3:
        def list_objects_v2(self, Bucket=None, Prefix=None, MaxKeys=None):
            return {"KeyCount": 7, "Contents": []}

    cw = FakeCW()
    sent = metrics.publish(db, "bucket", cw=cw, s3=FakeS3(), now=NOW)
    check("one put carries every metric", len(cw.calls) == 1 and cw.calls[0]["Namespace"] == "OceanOfJobs")
    names = [(m["MetricName"], (m.get("Dimensions") or [{}])[0].get("Value"), m["Value"]) for m in cw.calls[0]["MetricData"]]
    check("freshness per source and the fragment backlog",
          ("SourceFreshnessMinutes", "greenhouse", 30.0) in names and ("PendingFragments", None, 7) in names, repr(names))
    check("and the same is returned", sent["pending_fragments"] == 7 and sent["freshness_minutes"]["ashby"] == 2400)

    check("no bucket means no fragment count",
          metrics.publish(db, "", cw=FakeCW(), s3=FakeS3(), now=NOW)["pending_fragments"] is None)

print()
if failed:
    print(f"{len(failed)} failed:")
    for f in failed:
        print(f"  - {f}")
    sys.exit(1)
print("all passed")
