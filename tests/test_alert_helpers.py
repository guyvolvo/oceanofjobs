"""The alert mail's data cleanup, one small function at a time.

Run directly, no framework:  python tests/test_alert_helpers.py
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import alerts  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


NOW = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)

# A trailing "(Company)" goes when it is the company.
check("the company in brackets comes off the end",
      alerts.strip_company_suffix("Staff Data Scientist (Armis)", "Armis") == "Staff Data Scientist")
check("case and spacing do not matter", alerts.strip_company_suffix("Engineer (armis) ", " ARMIS") == "Engineer")
check("another company's name stays", alerts.strip_company_suffix("Engineer (Armis)", "Wix") == "Engineer (Armis)")
check("a bracket that is not the company stays", alerts.strip_company_suffix("Engineer (Remote)", "Armis") == "Engineer (Remote)")
check("no company, no change", alerts.strip_company_suffix("Engineer (Armis)", "") == "Engineer (Armis)")

# " - " is a separator; a hyphen inside a word is not.
check("the separator becomes a comma and the slash after it an ampersand",
      alerts.tidy_title("Staff Security Engineer - Application/Product Security")
      == "Staff Security Engineer, Application & Product Security")
check("a hyphenated word is left alone", alerts.tidy_title("Front-end Developer") == "Front-end Developer")
check("a slash in the role itself is left alone", alerts.tidy_title("UX/UI Designer") == "UX/UI Designer")
check("two separators become two commas", alerts.tidy_title("A - B - C") == "A, B, C")
check("a slash with spaces around it is not a word pair", alerts.tidy_title("Lead - Data / Platform") == "Lead, Data / Platform")
check("both cleanups together",
      alerts.clean_title("Staff Security Engineer - Application/Product Security (Armis)", "Armis")
      == "Staff Security Engineer, Application & Product Security")

# Country codes become names.
check("il becomes Israel", alerts.country_name("il") == "Israel")
check("US becomes the full name", alerts.country_name("US") == "United States")
check("a name passes through", alerts.country_name("Israel") == "Israel")
check("an unknown code is upper-cased and kept", alerts.country_name("zz") == "ZZ")
check("empty stays empty", alerts.country_name("") == "")

# The 30-day window, on the posted date.
recent = {"posted_at": (NOW - timedelta(days=29)).isoformat(), "first_seen": NOW.isoformat()}
old = {"posted_at": (NOW - timedelta(days=31)).isoformat(), "first_seen": NOW.isoformat()}
undated = {"posted_at": None, "first_seen": (NOW - timedelta(days=40)).isoformat()}
check("29 days old is in", alerts.is_fresh(recent, NOW))
check("31 days old is out even though it was scraped today", not alerts.is_fresh(old, NOW))
check("with no posted date, first seen stands in", not alerts.is_fresh(undated, NOW))
check("no date at all is let through", alerts.is_fresh({}, NOW))

# The age line.
check("under 24 hours is Just posted, marked new",
      alerts.age_label({"posted_at": (NOW - timedelta(hours=23)).isoformat()}, NOW) == ("Just posted", True))
check("over 24 hours is days ago, not marked",
      alerts.age_label({"posted_at": (NOW - timedelta(days=15, hours=3)).isoformat()}, NOW) == ("15d ago", False))

# Where.
il = {"filter": {"country": "IL"}}
check("city and country from the columns", alerts.row_place({"city": "Tel Aviv", "country": "IL"}) == "Tel Aviv, Israel")
check("the alert's country wins when a listing names several",
      alerts.row_place({"city": "Tel Aviv,Berlin", "country": "DE,IL"}, il) == "Tel Aviv, Israel")
check("no columns: the location text, with a trailing code spelled out",
      alerts.row_place({"location": "Haifa, IL"}) == "Haifa, Israel")
check("no columns and a full name: as it was", alerts.row_place({"location": "Haifa, Israel"}) == "Haifa, Israel")

# Logos: only ones this site serves.
check("a logo on this site is used", alerts.hosted_logo({"logo_url": f"{alerts.SITE_ORIGIN}/img/logos/ubisoft.png"}))
check("a hot-linked logo is not", alerts.hosted_logo({"logo_url": "https://www.wix.com/favicon.ico"}) is None)

# The since line.
check("the last digest's date", alerts.since_label({"last_digest_at": "2026-09-29T09:00:00+00:00"}) == "Sep 29")
check("a first mail dates from the alert's creation",
      alerts.since_label({"created_at": "2026-09-03T09:00:00+00:00"}) == "Sep 3")

# Unsubscribe tokens.
tok = alerts.unsubscribe_token("user-1", "alert-1", secret="s3cret")
check("a token is 32 hex characters and stable", len(tok) == 32 and tok == alerts.unsubscribe_token("user-1", "alert-1", secret="s3cret"))
check("another alert gets another token", tok != alerts.unsubscribe_token("user-1", "alert-2", secret="s3cret"))
check("another secret gets another token", tok != alerts.unsubscribe_token("user-1", "alert-1", secret="other"))
check("without a secret in the environment there is no one-click URL and the old header stands",
      alerts.unsubscribe_url({"user_id": "u", "alert_id": "a"}) is None
      and alerts._mail_headers({"user_id": "u", "alert_id": "a"}) == [{"Name": "List-Unsubscribe", "Value": f"<{alerts.SITE_ORIGIN}/account>"}])
alerts.UNSUBSCRIBE_SECRET = "s3cret"
try:
    url = alerts.unsubscribe_url({"user_id": "user-1", "alert_id": "alert-1"})
    hdrs = alerts._mail_headers({"user_id": "user-1", "alert_id": "alert-1"})
    check("with one, the URL carries the key and the token",
          url == f"{alerts.SITE_ORIGIN}/api/alerts/unsubscribe?u=user-1&a=alert-1&t={tok}", url)
    check("and the mail gets both headers, one-click included",
          hdrs == [{"Name": "List-Unsubscribe", "Value": f"<{url}>"},
                   {"Name": "List-Unsubscribe-Post", "Value": "List-Unsubscribe=One-Click"}], repr(hdrs))
finally:
    alerts.UNSUBSCRIBE_SECRET = ""

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
