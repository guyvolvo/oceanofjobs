"""Role pages: /jobs, /jobs/<role> and /jobs/<role>/<place>.

People search for a role and a place ("data engineer jobs in Germany",
"remote AI engineer jobs") and the site had no page answering that, only
the listings themselves. These are those pages: the open count, who is
hiring, where, what employers say they pay, and the newest fifty
listings, each linking to its own page. They also give a crawler a path
into the listings, which the sitemap alone did not (450 of 271k
indexed, 2026-10-20).

Static HTML, built with the sitemap (loader/sitemap.py) from the same
open set and on the same six-hour cadence, and served from the bucket,
so a visit costs the box nothing.

Google's spam policy names doorway pages: many near-identical pages for
places that funnel to one destination. So the set is small and fixed
(ROLES x PLACES), every page is a page of its own data, and a page is
only built when it has at least MIN_JOBS listings. Pages carry no
JobPosting markup, which Google's rules keep for a listing's own page.
"""

import html
import re
import sqlite3
from collections import Counter
from datetime import datetime, timedelta, timezone
from heapq import heappush, heappushpop
from urllib.parse import urlencode

from countries import label_for
from job_page import base_salary
from page_chrome import FOOT, fmt_int, head, plural, short_date, topbar
from titles import split_title

SITE = "https://oceanofjobs.com"
MIN_JOBS = 100
LISTED = 50
SALARY_MIN_FIGURES = 30

# (slug, heading, words in a sentence, board search, title pattern)
ROLES = [
    ("software-engineer", "Software engineer", "software engineer", "software engineer",
     r"\bsoftware\b.*\b(engineer|developer)\b|\b(developer|programmer)\b|\bswe\b|\bfull[ -]?stack\b|\b(back|front)[ -]?end engineer"),
    ("ai-engineer", "AI engineer", "AI engineer", "ai engineer",
     r"\b(ai|genai|gen ai|generative ai|llm|artificial intelligence)\b.*\b(engineer|developer|architect|researcher)\b"
     r"|\b(engineer|developer|architect)\b.*\b(ai|genai|generative ai|llm|artificial intelligence)\b"),
    ("machine-learning-engineer", "Machine learning engineer", "machine learning engineer", "machine learning engineer",
     r"\b(machine learning|ml|mlops)\b.*\b(engineer|developer)\b"),
    ("data-engineer", "Data engineer", "data engineer", "data engineer", r"\bdata (platform )?engineer"),
    ("data-scientist", "Data scientist", "data scientist", "data scientist", r"\bdata scien"),
    ("data-analyst", "Data analyst", "data analyst", "data analyst", r"\b(data|business intelligence|bi) analyst"),
    ("devops-engineer", "DevOps engineer", "DevOps engineer", "devops",
     r"\bdev ?ops\b|\bplatform engineer|\bsite reliability|\bsre\b"),
    ("cybersecurity", "Cybersecurity", "cybersecurity", "security",
     r"\bcyber ?security|\bsecurity (engineer|analyst|architect|researcher)|\bsoc analyst|\bappsec\b|\binfosec\b|\bpenetration tester"),
    ("product-manager", "Product manager", "product manager", "product manager", r"\bproduct (manager|owner)\b"),
    ("full-stack-developer", "Full stack developer", "full stack developer", "full stack", r"\bfull[ -]?stack"),
]
_MATCH = [(slug, re.compile(rx, re.I)) for slug, _, _, _, rx in ROLES]
ROLE = {r[0]: r for r in ROLES}

# (slug, country code, "in the United States", currency, salary period)
# The empty slug is the role's own page, every country.
PLACES = [
    ("", "", "", "USD", "YEAR"),
    ("remote", "", "", "USD", "YEAR"),
    ("united-states", "US", "in the United States", "USD", "YEAR"),
    ("united-kingdom", "GB", "in the United Kingdom", "GBP", "YEAR"),
    ("germany", "DE", "in Germany", "EUR", "YEAR"),
    ("india", "IN", "in India", "INR", "YEAR"),
    ("canada", "CA", "in Canada", "CAD", "YEAR"),
    ("israel", "IL", "in Israel", "ILS", "MONTH"),
]
PLACE = {p[0]: p for p in PLACES}
_SYMBOL = {"USD": "$", "GBP": "£", "EUR": "€", "INR": "₹", "CAD": "CA$", "ILS": "₪"}
# Below these a parsed figure is a misread, not a salary: "₹10L" reads as
# 10, "€50.000" as 50, "$50 - $70" an hourly rate with no unit.
_FLOOR = {"USD": 10_000, "GBP": 10_000, "EUR": 10_000, "CAD": 10_000, "INR": 100_000, "ILS": 3_000}


def roles_for(title: str) -> list[str]:
    """Role slugs a listing title belongs to, in ROLES order."""
    return [slug for slug, rx in _MATCH if rx.search(title or "")]


def path_for(role: str, place: str = "") -> str:
    return f"/jobs/{role}" + (f"/{place}" if place else "")


class _Page:
    """Everything one page shows, gathered in one pass over the rows."""

    def __init__(self):
        self.n = 0
        self.companies = Counter()
        self.places = Counter()
        self.remote = 0
        self.new_7d = 0
        self.salaries = []
        self.newest = []  # heap of (date, id, row), oldest on top

    def add(self, row, where, date, new, salary):
        self.n += 1
        self.companies[row["company_domain"]] += 1
        if where:
            self.places[where] += 1
        self.remote += row["workplace_type"] == "remote"
        self.new_7d += new
        if salary is not None:
            self.salaries.append(salary)
        item = (date, row["id"], row)
        if len(self.newest) < LISTED:
            heappush(self.newest, item)
        elif item > self.newest[0]:
            heappushpop(self.newest, item)


def _salary_mid(row, currency, period):
    """The midpoint of a listing's stated salary, in the page's currency
    and period, or None. Only figures the employer gave (base_salary)."""
    s = base_salary(row)
    if not s or s["currency"] != currency or s["value"].get("unitText") != period:
        return None
    v = s["value"]
    lo, hi = v.get("minValue", v.get("value")), v.get("maxValue", v.get("value"))
    mid = (lo + hi) / 2 if lo and hi else None
    return mid if mid and mid >= _FLOOR[currency] else None


def collect(conn: sqlite3.Connection, clause: str, now: datetime) -> dict[tuple[str, str], _Page]:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(jobs)")}
    source = "salary_source" if "salary_source" in cols else "NULL AS salary_source"
    cutoff = (now - timedelta(days=7)).isoformat()
    pages: dict[tuple[str, str], _Page] = {}
    rows = conn.execute(
        f"SELECT id, title, company_domain, country, city, location, workplace_type, salary_text, {source}, "
        f"posted_at, first_seen FROM jobs WHERE {clause}")
    for row in rows:
        row = dict(zip(("id", "title", "company_domain", "country", "city", "location", "workplace_type",
                        "salary_text", "salary_source", "posted_at", "first_seen"), row))
        roles = roles_for(row["title"])
        if not roles:
            continue
        codes = [c for c in (row["country"] or "").split(",") if c]
        # city lists do not line up with country lists, so a city is only
        # placed when the listing names one country
        city = (row["city"] or "").split(",")[0].strip() if len(codes) == 1 else ""
        date = str(row["posted_at"] or row["first_seen"] or "")
        new = str(row["first_seen"] or "") >= cutoff
        places = [("", codes[0] if codes else "")]
        if row["workplace_type"] == "remote":
            places.append(("remote", codes[0] if codes else ""))
        places += [(p[0], city) for p in PLACES[2:] if p[1] in codes]
        for role in roles:
            for place, where in places:
                page = pages.setdefault((role, place), _Page())
                page.add(row, where, date, new, _salary_mid(row, PLACE[place][3], PLACE[place][4]) if row["salary_text"] else None)
    return pages


def _money(amount: float, currency: str) -> str:
    return f"{_SYMBOL[currency]}{fmt_int(int(round(amount, -3 if amount >= 10000 else -2)))}"


def _salary(page: _Page):
    """(median, quarter, three quarters) of stated midpoints, or None
    below SALARY_MIN_FIGURES."""
    s = sorted(page.salaries)
    if len(s) < SALARY_MIN_FIGURES:
        return None
    return s[len(s) // 2], s[len(s) // 4], s[(3 * len(s)) // 4]


def heading(role: str, place: str) -> str:
    r, p = ROLE[role], PLACE[place]
    if place == "remote":
        return f"Remote {r[2]} jobs"
    return f"{r[1]} jobs" + (f" {p[2]}" if p[2] else "")


def _board(role: str, place: str) -> str:
    q = {"search": ROLE[role][3]}
    if place == "remote":
        q["workplace"] = "remote"
    elif PLACE[place][1]:
        q["country"] = PLACE[place][1]
    return "/board?" + urlencode(q)


def _bars(items, href) -> str:
    """Bars like the company page's: [(key, label, count)], biggest first."""
    if not items:
        return ""
    esc = html.escape
    top = items[0][2]
    out = []
    for key, label, n in items:
        link = href(key)
        name = f'<a href="{esc(link)}">{esc(label)}</a>' if link else esc(label)
        out.append(f'<div class="pg-track-row">{name}<div class="pg-track"><div class="pg-track-fill" style="width:{100 * n / top:.0f}%"></div></div>'
                   f'<span class="pg-track-n">{fmt_int(n)}</span></div>')
    return "".join(out)


def render(role: str, place: str, page: _Page, built: set, names: dict, now: datetime) -> str:
    esc = html.escape
    r, p = ROLE[role], PLACE[place]
    h1 = heading(role, place)
    n = page.n
    top = page.companies.most_common(10)
    name_of = lambda d: (names.get(d) or (None, None))[0] or d  # noqa: E731
    leaders = [name_of(d) for d, _ in top[:3]]
    where = "worldwide" if not place else ("" if place == "remote" else p[2])
    # "14,362 software engineer jobs in the United States", keeping AI and DevOps capitalised
    words = h1 if h1.split()[0] in ("AI", "DevOps") else h1[0].lower() + h1[1:]
    title = f"{fmt_int(n)} {words}{' worldwide' if not place else ''} | Ocean of Jobs"
    desc = (f"{fmt_int(n)} open {'remote ' if place == 'remote' else ''}{r[2]} jobs{' ' + where if where else ''} at {fmt_int(len(page.companies))} {plural(len(page.companies), 'company', 'companies')}, including "
            f"{', '.join(leaders[:-1]) + ' and ' + leaders[-1] if len(leaders) > 1 else leaders[0]}. "
            f"From the companies' own hiring systems, updated {short_date(now)}.")
    canonical = SITE + path_for(role, place)

    crumbs = [("Jobs by role", "/jobs"), (f"{r[1]} jobs", path_for(role) if place else None)]
    if place:
        crumbs.append((("Remote" if place == "remote" else label_for(p[1])), None))
    ld = [
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": label, **({"item": SITE + href} if href else {})}
            for i, (label, href) in enumerate(crumbs)]},
        {"@context": "https://schema.org", "@type": "ItemList", "name": h1, "numberOfItems": n,
         "itemListElement": [{"@type": "ListItem", "position": i + 1, "url": f"{SITE}/job/{jid}"}
                             for i, (_, jid, _) in enumerate(sorted(page.newest, reverse=True))]},
    ]

    tiles = [(fmt_int(n), "Open jobs", f"{fmt_int(page.new_7d)} new in the last 7 days"),
             (fmt_int(len(page.companies)), plural(len(page.companies), "Company", "Companies") + " hiring", esc(", ".join(leaders)))]
    if place != "remote":
        share = 100 * page.remote / n
        tiles.append((f"{share:.0f}%", "Remote", f"{fmt_int(page.remote)} of {fmt_int(n)} open jobs"))
    else:
        tiles.append((fmt_int(len(page.places)), plural(len(page.places), "Country", "Countries"), "where these employers are based"))
    pay = _salary(page)
    if pay:
        per = "a year" if p[4] == "YEAR" else "a month"
        tiles.append((_money(pay[0], p[3]), f"Median stated salary, {per}",
                      f"Middle half {_money(pay[1], p[3])} to {_money(pay[2], p[3])}, from {fmt_int(len(page.salaries))} listings that state one"))
    tiles_html = "".join(f'<div class="pg-tile"><span class="pg-tile-n">{a}</span><div class="pg-tile-label">{esc(b)}</div>'
                         f'<div class="pg-muted pg-tile-sub">{c}</div></div>' for a, b, c in tiles)

    rows = []
    for date, jid, j in sorted(page.newest, reverse=True):
        main, sub, _ = split_title(j["title"] or "")
        company = name_of(j["company_domain"])
        city = (j["city"] or "").split(",")[0].strip() or (j["location"] or "").split(",")[0].strip()
        line = " · ".join(esc(x) for x in (company, city) if x)
        d = _date(date)
        rows.append(f'<a class="pg-role" href="/job/{esc(jid)}"><span class="pg-role-text"><span class="pg-role-title">{esc(main)}'
                    f'{f"<span class=\"pg-role-sub\"> · {esc(sub)}</span>" if sub else ""}</span>'
                    f'<span class="pg-role-line">{line}</span></span><span class="pg-role-when">{esc(short_date(d)) if d else ""}</span></a>')
    listing = (f'<section class="pg-card pg-roles"><div class="pg-roles-head"><span class="pg-roles-title"><b>{fmt_int(min(n, LISTED))}</b> newest</span>'
               f'<span class="pg-muted">of {fmt_int(n)} open</span></div>{"".join(rows)}'
               f'<a class="pg-show-all" href="{esc(_board(role, place))}">Search the board</a></section>')

    side = []
    company_bars = _bars([(d, name_of(d), k) for d, k in top], lambda d: f"/company/{d}")
    side.append(f'<section class="pg-card"><div class="pg-card-title">Who is hiring</div><div class="pg-tracks">{company_bars}</div></section>')
    if page.places:
        if p[1]:
            label, items = "Where " + p[2], [(c, c, k) for c, k in page.places.most_common(8)]
            link = lambda c: None  # noqa: E731
        else:
            by_code = {q[1]: q[0] for q in PLACES[2:]}
            label = "Where"
            items = [(c, label_for(c) or c, k) for c, k in page.places.most_common(8) if c]
            link = lambda c: path_for(role, by_code[c]) if (role, by_code.get(c)) in built else None  # noqa: E731
        side.append(f'<section class="pg-card"><div class="pg-card-title">{esc(label)}</div><div class="pg-tracks">{_bars(items, link)}</div></section>')
    elsewhere = [f'<a href="{path_for(role, q[0])}">{esc(heading(role, q[0]) + ("" if q[0] else " worldwide"))}</a>'
                 for q in PLACES if q[0] != place and (role, q[0]) in built]
    if elsewhere:
        side.append(f'<section class="pg-card"><div class="pg-card-title">{esc(r[1])} jobs elsewhere</div><div class="pg-links">{"".join(elsewhere)}</div></section>')
    others = [f'<a href="{path_for(o[0], place)}">{esc(heading(o[0], place))}</a>'
              for o in ROLES if o[0] != role and (o[0], place) in built]
    if others:
        side.append(f'<section class="pg-card"><div class="pg-card-title">Other {"remote " if place == "remote" else ""}roles{" " + esc(where) if where and place else ""}</div><div class="pg-links">{"".join(others)}</div></section>')

    crumbs_html = " / ".join(f'<a href="{href}">{esc(label)}</a>' if href else esc(label) for label, href in crumbs)
    return (head(title, desc, canonical, ld=ld, og_type="website") + topbar("jobs") + f"""  <main class="pg-main" id="main" tabindex="-1">
    <nav class="pg-crumbs" aria-label="Breadcrumb">{crumbs_html}</nav>
    <header class="pg-co-head">
      <div class="pg-co-text">
        <h1 class="job-page-title pg-title">{esc(h1)}</h1>
        <div class="pg-co-about">{esc(desc)}</div>
      </div>
      <div class="pg-co-acts"><a class="pg-btn pg-btn-fill" href="{esc(_board(role, place))}">Search the board</a></div>
    </header>
    <div class="pg-tiles">{tiles_html}</div>
    <div class="pg-grid pg-grid-co">
      {listing}
      <aside class="pg-side">{"".join(side)}</aside>
    </div>
  </main>
{FOOT}""")


def render_hub(pages: dict, built: set, now: datetime) -> str:
    esc = html.escape
    cards = []
    for slug, label, words, _, _ in ROLES:
        if (slug, "") not in built:
            continue
        links = "".join(f'<a href="{path_for(slug, q[0])}">{esc("Remote" if q[0] == "remote" else label_for(q[1]))}'
                        f' <span class="pg-muted">{fmt_int(pages[(slug, q[0])].n)}</span></a>'
                        for q in PLACES[1:] if (slug, q[0]) in built)
        cards.append(f'<section class="pg-card"><div class="pg-card-title"><a href="{path_for(slug)}">{esc(label)} jobs</a>'
                     f' <span class="pg-muted">{fmt_int(pages[(slug, "")].n)} open</span></div><div class="pg-links">{links}</div></section>')
    desc = (f"Open tech jobs by role and country: software engineer, AI engineer, data, DevOps, cybersecurity and product roles, "
            f"from company hiring systems, updated {short_date(now)}.")
    return (head("Tech jobs by role and country | Ocean of Jobs", desc, f"{SITE}/jobs", robots=None if cards else "noindex,follow",
                 og_type="website") + topbar("jobs")
            + f"""  <main class="pg-main" id="main" tabindex="-1">
    <div class="pg-article">
      <h1 class="job-page-title pg-title">Tech jobs by role</h1>
      <p>{esc(desc)}</p>
      <div class="pg-role-hub">{"".join(cards)}</div>
    </div>
  </main>
{FOOT}""")


def render_thin(role: str, place: str, n: int, built: set) -> str:
    """A combination under MIN_JOBS. Every one of ROLES x PLACES always has
    a file, so a page that drops under the line is not left serving old
    numbers, and a crawler that knew it gets a page saying so and pointing
    on, rather than the bucket's 403 for a missing object."""
    esc = html.escape
    up = path_for(role) if (role, "") in built and place else "/jobs"
    h1 = heading(role, place)
    return (head(f"{h1} | Ocean of Jobs", f"Too few open {ROLE[role][2]} jobs here right now for a page of their own.",
                 SITE + path_for(role, place), robots="noindex,follow", og_type="website") + topbar("jobs")
            + f"""  <main class="pg-main" id="main" tabindex="-1">
    <div class="pg-article">
      <h1 class="job-page-title pg-title">{esc(h1)}</h1>
      <p>{fmt_int(n)} open right now, too few for a page of their own. <a href="{esc(_board(role, place))}">See them on the board</a>
      or <a href="{up}">browse {esc(heading(role, "")) if up != "/jobs" else "all roles"}</a>.</p>
    </div>
  </main>
{FOOT}""")


def _date(s: str):
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def build(conn: sqlite3.Connection, clause: str, now: datetime | None = None) -> tuple[dict[str, str], list[str]]:
    """({bucket key: HTML}, [indexable page paths]). Every combination
    gets a file; only those with MIN_JOBS are indexable."""
    now = now or datetime.now(timezone.utc)
    pages = collect(conn, clause, now)
    built = {k for k, v in pages.items() if v.n >= MIN_JOBS}
    domains = {d for k in built for d, _ in pages[k].companies.most_common(10)}
    domains |= {row["company_domain"] for k in built for _, _, row in pages[k].newest}
    names = {}
    cols = {r[1] for r in conn.execute("PRAGMA table_info(companies)")}
    if "company_name" in cols and domains:
        ds = sorted(domains)
        for i in range(0, len(ds), 500):
            chunk = ds[i:i + 500]
            names.update({d: (nm, None) for d, nm in conn.execute(
                f"SELECT domain, company_name FROM companies WHERE domain IN ({','.join('?' * len(chunk))})", chunk) if nm})
    out = {}
    for role, *_ in ROLES:
        for place, *_ in PLACES:
            key = "jobs/" + role + (f"/{place}" if place else "") + ".html"
            if (role, place) in built:
                out[key] = render(role, place, pages[(role, place)], built, names, now)
            else:
                out[key] = render_thin(role, place, pages[(role, place)].n if (role, place) in pages else 0, built)
    out["jobs.html"] = render_hub(pages, built, now)
    return out, sorted(path_for(r, p) for r, p in built) + (["/jobs"] if built else [])
