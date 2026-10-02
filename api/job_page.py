"""GET /job/{id}: one listing as a real HTML page.

Every listing on the board used to exist only as /board?job=<id>, which
is one JavaScript-rendered page whose title and description are the same
for every job. A crawler asked for 271,000 of those sees 271,000 copies
of the board. This is the page a crawler, a link preview, or a browser
with scripts off gets instead: the listing's own title, company, place,
date, salary, description and apply link in the HTML, a canonical URL,
and JobPosting structured data that says the same things the page shows.

The rendering is a function of one job row plus the clock (and, when
the handler has them, a few rows about the company and roles like it),
so it is testable without a database. handler.py fetches the rows and
picks the status; this module only says what the page looks like for a
given job, and what the status should be.

Status policy, which the sitemap generator (loader/sitemap.py) mirrors:
  open                  200, indexable, with JobPosting markup
  closed within 30 days 200, "closed" banner, noindex, no JobPosting:
                        a saved link still lands somewhere useful, and
                        the markup goes because Google asks for it to
                        go when the role is no longer available
  closed longer ago     410 Gone
  unknown id            404

Salary is shown but marked up only when the employer gave the figure.
An estimate is labelled as one on the page, in words.
"""

import html
import re
from datetime import datetime, timedelta, timezone

from countries import label_for
from listing_text import deadline_from, description_html, language_of
from page_chrome import (FOOT, SITE, ago, ago_short, ats_is_site, ats_name, fmt_int, head as _head_shared,
                         long_date, monogram, parse_ts, plural, short_date, topbar)
from titles import split_title

EXPIRED_KEEP_DAYS = 30
CARD = f"{SITE}/og.jpg"

SENIORITY_LABELS = {
    "intern": "Internship", "junior": "Junior", "mid": "Mid-level", "senior": "Senior", "staff": "Staff",
    "principal": "Principal", "lead": "Lead", "manager": "Manager", "director": "Director", "exec": "Executive",
}
WORKPLACE_LABELS = {"remote": "Remote", "hybrid": "Hybrid", "onsite": "Onsite"}

_parse = parse_ts


def _head(title, description, canonical, robots=None, ld=None, og_type="article"):
    """Kept under this name: company_page.py and the tests import it."""
    return _head_shared(title, description, canonical, robots=robots, ld=ld, og_type=og_type)


TOPBAR = topbar("jobs")


def status_for(job, now=None) -> int:
    """404, 410 or 200. See the module docstring for the policy."""
    if not job:
        return 404
    closed = _parse(job.get("closed_at"))
    if closed is None:
        return 200
    now = now or datetime.now(timezone.utc)
    return 410 if now - closed > timedelta(days=EXPIRED_KEEP_DAYS) else 200


def company_label(job) -> str:
    return (job.get("company_name") or job.get("company_domain") or "").strip()


def canonical_url(job_id: str) -> str:
    return f"{SITE}/job/{job_id}"


def _human_date(d) -> str:
    """30 Sep 2026 rather than 2026-09-30: a date a reader says."""
    return f"{d.day} {d.strftime('%b %Y')}"


def _salary_line(job):
    """(text, is_estimate) or None. Mirrors the board's own fallback: a
    row written before salary_source existed still carries the flag."""
    text = (job.get("salary_text") or "").strip()
    if not text:
        return None
    source = job.get("salary_source") or ("table" if job.get("salary_is_estimate") else "disclosed")
    return text, source != "disclosed"


def _description_html(text: str) -> str:
    """Kept for callers that want the plain conversion."""
    return description_html(text)


def _meta_description(job) -> str:
    where = (job.get("location") or "").split(";")[0].strip()
    head = f"{job.get('title', '').strip()} at {company_label(job)}"
    if where:
        head += f", {where}"
    body = re.sub(r"\s+", " ", job.get("description") or "").strip()
    text = f"{head}. {body}" if body else head
    return text[:157].rstrip() + ("…" if len(text) > 157 else "")


US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
    "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
    "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
}


def _us_region(job, city):
    """The state code when a US listing spells it: "Boston, MA" gives MA.
    Only the two-letter form right after the city is trusted; a listing
    that says "Cambridge, Massachusetts" or just "Austin" gets no region
    rather than a guessed one."""
    if (job.get("country") or "") != "US":
        return None
    m = re.search(re.escape(city) + r"\s*,\s*([A-Z]{2})(?:\s*,|\s*$|\s*;)", job.get("location") or "")
    return m.group(1) if m and m.group(1) in US_STATES else None


def _places(job):
    """JobPosting jobLocation entries from the derived city and country
    columns, which are what the board's own filters trust. One Place per
    city when the countries are unambiguous, else one per country. No
    street or postal code: the listings do not carry one, and Search
    Console's note about them is a suggestion, not something to invent."""
    countries = [c for c in (job.get("country") or "").split(",") if c]
    cities = [c for c in (job.get("city") or "").split(",") if c]
    places = []
    if cities and len(countries) <= 1:
        for city in cities:
            addr = {"@type": "PostalAddress", "addressLocality": city}
            region = _us_region(job, city)
            if region:
                addr["addressRegion"] = region
            if countries:
                addr["addressCountry"] = countries[0]
            places.append({"@type": "Place", "address": addr})
    else:
        for code in countries:
            places.append({"@type": "Place", "address": {"@type": "PostalAddress", "addressCountry": code}})
    return places


_CURRENCIES = [
    # longest prefixes first, so CA$ is read before $
    ("CA$", "CAD"), ("C$", "CAD"), ("A$", "AUD"), ("AU$", "AUD"), ("NZ$", "NZD"), ("US$", "USD"), ("S$", "SGD"),
    ("HK$", "HKD"), ("USD", "USD"), ("EUR", "EUR"), ("GBP", "GBP"), ("ILS", "ILS"), ("NIS", "ILS"), ("CAD", "CAD"),
    ("AUD", "AUD"), ("CHF", "CHF"), ("INR", "INR"), ("SGD", "SGD"), ("$", "USD"), ("€", "EUR"), ("£", "GBP"),
    ("₪", "ILS"), ("₹", "INR"), ("¥", "JPY"),
]
_UNITS = [("per hour", "HOUR"), ("/hour", "HOUR"), ("/hr", "HOUR"), ("hourly", "HOUR"), ("per day", "DAY"),
          ("per week", "WEEK"), ("per month", "MONTH"), ("/month", "MONTH"), ("monthly", "MONTH"),
          ("per year", "YEAR"), ("/year", "YEAR"), ("annually", "YEAR"), ("a year", "YEAR")]
_AMOUNT = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*([kK])?")


def _amounts(text):
    out = []
    for num, k in _AMOUNT.findall(text):
        try:
            v = float(num.replace(",", ""))
        except ValueError:
            continue
        out.append(v * 1000 if k else v)
    return out


def base_salary(job):
    """schema.org baseSalary, and only from a figure the employer gave.
    An estimate never goes into the markup, whatever the page says next
    to it. The text is the employer's own string, so a range reads as
    min and max, a single figure as a value, and anything with more than
    one range in it ("$600 – $2,000 per month · Multiple Ranges") is
    left out rather than half-read."""
    text = (job.get("salary_text") or "").strip()
    source = job.get("salary_source") or ("table" if job.get("salary_is_estimate") else "disclosed")
    if not text or source != "disclosed":
        return None
    # the first segment is the figure; anything after a separator is a
    # note (sign-on bonus, commission, "Multiple Ranges")
    head = re.split(r"\s[·•|]\s", text)[0]
    lower = head.lower()
    currency = next((code for sym, code in _CURRENCIES if sym.lower() in lower), None)
    if not currency:
        return None
    unit = next((u for word, u in _UNITS if word in lower), "YEAR")
    # strip currency words so "CA$90K" does not read its CA as a number
    figures = _amounts(re.sub(r"[A-Za-z]{2,3}\$", "$", head))
    if not figures or len(figures) > 2 or "multiple" in text.lower():
        return None
    value = {"@type": "QuantitativeValue", "unitText": unit}
    if len(figures) == 2:
        lo, hi = sorted(figures)
        value["minValue"], value["maxValue"] = lo, hi
    else:
        value["value"] = figures[0]
    return {"@type": "MonetaryAmount", "currency": currency, "value": value}


def deadline(job, now=None):
    """(date, phrase) when the description names a closing date, else
    None. The phrase is what the page sets in bold."""
    now = now or datetime.now(timezone.utc)
    posted = _parse(job.get("posted_at")) or _parse(job.get("first_seen"))
    return deadline_from(job.get("description") or "", now, country=(job.get("country") or "").split(",")[0], posted=posted)


def json_ld(job, now=None) -> dict:
    """schema.org JobPosting for an open listing. Every value here is
    also visible on the page, which is Google's rule for this markup.

    validThrough only when the description names a closing date, which
    the page shows as "Closes …". Google's own guidance is to leave the
    field out rather than invent one; a listing that closes is served
    410 with the markup gone, which is the signal that matters."""
    posted = _parse(job.get("posted_at")) or _parse(job.get("first_seen"))
    org = {"@type": "Organization", "name": company_label(job)}
    domain = job.get("company_domain") or ""
    if "." in domain and not domain.endswith(".invalid"):
        org["sameAs"] = f"https://{domain}"
    if job.get("logo_url"):
        org["logo"] = job["logo_url"]
    data = {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": job.get("title", ""),
        "description": job.get("description") or job.get("title", ""),
        "datePosted": posted.date().isoformat() if posted else None,
        "hiringOrganization": org,
        "url": canonical_url(job["id"]),
    }
    closes = deadline(job, now)
    if closes:
        data["validThrough"] = f"{closes[0].isoformat()}T23:59:59"
    places = _places(job)
    if places:
        data["jobLocation"] = places if len(places) > 1 else places[0]
    if job.get("workplace_type") == "remote":
        data["jobLocationType"] = "TELECOMMUTE"
        # Google wants a remote listing to say where applicants may be,
        # and reads one with neither this nor a jobLocation as invalid.
        # The countries the listing itself names are that answer; a
        # remote listing that names none is left as it is.
        wanted = [{"@type": "Country", "name": label_for(c)} for c in (job.get("country") or "").split(",") if c]
        if wanted:
            data["applicantLocationRequirements"] = wanted if len(wanted) > 1 else wanted[0]
    if job.get("external_id"):
        data["identifier"] = {"@type": "PropertyValue", "name": job.get("ats") or "ats", "value": str(job["external_id"])}
    if job.get("department"):
        data["occupationalCategory"] = job["department"]
    if job.get("seniority") == "intern":
        data["employmentType"] = "INTERN"
    salary = base_salary(job)
    if salary:
        data["baseSalary"] = salary
    return {k: v for k, v in data.items() if v is not None}


def _where_line(job) -> str:
    """"Venray, Limburg, Netherlands": the listing's own place text, with
    the country spelled out when only its code is there."""
    loc = (job.get("location") or "").split(";")[0].strip()
    codes = [c for c in (job.get("country") or "").split(",") if c]
    if loc and codes and label_for(codes[0]) and label_for(codes[0]).lower() not in loc.lower() and codes[0] not in loc.split(", "):
        loc = f"{loc}, {label_for(codes[0])}"
    return loc


def _role_row(j, now, with_company=True) -> str:
    esc = html.escape
    main, sub, _hours = split_title(j.get("title", ""))
    company = (j.get("company_name") or j.get("company_domain") or "").strip()
    city = (j.get("city") or "").split(",")[0].strip() or (j.get("location") or "").split(",")[0].strip()
    bits = [esc(x) for x in ([company] if with_company else []) + [city] if x]
    when = ago_short(j.get("posted_at") or j.get("first_seen"), now)
    if when:
        bits.append(esc(when))
    return (f'<a class="pg-row" href="/job/{esc(j["id"])}">{monogram(company, 32, j.get("logo_url"))}'
            f'<span class="pg-row-text"><span class="pg-row-title">{esc(main)}</span>'
            f'<span class="pg-row-sub">{" · ".join(bits)}</span></span></a>')


def render(job, now=None, extra=None) -> str:
    """The page for a job the database knows. Status is status_for().

    extra, when the handler has it: {"company_open": int, "company_jobs":
    [rows], "similar": [rows], "company_category": str}. Without it the
    page simply has no sidebar lists."""
    esc = html.escape
    now = now or datetime.now(timezone.utc)
    extra = extra or {}
    company = company_label(job)
    domain = job.get("company_domain") or ""
    main_title, sub_title, hours = split_title(job.get("title", ""))
    # The city goes in the title when there is one: "at Wix, Tel Aviv" is
    # what someone searching for the role types, and the title is the
    # one line of ours a search result shows.
    city = (job.get("city") or "").split(",")[0].strip()
    where = f", {city}" if city else ""
    title = f"{job.get('title', '').strip()} at {company}{where} | Ocean of Jobs"
    closed = _parse(job.get("closed_at"))
    posted = _parse(job.get("posted_at")) or _parse(job.get("first_seen"))
    open_ = closed is None
    desc = _meta_description(job)
    head = _head(title, desc, canonical_url(job["id"]), robots=None if open_ else "noindex,follow",
                 ld=json_ld(job, now) if open_ else None)

    closes = deadline(job, now) if open_ else None
    language = language_of(job.get("description") or "")
    level = SENIORITY_LABELS.get(job.get("seniority") or "", job.get("seniority"))
    workplace = WORKPLACE_LABELS.get(job.get("workplace_type") or "", job.get("workplace_type"))
    system = ats_name(job.get("ats"))

    # The meta line and the tags under the title.
    meta = []
    place = _where_line(job)
    if place:
        meta.append(f'<span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>{esc(place)}</span>')
    if workplace:
        meta.append(f'<span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>{esc(workplace)}</span>')
    if posted:
        meta.append(f'<span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Posted {esc(short_date(posted))}</span>')
    tags = []
    if closes:
        days = (closes[0] - now.date()).days
        left = "closes today" if days == 0 else f"{days} {plural(days, 'day')} left"
        tags.append(f'<span class="pg-tag pg-tag-green"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>Closes {esc(short_date(closes[0]))} · {esc(left)}</span>')
    if level:
        tags.append(f'<span class="pg-tag">{esc(level)}</span>')
    if hours:
        tags.append(f'<span class="pg-tag">{esc(hours)}</span>')
    if language != "English":
        tags.append(f'<span class="pg-tag"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>Listing in {esc(language)}</span>')
    if job.get("confidence") == "best_effort":
        tags.append('<span class="pg-tag" title="Scraped from the company\'s own page, not a live ATS API">Company website</span>')
    if not open_:
        tags.append('<span class="pg-tag pg-tag-closed">Closed</span>')

    # The facts, without the rows that have nothing to say.
    facts = [("Company", esc(company))]
    if place:
        facts.append(("Location", esc(place)))
    if workplace:
        facts.append(("Workplace", esc(workplace)))
    if level:
        facts.append(("Type" if job.get("seniority") == "intern" else "Level", esc(level)))
    if hours:
        facts.append(("Hours", esc(hours)))
    if job.get("department"):
        facts.append(("Team", esc(job["department"])))
    if job.get("category"):
        facts.append(("Category", esc(job["category"])))
    if closes:
        facts.append(("Closes", esc(long_date(closes[0]))))
    if posted:
        facts.append(("Posted", esc(long_date(posted))))
    salary = _salary_line(job)
    if salary:
        text, estimate = salary
        facts.append(("Estimated salary" if estimate else "Salary",
                      esc(text) + (' <span class="pg-muted">(a market estimate, not the employer\'s figure)</span>' if estimate else "")))
    facts.append(("Source", esc(system if not ats_is_site(job.get("ats")) else "Company website")))
    facts_html = "".join(f'<div class="pg-fact"><span class="pg-fact-k">{k}</span><span class="pg-fact-v">{v}</span></div>' for k, v in facts)
    seen_bits = []
    if not salary:
        seen_bits.append("No salary published")
    first = _parse(job.get("first_seen"))
    if first:
        seen_bits.append(f"first seen {short_date(first)}")
    if job.get("last_seen") and open_:
        seen_bits.append(f"checked {ago(job['last_seen'], now)}")
    seen_line = f'<p class="pg-muted pg-seen">{esc(" · ".join(seen_bits))}</p>' if seen_bits else ""

    # The description, with the closing-date phrase in bold.
    description = description_html(job.get("description") or "", bold=closes[1] if closes else None)
    if not description:
        description = '<p class="pg-muted">No description was provided by this listing. The apply link has the full posting.</p>'

    apply_url = esc(job.get("url") or "#")
    apply_label = f"Apply on {esc(company)} <span aria-hidden=\"true\">↗</span>"
    if open_:
        notice = ""
        apply_main = f'<a class="pg-apply" href="{apply_url}" target="_blank" rel="noopener nofollow">{apply_label}</a>'
        ready = (f'<div class="pg-ready"><div><div class="pg-ready-title">Ready to apply?</div>'
                 f'<div class="pg-muted">You\'ll finish on {esc(company)}\'s own site'
                 f'{"" if ats_is_site(job.get("ats")) else f", via {esc(system)}"}.</div></div>'
                 f'<a class="pg-apply pg-apply-inline" href="{apply_url}" target="_blank" rel="noopener nofollow">{apply_label}</a></div>')
    else:
        notice = (f'<div class="pg-notice">This listing closed on {_human_date(closed)}. '
                  f'<a href="/board?company={esc(domain)}">See what {esc(company)} is hiring for now</a>.</div>')
        apply_main = '<a class="pg-apply pg-apply-off" href="/board">Browse open listings</a>'
        ready = ""

    # The company line under the logo: what they do, how many roles.
    about = []
    if extra.get("company_category"):
        about.append(esc(extra["company_category"]))
    n_open = extra.get("company_open")
    if n_open:
        about.append(f"{fmt_int(n_open)} open {plural(n_open, 'role')}")
    about_line = f'<div class="pg-muted">{" · ".join(about)}</div>' if about else ""

    crumbs = ['<a href="/board">Jobs</a>']
    if job.get("category"):
        crumbs.append(f'<a href="/board?department={esc(job["category"])}">{esc(job["category"])}</a>')
    crumbs.append(f'<a href="/company/{esc(domain)}">{esc(company)}</a>')

    more = ""
    if extra.get("company_jobs"):
        rows = "".join(_role_row(j, now, with_company=True) for j in extra["company_jobs"][:3])
        all_n = f'<a class="pg-side-all" href="/company/{esc(domain)}">All {fmt_int(n_open)}</a>' if n_open else ""
        more = f'<section class="pg-card"><div class="pg-card-head"><span class="pg-card-title">More at {esc(company)}</span>{all_n}</div>{rows}</section>'
    similar = ""
    if extra.get("similar"):
        rows = "".join(_role_row(j, now, with_company=True) for j in extra["similar"][:3])
        similar = (f'<section class="pg-card"><div class="pg-card-title">Similar roles</div>{rows}'
                   f'<button type="button" class="pg-btn pg-btn-wide" data-alert-like><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21h4"/></svg>Alert me for roles like this</button></section>')

    alert_filter = {"department": job.get("category") or job.get("department") or "", "country": (job.get("country") or "").split(",")[0]}
    body = f"""{TOPBAR}
  <main class="pg-main" id="main" tabindex="-1">
    <nav class="pg-crumbs" aria-label="Breadcrumb">{" / ".join(crumbs)}</nav>
    {notice}
    <div class="pg-grid">
      <article class="pg-article">
        <div class="pg-company">{monogram(company, 48, job.get("logo_url"))}<div><a class="pg-company-name" href="/company/{esc(domain)}">{esc(company)}</a>{about_line}</div></div>
        <h1 class="job-page-title pg-title">{esc(main_title)}{f' <span class="pg-title-sub">{esc(sub_title)}</span>' if sub_title else ""}</h1>
        <div class="pg-meta">{"".join(meta)}</div>
        <div class="pg-tags">{"".join(tags)}</div>
        <div class="pg-desc job-page-description">{description}</div>
        {ready}
      </article>
      <aside class="pg-side">
        <section class="pg-card pg-card-main">
          {apply_main}
          <div class="pg-side-acts">
            <button type="button" class="pg-btn" data-save="{esc(job["id"])}" aria-pressed="false"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg><span>Save</span></button>
            <button type="button" class="pg-btn" data-copy="{canonical_url(job["id"])}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg><span>Copy link</span></button>
          </div>
          <div class="pg-facts">{facts_html}</div>
          {seen_line}
          <a class="pg-muted pg-board-link" href="/board?job={esc(job["id"])}">Open on the board</a>
        </section>
        {more}
        {similar}
      </aside>
    </div>
  </main>
  <script>
    (function () {{
      var KEY = "iljobs_starred";
      var save = document.querySelector("[data-save]");
      var read = function () {{ try {{ return JSON.parse(localStorage.getItem(KEY) || "[]"); }} catch (e) {{ return []; }} }};
      var paint = function () {{ var on = read().indexOf(save.dataset.save) >= 0; save.setAttribute("aria-pressed", String(on)); save.classList.toggle("on", on); save.querySelector("span").textContent = on ? "Saved" : "Save"; }};
      if (save) {{ paint(); save.addEventListener("click", function () {{ var ids = read(); var i = ids.indexOf(save.dataset.save); if (i >= 0) ids.splice(i, 1); else ids.push(save.dataset.save); try {{ localStorage.setItem(KEY, JSON.stringify(ids)); }} catch (e) {{}} paint(); }}); }}
      var copy = document.querySelector("[data-copy]");
      if (copy) copy.addEventListener("click", function () {{
        var done = function () {{ copy.querySelector("span").textContent = "Copied"; setTimeout(function () {{ copy.querySelector("span").textContent = "Copy link"; }}, 1500); }};
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(copy.dataset.copy).then(done, function () {{}});
        else {{ var ta = document.createElement("textarea"); ta.value = copy.dataset.copy; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); done(); }}
      }});
      var like = document.querySelector("[data-alert-like]");
      if (like) like.addEventListener("click", function () {{
        try {{ sessionStorage.setItem("iljobs_alert_prefill", JSON.stringify({_json_js(alert_filter)})); }} catch (e) {{}}
        location.href = "/account#alerts";
      }});
    }})();
  </script>
{FOOT}"""
    return head + body


def _json_js(obj) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False).replace("<", "\\u003c")


def render_missing(status: int, job_id: str) -> str:
    """The 404 and 410 pages: short, honest, noindex."""
    gone = status == 410
    title = "Listing no longer available | Ocean of Jobs" if gone else "Listing not found | Ocean of Jobs"
    what = ("This listing closed a while ago and the page has been retired."
            if gone else "There is no listing with this id. It may have been removed, or the link may be wrong.")
    head = _head(title, what, canonical_url(job_id), robots="noindex", og_type="website")
    return head + f"""{TOPBAR}
  <main class="pg-main" id="main" tabindex="-1">
    <div class="pg-article">
      <h1 class="job-page-title pg-title">{html.escape(title.split(" | ")[0])}</h1>
      <p>{html.escape(what)}</p>
      <p><a class="pg-apply pg-apply-off" href="/board">Browse open listings</a></p>
    </div>
  </main>
{FOOT}"""
