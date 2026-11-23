"""Per-job Workday checks for boards past the listing limit: which jobs get
asked, how answers read, and that they close a job only on the usual
6 hours and 3 answers.

Run directly, no framework:  python tests/test_workday_checks.py
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _p in (ROOT, ROOT / "loader", ROOT / "box"):
    sys.path.insert(0, str(_p))

import load_to_sqlite  # noqa: E402
import probe  # noqa: E402
import workday_checks as wc  # noqa: E402
from load_to_sqlite import load_resolved, open_db  # noqa: E402

failed = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failed.append(name)


check("detail url from a public url",
      wc.detail_url("https://amat.wd1.myworkdayjobs.com/en-US/External/job/RehovotISR/Analyst_R1")
      == "https://amat.wd1.myworkdayjobs.com/wday/cxs/amat/External/job/RehovotISR/Analyst_R1")
check("not a Workday url: no detail url", wc.detail_url("https://example.com/jobs/1") is None)
check("200 with a title is live", wc.verdict(200, json.dumps({"jobPostingInfo": {"title": "Analyst"}})) == "live")
check("404 is gone", wc.verdict(404, json.dumps({"errorCode": "S21", "httpStatus": 404})) == "gone")
check("403 S22 is gone", wc.verdict(403, json.dumps({"errorCode": "S22", "httpStatus": 403})) == "gone")
check("a 403 block page says nothing", wc.verdict(403, "<html>blocked</html>") is None)
check("406 says nothing", wc.verdict(406, json.dumps({"errorCode": "X"})) is None)


def read(conn, tmp, at, ids, complete=True):
    load_to_sqlite.now_iso = lambda: at
    jobs = [{"external_id": str(n), "ats": "workday", "title": f"Engineer {n}", "location": "Tel Aviv, Israel",
             "url": f"https://acme.wd1.myworkdayjobs.com/ext/job/TLV/Engineer_{n}"} for n in ids]
    path = tmp / "resolved.json"
    path.write_text(json.dumps([{"domain": "acme.com", "ats": "workday", "token": "acme:wd1:ext", "confidence": "verified",
                                 "job_count": len(ids), "complete": complete, "jobs": jobs}]), encoding="utf-8")
    with conn:
        load_resolved(conn, path)


def job(conn, n):
    return dict(conn.execute("SELECT id, closed_at, missing_since, missing_reads FROM jobs WHERE external_id = ?",
                             (str(n),)).fetchone())


probe.WORKDAY_TOTAL_LIMIT = 3  # three open jobs make the board "past the limit"
with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    conn = open_db(tmp / "t.db")
    read(conn, tmp, "2026-11-05T00:00:00+00:00", [1, 2, 3])
    read(conn, tmp, "2026-11-05T05:00:00+00:00", [1, 2], complete=False)
    asked = [url for _, url in wc.candidates(conn)]
    check("the job the latest read missed is asked, the others aren't",
          asked == ["https://acme.wd1.myworkdayjobs.com/ext/job/TLV/Engineer_3"], str(asked))

    j3, j2 = job(conn, 3)["id"], job(conn, 2)["id"]
    wc.record(conn, {j3: "gone"}, "2026-11-05T06:00:00+00:00")
    wc.record(conn, {j3: "gone"}, "2026-11-05T08:00:00+00:00")
    check("two gone answers: clock running, still open",
          job(conn, 3)["closed_at"] is None and job(conn, 3)["missing_reads"] == 2, str(job(conn, 3)))
    wc.record(conn, {j3: "gone"}, "2026-11-05T10:00:00+00:00")
    check("three gone answers inside 6 hours: still open", job(conn, 3)["closed_at"] is None, str(job(conn, 3)))
    wc.record(conn, {j3: "gone"}, "2026-11-05T12:00:00+00:00")
    check("gone for 6 hours and 3+ answers: closed", job(conn, 3)["closed_at"] == "2026-11-05T12:00:00+00:00",
          str(job(conn, 3)))

    conn.execute("UPDATE jobs SET missing_since = '2026-11-05T01:00:00+00:00', missing_reads = 2 WHERE id = ?", (j2,))
    wc.record(conn, {j2: "live"}, "2026-11-05T13:00:00+00:00")
    check("a live answer resets the clock", job(conn, 2)["missing_since"] is None and job(conn, 2)["missing_reads"] == 0,
          str(job(conn, 2)))
    conn.close()

print()
if failed:
    print(f"{len(failed)} failed")
    sys.exit(1)
print("all passed")
