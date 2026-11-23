"""box/known_gap.py: resolved companies missing from known.json, the list
the five-minute sweep polls.

Run directly, no framework:  python tests/test_known_gap.py
"""
import io
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "box"))

import known_gap  # noqa: E402
import metrics  # noqa: E402

failed = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failed.append(name)


with tempfile.TemporaryDirectory() as td:
    db = Path(td) / "jobs.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE companies (domain TEXT, ats TEXT, token TEXT)")
    conn.execute("CREATE TABLE jobs (ats TEXT, first_seen TEXT)")
    conn.executemany("INSERT INTO companies VALUES (?, ?, ?)", [
        ("buildots.com", "comeet", "uid:tok"),   # resolved, dropped from known.json
        ("claroty.com", "comeet", "uid:tok2"),   # resolved and listed
        ("leidos.com", "workday", "leidos:wd5:External"),  # the hourly Lambda's, not the sweep's
        ("apple.com", "apple", "apple"),         # big tech, same
        ("wix2.com", "smartrecruiters", "wix2"),  # merged into wix.com
        ("gone.com", None, None),                # demoted
        ("half.com", "greenhouse", None),        # no token, the sweep can't poll it
    ])
    conn.commit()
    known = [{"domain": "claroty.com", "ats": "comeet", "token": "uid:tok2"}]

    gap = known_gap.missing(conn, known)
    check("only the sweep-pollable resolved company that isn't listed",
          gap == [{"domain": "buildots.com", "ats": "comeet", "token": "uid:tok"}], repr(gap))
    check("nothing missing once it is listed", known_gap.missing(conn, known + gap) == [])
    conn.close()

    class FakeS3:
        def get_object(self, Bucket=None, Key=None):
            assert Key == "known.json"
            return {"Body": io.BytesIO(json.dumps(known).encode())}

    class FakeCW:
        calls = []

        def put_metric_data(self, **kw):
            self.calls.append(kw)

    cw = FakeCW()
    sent = metrics.publish(db, "bucket", cw=cw, s3=FakeS3())
    names = {m["MetricName"]: m["Value"] for m in cw.calls[0]["MetricData"]}
    check("publish sends the gap as CompaniesNotPolled", names.get("CompaniesNotPolled") == 1
          and sent["companies_not_polled"] == 1, repr(names))

    class BrokenS3:
        def get_object(self, **kw):
            raise RuntimeError("no network")

    cw2 = FakeCW()
    cw2.calls = []
    sent = metrics.publish(db, "bucket", cw=cw2, s3=BrokenS3())
    check("an unreadable known.json skips only that metric",
          sent["companies_not_polled"] is None and cw2.calls, repr(sent))

print()
if failed:
    print(f"{len(failed)} failed")
    sys.exit(1)
print("all passed")
