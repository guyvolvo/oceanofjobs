"""precompute_handler.py: what it publishes, where, and when it refuses.

The real loader/precompute.build runs against a small database made from
db/schema.sql. The Litestream restore is a file copy and S3 and
CloudWatch are in-memory stand-ins, so this checks the handler's own
decisions: the source-version guard, shadow against live, write order,
and that an incomplete build publishes nothing.

Run directly, no framework:  python tests/test_precompute_lambda.py
"""
import os
import shutil
import sqlite3
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp())
os.environ.update({"WORK_DIR": str(TMP / "work"), "DATA_BUCKET": "data", "FRONTEND_BUCKET": "front",
                   "PRECOMPUTE_MODE": "shadow"})
(TMP / "work").mkdir()
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(ROOT / "loader"))
sys.path.insert(0, str(ROOT))

from botocore.exceptions import ClientError  # noqa: E402

import precompute  # noqa: E402
import precompute_handler as h  # noqa: E402

failed = 0


def check(name, ok, detail=""):
    global failed
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  -- {detail}"))
    failed += not ok


def make_db(path: Path, last_loaded: str) -> None:
    path.unlink(missing_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
    cols = {r[1] for r in conn.execute("PRAGMA table_info(jobs)")}
    # Columns the loader adds after schema.sql, which the live file has.
    for col in ("role_class", "country", "city", "category"):
        if col not in cols:
            conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} TEXT")
            cols.add(col)
    rows = [
        ("j1", "wix.com", "Backend Engineer", "Tel Aviv, Israel", "IL", "Software Engineering", "tech"),
        ("j2", "wix.com", "Account Executive", "Tel Aviv, Israel", "IL", "Sales & Marketing", "other"),
        ("j3", "stripe.com", "Data Engineer", "Remote", "US", "Data", "tech"),
    ]
    for jid, dom, title, loc, cc, dept, rc in rows:
        rec = {"id": jid, "company_domain": dom, "ats": "greenhouse", "external_id": jid, "title": title,
               "location": loc, "country": cc, "department": dept, "category": dept, "role_class": rc,
               "confidence": "verified", "first_seen": "2026-10-10T00:00:00+00:00",
               "last_seen": "2026-10-16T00:00:00+00:00", "posted_at": "2026-10-10T00:00:00+00:00",
               "url": f"https://x/{jid}"}
        rec = {k: v for k, v in rec.items() if k in cols}
        conn.execute("INSERT OR IGNORE INTO companies (domain, ats, first_seen, last_checked) "
                     "VALUES (?, 'greenhouse', '2026-10-01T00:00:00+00:00', '2026-10-16T00:00:00+00:00')", (dom,))
        conn.execute(f"INSERT INTO jobs ({','.join(rec)}) VALUES ({','.join('?' * len(rec))})", list(rec.values()))
    if "logo_source" not in {r[1] for r in conn.execute("PRAGMA table_info(companies)")}:
        conn.execute("ALTER TABLE companies ADD COLUMN logo_source TEXT")
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_loaded', ?)", (last_loaded,))
    conn.commit()
    conn.close()


class FakeS3:
    def __init__(self):
        self.objects, self.log = {}, []

    def head_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"Metadata": self.objects[(Bucket, Key)]["Metadata"]}

    def put_object(self, Bucket, Key, Body, Metadata=None, **kw):
        self.objects[(Bucket, Key)] = {"Body": Body, "Metadata": Metadata or {}}
        self.log.append(("put", Bucket, Key))

    def delete_object(self, Bucket, Key):
        self.objects.pop((Bucket, Key), None)
        self.log.append(("delete", Bucket, Key))


class FakeCloudWatch:
    def __init__(self):
        self.data = []

    def put_metric_data(self, Namespace, MetricData):
        self.data += MetricData


s3, cw = FakeS3(), FakeCloudWatch()
sys.modules["boto3"] = types.SimpleNamespace(client=lambda name: {"s3": s3, "cloudwatch": cw}[name])

SOURCE = TMP / "source.db"
h.restore = lambda dest: shutil.copy(SOURCE, dest)

# A shadow run publishes the pair under precomputed-shadow/, facets first.
make_db(SOURCE, "2026-10-16T10:00:00+00:00")
out = h.lambda_handler({}, None)
puts = [k for op, b, k in s3.log if op == "put"]
check("shadow: facets then stats under precomputed-shadow/, then the homepage's hot.json",
      puts == ["precomputed-shadow/facets.json", "precomputed-shadow/stats.json", "hot.json"], puts)
check("shadow: hot.json goes to the frontend bucket", ("front", "hot.json") in s3.objects)
check("shadow: every object carries the source version",
      all(o["Metadata"].get("source-version") == "2026-10-16T10:00:00+00:00" for o in s3.objects.values()))
check("shadow: the measurements come back", all(k in out for k in ("restore_s", "build_s", "peak_rss_mb", "db_mb")), out)
check("shadow: freshness and duration reported", {m["MetricName"] for m in cw.data} >=
      {"PrecomputeSourceLagSeconds", "PrecomputeDurationSeconds"})
check("the restored copy is removed afterwards", not (TMP / "work" / "jobs.db").exists())

# The same source again: nothing to do, nothing written.
s3.log.clear()
out = h.lambda_handler({}, None)
check("same source: skipped, nothing written", "skipped" in out and not s3.log, out)

# A delayed run from older data never replaces newer artifacts.
make_db(SOURCE, "2026-10-16T09:00:00+00:00")
s3.log.clear()
out = h.lambda_handler({}, None)
check("older source: skipped, nothing written", "skipped" in out and not s3.log, out)

# Newer data replaces it.
make_db(SOURCE, "2026-10-16T13:00:00+00:00")
out = h.lambda_handler({}, None)
check("newer source: published", s3.objects[("data", "precomputed-shadow/stats.json")]["Metadata"]["source-version"]
      == "2026-10-16T13:00:00+00:00")

# Live: the API's prefix, the browser's copies and the force marker.
s3.objects[("data", "precomputed/stats.json")] = {"Body": b"{}", "Metadata": {}}  # the box's, unversioned
s3.objects[("data", "precomputed/force")] = {"Body": b"", "Metadata": {}}
s3.log.clear()
out = h.lambda_handler({"mode": "live"}, None)
keys = {(b, k) for op, b, k in s3.log if op == "put"}
check("live: overwrites the box's unversioned artifact and writes the frontend copies",
      keys == {("data", "precomputed/facets.json"), ("data", "precomputed/stats.json"),
               ("front", "facets.json"), ("front", "stats.json"), ("front", "hot.json")}, keys)
check("live: clears the force marker", ("data", "precomputed/force") not in s3.objects)
check("live: the shadow prefix is left alone",
      s3.objects[("data", "precomputed-shadow/stats.json")]["Metadata"]["source-version"] == "2026-10-16T13:00:00+00:00")

# An incomplete build publishes nothing and fails loudly.
make_db(SOURCE, "2026-10-16T14:00:00+00:00")
real_build = precompute.build
precompute.build = lambda db: {"stats.json": {"totals": {"open_jobs": 3}}, "facets.json": {"all": {}}}
s3.log.clear()
try:
    h.lambda_handler({}, None)
    raised = False
except RuntimeError:
    raised = True
precompute.build = real_build
check("incomplete facets: raises, nothing written", raised and not s3.log, s3.log)

# Compacted before the build: same artifacts, both copies removed after.
make_db(SOURCE, "2026-10-16T15:00:00+00:00")
s3.log.clear()
out = h.lambda_handler({"compact": True}, None)
check("compact: builds from the vacuumed copy and publishes", "compact_s" in out and len(s3.log) == 3, out)
check("compact: no copy left behind", not any((TMP / "work").glob("jobs*.db")))

# Measuring only: builds, writes nothing.
s3.log.clear()
out = h.lambda_handler({"publish": False}, None)
check("publish=false: measured, nothing written", "build_s" in out and not s3.log, out)

# The homepage picks: senior, recent, notable, one per company, no dull
# titles, and no monthly dollar estimate that reads as yearly pay.
from datetime import datetime, timezone  # noqa: E402

HOT = TMP / "hot.db"
make_db(HOT, "2026-10-16T10:00:00+00:00")
conn = sqlite3.connect(HOT)
conn.execute("UPDATE companies SET job_count = 100, company_name = NULL")
conn.execute("INSERT INTO companies (domain, ats, first_seen, last_checked, job_count, company_name, logo_source) "
             "VALUES ('tiny.io', 'lever', '2026-10-01', '2026-10-16', 3, 'Tiny', 'none')")
hot_rows = [
    ("h1", "wix.com", "Staff Machine Learning Engineer, LLM Platform", "staff", "hybrid", "₪40K - 60K", 1, "LLM,PyTorch,Go"),
    ("h2", "wix.com", "Senior Backend Engineer", "senior", None, None, 0, ""),
    ("h3", "stripe.com", "Principal AI Researcher", "principal", "remote", "$17K - $28K", 1, "Python"),
    ("h4", "stripe.com", "IT Support Technician", None, None, None, 0, ""),
    ("h5", "tiny.io", "Staff AI Engineer", "staff", None, None, 0, ""),
]
for jid, dom, title, sen, wp, sal, est, skills in hot_rows:
    conn.execute("INSERT INTO jobs (id, company_domain, ats, title, role_class, seniority, workplace_type, salary_text,"
                 " salary_is_estimate, skills, posted_at, first_seen, last_seen, confidence) VALUES"
                 " (?, ?, 'greenhouse', ?, 'tech', ?, ?, ?, ?, ?, '2026-10-15T08:00:00+00:00',"
                 " '2026-10-15T08:00:00+00:00', '2026-10-16T00:00:00+00:00', 'verified')",
                 (jid, dom, title, sen, wp, sal, est, skills))
conn.commit()
conn.close()
hot = h.hot_jobs(HOT, now=datetime(2026, 10, 16, 12, tzinfo=timezone.utc))["jobs"]
ids = [j["id"] for j in hot]
check("hot: best title per company, recent only, dull and small-company titles out", ids == ["h1", "h3"], ids)
check("hot: shekel estimate kept with three badges", hot[0]["badges"] == ["₪40K–60K est.", "Hybrid", "Staff"],
      hot[0]["badges"])
check("hot: monthly dollar estimate dropped", not any("$" in b for b in hot[1]["badges"]), hot[1]["badges"])
check("hot: a missing name falls back to the domain's own word", hot[0]["company"] == "Wix", hot[0]["company"])

shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if failed else 0)
