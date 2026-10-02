"""The listing and company pages' cache headers.

A crawler walking the sitemap asked for 70 to 95 listing pages a minute,
each a miss at the edge at ten minutes. Open pages now carry a six-hour
s-maxage; misses and gone pages keep a short browser-only lifetime so a
mistyped or retired URL does not sit at the edge.

Run directly, no framework:  python tests/test_page_cache.py
"""
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

DB = Path(tempfile.mkdtemp()) / "jobs.db"
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing",
             "AWS_SECRET_ACCESS_KEY": "testing", "DATA_PATH": str(DB)}.items():
    os.environ[k] = v

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


NOW = datetime.now(timezone.utc)
ago = lambda d: (NOW - timedelta(days=d)).isoformat(timespec="seconds")  # noqa: E731
OPEN_ID, OLD_ID = "a1b2c3d4e5f6a7b8", "d1b2c3d4e5f6a7b8"

conn = sqlite3.connect(DB)
conn.executescript("""
CREATE TABLE jobs (id TEXT PRIMARY KEY, company_domain TEXT, ats TEXT, external_id TEXT, title TEXT, location TEXT,
  department TEXT, category TEXT, seniority TEXT, workplace_type TEXT, url TEXT, posted_at TEXT, confidence TEXT,
  first_seen TEXT, last_seen TEXT, closed_at TEXT, skills TEXT, description TEXT, country TEXT, city TEXT,
  salary_text TEXT, salary_is_estimate INT, salary_source TEXT, role_class TEXT);
CREATE TABLE companies (domain TEXT PRIMARY KEY, ats TEXT, company_name TEXT, logo_url TEXT, first_seen TEXT, error TEXT);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO companies VALUES ('wix.com', 'greenhouse', 'Wix', NULL, '2026-01-01', NULL);
""")
for jid, closed in ((OPEN_ID, None), (OLD_ID, ago(60))):
    conn.execute("INSERT INTO jobs (id, company_domain, ats, external_id, title, location, url, posted_at, confidence, "
                 "first_seen, last_seen, closed_at, country, city) VALUES (?, 'wix.com', 'greenhouse', ?, 'Engineer', "
                 "'Tel Aviv, Israel', 'https://x/y', ?, 'verified', ?, ?, ?, 'IL', 'Tel Aviv')",
                 (jid, jid, ago(3), ago(3), ago(0), closed))
conn.commit()
conn.close()

import handler  # noqa: E402

handler._description_from_s3 = lambda job_id: None


def cache_of(resp):
    return {k.lower(): v for k, v in (resp.get("headers") or {}).items()}.get("cache-control", "")


six_hours = "s-maxage=21600"
r = handler.route_job_page(OPEN_ID)
check("an open listing page is kept six hours at the edge, ten minutes in the browser",
      r["statusCode"] == 200 and six_hours in cache_of(r) and "max-age=600" in cache_of(r), cache_of(r))
r = handler.route_company_page("wix.com")
check("a company page is kept six hours at the edge", r["statusCode"] == 200 and six_hours in cache_of(r), cache_of(r))
r = handler.route_job_page(OLD_ID)
check("a listing closed long ago is 410 with no edge lifetime", r["statusCode"] == 410 and "s-maxage" not in cache_of(r),
      f"{r['statusCode']} {cache_of(r)}")
r = handler.route_job_page("ffffffffffffffff")
check("an unknown listing is 404 with no edge lifetime", r["statusCode"] == 404 and "s-maxage" not in cache_of(r),
      f"{r['statusCode']} {cache_of(r)}")
r = handler.route_company_page("nobody.example")
check("an unknown company is 404 with no edge lifetime", r["statusCode"] == 404 and "s-maxage" not in cache_of(r),
      f"{r['statusCode']} {cache_of(r)}")
tf = (ROOT / "infra" / "cloudfront.tf").read_text(encoding="utf-8")
block = tf[tf.find('resource "aws_cloudfront_cache_policy" "job_page"'):]
block = block[:block.find("\n}\n")]
check("the CloudFront page policy allows the full six hours", "max_ttl = 21600" in block, block[:300])

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
