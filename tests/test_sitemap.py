"""The generated sitemap lists what the board shows, and nothing else.

Run directly, no framework:  python tests/test_sitemap.py
"""

import json
import re
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))
sys.path.insert(0, str(ROOT / "api"))

import sitemap  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


NOW = datetime(2026, 9, 18, 12, 0, tzinfo=timezone.utc)
tmp = Path(tempfile.mkdtemp())
db = tmp / "jobs.db"
conn = sqlite3.connect(db)
conn.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
conn.execute("INSERT INTO companies (domain, ats, first_seen, last_checked, company_name) VALUES ('wix.com','greenhouse','2026-09-01','2026-09-18','Wix')")


def job(jid, posted, first_seen="2026-09-10T08:00:00+00:00", closed=None, title="Engineer", desc="Build & ship", chars=900):
    conn.execute("INSERT INTO jobs (id, company_domain, ats, title, location, department, url, posted_at, first_seen, last_seen, closed_at, description, description_chars, confidence)"
                 " VALUES (?, 'wix.com', 'greenhouse', ?, 'Tel Aviv, Israel', 'R&D', 'https://x/y', ?, ?, '2026-09-18T11:00:00+00:00', ?, ?, ?, 'verified')",
                 (jid, title, posted, first_seen, closed, desc, chars))


# Shard size is shrunk so sharding is exercised without 80,001 rows.
sitemap.SHARD = 3
job("a1", "2026-09-17T10:00:00+00:00")
job("a2", None)                                            # no source date: first_seen stands in
job("a3", "2026-09-16T10:00:00+00:00", title="Dev <Lead>")
job("a4", "2026-09-15T10:00:00+00:00")                    # second shard
job("closed1", "2026-09-14T10:00:00+00:00", closed="2026-09-17T00:00:00+00:00")
job("stale1", "2024-01-01T10:00:00+00:00")                # older than the freshness window
conn.commit()
conn.close()

docs = sitemap.build(db, NOW)
pages_az = {k: docs.pop(f"companies/{k}.html") for k in sitemap.LETTERS}
# Role pages (api/role_pages.py, tested in test_role_pages.py) ride along as HTML.
roles = {k: docs.pop(k) for k in [k for k in docs if k == "jobs.html" or k.startswith("jobs/")]}
check("the indexable role pages are listed as JSON", isinstance(json.loads(docs.pop("role-pages.json")[0]), list))
check("every role and place gets an HTML file", len(roles) >= 80 and all(v[1].startswith("text/html") for v in roles.values()), str(len(roles)))
check("an index, a pages sitemap, the feed, two job shards and a company shard",
      sorted(docs) == ["feed.xml", "sitemap-companies-1.xml", "sitemap-jobs-1.xml", "sitemap-jobs-2.xml", "sitemap-pages.xml", "sitemap.xml"], repr(sorted(docs)))
w = pages_az["w"][0].decode("utf-8")
check("the directory links each company under its name's first letter, with its open count",
      '<a href="/company/wix.com">Wix</a> <span>4 open tech jobs</span>' in w and "noindex" not in w
      and '<link rel="canonical" href="https://oceanofjobs.com/companies/w" />' in w, w[-900:])
check("every letter has a page that links to every other letter",
      all(p[1].startswith("text/html") and p[0].count(b'href="/companies/') == len(sitemap.LETTERS) for p in pages_az.values()))
check("a letter with no company is kept out of the index but still followed",
      b'content="noindex,follow"' in pages_az["q"][0] and b"/company/" not in pages_az["q"][0])
companies = docs["sitemap-companies-1.xml"][0].decode("utf-8")
check("the company page is listed once, with the newest open listing's arrival as lastmod",
      companies.count("<loc>https://oceanofjobs.com/company/wix.com</loc>") == 1
      and "<loc>https://oceanofjobs.com/company/wix.com</loc><lastmod>2026-09-10T08:00:00Z</lastmod>" in companies, companies[:400])

idx = ET.fromstring(docs["sitemap.xml"][0])
ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
locs = [e.text for e in idx.findall("s:sitemap/s:loc", ns)]
check("the index names every file by absolute URL",
      locs == ["https://oceanofjobs.com/sitemap-pages.xml", "https://oceanofjobs.com/sitemap-jobs-1.xml",
               "https://oceanofjobs.com/sitemap-jobs-2.xml", "https://oceanofjobs.com/sitemap-companies-1.xml"], repr(locs))
check("index entries carry the build time", all(e.text == "2026-09-18T12:00:00Z" for e in idx.findall("s:sitemap/s:lastmod", ns)))

s1 = ET.fromstring(docs["sitemap-jobs-1.xml"][0])
s2 = ET.fromstring(docs["sitemap-jobs-2.xml"][0])
urls1 = [e.text for e in s1.findall("s:url/s:loc", ns)]
urls2 = [e.text for e in s2.findall("s:url/s:loc", ns)]
check("open, fresh listings only, at their own pages, in id order across shards",
      urls1 == [f"https://oceanofjobs.com/job/{i}" for i in ("a1", "a2", "a3")]
      and urls2 == ["https://oceanofjobs.com/job/a4"], repr((urls1, urls2)))

# Title-only listings wait for a description, from the column or the
# nightly backfill's list.
bare = sqlite3.connect(":memory:")
bare.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
bare.execute("INSERT INTO companies (domain, ats, first_seen, last_checked) VALUES ('wix.com','greenhouse','2026-09-01','2026-09-18')")
for jid, chars in (("full", 900), ("bare1", 0), ("bare2", 0)):
    bare.execute("INSERT INTO jobs (id, company_domain, ats, title, url, posted_at, first_seen, last_seen, description_chars, confidence)"
                 " VALUES (?, 'wix.com', 'greenhouse', 'Engineer', 'https://x/y', '2026-09-17T10:00:00+00:00', '2026-09-17T10:00:00+00:00',"
                 " '2026-09-18T11:00:00+00:00', ?, 'verified')", (jid, chars))
listed = "".join(sitemap.job_shards(bare, frozenset({"bare2"})))
check("a title-only listing waits until it has a description",
      "/job/full<" in listed and "/job/bare2<" in listed and "/job/bare1<" not in listed, listed[-400:])
check("closed and outdated listings are left out",
      not any("closed1" in u or "stale1" in u for u in urls1 + urls2))
mods = {e.find("s:loc", ns).text.rsplit("/", 1)[1]: (e.find("s:lastmod", ns).text if e.find("s:lastmod", ns) is not None else None)
        for e in s1.findall("s:url", ns)}
check("lastmod is the posting date, in UTC with a Z", mods["a1"] == "2026-09-17T10:00:00Z", repr(mods))
check("a listing without a source date uses when the board first saw it", mods["a2"] == "2026-09-10T08:00:00Z", repr(mods))

pages = ET.fromstring(docs["sitemap-pages.xml"][0])
entries = {e.find("s:loc", ns).text: (e.find("s:lastmod", ns).text if e.find("s:lastmod", ns) is not None else None)
           for e in pages.findall("s:url", ns)}
check("the site pages, with the board and Explore dated to the snapshot and the rest undated",
      entries == {"https://oceanofjobs.com/": None, "https://oceanofjobs.com/board": "2026-09-18T12:00:00Z",
                  "https://oceanofjobs.com/stats": "2026-09-18T12:00:00Z", "https://oceanofjobs.com/companies": "2026-09-18T12:00:00Z",
                  "https://oceanofjobs.com/docs": None, "https://oceanofjobs.com/docs/mcp": None, "https://oceanofjobs.com/docs/extension": None,
                  "https://oceanofjobs.com/docs/api": None,
                  "https://oceanofjobs.com/contact": None, "https://oceanofjobs.com/privacy": None,
                  "https://oceanofjobs.com/pricing": None, "https://oceanofjobs.com/terms": None, "https://oceanofjobs.com/refunds": None,
                  **{f"https://oceanofjobs.com/companies/{k}": "2026-09-18T12:00:00Z" for k in sitemap.LETTERS}}, repr(entries))

rss = ET.fromstring(docs["feed.xml"][0])
items = rss.findall("channel/item")
check("the feed is newest first and skips closed and stale listings",
      [i.find("link").text.rsplit("/", 1)[1] for i in items] == ["a1", "a3", "a4", "a2"],
      repr([i.find("link").text for i in items]))
first = items[0]
check("an item has a title with the company, a permalink guid, a date and a description",
      first.find("title").text == "Engineer at Wix" and first.find("guid").text == "https://oceanofjobs.com/job/a1"
      and first.find("pubDate").text.startswith("Thu, 17 Sep 2026") and "Wix · Tel Aviv, Israel · R&D. " in first.find("description").text and "—" not in first.find("description").text,
      repr((first.find("title").text, first.find("pubDate").text, first.find("description").text)))
check("escaping survives a title with angle brackets and an ampersand in the blurb",
      any(i.find("title").text == "Dev <Lead> at Wix" for i in items) and "Build & ship" in items[0].find("description").text)
check("every document declares UTF-8 and parses as XML", all(b.startswith(b'<?xml version="1.0" encoding="UTF-8"?>') for b, _ in docs.values()))
check("content types are XML and RSS", docs["sitemap.xml"][1].startswith("application/xml") and docs["feed.xml"][1].startswith("application/rss+xml"))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
