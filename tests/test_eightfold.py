"""Eightfold careers boards (probe.f_eightfold), first used for Teva.

The payload shape is trimmed from careers.teva on 2026-09-18. The trap
worth a test: the server decides the page size. It answered 10 rows to
num=100, so a reader that advances by the number it asked for skips most
of the board while looking like it read all of it (498 of 558 missed
when this was written).

Run directly, no framework:  python tests/test_eightfold.py
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

import probe  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


TOKEN = "careers.teva:tevapharm.com"


def pos(jid, name, location, locations=None, department="Quality", created=1787135417,
        workplace="onsite", description=""):
    return {"id": jid, "name": name, "location": location, "locations": locations or [location],
            "department": department, "t_create": created, "t_update": created + 100,
            "work_location_option": workplace, "job_description": description,
            "canonicalPositionUrl": f"https://www.careers.teva/careers/job/{jid}"}


class Resp:
    def __init__(self, status=200, payload=None):
        self.status_code, self._payload = status, payload

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


class Sess:
    """Answers with PAGE rows at a time whatever num asks for, which is
    what the real one does."""

    def __init__(self, rows, page=10, count=None, fail_at=None):
        self.rows, self.page, self.count, self.fail_at = rows, page, count, fail_at
        self.calls = []

    def get(self, url, **kw):
        self.calls.append(url)
        self.headers = kw.get("headers") or {}
        start = int(url.split("start=")[1].split("&")[0])
        if self.fail_at is not None and start == self.fail_at:
            return Resp(403, None)
        return Resp(200, {"count": self.count if self.count is not None else len(self.rows),
                          "positions": self.rows[start:start + self.page]})


ROWS = [pos(str(i), f"Role {i}", "Kfar Saba, Israel" if i % 5 == 0 else "Prague, Czechia") for i in range(58)]

for bad in ["teva", "teva.com", "", None, "host:", ":tevapharm.com", "nodot:tevapharm.com"]:
    sess = Sess(ROWS)
    check(f"a guessed token {bad!r} makes no request",
          probe.f_eightfold(sess, bad) is None and not sess.calls)

sess = Sess(ROWS)
jobs = probe.f_eightfold(sess, TOKEN)
check("reads the whole board, not just the first page",
      jobs is not None and len(jobs) == 58, repr(jobs and len(jobs)))
check("advances by what came back, not by what it asked for",
      [int(c.split("start=")[1].split("&")[0]) for c in sess.calls][:3] == [0, 10, 20],
      repr(sess.calls[:3]))
check("sends a browser user agent and asks for JSON",
      "Mozilla" in sess.headers.get("User-Agent", "") and sess.headers.get("Accept") == "application/json",
      repr(sess.headers))
j = jobs[0]
check("title", j.title == "Role 0")
check("location", j.location == "Kfar Saba, Israel", j.location)
check("the country resolves", probe._fill_classifications(jobs, "tevapharm.com")[0].country == "IL")
check("department", j.department == "Quality")
check("workplace", j.workplace_type == "onsite", repr(j.workplace_type))
check("the date comes from the posting", (j.posted_at or "").startswith("2026-"), repr(j.posted_at))
check("the link is the board's own", j.url.endswith("/careers/job/0"), j.url)

# Several locations on one posting.
many = probe.f_eightfold(Sess([pos("9", "Split role", "Tel Aviv, Israel",
                                   ["Tel Aviv, Israel", "Kfar Saba, Israel"])]), TOKEN)
check("every named location comes along", many[0].location == "Tel Aviv, Israel; Kfar Saba, Israel",
      many[0].location)

# Descriptions where the board carries them.
with_desc = probe.f_eightfold(Sess([pos("7", "Described", "Tel Aviv, Israel",
                                        description="<p>Do the work.</p>")]), TOKEN)
check("a description is read when the board has one",
      "Do the work." in (with_desc[0].description or "") and with_desc[0].description_chars > 0,
      repr(with_desc[0].description))
check("and an empty one is not invented",
      probe.f_eightfold(Sess([pos("8", "Bare", "Tel Aviv, Israel")]), TOKEN)[0].description is None)

# Failures never close the rest of the board.
check("a page that fails part way fails the read",
      probe.f_eightfold(Sess(ROWS, fail_at=10), TOKEN) is None)
check("a tenant that refuses (403, as amdocs and qualcomm do) is a failed read",
      probe.f_eightfold(Sess(ROWS, fail_at=0), TOKEN) is None)
check("an empty board is a failed read", probe.f_eightfold(Sess([], count=0), TOKEN) is None)


# The pcsx API, for tenants the v2 call refuses. Trimmed from
# jobs.amdocs.com on 2026-11-26: 10 rows a page, no description in the
# list, the text from position_details.
def pcsx_pos(jid, locations=("Raanana, Center District, Israel",)):
    return {"id": jid, "displayJobId": "213469", "name": f"Role {jid}", "locations": list(locations),
            "standardizedLocations": ["Ra'anana, Center District, IL"], "postedTs": 1795364652,
            "creationTs": 1790010016, "department": "Engineering", "workLocationOption": "hybrid",
            "positionUrl": f"/careers/job/{jid}"}


class PcsxSess:
    def __init__(self, rows, fail_start=None):
        self.rows, self.fail_start, self.calls = rows, fail_start, []

    def get(self, url, **kw):
        self.calls.append(url)
        if "/api/apply/v2/" in url:
            return Resp(403, {"message": "Not authorized for PCSX"})
        if "/position_details" in url:
            jid = int(url.split("position_id=")[1].split("&")[0])
            return Resp(200, {"status": 200, "data": {"id": jid, "jobDescription": f"<p>Text of {jid}</p>"}})
        start = int(url.split("start=")[1].split("&")[0])
        if start == self.fail_start:
            return Resp(500, None)
        return Resp(200, {"status": 200, "data": {"count": len(self.rows), "positions": self.rows[start:start + 10]}})


AMDOCS = "jobs.amdocs.com:amdocs.com"
PCSX_ROWS = [pcsx_pos(563431014933800 + i) for i in range(23)]
sess = PcsxSess(PCSX_ROWS)
jobs = probe.f_eightfold(sess, AMDOCS, known_ids={"563431014933801"}, description_budget=1)
check("pcsx: a tenant v2 refuses is read through pcsx, every page",
      jobs is not None and len(jobs) == 23 and any("/api/apply/v2/" in c for c in sess.calls), jobs and len(jobs))
check("pcsx: asks for every location",
      all("&location=&" in c for c in sess.calls if "/pcsx/search" in c), sess.calls)
j = jobs[0]
check("pcsx: title, place, link, date, department, workplace",
      (j.title, j.location, j.url, j.department, j.workplace_type)
      == ("Role 563431014933800", "Raanana, Center District, Israel",
          "https://jobs.amdocs.com/careers/job/563431014933800", "Engineering", "hybrid")
      and (j.posted_at or "").startswith("2026-"), j)
check("pcsx: the country resolves", probe._fill_classifications([j], "amdocs.com")[0].country == "IL")
check("pcsx: descriptions only for undescribed roles, within the budget",
      [x.external_id for x in jobs if x.description] == ["563431014933800"]
      and "Text of 563431014933800" in jobs[0].description, [(x.external_id, x.description) for x in jobs[:3]])
check("pcsx: no budget, no detail calls",
      not any("position_details" in c for c in (lambda s: (probe.f_eightfold(s, AMDOCS), s.calls)[1])(PcsxSess(PCSX_ROWS))))
check("pcsx: a page that fails part way fails the read",
      probe.f_eightfold(PcsxSess(PCSX_ROWS, fail_start=10), AMDOCS) is None)

# Wiring.
check("registered as a fetcher", probe.FETCHERS.get("eightfold") is probe.f_eightfold)
check("polls hourly, not in the five-minute sweep", "eightfold" in probe.SLOW_BOARD_ATS)
pin = probe.load_pins().get("eightfold", {}).get("tevapharm.com", {})
check("tevapharm.com is pinned to its careers host and tenant", pin.get("token") == TOKEN, repr(pin))
check("tevapharm.com is in the sweep",
      "tevapharm.com" in (ROOT / "domains.txt").read_text(encoding="utf-8").split())
for domain, token in [("amdocs.com", AMDOCS), ("qualcomm.com", "careers.qualcomm.com:qualcomm.com")]:
    check(f"{domain} is pinned to its careers host and tenant",
          probe.load_pins().get("eightfold", {}).get(domain, {}).get("token") == token)
os.environ.setdefault("DATA_BUCKET", "unused-in-this-test")
import scrape_workday_handler  # noqa: E402
check("the hourly Lambda polls it", "eightfold" in scrape_workday_handler.BIG_TECH_ATS)

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
