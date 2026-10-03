"""GET /company/{domain}: one employer as a real HTML page.

A job page lives about a month. A company page is the stable address:
"Wix jobs" is what people type, and the page that answers it should
be the same URL next year. It shows what the company has open right
now, by team and by place, how fast roles arrive, and how long the
board has watched the company, which is the one thing a careers site
never tells you.

The rendering is a function of one company row, its open listings, a
few facts the handler counts, and the clock. handler.py fetches those
and picks the status; this module says what the page looks like and
what the status should be.

Status policy, which loader/sitemap.py mirrors:
  a company the board tracks       200. Indexable while it has an open
                                   role; noindex when it has none, so a
                                   thousand empty pages do not go into
                                   the index, but the URL still answers
                                   and says when it last had one
  an alias of another domain       301 to that domain's page (the
                                   loader demotes a second domain for
                                   the same board; api/same_company.py
                                   names the ones it cannot catch)
  unknown domain                   404
"""

import html
import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

from job_page import FOOT, SENIORITY_LABELS, SITE, _head, _parse
from page_chrome import ago_short, ats_is_site, ats_name, fmt_int, monogram, plural, short_date, topbar
from same_company import SAME_COMPANY
from titles import split_title

TOPBAR = topbar("companies")

# A hostname with at least one dot, lowercase, no scheme or path. What
# the companies table holds; anything else is not a page we have.
DOMAIN_RE = re.compile(r"^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
MAX_LISTED = 300
SHOWN_AT_FIRST = 10


def is_domain(s: str) -> bool:
    return bool(s) and bool(DOMAIN_RE.match(s))


def canonical_url(domain: str) -> str:
    return f"{SITE}/company/{domain}"


def company_label(company) -> str:
    return (company.get("company_name") or company.get("domain") or "").strip()


def redirect_target(company) -> str | None:
    """The domain this one is a second name for, if it is one."""
    domain = company.get("domain") or ""
    if domain in SAME_COMPANY:
        return SAME_COMPANY[domain]
    m = re.match(r"alias of ([a-z0-9.-]+) ", company.get("error") or "")
    return m.group(1) if m else None


def status_for(company) -> int:
    """404, 301 or 200. See the module docstring for the policy."""
    if not company:
        return 404
    return 301 if redirect_target(company) else 200


def _age(ts, now) -> str:
    d = _parse(ts)
    if not d:
        return ""
    days = (now - d).days
    if days <= 0:
        return "today"
    if days == 1:
        return "1 day ago"
    if days < 30:
        return f"{days} days ago"
    months = days // 30
    return "1 month ago" if months == 1 else f"{months} months ago"


def _place_counts(jobs) -> list[tuple[str, int]]:
    """Cities with how many open roles are in each, most first."""
    c = Counter()
    for j in jobs:
        for city in (j.get("city") or "").split(","):
            if city.strip():
                c[city.strip()] += 1
    return c.most_common()


def _places(jobs) -> list[str]:
    return [p for p, _ in _place_counts(jobs)]


def _department_counts(jobs) -> list[tuple[str, int]]:
    c = Counter((j.get("department") or "").strip() for j in jobs)
    c.pop("", None)
    return c.most_common()


def _departments(jobs) -> list[str]:
    return [d for d, _ in _department_counts(jobs)]


def _join(items: list[str], limit: int) -> str:
    shown = items[:limit]
    rest = len(items) - len(shown)
    text = ", ".join(shown)
    return text + (f" and {rest} more" if rest > 0 else "")


def meta_description(company, jobs, facts) -> str:
    name = company_label(company)
    n = len(jobs)
    if not n:
        return f"{name} has no open roles on Ocean of Jobs right now. The board has listed {facts['total']} of its roles since {facts['since']}."
    places = _places(jobs)
    where = f" in {_join(places, 3)}" if places else ""
    titles = _join([j.get("title", "").strip() for j in jobs[:3] if j.get("title")], 3)
    role = "open role" if n == 1 else "open roles"
    text = f"{n} {role} at {name}{where}: {titles}. Every listing links to the company's own application page."
    return text if len(text) <= 300 else text[:297].rsplit(" ", 1)[0] + "..."


def organization_ld(company) -> dict:
    """schema.org Organization for the company itself."""
    domain = company.get("domain") or ""
    org = {"@context": "https://schema.org", "@type": "Organization", "name": company_label(company),
           "url": f"https://{domain}", "sameAs": canonical_url(domain)}
    if company.get("logo_url"):
        org["logo"] = company["logo_url"]
    return org


def json_ld(company, jobs) -> dict:
    """schema.org CollectionPage about the Organization, with the open
    listings as an ItemList of the pages that carry their JobPosting
    markup. Nothing here is a claim the page does not show."""
    domain = company.get("domain") or ""
    org = {"@type": "Organization", "name": company_label(company), "url": f"https://{domain}"}
    if company.get("logo_url"):
        org["logo"] = company["logo_url"]
    data = {"@context": "https://schema.org", "@type": "CollectionPage", "url": canonical_url(domain),
            "name": f"{company_label(company)} jobs", "about": org}
    if jobs:
        data["mainEntity"] = {
            "@type": "ItemList",
            "numberOfItems": len(jobs),
            "itemListElement": [
                {"@type": "ListItem", "position": i, "url": f"{SITE}/job/{j['id']}", "name": j.get("title", "")}
                for i, j in enumerate(jobs[:MAX_LISTED], 1)
            ],
        }
    return data


def _weeks_svg(weeks, now) -> str:
    """New roles per week as bars, the current week in green. weeks:
    [{"start": date, "n": int}, ...] oldest first."""
    if not weeks:
        return ""
    top = max(1, max(w["n"] for w in weeks))
    n = len(weeks)
    slot = 300 / n
    bar = min(55, slot * 0.72)
    parts = []
    for i, w in enumerate(weeks):
        h = 58 * w["n"] / top
        x = 10 + i * (280 / n) + (280 / n - bar) / 2 if n > 1 else 122
        y = 82 - h
        last = i == n - 1
        fill = "var(--green)" if last else "var(--panel-line)"
        label = short_date(w["start"]) + ("*" if last else "")
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar:.1f}" height="{h:.1f}" style="fill:{fill}"/>'
                     f'<text x="{x + bar / 2:.1f}" y="{y - 5:.1f}" text-anchor="middle" font-size="10" class="pg-svg-ink">{w["n"]}</text>'
                     f'<text x="{x + bar / 2:.1f}" y="96" text-anchor="middle" font-size="10" class="pg-svg-grey">{html.escape(label)}</text>')
    return (f'<svg viewBox="0 0 300 100" role="img" aria-label="New roles listed per week" class="pg-weeks">{"".join(parts)}</svg>'
            '<div class="pg-muted pg-tiny">* this week so far</div>')


def render(company, jobs, facts, now=None) -> str:
    """The page for a company the database knows.

    facts: {"total": roles listed all time, "since": first listing seen
    (ISO date), "last_open": when the last open role was seen, for a
    company with none open now}, and when the handler counts them:
    "new_7d", "new_prev_7d" (roles first seen in the last week and the
    week before), "weeks" ([{"start", "n"}] for the last four), "closed"
    (roles listed that have since closed), "category" (the most common
    category among its roles).
    """
    esc = html.escape
    now = now or datetime.now(timezone.utc)
    name = company_label(company)
    domain = company.get("domain") or ""
    n = len(jobs)
    title = (f"{name} jobs: {n} open {'role' if n == 1 else 'roles'} | Ocean of Jobs" if n
             else f"{name} jobs | Ocean of Jobs")
    desc = meta_description(company, jobs, facts)
    head = _head(title, desc, canonical_url(domain), robots=None if n else "noindex,follow",
                 ld=[json_ld(company, jobs), organization_ld(company)], og_type="website")

    system = ats_name(company.get("ats"))
    place_counts, dept_counts = _place_counts(jobs), _department_counts(jobs)
    places = [p for p, _ in place_counts]

    # The line under the name: what they do, where, and their site.
    about = []
    if facts.get("category"):
        about.append(esc(facts["category"]))
    if places:
        about.append(esc(_join(places[:2], 2)) if len(places) <= 2 else esc(f"{places[0]}, {places[1]} and {len(places) - 2} more"))
    about.append(f'<a href="https://{esc(domain)}" rel="nofollow noopener" target="_blank">{esc(domain)} <span aria-hidden="true">↗</span></a>')
    summary = f"{n} open {'role' if n == 1 else 'roles'}" + (f" in {esc(_join(places, 3))}" if places else "")

    # The four tiles.
    since = esc(facts.get("since") or "")
    since_text = ""
    if facts.get("since"):
        d = _parse(facts["since"])
        since_text = f"listed since {short_date(d)}" if d else f"listed since {since}"
    tiles = [
        (f'<span class="pg-tile-n pg-tile-green">{fmt_int(n)}</span>', f"Open {plural(n, 'role')}", f"{fmt_int(facts.get('total') or 0)} {since_text}".strip()),
    ]
    if facts.get("new_7d") is not None:
        prev = facts.get("new_prev_7d")
        tiles.append((f'<span class="pg-tile-n">{fmt_int(facts["new_7d"])}</span>', "New this week",
                      f"{fmt_int(prev)} the week before" if prev is not None else ""))
    if places:
        tiles.append((f'<span class="pg-tile-n">{fmt_int(len(places))}</span>', plural(len(places), "Location"),
                      esc(_join(places, 3))))
    tiles.append((f'<span class="pg-tile-n pg-tile-text">{esc("Own site" if ats_is_site(company.get("ats")) else system)}</span>', "Hiring system",
                  "Applications go to their site"))
    tiles_html = "".join(f'<div class="pg-tile">{a}<div class="pg-tile-label">{esc(b)}</div><div class="pg-muted pg-tile-sub">{c}</div></div>'
                         for a, b, c in tiles)

    # The open roles: team filters, then the rows.
    if n:
        teams = ([f'<button type="button" class="pg-opt on" data-team="" aria-pressed="true">All teams <span class="pg-opt-n">{fmt_int(n)}</span></button>']
                 + [f'<button type="button" class="pg-opt" data-team="{esc(d)}" aria-pressed="false">{esc(d)} <span class="pg-opt-n">{fmt_int(c)}</span></button>'
                    for d, c in dept_counts[:12]])
        if len(dept_counts) > 12:
            teams.append(f'<span class="pg-muted pg-opt-more">+ {len(dept_counts) - 12} more</span>')
        rows = []
        for i, j in enumerate(jobs[:MAX_LISTED]):
            main, sub, hours = split_title(j.get("title", ""))
            city = (j.get("city") or "").split(",")[0].strip() or (j.get("location") or "").split(",")[0].strip()
            line = " · ".join(esc(x) for x in [city, (j.get("department") or "").strip()] if x)
            level = SENIORITY_LABELS.get(j.get("seniority") or "", "")
            when = ago_short(j.get("posted_at") or j.get("first_seen"), now)
            rows.append(
                f'<a class="pg-role{"" if i < SHOWN_AT_FIRST else " pg-role-more"}" href="/job/{esc(j["id"])}" data-team="{esc((j.get("department") or "").strip())}">'
                f'<span class="pg-role-text"><span class="pg-role-title">{esc(main)}{f"<span class=\"pg-role-sub\"> · {esc(sub)}</span>" if sub else ""}</span>'
                f'<span class="pg-role-line">{line}{f"<span class=\"pg-tag pg-tag-small\">{esc(hours)}</span>" if hours else ""}'
                f'{f"<span class=\"pg-tag pg-tag-small\">{esc(level)}</span>" if level and not hours else ""}</span></span>'
                f'<span class="pg-role-when">{esc(when)}</span></a>')
        more = ""
        if n > SHOWN_AT_FIRST:
            more = f'<button type="button" class="pg-show-all" data-show-all>Show all {fmt_int(min(n, MAX_LISTED))} roles</button>'
        if n > MAX_LISTED:
            more += f'<a class="pg-show-all" href="/board?company={esc(domain)}">All {fmt_int(n)} on the board</a>'
        listing = (f'<section class="pg-card pg-roles"><div class="pg-roles-head"><span class="pg-roles-title"><b>{fmt_int(n)}</b> open {plural(n, "role")}</span>'
                   f'<span class="pg-muted">Newest first</span></div>'
                   f'<div class="pg-teams">{"".join(teams)}</div>{"".join(rows)}{more}'
                   f'<p class="pg-roles-none pg-muted" hidden>No open roles on that team right now.</p></section>')
    else:
        last = facts.get("last_open")
        seen = f" The last one closed {esc(_age(last, now))}." if last else ""
        listing = (f'<section class="pg-card pg-roles"><div class="pg-roles-head"><span class="pg-roles-title">No open roles right now</span></div>'
                   f'<p class="pg-muted pg-roles-empty">Nothing is open at {esc(name)} at the moment.{seen} '
                   f'The board checks its careers page on every run and lists what appears.</p></section>')

    # The sidebar: where, how fast, and where the data comes from.
    side = []
    if place_counts:
        top = place_counts[:5]
        rest = place_counts[5:]
        biggest = top[0][1]
        bars = [(f'<div class="pg-track-row"><a href="/board?company={esc(domain)}&amp;city={esc(c)}">{esc(c)}</a>'
                 f'<div class="pg-track"><div class="pg-track-fill" style="width:{100 * k / biggest:.0f}%"></div></div><span class="pg-track-n">{fmt_int(k)}</span></div>')
                for c, k in top]
        if rest:
            k = sum(x for _, x in rest)
            bars.append(f'<div class="pg-track-row"><span class="pg-muted">{len(rest)} more {plural(len(rest), "place")}</span>'
                        f'<div class="pg-track"><div class="pg-track-fill pg-track-rest" style="width:{min(100, 100 * k / biggest):.0f}%"></div></div><span class="pg-track-n">{fmt_int(k)}</span></div>')
        side.append(f'<section class="pg-card"><div class="pg-card-title">Where they\'re hiring</div><div class="pg-tracks">{"".join(bars)}</div></section>')
    if facts.get("weeks"):
        side.append(f'<section class="pg-card"><div class="pg-card-title">New roles per week</div>{_weeks_svg(facts["weeks"], now)}</section>')
    data_bits = [f"Scraped from {esc(name)}'s {'own careers site' if ats_is_site(company.get('ats')) else esc(system) + ' board'} every few minutes."]
    if facts.get("closed") is not None and facts.get("since"):
        d = _parse(facts["since"])
        data_bits.append(f"{fmt_int(facts['closed'])} {plural(facts['closed'], 'role')} listed since {short_date(d) if d else esc(facts['since'])} "
                         f"{'has' if facts['closed'] == 1 else 'have'} since closed.")
    side.append(f'<section class="pg-card"><div class="pg-card-title">About the data</div><p class="pg-muted pg-about">{" ".join(data_bits)}</p></section>')

    crumbs = ['<a href="/companies">Companies</a>']
    if facts.get("category"):
        crumbs.append(f'<a href="/board?department={esc(facts["category"])}">{esc(facts["category"])}</a>')
    crumbs.append(esc(name))
    alert_filter = {"company": domain}

    body = f"""{TOPBAR}
  <main class="pg-main" id="main" tabindex="-1">
    <nav class="pg-crumbs" aria-label="Breadcrumb">{" / ".join(crumbs)}</nav>
    <header class="pg-co-head">
      {monogram(name, 64, company.get("logo_url"), "pg-logo-big")}
      <div class="pg-co-text">
        <h1 class="job-page-title pg-title">{esc(name)}</h1>
        <div class="pg-co-about">{" · ".join(about)}</div>
        <p class="company-summary visually-hidden">{summary}</p>
      </div>
      <div class="pg-co-acts">
        <button type="button" class="pg-btn" data-alert-company><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21h4"/></svg>Alert me</button>
        <a class="pg-btn pg-btn-fill" href="/board?company={esc(domain)}">See all {fmt_int(n)} on the board</a>
      </div>
    </header>
    <div class="pg-tiles">{tiles_html}</div>
    <div class="pg-grid pg-grid-co">
      {listing}
      <aside class="pg-side">{"".join(side)}</aside>
    </div>
  </main>
  <script>
    (function () {{
      var roles = document.querySelectorAll(".pg-role");
      var none = document.querySelector(".pg-roles-none");
      var showAll = document.querySelector("[data-show-all]");
      var expanded = false;
      var team = "";
      var paint = function () {{
        var shown = 0;
        roles.forEach(function (r) {{
          var hit = !team || r.dataset.team === team;
          var late = r.classList.contains("pg-role-more");
          r.hidden = !hit || (late && !expanded && !team);
          if (hit) shown += 1;
        }});
        if (none) none.hidden = shown > 0;
        if (showAll) showAll.hidden = expanded || !!team;
      }};
      document.querySelectorAll("[data-team]").forEach(function (b) {{
        if (b.tagName !== "BUTTON") return;
        b.addEventListener("click", function () {{
          team = b.dataset.team;
          document.querySelectorAll("button[data-team]").forEach(function (x) {{ var on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); }});
          paint();
        }});
      }});
      if (showAll) showAll.addEventListener("click", function () {{ expanded = true; paint(); }});
      var alert = document.querySelector("[data-alert-company]");
      if (alert) alert.addEventListener("click", function () {{
        try {{ sessionStorage.setItem("iljobs_alert_prefill", JSON.stringify({json.dumps(alert_filter)})); }} catch (e) {{}}
        location.href = "/account#alerts";
      }});
      paint();
    }})();
  </script>
{FOOT}"""
    return head + body


def render_redirect(target: str) -> str:
    """The body behind a 301, for a client that shows it."""
    url = canonical_url(target)
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Moved</title>'
            f'<meta http-equiv="refresh" content="0; url={html.escape(url, quote=True)}" /></head>'
            f'<body><a href="{html.escape(url, quote=True)}">{html.escape(url)}</a></body></html>')


def render_missing(domain: str) -> str:
    title = "Company not found | Ocean of Jobs"
    what = "The board does not track a company at this address. It may be spelled differently, or it may not have a careers page we can read."
    # Only a well-formed domain goes back into the page.
    canonical = canonical_url(domain) if is_domain(domain) else f"{SITE}/companies"
    head = _head(title, what, canonical, robots="noindex", og_type="website")
    return head + f"""{TOPBAR}
  <main class="pg-main" id="main" tabindex="-1">
    <div class="pg-article">
      <h1 class="job-page-title pg-title">Company not found</h1>
      <p>{html.escape(what)}</p>
      <p><a class="pg-apply pg-apply-off" href="/board">Browse open listings</a></p>
    </div>
  </main>
{FOOT}"""


def week_buckets(first_seens, now, weeks: int = 4) -> list[dict]:
    """[{"start": date, "n": count}] for the last `weeks` weeks ending
    with the current one (weeks start on Monday). The handler feeds it
    the first_seen of every role the company listed in that span."""
    today = now.date() if hasattr(now, "date") else now
    this_monday = today - timedelta(days=today.weekday())
    starts = [this_monday - timedelta(days=7 * (weeks - 1 - i)) for i in range(weeks)]
    counts = [0] * weeks
    for ts in first_seens:
        d = _parse(ts)
        if not d:
            continue
        day = d.date()
        for i, s in enumerate(starts):
            if s <= day < s + timedelta(days=7):
                counts[i] += 1
                break
    return [{"start": s, "n": c} for s, c in zip(starts, counts)]
