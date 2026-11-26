"""Israeli employers' own careers sites: f_leumi, f_hapoalim, f_mizrahi,
f_maccabi. The markup and records are cut down from what each site
served on 2026-11-26.

Run directly, no framework:  python tests/test_il_own_sites.py
"""

import json
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
    def __init__(self, status=200, text="", body=None, url=""):
        self.status_code, self.url = status, url
        self.text = json.dumps(body, ensure_ascii=False) if body is not None else text

    def json(self):
        return json.loads(self.text)


class Sess:
    """GETs answered by URL, POSTs from a list in order."""
    def __init__(self, gets=None, posts=None):
        self.gets_map, self.posts_list, self.calls = gets or {}, list(posts or []), []

    def get(self, url, **kw):
        self.calls.append(url)
        return self.gets_map.get(url, Resp(404, url=url))

    def post(self, url, **kw):
        self.calls.append((url, kw.get("json")))
        return self.posts_list.pop(0) if self.posts_list else Resp(500)


TOKENS = {"leumi": "www.leumi.co.il", "hapoalim": "www.bankhapoalim.co.il",
          "mizrahi": "www.mizrahi-tefahot.co.il/about-mizrahi-tefahot-he/career/open-jobs/",
          "maccabi": "www.maccabi4u.co.il"}

for ats in TOKENS:
    for bad in ["leumi", "", None]:
        sess = Sess()
        check(f"{ats}: a guessed token {bad!r} makes no request",
              probe.FETCHERS[ats](sess, bad) is None and not sess.calls)


# Leumi: one page, every role and its text.
LEUMI_ROW = """<div class="table-row row-1"role="row"><div class="add" role="cell">
<input type="checkbox" name="job_checkbox" value="{id}"></div>
<div class="role" role="cell"><div class="role-title">תפקיד</div><button aria-expanded="false">{title}</button></div>
<div class="area" role="cell"><div class="area-title">אזור</div><span>
                 המרכז והשפלה
                 צפון
               </span></div></div>
<div class="full-job"><div class="container"><div class="job-title"><h3 class="job-title"> {title} </h3></div>
<div class="job-content"><div class="department-section"><div class="department-text">מערך/חטיבה:
<a href="/he/Articles/38824" class="link-wrap"> החטיבה הבנקאית </a></div></div>
<div class="job-description-text"><p><span style="display: none;">דרושים/ות בנקאים/יות לסניפי לאומי</span></p>
<p>אחריות למכלול הטיפול בפעילות ההשקעות של הלקוחות.</p></div>
<div class="job-requirements-text"><ul><li>רישיון ייעוץ - חובה</li></ul></div></div></div></div>"""
LEUMI = ('<div class="table-header"><div class="area" role="columnheader">אזור</div></div><div class="table-body">'
         + LEUMI_ROW.format(id=793, title="יועץ/ת השקעות  1020") + LEUMI_ROW.format(id=809, title="בנקאי/ת 1205") + "</div>")
sess = Sess({"https://www.leumi.co.il/he/leumi_main/searchjobs": Resp(text=LEUMI)})
jobs = probe.f_leumi(sess, TOKENS["leumi"])
check("leumi: one request reads the board", len(sess.calls) == 1 and [j.external_id for j in jobs or []] == ["793", "809"],
      (sess.calls, jobs))
j = jobs[0]
check("leumi: title, regions ending in Israel, the sitemap's link, the division",
      (j.title, j.location, j.url, j.department) == ("יועץ/ת השקעות 1020", "המרכז והשפלה; צפון, Israel",
                                                     "https://www.leumi.co.il/he/about/career/Job/793", "החטיבה הבנקאית"), j)
check("leumi: the text and requirements come along, the hidden stock paragraph does not",
      "ההשקעות" in (j.description or "") and "רישיון" in j.description and "דרושים" not in j.description
      and j.description_chars == len(j.description), j.description)
check("leumi: the country resolves", probe._fill_classifications(jobs, "leumi.co.il")[0].country == "IL")
check("leumi: a page with no roles is no read", probe.f_leumi(Sess({
    "https://www.leumi.co.il/he/leumi_main/searchjobs": Resp(text="<html></html>")}), TOKENS["leumi"]) is None)


# Hapoalim: the lobby, then each role's page under the prefix Imperva
# moved the site to.
def hap_card(nid, name):
    return (f'<a href="/he/node/{nid}" class="views-row job"><div class="job-name" dir="rtl">{name}</div>'
            f'<div class="wrap-details"><div class="job-details"><div class="job-area">גוש דן</div></div>'
            f'<div class="more-info">למידע נוסף</div></div></a>')


LOBBY = 'https://www.bankhapoalim.co.il/he/jobs-site/lobby'
MOVED = 'https://www.bankhapoalim.co.il/forms/he/jobs-site/lobby'
settings = '<script type="application/json">{"number_to_display":"10","jobs_destination":1}</script>'
lobby = settings + '<div class="wrap-jobs">' + hap_card(3120, "רפרנט/ית בחטיבה העסקית") + hap_card(3107, "אחראי/ת הפעלת מערכות") + "</div>"
detail = ('<div class="job-content-description"><div class="job-content-description-text">'
          '<strong>תאור היחידה</strong><br />ניתוח נתונים פיננסים<br /></div></div>')
sess = Sess({LOBBY: Resp(text=lobby, url=MOVED),
             "https://www.bankhapoalim.co.il/forms/he/node/3120": Resp(text=detail)})
jobs = probe.f_hapoalim(sess, TOKENS["hapoalim"], known_ids={"3107"}, description_budget=5)
check("hapoalim: every card, linked at its public path",
      [(j.external_id, j.title, j.url) for j in jobs or []] == [
          ("3120", "רפרנט/ית בחטיבה העסקית", "https://www.bankhapoalim.co.il/he/node/3120"),
          ("3107", "אחראי/ת הפעלת מערכות", "https://www.bankhapoalim.co.il/he/node/3107")], jobs)
check("hapoalim: region ending in Israel", jobs[0].location == "גוש דן, Israel", jobs[0].location)
check("hapoalim: the text is read under /forms, and only for a role not yet described",
      "ניתוח נתונים" in (jobs[0].description or "") and jobs[1].description is None
      and "https://www.bankhapoalim.co.il/forms/he/node/3107" not in sess.calls, (jobs, sess.calls))
check("hapoalim: no budget, no role pages", (lambda s: probe.f_hapoalim(s, TOKENS["hapoalim"]) and len(s.calls) == 1)(
    Sess({LOBBY: Resp(text=lobby, url=MOVED)})))
full = settings + "".join(hap_card(3000 + i, f"Role {i}") for i in range(10))
check("hapoalim: a full lobby of ten may hide more behind load-more, so it is no read",
      probe.f_hapoalim(Sess({LOBBY: Resp(text=full, url=MOVED)}), TOKENS["hapoalim"]) is None)
check("hapoalim: a refused lobby is no read",
      probe.f_hapoalim(Sess({LOBBY: Resp(403)}), TOKENS["hapoalim"]) is None)


# Mizrahi: cards on the listing, the full text on each role's page.
def miz_card(slug, title, regions):
    return (f'<div class="job filterItem" data-jobfields="&#x5D1;&#x5E0;&#x5E7;&#x5D0;&#x5D5;&#x5EA;" '
            f'data-jobtypes="&#x5DE;&#x5E9;&#x5E8;&#x5D4; &#x5DE;&#x5DC;&#x5D0;&#x5D4;" data-jobregions="{regions}">'
            f'<h3>{title}</h3><div class="jobData col-lg-8"><div class="jobDescription">'
            f'<div class="mizRteditor">קליטה כעובד בנק מהיום הראשון!</div></div>'
            f'<a class="toggler collapsed" href="{slug}" role="button">x</a></div>'
            f'<input type="hidden" name="HiddenJobsIds" id="HiddenJobsIds" value="JB-107"></div>')


LISTING = "https://" + TOKENS["mizrahi"]
listing = (miz_card("lodseller", "&#x5D1;&#x5E0;&#x5E7;&#x5D0;&#x5D9; &#x5D8;&#x5DC;&#x5E4;&#x5D5;&#x5E0;&#x5D9;",
                    "&#x5E9;&#x5E4;&#x5DC;&#x5D4;")
           + miz_card("teller-petah-tikva", "&#x5D8;&#x5DC;&#x5E8;", "&#x5DE;&#x5E8;&#x5DB;&#x5D6; | &#x5DE;&#x5E8;&#x5DB;&#x5D6;"))
role = ('<div class="jobDetails"><div class="mizRteditor"><p><strong>תיאור המשרה</strong><br>שער הכניסה לעולם הבנקאות</p>'
        '</div></div><div class="job-buttons"><button>הגשת מועמדות</button></div>')
sess = Sess({LISTING: Resp(text=listing), LISTING + "lodseller/": Resp(text=role)})
jobs = probe.f_mizrahi(sess, TOKENS["mizrahi"], known_ids={"teller-petah-tikva"}, description_budget=5)
check("mizrahi: the slug is the id and the role's page the link",
      [(j.external_id, j.url) for j in jobs or []] == [("lodseller", LISTING + "lodseller/"),
                                                       ("teller-petah-tikva", LISTING + "teller-petah-tikva/")], jobs)
check("mizrahi: entities unescaped, a region named twice is named once, field as department",
      (jobs[0].title, jobs[0].location, jobs[1].location, jobs[0].department)
      == ("בנקאי טלפוני", "שפלה, Israel", "מרכז, Israel", "בנקאות"), jobs)
check("mizrahi: a new role gets its full text", "שער הכניסה" in (jobs[0].description or ""), jobs[0].description)
check("mizrahi: a described role gets no blurb, which would replace the full text",
      jobs[1].description is None and jobs[1].description_chars == 0, jobs[1].description)
blurb_only = probe.f_mizrahi(Sess({LISTING: Resp(text=listing)}), TOKENS["mizrahi"])
check("mizrahi: with no budget a new role carries the card's blurb",
      blurb_only and "קליטה כעובד" in (blurb_only[0].description or ""), blurb_only and blurb_only[0].description)


# Maccabi: one JSON route, paged until the total.
def mac_row(jid):
    return {"Areas": [{"Id": 40, "Description": "מרכז"}, {"Id": 50, "Description": "השפלה"}], "ProfessionId": 13,
            "Profession": "פיזיותרפיה", "JobId": str(jid), "Id": 131618 + jid, "Title": "פיזיותרפיה",
            "Description": "מנהל/ת פיזיותרפיה", "Notes": "על המשרה:<br/>• ניהול צוות",
            "JobUrl": f"https://www.maccabi4u.co.il/careers/all-positions/x-{jid}/", "AdvertisingDestination": 3}


old_page = probe.MACCABI_PAGE
probe.MACCABI_PAGE = 2
sess = Sess(posts=[Resp(body={"Results": [mac_row(1), mac_row(2)], "TotalResults": 3}),
                   Resp(body={"Results": [mac_row(3)], "TotalResults": 3})])
jobs = probe.f_maccabi(sess, TOKENS["maccabi"])
check("maccabi: pages until the total", [j.external_id for j in jobs or []] == ["1", "2", "3"], jobs)
check("maccabi: asks for the public roles, a page at a time",
      [c[1]["PageNumber"] for c in sess.calls] == [0, 1] and sess.calls[0][1]["AdvertisingDestination"] == "1"
      and sess.calls[0][0] == "https://www.maccabi4u.co.il/api/maccabi/SearchJobsApi/FilterJobs", sess.calls)
j = jobs[0]
check("maccabi: title, areas ending in Israel, its own link, profession, the text",
      (j.title, j.location, j.url, j.department) == ("מנהל/ת פיזיותרפיה", "מרכז; השפלה, Israel",
                                                     "https://www.maccabi4u.co.il/careers/all-positions/x-1/", "פיזיותרפיה")
      and "ניהול צוות" in (j.description or ""), j)
check("maccabi: a second page that fails is no read at all",
      probe.f_maccabi(Sess(posts=[Resp(body={"Results": [mac_row(1), mac_row(2)], "TotalResults": 3}), Resp(500)]),
                      TOKENS["maccabi"]) is None)
probe.MACCABI_PAGE = old_page

# Wiring: each is pinned and polled hourly from the pins.
os.environ.setdefault("DATA_BUCKET", "unused-in-this-test")
import scrape_workday_handler  # noqa: E402
pins = probe.load_pins()
domains = set((ROOT / "domains.txt").read_text(encoding="utf-8").split())
for ats, domain in [("leumi", "leumi.co.il"), ("hapoalim", "bankhapoalim.co.il"),
                    ("mizrahi", "mizrahi-tefahot.co.il"), ("maccabi", "maccabi4u.co.il")]:
    check(f"{ats}: registered, polled hourly by the Lambda, not in the five-minute sweep",
          probe.FETCHERS.get(ats) is getattr(probe, f"f_{ats}") and ats in probe.SLOW_BOARD_ATS
          and ats in scrape_workday_handler.BIG_TECH_ATS)
    check(f"{ats}: {domain} is pinned to its token and in domains.txt",
          pins.get(ats, {}).get(domain, {}).get("token") == TOKENS[ats] and domain in domains)

print()
if failures:
    print(f"{len(failures)} failed")
    sys.exit(1)
print("all passed")
