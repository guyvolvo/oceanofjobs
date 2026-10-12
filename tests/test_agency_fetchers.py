"""The staffing firms' own-site fetchers: f_experis, f_adamjobs, f_nogamy,
f_matrix. The markup and records are cut down from what each site served
on 2026-10-12.

Run directly, no framework:  python tests/test_agency_fetchers.py
"""

import json
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
    def __init__(self, status=200, text="", body=None):
        self.status_code = status
        self.text = json.dumps(body, ensure_ascii=False) if body is not None else text
        self.headers = {"Content-Type": "application/json"} if body is not None else {}

    def json(self):
        return json.loads(self.text)


class Sess:
    """GETs answered by URL; POSTs answered in order."""
    def __init__(self, gets=None, posts=None):
        self.gets_map, self.posts_list, self.calls = gets or {}, list(posts or []), []
        self.headers = {}

    def get(self, url, **kw):
        self.calls.append(url)
        return self.gets_map.get(url, Resp(404))

    def post(self, url, **kw):
        self.calls.append(url)
        return self.posts_list.pop(0) if self.posts_list else Resp(500)


for ats in ("experis", "adamjobs", "nogamy", "matrix"):
    for bad in ["experis", "", None]:
        sess = Sess()
        check(f"{ats}: a guessed token {bad!r} makes no request", probe.FETCHERS[ats](sess, bad) is None and not sess.calls)


def experis_page(nodes, more):
    return Resp(body={"data": {"allJob": {"nodes": nodes, "pageInfo": {"offsetPagination": {"hasMore": more}}}}})


def node(code, slug, title="Network Engineer"):
    return {"title": title, "slug": slug, "date": "2026-10-12T04:00:00",
            "jobFields": {"jobcode": code, "jobdescription": "<p>תיאור</p>"},
            "jobAreas": {"nodes": [{"name": "שרון"}]}, "jobProfessions": {"nodes": [{"name": "סייבר"}]}}


sess = Sess(posts=[experis_page([node("1", "1"), node("1", "1-2")], True), experis_page([node("2", "2", "SOC Analyst")], False)])
jobs = probe.f_experis(sess, "experis.co.il")
check("experis: reads every page, folds a job code posted twice", [j.external_id for j in jobs or []] == ["1", "2"], jobs)
check("experis: the API is on experiscontent.<host>", sess.calls[0] == "https://experiscontent.experis.co.il/graphql", sess.calls)
check("experis: public URL, place ending in Israel, profession as department",
      jobs and (jobs[0].url, jobs[0].location, jobs[0].department) == ("https://experis.co.il/job/1", "שרון, Israel", "סייבר"), jobs and jobs[0])
check("experis: a failed second page is no read at all",
      probe.f_experis(Sess(posts=[experis_page([node("1", "1")], True), Resp(500)]), "experis.co.il") is None)

YAEL = """<ul><li class="filter_dropdown_choices"> <input type='checkbox' class='jobs_filter_input' value='30' name='area'
 id='area-30'> <label for='area-30' class='jobs_filter_input_label'> השרון</label> </li></ul>
<div class="list_jobs"><div class="job_item" data-area='30,' data-company="yael,"><div class="job_header">
<h3 class="job_title pink_dot">מפתח/ת MF</h3><button data-copy='https://yaelgroup.com/jobs/order/25785/'></button></div>
<div class="job_content"><div class="col-md-8 job_description"><ul><li>ניסיון</li></ul></div><div class="job_form">x</div></div></div>
<div class="job_item" data-area='99,' data-company="cvnext,"><h3 class="job_title pink_dot">קניין/ית</h3>
<button data-copy='https://yaelgroup.com/jobs/korn_order/17186/'></button></div></div><footer></footer>"""
jobs = probe.f_adamjobs(Sess({"https://yaelgroup.com/job/": Resp(text=YAEL)}), "yaelgroup.com/job/")
check("adamjobs: both order kinds, the second kind's id keeps its path",
      [(j.external_id, j.url) for j in jobs or []] == [("25785", "https://yaelgroup.com/jobs/order/25785/"),
                                                       ("korn_order-17186", "https://yaelgroup.com/jobs/korn_order/17186/")], jobs)
check("adamjobs: area codes named from the page's own filter; an unknown code is just Israel",
      jobs and [j.location for j in jobs] == ["השרון, Israel", "Israel"], jobs)

NOGAMY = """<div class="jobs-accordion"><div class="collapse-toggler"><div class="block"><h3 class="f-d-24"> מנהל/ת פרויקט </h3>
<h4 class="f-d-14">מס' משרה 5973</h4><div>אם אתם/ן אוהבים/ות</div></div></div>
<div class="collapse-toggler"><h3> oracle + sql DBA </h3><h4>מס' משרה 5972</h4><p>DBA</p></div></div><footer>"""
page = "www.nogamy.co.il/join/"
jobs = probe.f_nogamy(Sess({f"https://{page}": Resp(text=NOGAMY)}), page)
check("nogamy: each role with its number, linked by fragment",
      [(j.external_id, j.title, j.url) for j in jobs or []] == [("5973", "מנהל/ת פרויקט", f"https://{page}#5973"),
                                                                ("5972", "oracle + sql DBA", f"https://{page}#5972")], jobs)


def matrix_item(jid, title):
    return (f'<div class="job-item" id="job-item-{jid}"\n job-id="{jid}"> <a class="job-title" href="https://www.matrix.co.il/jobs/x-{jid}/">{title}</a>'
            f'<b>איזור: </b><b class="job-areas">גוש דן</b><p>תיאור</p><!-- <b>דרישות:</b> Java --><div class="job-buttons"></div></div>')


base = "https://www.matrix.co.il/jobs/a/"
two_pages = {base: Resp(text=matrix_item(1, "QA") + matrix_item(2, "Dev")), base + "page/2/": Resp(text=matrix_item(3, "PM"))}
jobs = probe.f_matrix(Sess(two_pages), "www.matrix.co.il/jobs/a/")
check("matrix: pages until the first 404", [j.external_id for j in jobs or []] == ["1", "2", "3"], jobs)
check("matrix: the commented-out requirements are kept, the area label is not",
      jobs and "Java" in (jobs[0].description or "") and "job-areas" not in (jobs[0].description or ""), jobs and jobs[0].description)
broken = dict(two_pages, **{base + "page/2/": Resp(500)})
check("matrix: any failure but the end's 404 is no read at all", probe.f_matrix(Sess(broken), "www.matrix.co.il/jobs/a/") is None)

print()
if failures:
    print(f"{len(failures)} failed")
    sys.exit(1)
print("all passed")
