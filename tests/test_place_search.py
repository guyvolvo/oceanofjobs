"""Searching for a place from the board's Location box.

The location facet carries the 40 biggest countries, so typing
"argentina" said No places match while Argentina had 1,891 listings.
/api/places/search asks the snapshot for countries and cities whose names
contain the text, counted under the board's other filters.

Run directly, no framework:  python tests/test_place_search.py
"""

import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

os.environ.setdefault("ALERTS_TABLE", "test-alerts")
os.environ.setdefault("DATA_BUCKET", "test-bucket")
os.environ.setdefault("DATA_KEY", "jobs.db")
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import aggregates  # noqa: E402
import handler  # noqa: E402
import job_filters  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


conn = sqlite3.connect(":memory:")
conn.row_factory = sqlite3.Row
conn.execute("""CREATE TABLE jobs (id TEXT PRIMARY KEY, company_domain TEXT, ats TEXT, title TEXT,
    location TEXT, department TEXT, seniority TEXT, workplace_type TEXT, url TEXT, posted_at TEXT,
    confidence TEXT, first_seen TEXT, last_seen TEXT, closed_at TEXT, skills TEXT, description TEXT,
    country TEXT, city TEXT)""")
conn.execute("CREATE TABLE companies (domain TEXT PRIMARY KEY, ats TEXT)")
jobs = [("a1", "AR", "Buenos Aires", "Engineer"), ("a2", "AR", "Buenos Aires", "Engineer"),
        ("a3", "AR", "Cordoba", "Engineer"), ("a4", "AR", "Cordoba", "Designer"),
        ("u1", "US", "Buenos Aires", "Engineer"),  # the small town in Michigan
        ("i1", "IL", "Tel Aviv", "Engineer"), ("i2", "IL", "Tel Aviv_Yafo", "Engineer")]
for jid, country, city, title in jobs:
    conn.execute("INSERT INTO jobs (id, company_domain, ats, title, location, confidence, posted_at, first_seen,"
                 " last_seen, country, city) VALUES (?,'x.com','x',?,'',"
                 "'verified',datetime('now'),datetime('now'),datetime('now'),?,?)", (jid, title, country, city))
conn.commit()
job_filters.register_functions(conn)

places = lambda **p: {c["value"]: c for c in aggregates.search_places(conn, p)["locations"]}

got = places(name="argentina")
check("a country past any top-N cut is found by name", list(got) == ["AR"], repr(got))
check("with its listings and all its cities",
      got["AR"]["n"] == 4 and [t["value"] for t in got["AR"]["cities"]] == ["Buenos Aires", "Cordoba"], repr(got))
check("case does not matter", list(places(name="ARGEN")) == ["AR"])

got = places(name="buenos")
check("a city is found under every country that names it", sorted(got) == ["AR", "US"], repr(got))
check("a country found only through a city carries no count of its own",
      got["US"]["n"] is None and got["US"]["cities"] == [{"value": "Buenos Aires", "n": 1}], repr(got))
check("and lists only the matching city", [t["value"] for t in got["AR"]["cities"]] == ["Buenos Aires"], repr(got))

check("an underscore is a literal character, not a wildcard",
      [t["value"] for t in places(name="v_y")["IL"]["cities"]] == ["Tel Aviv_Yafo"], repr(places(name="v_y")))
check("one character asks nothing", places(name="a") == {})
check("other filters still count", places(name="argentina", search="designer")["AR"]["n"] == 1,
      repr(places(name="argentina", search="designer")))
check("the place filters themselves are ignored, so a ticked country does not hide the others",
      list(places(name="argentina", country="IL", city="IL:Tel Aviv")) == ["AR"])

handler.get_connection = lambda: conn
resp = handler.lambda_handler({"rawPath": "/api/places/search", "rawQueryString": "name=argentina",
                               "queryStringParameters": {"name": "argentina"},
                               "requestContext": {"http": {"method": "GET"}}}, None)
body = json.loads(resp["body"])
check("the route answers", resp["statusCode"] == 200 and body["locations"][0]["value"] == "AR", repr(resp)[:200])

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
