"""What every server-rendered page shares: the head, the bar at the
top, the foot, the hiring-system names, a few small formatters. The
listing page (job_page.py) and the company page (company_page.py) both
read from here, so the two cannot drift apart.
"""

import html
import json
from datetime import datetime, timezone

SITE = "https://oceanofjobs.com"
CARD = f"{SITE}/og.jpg"

# The hiring system behind a listing, said the way its vendor says it.
ATS_NAMES = {
    "greenhouse": "Greenhouse", "lever": "Lever", "workday": "Workday", "smartrecruiters": "SmartRecruiters",
    "ashby": "Ashby", "comeet": "Comeet", "bamboohr": "BambooHR", "workable": "Workable", "personio": "Personio",
    "teamtailor": "Teamtailor", "recruitee": "Recruitee", "jobvite": "Jobvite", "icims": "iCIMS", "successfactors": "SAP SuccessFactors",
    "taleo": "Taleo", "breezy": "Breezy", "jazzhr": "JazzHR", "rippling": "Rippling", "niloosoft": "Niloosoft", "hunter": "Hunter",
    "custom": "the company website", "html": "the company website", "careers": "the company website",
}


def ats_name(ats: str | None) -> str:
    key = (ats or "").strip().lower()
    if not key:
        return "the company website"
    return ATS_NAMES.get(key, ats.strip())


def ats_is_site(ats: str | None) -> bool:
    return ats_name(ats) == "the company website"


def parse_ts(ts):
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def short_date(d) -> str:
    """Sep 28, with the year only when it is not this one's."""
    today = datetime.now(timezone.utc)
    s = f"{d.strftime('%b')} {d.day}"
    return s if d.year == today.year else f"{s}, {d.year}"


def long_date(d) -> str:
    """Sep 28, 2026."""
    return f"{d.strftime('%b')} {d.day}, {d.year}"


def ago(ts, now) -> str:
    """"2 hours ago", "3 days ago", "1 month ago"; "" without a time."""
    d = parse_ts(ts)
    if not d:
        return ""
    s = (now - d).total_seconds()
    if s < 90:
        return "just now"
    m = int(s // 60)
    if m < 60:
        return f"{m} minute{'s' if m != 1 else ''} ago"
    h = int(s // 3600)
    if h < 24:
        return f"{h} hour{'s' if h != 1 else ''} ago"
    days = int(s // 86400)
    if days < 30:
        return f"{days} day{'s' if days != 1 else ''} ago"
    months = days // 30
    return f"{months} month{'s' if months != 1 else ''} ago"


def ago_short(ts, now) -> str:
    """"2h", "3d", "1w", "2mo" for a dense list."""
    d = parse_ts(ts)
    if not d:
        return ""
    s = (now - d).total_seconds()
    if s < 3600:
        return "now" if s < 300 else f"{int(s // 60)}m"
    if s < 86400:
        return f"{int(s // 3600)}h"
    days = int(s // 86400)
    if days < 7:
        return f"{days}d"
    if days < 30:
        return f"{days // 7}w"
    return f"{days // 30}mo"


def fmt_int(n) -> str:
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return str(n)


def plural(n: int, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


def head(title, description, canonical, robots=None, ld=None, og_type="article"):
    """The head every server-rendered page shares. canonical is the
    page's own absolute URL; ld is one JSON-LD object or a list of
    them, each in its own script."""
    esc = html.escape
    # Escaped like every other attribute here. The 404 pages passed the
    # requested path through canonical_url, and an unescaped quote in it
    # put attacker markup straight into the page (security review,
    # 2026-10-03).
    canonical = esc(canonical, quote=True)
    blocks = [] if ld is None else (ld if isinstance(ld, list) else [ld])
    ld_tag = "".join(
        # "<" inside a script element could open a tag; JSON is happy to
        # carry it as <, and every parser reads it back as "<".
        '  <script type="application/ld+json">' + json.dumps(b, ensure_ascii=False).replace("<", "\\u003c") + "</script>\n"
        for b in blocks)
    robots_tag = f'  <meta name="robots" content="{robots}" />\n' if robots else ""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#f2f0ef" />
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}" />
  <link rel="canonical" href="{canonical}" />
{robots_tag}  <meta property="og:type" content="{og_type}" />
  <meta property="og:url" content="{canonical}" />
  <meta property="og:title" content="{esc(title)}" />
  <meta property="og:description" content="{esc(description)}" />
  <meta property="og:image" content="{CARD}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{esc(title)}" />
  <meta name="twitter:description" content="{esc(description)}" />
  <meta name="twitter:image" content="{CARD}" />
  <link rel="alternate" type="application/rss+xml" title="Ocean of Jobs newest listings" href="{SITE}/feed.xml" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=3" />
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon-180.png?v=3" />
  <link rel="preload" href="/fonts/OverusedGrotesk-VF.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="/fonts/SourceSans3-VF-latin.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/style.css" />
{ld_tag}  <script>
    if (localStorage.getItem("iljobs_theme") === "dark") {{
      document.querySelector('meta[name="theme-color"]').content = "#17181c";
      document.documentElement.setAttribute("data-theme", "dark");
    }}
  </script>
</head>
"""


def topbar(current: str = "") -> str:
    """The bar: the mark, the four pages, a search that lands on the
    board, and Log in. `current` is "jobs" or "companies"."""
    def nav(key, href, label):
        on = ' class="on" aria-current="page"' if key == current else ""
        return f'<a href="{href}"{on}>{label}</a>'
    return f"""<body class="job-page-body">
<a class="skip-link" href="#main">Skip to content</a>
  <header class="pg-bar">
    <div class="pg-bar-in">
      <a class="pg-mark" href="/" aria-label="Ocean of Jobs home"><img src="/favicon.svg?v=3" width="24" height="24" alt="" /><span translate="no">oceanofjobs.com</span></a>
      <nav class="pg-nav" aria-label="Site">{nav("jobs", "/board", "Jobs")}{nav("companies", "/companies", "Companies")}{nav("stats", "/stats", "Statistics")}{nav("api", "/api/help", "API")}</nav>
      <form class="pg-search" action="/board" method="get" role="search">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input type="search" name="search" aria-label="Search jobs" placeholder="Search jobs…" autocomplete="off" />
      </form>
      <a class="pg-login" href="/account">Log in</a>
    </div>
  </header>
"""


FOOT = """  <script src="/count.js"></script>
  <script>
    (function () {
      var side = document.querySelector(".pg-side");
      if (!side) return;
      var fit = function () { side.style.top = Math.min(16, window.innerHeight - side.offsetHeight - 16) + "px"; };
      fit(); window.addEventListener("resize", fit); window.addEventListener("load", fit);
    })();
  </script>
  <footer class="pg-foot">
    <span>oceanofjobs.com · listings scraped from company hiring systems</span>
    <span><a href="/board">Browse the board</a> · <a href="/api/help">API</a> · <a href="/privacy">Privacy</a></span>
  </footer>
</body>
</html>
"""


def monogram(name: str, size: int, logo_url: str | None = None, cls: str = "") -> str:
    """A company's mark: its logo, or the first letter in a tile."""
    letter = html.escape((name or "?").strip()[:1].upper() or "?")
    img = (f'<img src="{html.escape(logo_url, quote=True)}" alt="" width="{size}" height="{size}" loading="lazy" onerror="this.remove()" />'
           if logo_url else "")
    return f'<span class="pg-logo {cls}" style="--s:{size}px" aria-hidden="true">{img}<span class="pg-letter">{letter}</span></span>'
