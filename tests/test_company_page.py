"""/company/<domain>: what the page says, and what status it answers.

Run directly, no framework:  python tests/test_company_page.py
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

import company_page  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


NOW = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
ago = lambda d: (NOW - timedelta(days=d)).isoformat(timespec="seconds")

WIX = {"domain": "wix.com", "ats": "smartrecruiters", "error": None, "first_seen": ago(300),
       "company_name": "Wix", "logo_url": "https://wix.com/favicon.png"}


def job(i, title, city="Tel Aviv", **over):
    base = {"id": f"id{i:02d}", "title": title, "location": f"{city}, Israel" if city else "Remote", "department": "R&D",
            "seniority": "senior", "workplace_type": "hybrid", "posted_at": ago(i), "first_seen": ago(i),
            "country": "IL" if city else "", "city": city}
    base.update(over)
    return base


jobs = [job(1, "Senior Backend Engineer"), job(2, "Product Designer <UX>", department="Design"),
        job(3, "Data Engineer", city="Berlin", country="DE"), job(9, "QA Lead", city="")]
facts = {"total": 412, "since": "2025-11-03", "last_open": None}


def ld_of(page):
    m = re.search(r'<script type="application/ld\+json">(.*?)</script>', page, re.S)
    return json.loads(m.group(1).replace("<\\/", "</")) if m else None


p = company_page.render(WIX, jobs, facts, NOW)
check("a tracked company is 200", company_page.status_for(WIX) == 200)
check("title is the query: '<name> jobs', with the open count", "<title>Wix jobs: 4 open roles | Ocean of Jobs</title>" in p)
check("canonical is the company's own page", '<link rel="canonical" href="https://oceanofjobs.com/company/wix.com" />' in p)
check("indexable while it has an open role", 'name="robots"' not in p)
check("h1 is the name alone, and the summary says what the page is",
      '<h1 class="job-page-title pg-title">Wix</h1>' in p and "4 open roles in Tel Aviv, Berlin" in p and "Wix jobs</h1>" not in p)
check("every open role links its own page, with place, team, level and age",
      p.count('class="pg-role" href="/job/id') == 4
      and '<a class="pg-role" href="/job/id01" data-team="R&amp;D"><span class="pg-role-text"><span class="pg-role-title">Senior Backend Engineer</span><span class="pg-role-line">Tel Aviv · R&amp;D<span class="pg-tag pg-tag-small">Senior</span></span></span><span class="pg-role-when">1d</span></a>' in p
      and "Remote · R&amp;D" in p, p[p.find('class="pg-role"'):][:600])
check("the teams are filter buttons with counts",
      '<button type="button" class="pg-opt on" data-team="" aria-pressed="true">All teams <span class="pg-opt-n">4</span></button>' in p
      and 'data-team="R&amp;D" aria-pressed="false">R&amp;D <span class="pg-opt-n">3</span>' in p and 'data-team="Design"' in p, p[p.find("pg-teams"):][:400])
check("the four tiles: open roles with the total since, locations, hiring system",
      '<span class="pg-tile-n pg-tile-green">4</span><div class="pg-tile-label">Open roles</div><div class="pg-muted pg-tile-sub">412 listed since Nov 3, 2025</div>' in p
      and '<span class="pg-tile-n">2</span><div class="pg-tile-label">Locations</div><div class="pg-muted pg-tile-sub">Tel Aviv, Berlin</div>' in p
      and 'pg-tile-text">SmartRecruiters</span><div class="pg-tile-label">Hiring system</div>' in p, p[p.find("pg-tiles"):][:900])
check("where they are hiring, as bars by city", "Where they're hiring" in p and 'href="/board?company=wix.com&amp;city=Tel Aviv">Tel Aviv</a>' in p and 'style="width:100%"' in p)
check("about the data names the hiring system", "Scraped from Wix's SmartRecruiters board every few minutes." in p)
t = company_page.render(WIX, [job(5, "Ambulant Begeleider Maastricht | regelmatige werktijden | 24-28 uur", department="Zorg")], facts, NOW)
check("a packed title is split into title, grey subtitle and an hours tag",
      '<span class="pg-role-title">Ambulant Begeleider Maastricht<span class="pg-role-sub"> · regelmatige werktijden</span></span>' in t
      and '<span class="pg-tag pg-tag-small">24–28 uur</span>' in t, t[t.find('class="pg-role"'):][:400])
rich = dict(facts, new_7d=18, new_prev_7d=27, closed=39, category="Healthcare",
            weeks=company_page.week_buckets([ago(1), ago(2), ago(9), ago(20)], NOW))
r = company_page.render(WIX, jobs, rich, NOW)
check("with the counted facts: new this week, the weeks chart, the closed count, the category in the header and crumbs",
      '<span class="pg-tile-n">18</span><div class="pg-tile-label">New this week</div><div class="pg-muted pg-tile-sub">27 the week before</div>' in r
      and 'aria-label="New roles listed per week"' in r and "39 roles listed since Nov 3, 2025 have since closed." in r
      and "Healthcare · Tel Aviv, Berlin · " in r and '<a href="/board?department=Healthcare">Healthcare</a> / Wix' in r, r[r.find("pg-crumbs"):][:300])
wk = company_page.week_buckets([ago(1), ago(2), ago(9), ago(20), "junk"], NOW)
check("week buckets: four weeks ending this one, oldest first, the junk ignored", len(wk) == 4 and sum(w["n"] for w in wk) == 4 and wk[-1]["n"] >= 2, repr([w["n"] for w in wk]))
check("angle brackets in a title are escaped", "Product Designer &lt;UX&gt;" in p and "<UX>" not in p)
check("the header links the company site (nofollow) and the board filtered to it",
      'href="https://wix.com" rel="nofollow noopener" target="_blank">wix.com' in p
      and 'href="/board?company=wix.com">See all 4 on the board</a>' in p and "Alert me</button>" in p)
md = re.search(r'<meta name="description" content="([^"]*)"', p).group(1)
check("meta description counts, places and names the newest roles",
      md.startswith("4 open roles at Wix in Tel Aviv, Berlin: Senior Backend Engineer, Product Designer &lt;UX&gt;, Data Engineer."), md)
ld = ld_of(p)
check("markup: a CollectionPage about the Organization, listing the job pages",
      ld and ld["@type"] == "CollectionPage" and ld["about"]["@type"] == "Organization" and ld["about"]["url"] == "https://wix.com"
      and ld["about"]["logo"] == "https://wix.com/favicon.png" and ld["mainEntity"]["numberOfItems"] == 4
      and ld["mainEntity"]["itemListElement"][0]["url"] == "https://oceanofjobs.com/job/id01", repr(ld)[:300])
orgs = re.findall(r'<script type="application/ld\+json">(.*?)</script>', p, re.S)
org = json.loads(orgs[1]) if len(orgs) > 1 else None
check("and an Organization block of its own", bool(org) and org["@type"] == "Organization" and org["name"] == "Wix"
      and org["url"] == "https://wix.com" and org["logo"] == "https://wix.com/favicon.png", repr(org))
check("the shared head and foot are the listing page's", 'class="job-page-body"' in p and 'href="https://oceanofjobs.com/feed.xml"' in p and "Browse the board" in p)

# Nothing open: the page stays, says so, and is not for the index.
e = company_page.render(WIX, [], {"total": 412, "since": "2025-11-03", "last_open": ago(40)}, NOW)
check("no open roles: 200, noindex, and the page says when the last one closed",
      company_page.status_for(WIX) == 200 and '<meta name="robots" content="noindex,follow" />' in e
      and "<title>Wix jobs | Ocean of Jobs</title>" in e and "The last one closed 1 month ago." in e)
check("its markup carries no empty list", "mainEntity" not in (ld_of(e) or {}))

# Aliases redirect to the one page.
alias = {"domain": "wix2.com", "ats": None, "error": "alias of wix.com (both resolve to smartrecruiters:Wix2)", "first_seen": ago(10)}
check("a demoted alias is a 301 to the real domain",
      company_page.status_for(alias) == 301 and company_page.redirect_target(alias) == "wix.com")
same = {"domain": "sentinelone.com", "ats": "greenhouse", "error": None}
check("a same_company duplicate redirects too", company_page.redirect_target(same) == "sentinellabs.io")
check("the redirect body names the target", 'href="https://oceanofjobs.com/company/wix.com"' in company_page.render_redirect("wix.com"))

# Unknown and malformed.
check("unknown is 404", company_page.status_for(None) == 404)
check("only a hostname is a page", company_page.is_domain("wix.com") and company_page.is_domain("check-point.co.il")
      and not company_page.is_domain("wix") and not company_page.is_domain("Wix.com") and not company_page.is_domain("a/b.com")
      and not company_page.is_domain("x.com/../y"))
m = company_page.render_missing("nope.example")
check("the 404 page is noindex and offers the board", 'content="noindex"' in m and 'href="/board"' in m)

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
