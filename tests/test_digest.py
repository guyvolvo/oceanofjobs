"""The alert digest: what it says, in both parts, and how it holds up
with Hebrew titles, hot-linked logos and empty fields.

Run directly, no framework:  python tests/test_digest.py
"""

import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

# alerts.py builds its DynamoDB and SES clients at import time; nothing
# here calls them, but botocore still wants a region and keys to build.
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import html as _html  # noqa: E402
import alerts  # noqa: E402

failures = []

# digest_due: the cadence gate. A fixed clock, so the test does not
# depend on when it runs.
_MON_0630 = datetime(2026, 9, 28, 6, 30, tzinfo=timezone.utc)   # a Monday; 09:30 in Israel
_TUE_0630 = _MON_0630 + timedelta(days=1)
_MON_1200 = _MON_0630.replace(hour=12)


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


NOW = datetime(2026, 9, 19, 12, 0, tzinfo=timezone.utc)
ALERT = {"alert_id": "a1", "user_id": "u1", "email": "x@example.com",
         "filter": {"country": "IL", "department": "Product", "seniority": "senior", "search": ""}}


def job(**over):
    base = {"id": "abc", "title": "Senior Product Manager", "company_domain": "wix.com", "company_name": "Wix",
            "city": "Tel Aviv", "country": "il", "location": "Tel Aviv, Israel",
            "url": "https://boards.greenhouse.io/wix/jobs/1",
            "posted_at": (NOW - timedelta(hours=2)).isoformat(), "first_seen": (NOW - timedelta(hours=1)).isoformat(),
            "seniority": "senior", "workplace_type": "hybrid", "salary_text": None, "salary_is_estimate": 0, "salary_source": None,
            "logo_url": "https://wix.com/favicon.png"}
    base.update(over)
    return base


matches = [
    job(),
    job(id="heb", title="ראש/ת מנהל תקשורת שיווקית וקשרי לקוחות", company_domain="iai.co.il", company_name="IAI",
        city=None, country=None, location='נתב"ג, Israel', url="https://jobs.iai.co.il/job/76050151", posted_at=None,
        first_seen=(NOW - timedelta(days=3)).isoformat(), seniority=None, workplace_type=None),
    job(id="est", title="Data Engineer - Streaming/Batch (Wix)", salary_text="₪30K – ₪40K", salary_source="model",
        logo_url=f"{alerts.SITE_ORIGIN}/img/logos/wix.png"),
    job(id="disc", title="Backend <Lead>", salary_text="$150K – $200K", salary_source="disclosed", company_name=None, logo_url=None),
]

h = alerts._digest_html(len(matches), matches, ALERT, NOW)
t = alerts._digest_text(len(matches), matches, ALERT, NOW)

# The shell: dark by declaration, tables only, one font stack, no web font
check("the head declares the dark scheme so clients do not invert it",
      '<meta name="color-scheme" content="dark" />' in h and '<meta name="supported-color-schemes" content="dark" />' in h)
check("the preheader is hidden and says how many, what for, since when",
      '4 new jobs matching "Israel" since Sep 19' in h and "max-height:0" in h)
check("tables, no flex, no grid, no positioning, no SVG, no background image",
      'role="presentation"' in h and "display:flex" not in h and "display:grid" not in h
      and "position:" not in h and "<svg" not in h and "background-image" not in h and "url(" not in h)
check("the font stack starts with Geist and no web font is loaded",
      "'Geist',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif" in h and "fonts.googleapis" not in h)
check("600px at most, centred, 40px of page around it and 16px on a phone",
      "max-width:600px" in h and 'align="center"' in h and 'class="otj-page" style="padding:40px 16px;"' in h
      and ".otj-page { padding: 16px !important; }" in h)
check("page, card and header colours", "background:#0a0a0b" in h
      and "background:#111214; border:1px solid #222328; border-radius:20px" in h
      and "background:#000000; border-bottom:1px solid #222328" in h)

# The header
check("the lighthouse and the site name", f'<img src="{alerts.LOGO_PNG}" width="28" height="28"' in h and ">oceanofjobs.com</td>" in h)
check("the count is green inside a 40px headline, 30px on a phone",
      '<span style="color:#2fb36a;">4</span> new jobs for &ldquo;Israel&rdquo;' in h
      and "font-size:40px; line-height:1.05; font-weight:500; letter-spacing:-0.03em" in h
      and ".otj-head { font-size: 30px !important;" in h)
check("the since line carries the date", ">Since your last alert on Sep 19</div>" in h)

# Rows
check("four rows, 4px apart, no rules between them",
      h.count("padding:0 0 4px 0;") == 4 and "border-top" not in h)
check("a hot-linked logo is not loaded; the tile shows the company's letter",
      "wix.com/favicon.png" not in h
      and 'border-radius:12px; font-family:\'Geist\',-apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif; font-size:20px; line-height:1; font-weight:600; color:#c9cacf;">W</td>' in h)
check("a logo this site serves is shown in the tile",
      f'<img src="{alerts.SITE_ORIGIN}/img/logos/wix.png" width="48" height="48"' in h)
check("no company name at all: the domain's letter", 'color:#c9cacf;">W</td>' in h and h.count('color:#c9cacf;">W</td>') == 2)
check("the title links to the job's page here, 17px, no underline",
      f'<a href="{alerts.SITE_ORIGIN}/job/abc" dir="auto" style="display:block; font-family:\'Geist\',-apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif; font-size:17px; line-height:1.3; font-weight:500; color:#f4f1ee; text-decoration:none;">Senior Product Manager</a>' in h)
check("company, city with the country spelled out, and the age",
      'Wix &middot; Tel Aviv, Israel &middot; <span style="color:#2fb36a;">Just posted</span>' in h)
check("older than a day: days ago, muted", '<span style="color:#8a8c93;">3d ago</span>' in h)
check("no city column: the location text stands in", 'IAI &middot; נתב&quot;ג, Israel' in h)
check("the trailing company comes off the title and the separator is tidied",
      ">Data Engineer, Streaming &amp; Batch</a>" in h and "(Wix)" not in h)
check("no salary in the mail", "₪30K" not in h and "$150K" not in h and "Est." not in h)
check("angle brackets in a title are escaped", "Backend &lt;Lead&gt;" in h and "<Lead>" not in h)
check("Apply goes straight to the employer, with the arrow as text",
      h.count('href="https://boards.greenhouse.io/wix/jobs/1"') >= 2 and "Apply&nbsp;&#8599;" in h and "<svg" not in h)
check("the buttons have an Outlook fallback", h.count("<v:roundrect") == 5 and 'fillcolor="#2fb36a"' in h)
check("on a phone the right-hand button hides and the one under the words shows",
      ".otj-apply-desk { display: none !important; }" in h and ".otj-apply-mob { display: block !important;" in h
      and h.count('class="otj-apply-mob"') == 4)
check("titles and meta lines size themselves to their script", h.count('dir="auto"') == 9)

# The footer, in and under the card
board = alerts.board_url(ALERT)
check("the board link carries the alert's own filters, empty ones dropped",
      board == "https://oceanofjobs.com/board?country=IL&department=Product&seniority=senior", board)
check("See all with the count, then Edit this alert",
      ">See all 4 jobs</a>" in h and h.count(f'href="{_html.escape(board)}"') == 2 and ">Edit this alert</a>" in h)
check("why you got this, and the three links",
      "because you created an alert for &ldquo;Israel&rdquo; on oceanofjobs.com" in h
      and ">Manage alerts</a>" in h and ">Unsubscribe</a>" in h and h.count(f'href="{alerts.SITE_ORIGIN}/account"') == 3
      and f'href="{alerts.SITE_ORIGIN}/"' in h)
check("the card comes before the footer text",
      h.index("border-radius:20px") < h.index('class="otj-head"') < h.index(">See all 4 jobs</a>") < h.index(">Manage alerts</a>"))

# Five rows at most, and the button carries the rest
many = [job(id=f"j{i}", title=f"Role {i}") for i in range(9)]
big = alerts._digest_html(9, many, ALERT, NOW)
check("at most five rows are shown", big.count("padding:0 0 4px 0;") == 5 and "Role 4" in big and "Role 5" not in big)
check("the button says how many there are in total", ">See all 9 jobs</a>" in big)

# Plain text says the same things
check("text part: headline, since, rows with apply and page links, then the board",
      t.startswith('4 new jobs for "Israel"\nSince your last alert on Sep 19')
      and "Apply: https://boards.greenhouse.io/wix/jobs/1" in t and f"{alerts.SITE_ORIGIN}/job/abc" in t
      and f"See all 4 jobs: {board}" in t and f"Edit this alert: {alerts.SITE_ORIGIN}/account" in t
      and "Manage alerts or unsubscribe" in t, t[:200])
check("text part: cleaned titles, no salary", "Data Engineer, Streaming & Batch" in t and "Est." not in t and "₪" not in t)

# Singular, and an alert with no filter at all
one = alerts._digest_html(1, matches[:1], {"filter": {}}, NOW)
check("singular reads right", '1</span> new job for &ldquo;your alert&rdquo;' in one and '1 new job matching "your alert"' in one
      and ">See all 1 job</a>" in one)
check("no filter means a bare board link", 'href="https://oceanofjobs.com/board"' in one)
check("israel_only still reads as Israel", alerts._filter_summary({"filter": {"israel_only": True}}) == ["Israel"]
      and alerts.alert_name({"filter": {"israel_only": True}}) == "Israel")

# The subject line: the newest listing, named
check("one job: title at company",
      alerts.digest_subject(ALERT, matches[:1]) == "Senior Product Manager at Wix", alerts.digest_subject(ALERT, matches[:1]))
check("two jobs: both named, no arithmetic",
      alerts.digest_subject(ALERT, matches[:2]) == "Senior Product Manager at Wix and ראש/ת מנהל תקשורת שיווקית וקשרי לקוחות at IAI")
check("three or more: the first, then the count of the rest",
      alerts.digest_subject(ALERT, matches) == "Senior Product Manager at Wix and 3 more new jobs", alerts.digest_subject(ALERT, matches))
check("no company name falls back to the domain, and none at all to the title alone",
      alerts.digest_subject(ALERT, [matches[3]]) == "Backend <Lead> at wix.com"
      and alerts.digest_subject(ALERT, [job(company_name=None, company_domain="")]) == "Senior Product Manager")
check("the preheader still carries the count and the alert name, so the inbox line does",
      '4 new jobs matching "Israel" since Sep 19' in h)

print()
check("instant is always due", alerts.digest_due("instant", None, _MON_1200))
# daily, default 09:00 Asia/Jerusalem; 06:30Z is 09:30 there
check("daily, nothing sent since before today's moment, sends",
      alerts.digest_due("daily", (_MON_0630 - timedelta(hours=1)).isoformat(), _MON_0630))
check("daily, sent after today's moment, waits",
      not alerts.digest_due("daily", (_MON_0630 - timedelta(minutes=20)).isoformat(), _MON_0630))
check("daily, before today's moment, yesterday's already sent, waits",
      not alerts.digest_due("daily", (_MON_0630 - timedelta(days=1)).isoformat(), _MON_0630 - timedelta(hours=2)))
check("daily, before today's moment, yesterday's missed, sends now",
      alerts.digest_due("daily", (_MON_0630 - timedelta(days=2)).isoformat(), _MON_0630 - timedelta(hours=2)))
check("daily, created after today's moment, waits for tomorrow",
      not alerts.digest_due("daily", (_MON_0630 + timedelta(minutes=5)).isoformat(), _MON_0630 + timedelta(hours=1)))
check("daily at a chosen time and zone: 18:00 New York is 22:00Z, due at 22:05Z",
      alerts.digest_due("daily", (_MON_0630).isoformat(), _MON_0630.replace(hour=22, minute=5), at="18:00", tz="America/New_York"))
check("daily at a chosen time and zone: not due at 21:55Z",
      not alerts.digest_due("daily", (_MON_0630).isoformat(), _MON_0630.replace(hour=21, minute=55), at="18:00", tz="America/New_York"))
# weekly, default Monday
check("weekly on Monday after the moment, last week's sent, sends",
      alerts.digest_due("weekly", (_MON_0630 - timedelta(days=7)).isoformat(), _MON_0630))
check("weekly on Tuesday, Monday's sent, waits",
      not alerts.digest_due("weekly", _MON_0630.isoformat(), _TUE_0630))
check("weekly on Tuesday, Monday's missed, sends",
      alerts.digest_due("weekly", (_MON_0630 - timedelta(days=8)).isoformat(), _TUE_0630))
check("weekly on a chosen day: Friday, checked Tuesday, waits",
      not alerts.digest_due("weekly", (_MON_0630 - timedelta(days=1)).isoformat(), _TUE_0630, day=4))
check("weekly on a chosen day: Friday, checked Friday 09:30 IL, sends",
      alerts.digest_due("weekly", (_MON_0630 - timedelta(days=1)).isoformat(), _MON_0630 + timedelta(days=4), day=4))
check("unknown cadence behaves as instant", alerts.digest_due("hourly", None, _MON_1200))
check("a bad zone and time fall back to the defaults, not to never",
      alerts.digest_due("daily", (_MON_0630 - timedelta(hours=1)).isoformat(), _MON_0630, at="nope", tz="Mars/Olympus"))

if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
