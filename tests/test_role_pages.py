"""api/role_pages.py on a small in-memory database: which pages get
built, what they say, and the rules Google holds such pages to.

Run directly, no framework:  python tests/test_role_pages.py
"""
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

import role_pages  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


NOW = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE jobs (id TEXT, title TEXT, company_domain TEXT, country TEXT, city TEXT, location TEXT, workplace_type TEXT,
                   salary_text TEXT, salary_source TEXT, posted_at TEXT, first_seen TEXT, closed_at TEXT);
CREATE TABLE companies (domain TEXT, company_name TEXT);
INSERT INTO companies VALUES ('acme.com', 'Acme'), ('globex.com', 'Globex');
""")
rows = []
# 120 US data engineers, 40 of them stating a salary; 30 remote
for i in range(120):
    rows.append((f"de{i:03d}", "Senior Data Engineer", "acme.com" if i % 3 else "globex.com", "US", "New York", "New York, NY",
                 "remote" if i < 30 else "onsite", "$150,000 - $190,000" if i < 40 else None, "disclosed",
                 f"2026-10-{(i % 20) + 1:02d}", f"2026-10-{(i % 20) + 1:02d}T00:00:00+00:00", None))
# 60 data engineers in Germany: not enough for a Germany page
for i in range(60):
    rows.append((f"dd{i:03d}", "Data Engineer", "globex.com", "DE", "Berlin", "Berlin", "onsite", None, None, "2026-10-10", "2026-10-10", None))
# closed and unrelated rows never count
rows.append(("closed1", "Data Engineer", "acme.com", "US", "Austin", "Austin", "onsite", None, None, "2026-10-01", "2026-10-01", "2026-10-15"))
rows.append(("chef1", "Head Chef", "acme.com", "US", "Austin", "Austin", "onsite", None, None, "2026-10-01", "2026-10-01", None))
db.executemany("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)

out, paths = role_pages.build(db, "closed_at IS NULL", NOW)
check("a role worldwide with 180 jobs gets a page", "jobs/data-engineer.html" in out, str(sorted(out)))
check("120 in the US gets a country page", "jobs/data-engineer/united-states.html" in out)
thin = out["jobs/data-engineer/germany.html"]
check("60 in Germany is under the line: a noindex page", 'content="noindex,follow"' in thin and "60 open right now" in thin)
check("which points up to the role's page", 'href="/jobs/data-engineer"' in thin)
check("30 remote is under the line too", 'content="noindex,follow"' in out["jobs/data-engineer/remote.html"])
check("every role and place has a file", len([k for k in out if k.startswith("jobs/")]) == len(role_pages.ROLES) * len(role_pages.PLACES))
check("a built page is indexable", "noindex" not in out["jobs/data-engineer/united-states.html"])
check("the hub is built", "jobs.html" in out and "/jobs" in paths)
check("paths match the pages", set(paths) == {"/jobs", "/jobs/data-engineer", "/jobs/data-engineer/united-states"}, str(paths))

us = out["jobs/data-engineer/united-states.html"]
check("the title leads with the count", "<title>120 data engineer jobs in the United States | Ocean of Jobs</title>" in us,
      re.search(r"<title>.*?</title>", us).group(0))
check("the closed listing is not counted", "closed1" not in us)
check("no JobPosting markup on a list page", '"JobPosting"' not in us)
blocks = [json.loads(b.replace("\\u003c", "<")) for b in re.findall(r'<script type="application/ld\+json">(.*?)</script>', us)]
check("breadcrumbs and an item list instead", sorted(b["@type"] for b in blocks) == ["BreadcrumbList", "ItemList"])
items = next(b for b in blocks if b["@type"] == "ItemList")["itemListElement"]
check("the item list holds the 50 newest", len(items) == 50, str(len(items)))
check("the median salary shows once 30 listings state one", "$170,000" in us and "from 40 listings" in us)
check("the remote share is counted", "25%" in us and "30 of 120" in us)
check("company names come from the companies table", "Acme" in us and "Globex" in us)
check("the board link carries the role and country", "/board?search=data+engineer&amp;country=US" in us)
check("the worldwide page links down to the country page", 'href="/jobs/data-engineer/united-states"' in out["jobs/data-engineer.html"])
check("no link to a page that was not built", '"/jobs/data-engineer/germany"' not in out["jobs/data-engineer.html"])

check("roles_for matches several roles", role_pages.roles_for("Senior ML Engineer, Generative AI") == ["ai-engineer", "machine-learning-engineer"],
      str(role_pages.roles_for("Senior ML Engineer, Generative AI")))
check("roles_for skips other jobs", role_pages.roles_for("Head Chef") == [])
check("AI keeps its capitals", role_pages.heading("ai-engineer", "remote") == "Remote AI engineer jobs")

# Job pages link to role pages the last build made indexable (api/handler.py _role_links).
import os  # noqa: E402
import tempfile  # noqa: E402
tmp = Path(tempfile.mkdtemp())
(tmp / "role-pages.json").write_text(json.dumps(["/jobs/data-engineer", "/jobs/data-engineer/united-states", "/jobs/data-engineer/remote"]))
for k, v in {"DATA_PATH": str(tmp / "jobs.db"), "ALERTS_TABLE": "t", "DATA_BUCKET": "b", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "x", "AWS_SECRET_ACCESS_KEY": "x"}.items():
    os.environ.setdefault(k, v)
import handler  # noqa: E402
links = handler._role_links({"title": "Senior Data Engineer", "country": "US", "workplace_type": "remote"})
check("a remote US data engineer links to the country, remote and worldwide pages",
      links == [("/jobs/data-engineer/united-states", "Data engineer jobs in the United States"),
                ("/jobs/data-engineer/remote", "Remote data engineer jobs"), ("/jobs/data-engineer", "Data engineer jobs worldwide")], str(links))
check("no links to pages that are not indexable",
      handler._role_links({"title": "Data Engineer", "country": "DE", "workplace_type": "onsite"}) == [("/jobs/data-engineer", "Data engineer jobs worldwide")])
check("other jobs get none", handler._role_links({"title": "Head Chef", "country": "US"}) == [])

print()
if failures:
    print("%d failed" % len(failures))
    sys.exit(1)
print("all passed")
