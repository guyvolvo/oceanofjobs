"""sitemap.xml, its shards, and feed.xml, generated from the snapshot.

A sitemap that is a hand-edited file goes stale the day the site
changes, and a sitemap of 271,000 listings cannot be hand-edited at all.
So the merge, which is the one process that knows what is open right
now and already publishes bootstrap.json and stats.json beside the
snapshot it just built, writes these too.

What goes in: every listing the board would show, meaning open and
inside the freshness window, at its own page /job/<id>, and every
company with at least one such listing at /company/<domain>, with the
newest open listing's arrival as lastmod (that is when the page last
gained a row). Closed listings
are left out the day they close; api/job_page.py keeps their page up
for thirty days with a "closed" notice and noindex, then answers 410,
so a crawler that already has the URL is told plainly rather than fed
an empty shell.

lastmod is the listing's posting date, or when the board first saw it
for a listing whose source gives no date. It is deliberately not
last_seen, which moves every time a board is polled and would tell a
crawler that 271,000 pages changed this morning.

Shards of 40,000, under the 50,000 limit with room to spare, listed in
a sitemap index. The pages sitemap carries the five hand-built pages;
the board and Explore get the snapshot time as lastmod, since their
content changes with it, and the others carry none rather than a
number nobody can stand behind.

feed.xml is the newest hundred, the same ordering as bootstrap.json,
for readers, aggregators and anyone who wants the new listings without
polling the API.

companies/<letter>.html is the same company list as plain links, one
page per first letter, served at /companies/a and so on. /companies
itself is drawn in the browser, so without these a crawler had no way
from the homepage to a company page except the sitemap, and Google
left 258,032 sitemap-only URLs at "Discovered, not indexed"
(2026-10-20). Company pages link on to every job they list.

Publishing is best effort and rate limited to once an hour: the
generation reads every open row, and a five-minute cadence would spend
most of the applier's time rewriting files a crawler reads daily.
"""

import html
import json
import sqlite3
import sys
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "api"))

from job_filters import FRESH_CLAUSE  # noqa: E402
from page_chrome import FOOT, fmt_int, head, topbar  # noqa: E402

SITE = "https://oceanofjobs.com"
SHARD = 40_000
FEED_ITEMS = 100
# Six hours. Crawlers fetch a sitemap daily at best; hourly rebuilds
# were a minute of disk each for nothing (2026-10-01).
MAX_AGE_S = 6 * 3600

# (path, lastmod follows the snapshot?)
PAGES = [("/", False), ("/board", True), ("/stats", True), ("/companies", True),
         ("/docs", False), ("/docs/mcp", False), ("/docs/extension", False), ("/docs/api", False), ("/contact", False), ("/privacy", False),
         ("/pricing", False), ("/terms", False), ("/refunds", False)]

# The directory's pages: a to z, and one for names that start with a
# digit or anything else.
LETTERS = [chr(c) for c in range(ord("a"), ord("z") + 1)] + ["0-9"]

# Tech roles only, which is what the board itself shows by default
# (frontend/app.js opens on roles=tech) and what the product claims to
# be. Without it this offered Google 923,794 URLs, of which about
# 700,000 were roles the default view does not even display.
#
# Not a memory fix, though it is one: 102MB of generated XML down to
# about 24MB, and a build that took 392 seconds and 433MB. The reason
# is crawl budget. Measured on the live site, Google had indexed 450
# pages out of 271k submitted, so the constraint is plainly not how
# many URLs are on offer, and concentrating what little crawling this
# domain earns onto the 219,224 listings that match the product is the
# only lever here that could move it.
#
# role_class is NULL until classify_roles has read a listing, so this
# also holds back brand-new rows for a cycle rather than publishing a
# URL before the board would show it.
_OPEN = f"closed_at IS NULL AND {FRESH_CLAUSE}"
_OPEN_TECH = f"closed_at IS NULL AND role_class = 'tech' AND {FRESH_CLAUSE}"


def open_clause(conn: sqlite3.Connection) -> str:
    """The open-listings test, narrowed to tech where the snapshot can.

    Checked rather than assumed, the same way handler.py drops a roles
    filter against a snapshot that predates the column: a partition or
    an older file has no role_class, and asking for one is an error
    rather than an empty sitemap. Falling back to every open listing is
    the behaviour this had before, which is wrong in the same direction
    as it always was rather than newly broken.
    """
    try:
        if any(r[1] == "role_class" for r in conn.execute("PRAGMA table_info(jobs)")):
            return _OPEN_TECH
    except sqlite3.Error:
        pass
    return _OPEN


def _w3c(ts: str | None, fallback: str | None = None) -> str | None:
    """A stored ISO timestamp as sitemaps want it, UTC with a Z."""
    for v in (ts, fallback):
        if not v:
            continue
        try:
            d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            continue
        d = d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return None


def _url(loc: str, lastmod: str | None) -> str:
    tail = f"<lastmod>{lastmod}</lastmod>" if lastmod else ""
    return f"  <url><loc>{html.escape(loc, quote=True)}</loc>{tail}</url>\n"


def pages_sitemap(now: datetime, role_paths: list[str] = ()) -> str:
    stamp = now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = "".join(_url(SITE + path, stamp if follows else None)
                   for path, follows in PAGES + [(f"/companies/{k}", True) for k in LETTERS] + [(p, True) for p in role_paths])
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n")


def job_shards(conn: sqlite3.Connection, described: frozenset = frozenset()) -> list[str]:
    """One XML document per shard, in id order so a listing keeps its
    shard between runs and a crawler's per-file bookkeeping stays useful.

    Only listings with a description: 22% of open tech listings were a
    title alone (2026-10-21), and a crawler that rarely visits should
    spend its visits on pages with something to read. described is the
    nightly backfill's list (box/describe_backfill.py), whose text lives
    only in S3; a listing joins the sitemap the night it gets one."""
    rows = [r for r in conn.execute(
        f"SELECT id, posted_at, first_seen, COALESCE(description_chars, 0) FROM jobs WHERE {open_clause(conn)} ORDER BY id")
        if r[3] >= 200 or r[0] in described]
    shards = []
    for start in range(0, len(rows), SHARD):
        body = "".join(_url(f"{SITE}/job/{r[0]}", _w3c(r[1], r[2])) for r in rows[start:start + SHARD])
        shards.append('<?xml version="1.0" encoding="UTF-8"?>\n'
                      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n")
    return shards


def company_rows(conn: sqlite3.Connection) -> list[tuple]:
    """(domain, newest arrival, open listings, name) per company with an
    open listing, read once for both the sitemap and the directory."""
    has_name = any(r[1] == "company_name" for r in conn.execute("PRAGMA table_info(companies)"))
    name_sql = ("(SELECT company_name FROM companies WHERE domain = jobs.company_domain)" if has_name else "NULL")
    return [tuple(r) for r in conn.execute(
        f"""
        SELECT company_domain, MAX(first_seen), COUNT(*), {name_sql} FROM jobs WHERE {open_clause(conn)}
        GROUP BY company_domain ORDER BY company_domain
        """).fetchall() if r[0]]


def company_shards(rows: list[tuple]) -> list[str]:
    """Companies with an open listing, at /company/<domain>."""
    shards = []
    for start in range(0, len(rows), SHARD):
        body = "".join(_url(f"{SITE}/company/{r[0]}", _w3c(r[1])) for r in rows[start:start + SHARD])
        shards.append('<?xml version="1.0" encoding="UTF-8"?>\n'
                      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n")
    return shards


def _letter(name: str) -> str:
    c = name.strip()[:1].lower()
    return c if "a" <= c <= "z" else "0-9"


def directory_pages(rows: list[tuple]) -> dict[str, str]:
    """{letter: HTML}: every company, by name, as a link to its page."""
    by_letter: dict[str, list[tuple[str, str, int]]] = {k: [] for k in LETTERS}
    for domain, _, n, name in rows:
        label = (name or "").strip() or domain
        by_letter[_letter(label)].append((label, domain, n))
    pages = {}
    for key, items in by_letter.items():
        items.sort(key=lambda t: (t[0].casefold(), t[1]))
        shown = "0 to 9" if key == "0-9" else key.upper()
        nav = "".join(
            f'<a href="/companies/{k}"' + (' aria-current="page"' if k == key else "") + f">{'0-9' if k == '0-9' else k.upper()}</a>"
            for k in LETTERS)
        body = "".join(
            f'<li><a href="/company/{html.escape(d, quote=True)}">{html.escape(label)}</a>'
            f' <span>{fmt_int(n)} open</span></li>' for label, d, n in items)
        title = f"Companies hiring, {shown} | Ocean of Jobs"
        what = (f"{fmt_int(len(items))} companies starting with {shown} that have open roles on Ocean of Jobs."
                if items else f"No company starting with {shown} has open roles right now.")
        pages[key] = (head(title, what, f"{SITE}/companies/{key}", robots=None if items else "noindex,follow",
                           og_type="website")
                      + topbar("companies")
                      + f"""  <main class="pg-main" id="main" tabindex="-1">
    <div class="pg-article dir-az-page">
      <h1 class="job-page-title pg-title">Companies hiring, {shown}</h1>
      <p>{html.escape(what)} <a href="/companies">Search and filter all companies</a>.</p>
      <nav class="dir-az" aria-label="Companies by first letter">{nav}</nav>
      <ul class="dir-az-list">{body}</ul>
    </div>
  </main>
{FOOT}""")
    return pages


def index(shard_count: int, now: datetime, company_shard_count: int = 0) -> str:
    stamp = now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    names = (["sitemap-pages.xml"] + [f"sitemap-jobs-{i}.xml" for i in range(1, shard_count + 1)]
             + [f"sitemap-companies-{i}.xml" for i in range(1, company_shard_count + 1)])
    body = "".join(f"  <sitemap><loc>{SITE}/{n}</loc><lastmod>{stamp}</lastmod></sitemap>\n" for n in names)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</sitemapindex>\n")


def feed(conn: sqlite3.Connection, now: datetime) -> str:
    has_name = any(r[1] == "company_name" for r in conn.execute("PRAGMA table_info(companies)"))
    name_sql = ("(SELECT company_name FROM companies WHERE domain = jobs.company_domain)" if has_name else "NULL")
    rows = conn.execute(
        f"""
        SELECT id, title, company_domain, {name_sql} AS company_name, location, department,
               posted_at, first_seen, substr(COALESCE(description, ''), 1, 400) AS blurb
        FROM jobs WHERE {open_clause(conn)}
        ORDER BY posted_at IS NULL, datetime(posted_at) DESC, id DESC
        LIMIT ?
        """, (FEED_ITEMS,)).fetchall()
    items = []
    for r in rows:
        link = f"{SITE}/job/{r['id']}"
        company = r["company_name"] or r["company_domain"]
        when = _w3c(r["posted_at"], r["first_seen"])
        pub = format_datetime(datetime.fromisoformat(when.replace("Z", "+00:00"))) if when else ""
        where = (r["location"] or "").strip()
        summary = " · ".join(x for x in (company, where, r["department"]) if x)
        blurb = (r["blurb"] or "").strip()
        desc = summary + (f" — {blurb}" if blurb else "")
        items.append(
            "    <item>\n"
            f"      <title>{html.escape(r['title'])} at {html.escape(company)}</title>\n"
            f"      <link>{link}</link>\n"
            f'      <guid isPermaLink="true">{link}</guid>\n'
            + (f"      <pubDate>{pub}</pubDate>\n" if pub else "")
            + f"      <description>{html.escape(desc)}</description>\n"
            + (f"      <category>{html.escape(r['department'])}</category>\n" if r["department"] else "")
            + "    </item>\n")
    built = format_datetime(now.astimezone(timezone.utc))
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n'
            "  <channel>\n"
            "    <title>Ocean of Jobs newest listings</title>\n"
            f"    <link>{SITE}/board</link>\n"
            f'    <atom:link href="{SITE}/feed.xml" rel="self" type="application/rss+xml" />\n'
            "    <description>The newest listings on OceanOfJobs.com, the open-source job board.</description>\n"
            "    <language>en</language>\n"
            f"    <lastBuildDate>{built}</lastBuildDate>\n"
            + "".join(items)
            + "  </channel>\n</rss>\n")


def build(db_path: Path, now: datetime | None = None) -> dict[str, tuple[bytes, str]]:
    """{key: (body, content type)} for everything to publish."""
    now = now or datetime.now(timezone.utc)
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        # shortcut: described-ids.txt also holds listings whose source had
        # no text, about 2% of it; split the file if that grows.
        done = db_path.with_name("described-ids.txt")
        shards = job_shards(conn, frozenset(done.read_text().split()) if done.exists() else frozenset())
        rows = company_rows(conn)
        companies = company_shards(rows)
        rss = feed(conn, now)
        # shortcut: the maintenance Lambda (schedule disabled since the box
        # took over) packages this file without api/role_pages.py and its
        # imports, so it publishes without role pages. Add them to
        # deploy-scrape-lambda.yml's cp lines if that Lambda comes back.
        try:
            import role_pages
        except ImportError:
            roles, role_paths = {}, []
        else:
            roles, role_paths = role_pages.build(conn, open_clause(conn), now)
    finally:
        conn.close()
    xml = "application/xml; charset=utf-8"
    out = {
        "sitemap.xml": (index(len(shards), now, len(companies)).encode("utf-8"), xml),
        "sitemap-pages.xml": (pages_sitemap(now, role_paths).encode("utf-8"), xml),
        "feed.xml": (rss.encode("utf-8"), "application/rss+xml; charset=utf-8"),
    }
    for i, doc in enumerate(shards, 1):
        out[f"sitemap-jobs-{i}.xml"] = (doc.encode("utf-8"), xml)
    for i, doc in enumerate(companies, 1):
        out[f"sitemap-companies-{i}.xml"] = (doc.encode("utf-8"), xml)
    for key, page in directory_pages(rows).items():
        out[f"companies/{key}.html"] = (page.encode("utf-8"), "text/html; charset=utf-8")
    for key, page in roles.items():
        out[key] = (page.encode("utf-8"), "text/html; charset=utf-8")
    # Which role pages are indexable, for job pages to link to (api/handler.py).
    out["role-pages.json"] = (json.dumps(role_paths).encode("utf-8"), "application/json")
    return out


def _fresh_enough(s3, bucket: str) -> bool:
    """Whether the published sitemap is under MAX_AGE_S old.

    Says why when it cannot tell. The first deploy answered False on
    every run because the role could write these keys but not HEAD
    them, and a silent False meant 30MB republished every five minutes
    with nothing in the log to say so. A missing object is the normal
    first-run case; anything else is a problem worth a line.
    """
    try:
        head = s3.head_object(Bucket=bucket, Key="sitemap.xml")
    except Exception as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code", "")
        if code not in ("404", "NoSuchKey", "NotFound"):
            print(f"sitemap age check failed ({code or e!r}), publishing anyway", file=sys.stderr)
        return False
    age = (datetime.now(timezone.utc) - head["LastModified"]).total_seconds()
    if age < MAX_AGE_S:
        print(f"sitemap is {age:.0f}s old, leaving it", file=sys.stderr)
        return True
    return False


def publish(frontend_bucket: str, db_path: Path, tmp: Path | None = None) -> list[str]:
    """Write everything to the frontend bucket. Returns the keys written,
    [] on any failure: a merge that has already pushed its snapshot must
    not fail over a sitemap."""
    if not frontend_bucket:
        return []
    try:
        import boto3

        s3 = boto3.client("s3")
        if _fresh_enough(s3, frontend_bucket):
            return []
        docs = build(db_path)
        if tmp:
            (Path(tmp) / "role-pages.json").write_bytes(docs["role-pages.json"][0])
        written = []
        # Shards first, the index last, so a crawler that reads the new
        # index never asks for a shard that is not there yet.
        for key in sorted(docs, key=lambda k: (k == "sitemap.xml", k)):
            body, ctype = docs[key]
            s3.put_object(Bucket=frontend_bucket, Key=key, Body=body, ContentType=ctype,
                          CacheControl="public, max-age=3600")
            written.append(key)
        # A shard count that shrank leaves old files behind; the index no
        # longer names them, but a crawler that remembers them would get
        # a stale list. Deleting a key that is not there is not an error.
        for prefix in ("sitemap-jobs-", "sitemap-companies-"):
            count = sum(1 for k in docs if k.startswith(prefix))
            for i in range(count + 1, count + 4):
                s3.delete_object(Bucket=frontend_bucket, Key=f"{prefix}{i}.xml")
        shard_count = sum(1 for k in docs if k.startswith("sitemap-jobs-"))
        total = sum(len(b) for b, _ in docs.values())
        print(f"published {len(written)} sitemap/feed files ({total} bytes, {shard_count} job shards)", file=sys.stderr)
        return written
    except Exception as e:
        print(f"sitemap publish failed (non-fatal): {e!r}", file=sys.stderr)
        return []
