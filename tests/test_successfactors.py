"""SAP SuccessFactors Career Site Builder (probe.f_successfactors), first
used for ICL. The search-table and job-page markup is cut down from
careers.icl-group.com on 2026-11-26.

Run directly, no framework:  python tests/test_successfactors.py
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
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        failures.append(name)


class Resp:
    def __init__(self, status=200, text=""):
        self.status_code, self.text = status, text


class Sess:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def get(self, url, **kw):
        self.calls.append(url)
        return self.pages.get(url, Resp(404))


HOST = "careers.icl-group.com"
SEARCH = f"https://{HOST}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow="


def row(jid, title, place, date="26 Nov 2026"):
    path = f"/job/Haifa-x/{jid}/"
    return f"""<tr class="data-row"><td class="colTitle" headers="hdrTitle">
<span class="jobTitle hidden-phone"><a href="{path}" class="jobTitle-link">{title}</a></span>
<div class="jobdetail-phone visible-phone"><span class="jobTitle visible-phone">
<a class="jobTitle-link" href="{path}">{title}</a></span></div></td>
<td class="colLocation hidden-phone" headers="hdrLocation"><span class="jobLocation">
            {place}
        </span></td>
<td class="colDate hidden-phone" nowrap="nowrap" headers="hdrDate"><span class="jobDate">{date}
</span></td></tr>"""


def page(total, rows):
    return (f'<span class="paginationLabel" aria-label="Results 1 – 2">Results <b>1 – 2</b> of <b>{total}</b></span>'
            f"<table><tbody>{''.join(rows)}</tbody></table>")


P1 = page(3, [row(1370809157, "מפעיל.ה למתקן יצור בדשנים", "Haifa, IL"),
              row(1377759457, "Food Science Co-op", "Webster Groves, MO, US, 63119", "25 Nov 2026")])
P2 = page(3, [row(1376568857, "Estágio em SGI", "Ladenburg, DE, 68526"), row(1370809157, "dup", "Haifa, IL")])
JOB = """<span itemprop="title">מפעיל.ה</span><meta itemprop="datePosted" content="Thu Nov 26 02:00:00 UTC 2026">
<div class="joblayouttoken"><span itemprop="description" data-careersite-propertyid="description">
<span class="jobdescription"><p><strong>מה יהיו תחומי האחריות שלך</strong><br>מפעיל במתקן כימי</p></span></span></div>
<div class="joblayouttoken"><a>Apply now</a></div>"""

for bad in ["icl", "", None, "careers.icl-group.com/search"]:
    sess = Sess({})
    check(f"a guessed token {bad!r} makes no request", probe.f_successfactors(sess, bad) is None and not sess.calls)

sess = Sess({SEARCH + "0": Resp(text=P1), SEARCH + "2": Resp(text=P2),
             f"https://{HOST}/job/Haifa-x/1370809157/": Resp(text=JOB)})
jobs = probe.f_successfactors(sess, HOST, known_ids={"1377759457"}, description_budget=5)
check("pages by the rows it has, until the stated total, folding a repeat",
      [j.external_id for j in jobs or []] == ["1370809157", "1377759457", "1376568857"]
      and sess.calls[:2] == [SEARCH + "0", SEARCH + "2"], (jobs, sess.calls))
j = jobs[0]
check("title, link, date", (j.title, j.url, j.posted_at) == (
    "מפעיל.ה למתקן יצור בדשנים", f"https://{HOST}/job/Haifa-x/1370809157/", "2026-11-26T00:00:00+00:00"), j)
check("a country code is spelled out, so IL is Israel and DE Germany, never a US state",
      [x.location for x in jobs] == ["Haifa, Israel", "Webster Groves, MO, United States", "Ladenburg, Germany"],
      [x.location for x in jobs])
check("the countries resolve",
      [x.country for x in probe._fill_classifications(jobs, "icl-group.com")] == ["IL", "US", "DE"],
      [x.country for x in jobs])
check("the text is read from the job page's microdata, for roles not yet described",
      "מפעיל במתקן כימי" in (j.description or "") and "Apply now" not in j.description
      and jobs[1].description is None and f"https://{HOST}/job/Haifa-x/1377759457/" not in sess.calls,
      (j.description, sess.calls))
check("a place named with more after it keeps the first", probe._sf_location("DE +1 more…") == "Germany")

check("a page that comes back empty before the total is no read",
      probe.f_successfactors(Sess({SEARCH + "0": Resp(text=P1), SEARCH + "2": Resp(text=page(3, []))}), HOST) is None)
check("a page that fails is no read",
      probe.f_successfactors(Sess({SEARCH + "0": Resp(text=P1)}), HOST) is None)
check("a page with no result count is no read",
      probe.f_successfactors(Sess({SEARCH + "0": Resp(text="<table></table>")}), HOST) is None)

check("registered as a fetcher", probe.FETCHERS.get("successfactors") is probe.f_successfactors)
check("polls hourly, not in the five-minute sweep", "successfactors" in probe.SLOW_BOARD_ATS)
pin = probe.load_pins().get("successfactors", {}).get("icl-group.com", {})
check("icl-group.com is pinned to its career site", pin.get("token") == HOST, repr(pin))
check("icl-group.com is in domains.txt", "icl-group.com" in (ROOT / "domains.txt").read_text(encoding="utf-8").split())
os.environ.setdefault("DATA_BUCKET", "unused-in-this-test")
import scrape_workday_handler  # noqa: E402
check("the hourly Lambda polls it", "successfactors" in scrape_workday_handler.BIG_TECH_ATS)

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
