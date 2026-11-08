"""Resolve each company's real name from its own ATS, once.

Why this exists. `companies.domain` is frequently not the company's real
hostname. Common Crawl discovery finds an ATS board, extracts the account
slug, and guesses {slug}.com; when that guess doesn't resolve it is kept
anyway (fixed going forward in refresh_discovery_queue.py, but ~570 rows
already carry one). So the board captions 20 real Headout listings
"headoutcareers.com", a host that has never existed. Eight of a
40-company sample were invented that way.

The honest identity is sitting in the ATS response: Greenhouse's board
endpoint says "Headout", SmartRecruiters says "Informa Group Plc.".
Reading it costs one request per company, ever, because a company's name
doesn't change. Results accumulate in company-names.json; already-named
companies are skipped on every later run, so the steady-state cost is
only whatever was discovered since.

Deliberately NOT renaming `domain` to the real host. job_id() hashes
{domain}|{ats}|{external_id} and domain is the companies primary key, so
rewriting it would change every job id for that company: its listings
would all reappear as new with first_seen reset, the old rows would
close, and the lifetime tracking PRODUCT.md calls a core differentiator
would be destroyed. Saved alerts and shared URLs filtering on the old
value would break silently too. The domain stays an opaque internal id;
the name is what gets shown.

Coverage, measured live 2026-09-09 against real boards:

    greenhouse       /boards/{token}                 .name
    ashby            jobs.ashbyhq.com/{token}        og:title, minus " Jobs"
    smartrecruiters  postings                        .company.name
    workable         widget/accounts/{token}         .name
    comeet           positions                       .company_name
    recruitee        {token}.recruitee.com/api       .company_name

    lever            job page                        <title> before " - "
    bamboohr         {token}.bamboohr.com            <title> "Login - X"
    breezy           {token}.breezy.hr               <title> "%DOC_TITLE%X"
    jazzhr           {token}.applytojob.com          <title> "X - Career Page"
    teamtailor       {token}.teamtailor.com          og:site_name
    personio         {token}.jobs.personio.de        <title> "Jobs at X" / "Jobs bei X"
    workday          first job's detail              hiringOrganization.name

    pinpoint         {token}.pinpointhq.com          <title> "Jobs at X | ..."

When a board gives nothing, fallback_name() asks the company's own
pages (Workday sidebar and site id, homepage, Wikidata) and keeps an
answer only if it agrees with the domain or tenant; a board that gave
nothing is asked again after TRY_AGAIN instead of never. Added
2026-11-08, when 881 companies with 49,511 open listings showed a bare
domain; a dry run named 789 of them (46,668 listings).

The last seven were added 2026-09-25. This file used to say Lever and
Workday were "about 1% of tracked companies" and could stay unnamed;
that was true on 2026-09-09 and stopped being true when Workday
discovery grew to 3,028 tenants, which is 64% of every open listing.
Workday tenants come from workday-tenants.json rather than known.json,
which holds 33 of them, and the vendor scrapers (Amazon, Apple, Google,
Microsoft, the Israeli boards) have no endpoint to ask, so STATIC_NAMES
names them by hand.

Workday's hiringOrganization is the legal entity, which is usually the
company ("GD Information Technology, Inc.") and occasionally a payroll
shell ("WVE WVNH EMP LLC"). The legal suffix is stripped and a name that
is all capitals with a vowelless token is dropped; the domain is better
than that.

Usage:
    python resolve_company_names.py --bucket $DATA_BUCKET
    python resolve_company_names.py --known known.json --out names.json
"""

import argparse
import html
import json
import os
import re
import sqlite3
import sys
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

TIMEOUT = 12
WORKERS = 12
UA = "Mozilla/5.0 (compatible; Ocean of Jobs/1.0; +https://oceanofjobs.com)"

NAMES_KEY = "company-names.json"
# When each tried-empty company was last asked, beside the local names
# file. "" used to be final, so a board that failed once stayed unnamed
# for good: 494 of them on 2026-11-08, Capital One and Cadence among them.
TRIED_FILE = "company-names-tried.json"
TRY_AGAIN = timedelta(days=30)

# Boards with no endpoint that says who they are: the single-vendor
# scrapers and the Israeli custom boards. Applied without a request, and
# last, so a wrong resolved name can be corrected here without touching
# S3 (box/apply_company_names.py reads this too). Counts are open
# listings on 2026-09-25, which is why these few are worth a hand list.
STATIC_NAMES = {
    "amazon.com": "Amazon",                      # 14,453
    "aws.amazon.com": "Amazon Web Services",     #  8,319
    "apple.com": "Apple",                        #  4,991
    "google.com": "Google",                      #  3,243
    "microsoft.com": "Microsoft",                #  2,434
    "nvidia.com": "NVIDIA",
    "elbitsystems.com": "Elbit Systems",         #    579
    "tevapharm.com": "Teva",                     #    566
    "clalit.co.il": "Clalit",                    #    559
    "dell.com": "Dell",                          #    467
    "akamai.com": "Akamai",                      #    254
    "ness-tech.co.il": "Ness",                   #    216
    "one1.co.il": "One1",                        #    157
    "discountbank.co.il": "Discount Bank",       #     62
    "pwc.com": "PwC",                            #     51
    "iai.co.il": "IAI",
    # Workday tenants whose hiring organization is a payroll entity, a
    # subsidiary or a ledger line, checked by hand against the listings
    # on 2026-09-25 and ordered by open listings. The domain is the row's
    # domain, which for Workday is often a guess from the tenant name
    # (ghr.fr is Bank of America's "ghr" tenant), so the map keys on it
    # as written, not as it should be.
    "dollartree.com": "Dollar Tree",             # 24,208
    "cvshealth.com": "CVS Health",               # 19,079
    "oreillyauto.de": "O'Reilly Auto Parts",     # 18,778
    "lowes.com": "Lowe's",                       # 12,506
    "whataburger.com": "Whataburger",
    "ngc.com": "Northrop Grumman",               #  3,784
    "davita.com": "DaVita",
    "mvh.myworkdayjobs.com": "Banfield Pet Hospital",
    "thermofisher.com": "Thermo Fisher Scientific",
    "jci.com": "Johnson Controls",
    "basspro.de": "Bass Pro Shops",
    "abercrombie.com": "Abercrombie & Fitch",
    "gevernova.com": "GE Vernova",
    "asmglobal.com": "ASM Global",
    "ghr.fr": "Bank of America",
    "wvumedicine.com": "WVU Medicine",
    "sysco.com": "Sysco",
    "slihrms.myworkdayjobs.com": "AtkinsR\u00e9alis",
    "musc.co": "MUSC Health",
    "massgeneralbrigham.ai": "Mass General Brigham",
    "knitwellgroup.com": "KnitWell Group",
    "kindercare.com": "KinderCare",
    "jll.com": "JLL",
    "genpt.ai": "Genuine Parts Company",
    "freseniusmedicalcare.com": "Fresenius Medical Care",
    "circlek.com": "Circle K",
    "bilh.myworkdayjobs.com": "Beth Israel Lahey Health",
    "bah.com": "Booz Allen Hamilton",
    "adventhealth.com": "AdventHealth",
    "aah.org": "Advocate Health",
    "walmart.com": "Walmart",
    "uhaul.myworkdayjobs.com": "U-Haul",
    "tmobile.com": "T-Mobile",
    "thales.com": "Thales",
    "tapestry.com": "Tapestry",
    "sentara.com": "Sentara Health",
    "pnc.com": "PNC",
    "petco.net": "Petco",
    "michaels.myworkdayjobs.com": "Michaels",
    "leidos.com": "Leidos",
    "kohls.de": "Kohl's",
    "hitachi.myworkdayjobs.com": "Hitachi Energy",
    "genpact.com": "Genpact",
    "drivenbrands.com": "Driven Brands",
    "cw.ai": "Cushman & Wakefield",
    "citi.com": "Citi",
    "bridgestone.com": "Bridgestone",
    "advanceauto.myworkdayjobs.com": "Advance Auto Parts",
    "accenture.com": "Accenture",
    "abb.myworkdayjobs.com": "ABB",
    "eiffage.com": "Eiffage",
    "spectrumhealth.com": "Corewell Health",
    "mmc.com": "Marsh McLennan",
    "iqvia.com": "IQVIA",
    "jj.ai": "Johnson & Johnson",
    "sunriseseniorliving.com": "Sunrise Senior Living",
    "ochsner.com": "Ochsner Health",
    "kbr.com": "KBR",
    "aspendental.com": "Aspen Dental",
    "umiami.myworkdayjobs.com": "University of Miami",
    "wf.com": "Wells Fargo",
    "interpublic.com": "IPG",
    "cnx.com": "Concentrix",
    "signetjewelers.com": "Signet Jewelers",
    "hcmportal.myworkdayjobs.com": "UPS",
    "brownhealth.com": "Brown University Health",
    "vfc.com": "VF Corporation",
    "2020companies.com": "2020 Companies",
    "rrhs.io": "Rochester Regional Health",
    "imh.com": "Intermountain Health",
    "statestreet.com": "State Street",
    "rbc.ai": "RBC",
    "gdit.com": "GDIT",
    "onetp.myworkdayjobs.com": "Teleperformance",
    "nshs.net": "Endeavor Health",
    "msd.com": "MSD",
    "ummh.de": "UMass Memorial Health",
    "rtx.com": "RTX",
    "abbott.com": "Abbott",
    "pae.com": "PAE",
    # Workday tenant mckesson, domain guessed as mckesson.fr, whose homepage
    # is a Bordeaux health guide called "Mckes'son" that passes every check.
    "mckesson.fr": "McKesson",                   #    676
    # Workday tenants nothing automatic can name (2026-11-08): the domain is
    # a Workday host or a guess that matches nothing, and the tenant's own
    # pages do not spell the name the tenant id abbreviates.
    "mydpr.myworkdayjobs.com": "DPR Construction",            # 571
    "biibhr.myworkdayjobs.com": "Biogen",                     # 279
    "surbanajurong.myworkdayjobs.com": "Surbana Jurong",      # 240
    "cbrands.com": "Constellation Brands",                    # 100
    "andersonsinc.com": "The Andersons",                      #  88
    "dodgeandcox.com": "Dodge & Cox",                         #  16
    "bristow.myworkdayjobs.com": "Bristow Group",             #  16
    # A Personio slug guessed into a domain that is one person's homepage.
    # "" shows the domain, which is better than his name.
    "jonathan.com": "",
}

LEGAL_SUFFIX = re.compile(
    r"[\s,]+(inc\.?|incorporated|llc\.?|l\.l\.c\.|llp|pllc|ltd\.?|limited|corp\.?|corporation|co\.?|plc|"
    r"gmbh|ggmbh|ag|s\.?a\.?|s\.?a\.?s\.?|s\.?r\.?l\.?|b\.?v\.?|pty\.?|pvt\.?|n\.?v\.?|k\.?k\.?|"
    r"pte\.?|sdn\.? bhd\.?|n\.\s?a\.|national association|legal entity)\s*$",
    re.I,
)

# See referral_boards.py. A referral board's own name is "Referral
# Board", so the resolver below is answering honestly and still getting
# it wrong; only the override knows who the board belongs to.
try:
    from referral_boards import REFERRAL_BOARDS
except ImportError:
    REFERRAL_BOARDS = {}


def _txt(v) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v or None


def _json(sess: requests.Session, url: str):
    try:
        r = sess.get(url, timeout=TIMEOUT)
    except requests.RequestException:
        return None
    if r.status_code != 200 or "json" not in r.headers.get("Content-Type", "").lower():
        return None
    try:
        return r.json()
    except ValueError:
        return None


# Everything a title or a meta tag can tell us is in the first stretch of
# the document. The first full run read whole pages, some of them
# megabytes of SPA bundle, and sat at 98% CPU for three hours with
# nothing to show: the patterns below used to have unbounded [^>]+ runs
# that backtrack across a long attribute list. Now the read stops at
# HEAD_BYTES and every quantifier has a ceiling.
HEAD_BYTES = 256 * 1024


def _host(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").removeprefix("www.")


def _html(sess: requests.Session, url: str, same_site: bool = False) -> str | None:
    """The head of a page. same_site refuses one that redirected to another
    name (victoria.com lands on victoriassecret.com) but not to another
    ending of the same one (aircall.com to aircall.io)."""
    try:
        with sess.get(url, timeout=TIMEOUT, headers={"Accept": "text/html"}, stream=True) as r:
            if r.status_code != 200 or (same_site and _host(r.url).split(".")[0] != _host(url).split(".")[0]):
                return None
            raw = b""
            for chunk in r.iter_content(16 * 1024):
                raw += chunk
                if len(raw) >= HEAD_BYTES:
                    break
            # requests calls an HTML page with no charset ISO-8859-1, which
            # turned a UTF-8 "we’re" into "weâ€™re". Without a declared
            # charset this is UTF-8, as nearly every page is now.
            declared = "charset" in r.headers.get("Content-Type", "").lower()
            return raw.decode(r.encoding if declared and r.encoding else "utf-8", errors="replace")
    except requests.RequestException:
        return None


def _title(page: str | None) -> str | None:
    m = re.search(r"<title[^>]{0,200}>([^<]{0,400})", page or "", re.I)
    return _txt(" ".join(html.unescape(m.group(1)).split())) if m else None


_META_TAG = re.compile(r"<meta\b[^>]{0,1000}>", re.I)
_META_ATTR = re.compile(r'\b(property|name|content)\s*=\s*(?:"([^"]{0,500})"|\'([^\']{0,500})\')', re.I)


def _meta(page: str | None, prop: str) -> str | None:
    """One tag at a time, attributes read once each: no pattern here can
    run back and forth across a page looking for a second quote."""
    for tag in _META_TAG.finditer(page or ""):
        attrs = {k.lower(): (a if a is not None else b) for k, a, b in _META_ATTR.findall(tag.group(0))}
        if (attrs.get("property") or attrs.get("name") or "").lower() == prop.lower() and attrs.get("content"):
            return _txt(html.unescape(attrs["content"]))
    return None


_TITLE_NOISE = {"login", "careers", "career page", "career site", "jobs", "job openings",
                "open positions", "current openings", "welcome", "home", "job board"}


def _from_title(t: str | None) -> str | None:
    """The company out of a board title like "Login - X", "X - Career
    Page", "Careers at X" or "Jobs bei X": split on the usual separators,
    drop the pieces that are only the board's own furniture, and keep
    the longest of what is left. The order and the separator vary by
    vendor and by locale; the furniture does not."""
    if not t:
        return None
    # "Jobs bei " with nothing after it is a board whose owner never set
    # a name: the prefix goes whether or not anything follows, and an
    # empty remainder is no name rather than the prefix itself.
    t = re.sub(r"^(?:jobs|careers)\s+(?:at|bei|chez|en|presso|@)\s*", "", t, flags=re.I).strip()
    pieces = [x.strip(" -–—|:·") for x in re.split(r"\s+[-–—|:·]\s+", t)]
    keep = [x for x in pieces if x and x.lower() not in _TITLE_NOISE]
    return _txt(max(keep, key=len)) if keep else None


def _strip_legal(name: str | None) -> str | None:
    """"Tenable, Inc." down to "Tenable": one trailing legal suffix off.
    Applied to every resolver's answer, since Greenhouse and the rest
    hand back the registered entity as often as Workday does."""
    if not name:
        return None
    return _txt(LEGAL_SUFFIX.sub("", name.strip()).strip(" ,"))


# What a Workday hiring organization wears in front of its name, from
# the first 2,900 tenants resolved: a ledger code with digits in it
# ("AL8238 UK Grid Solutions", "R301US Hibbett Retail", "C002 Medical
# University Hospital Authority", "94-1687665 Bank of America"), a
# number joined by a dash ("8286-Cordis De Mexico"), a parenthetical
# ("(Midtown Oaks Post Acute) White Fir Holdings"), a stray dash
# ("- KCE Champions"). A code is capitals, digits, underscores and
# dashes only, with a letter and a digit and three characters in it, or
# two or more bare digits; so 3M, 7-Eleven, 2U, R1, 1st Source and
# 23andMe keep their names.
_ORG_PREFIX = re.compile(
    r"^(?:\([^)]*\)\s*|-\s+"
    r"|(?=[A-Z0-9_-]{3})(?=[A-Z_-]*\d)(?=[\d_]*[A-Z])[A-Z0-9_-]+[\s-]+"
    r"|\d{2,}[\s-]+)+"
)
# And behind it: a code in parentheses ("Novasyte LLC (USA7)", "Advance
# Stores Company Inc (500)"), or a location after an underscore ("Booz
# Allen Hamilton_United States").
_ORG_SUFFIX = re.compile(r"(?:\s*\([^)]*\d[^)]*\)|_[A-Za-z ]+)\s*$")


def _clean_org(name: str | None) -> str | None:
    """A Workday hiring organization down to a name a reader would say:
    the ledger code off the front, the legal suffix off the back, and
    the acronym soup a payroll entity carries rejected outright, since
    the domain is better than that."""
    if name:
        name = _ORG_SUFFIX.sub("", _ORG_PREFIX.sub("", name.strip()))
    name = _strip_legal(name)
    if not name:
        return None
    tokens = name.split()
    # Two or more tokens, all capitals, none longer than four letters:
    # "WVE WVNH EMP", "OHE OHNH EMP". A brand that is an acronym is one
    # token ("IAI", "GDIT"); a run of short ones is a ledger code.
    if len(tokens) >= 2 and all(t.isupper() and len(t) <= 4 for t in tokens):
        return None
    if len(tokens) >= 2 and all(t.isupper() for t in tokens) and any(not re.search(r"[AEIOUY]", t) for t in tokens):
        return None
    return name


def _greenhouse(sess, token):
    d = _json(sess, f"https://boards-api.greenhouse.io/v1/boards/{token}")
    return _txt((d or {}).get("name")) if isinstance(d, dict) else None


def _ashby(sess, token):
    # No name anywhere in the JSON job-board API (checked: the response
    # is just {jobs, apiVersion}), but the public board page titles
    # itself "<Company> Jobs", which is the company's own chosen display
    # name rather than anything derived from the slug.
    try:
        r = sess.get(f"https://jobs.ashbyhq.com/{token}", timeout=TIMEOUT)
    except requests.RequestException:
        return None
    if r.status_code != 200:
        return None
    m = re.search(r'<meta property="og:title" content="([^"]+)"', r.text) or \
        re.search(r"<title>([^<]+)</title>", r.text)
    if not m:
        return None
    return _txt(re.sub(r"\s+Jobs$", "", m.group(1).strip()))


def _smartrecruiters(sess, token):
    d = _json(sess, f"https://api.smartrecruiters.com/v1/companies/{token}/postings?limit=1")
    posts = (d or {}).get("content") or [] if isinstance(d, dict) else []
    return _txt(((posts[0] if posts else {}).get("company") or {}).get("name"))


def _workable(sess, token):
    d = _json(sess, f"https://apply.workable.com/api/v1/widget/accounts/{token}")
    return _txt((d or {}).get("name")) if isinstance(d, dict) else None


def _comeet(sess, token):
    # token is "uid:token" for comeet, same as everywhere else.
    if ":" not in token:
        return None
    uid, ctoken = token.split(":", 1)
    d = _json(sess, f"https://www.comeet.com/careers-api/1.0/company/{uid}/positions?token={ctoken}")
    if isinstance(d, list) and d:
        return _txt(d[0].get("company_name"))
    return None


def _recruitee(sess, token):
    d = _json(sess, f"https://{token}.recruitee.com/api/offers/")
    offers = (d or {}).get("offers") or [] if isinstance(d, dict) else []
    return _txt((offers[0] if offers else {}).get("company_name"))


def _lever(sess, token):
    # The board root is an SPA titled "Lever". A posting's own page is
    # server-rendered as "<Company> - <Job title>", and the API says
    # which page to ask.
    posts = _json(sess, f"https://api.lever.co/v0/postings/{token}?mode=json&limit=1")
    url = posts[0].get("hostedUrl") if isinstance(posts, list) and posts else None
    t = _title(_html(sess, url)) if url else None
    return _txt(t.split(" - ", 1)[0]) if t and " - " in t else None


def _bamboohr(sess, token):
    # The root, not /careers: the root is titled "Login - <Company>" and
    # the careers page is titled by the company, which is sometimes
    # nothing at all.
    return _from_title(_title(_html(sess, f"https://{token}.bamboohr.com")))


def _breezy(sess, token):
    t = _title(_html(sess, f"https://{token}.breezy.hr"))
    return _txt(t.replace("%DOC_TITLE%", "")) if t else None


def _jazzhr(sess, token):
    return _from_title(_title(_html(sess, f"https://{token}.applytojob.com")))


def _teamtailor(sess, token):
    return _meta(_html(sess, f"https://{token}.teamtailor.com"), "og:site_name")


def _pinpoint(sess, token):
    # "Jobs at HOLT Group | HOLT Group Careers" (checked 2026-11-08).
    m = re.match(r"(?i)\s*jobs at (.+?)\s+\|", _title(_html(sess, f"https://{token}.pinpointhq.com/")) or "")
    return _txt(m.group(1)) if m else None


def _personio(sess, token):
    return _from_title(_title(_html(sess, f"https://{token}.jobs.personio.de")))


# Three, not five. Five was a request per job on 3,000 tenants, and the
# vote is between "the company" and "a subsidiary", which three settles
# as well as five did on the tenants checked by hand.
WORKDAY_SAMPLE = 3


def _workday(sess, token, domain=None):
    # token is "tenant:wd:site", the way workday-tenants.json spells it.
    #
    # hiringOrganization is per job and is the entity that posted it,
    # which for a group is often a subsidiary: micron.com's first listing
    # said "1580 Micron Memory Taiwan". So this reads a handful of jobs,
    # strips the numeric prefix and the legal suffix from each, and takes
    # the most common answer, preferring one that contains the domain's
    # own name when the vote is close. One job is a sample of one.
    try:
        tenant, wd, site = token.split(":", 2)
    except ValueError:
        return None
    base = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}"
    try:
        r = sess.post(f"{base}/jobs", json={"appliedFacets": {}, "limit": WORKDAY_SAMPLE, "offset": 0, "searchText": ""},
                      timeout=TIMEOUT, headers={"Accept": "application/json"})
        posts = (r.json() if r.status_code == 200 else {}).get("jobPostings") or []
    except (requests.RequestException, ValueError):
        return None
    votes: dict[str, int] = {}
    for post in posts[:WORKDAY_SAMPLE]:
        path = post.get("externalPath")
        if not path:
            continue
        try:
            r = sess.get(f"{base}{path}", timeout=TIMEOUT, headers={"Accept": "application/json"})
            d = r.json() if r.status_code == 200 else {}
        except (requests.RequestException, ValueError):
            continue
        name = _clean_org(_txt((d.get("hiringOrganization") or {}).get("name")))
        if name:
            votes[name] = votes.get(name, 0) + 1
    if not votes:
        return None
    # Not a gate. I tried requiring the name to share its opening
    # letters with the domain and ran it over the 2,901 tenants already
    # named: it would have dropped 962, and among them Bank of America
    # (tenant ghr, domain guessed as ghr.fr), Booz Allen, Ohio State
    # and United Rentals. The domain is itself a guess from the tenant
    # name for most of Workday, so it cannot judge the name. The
    # payroll entities the vote cannot see past (ngc.com's "Northwest
    # Gospel Church", davita.com's "RHI DVA Renal Healthcare") are
    # corrected by hand in STATIC_NAMES, largest tenants first.
    label = re.sub(r"[^a-z0-9]", "", (domain or "").split(".")[0].lower())
    def score(item):
        name, n = item
        own = 1 if label and label in re.sub(r"[^a-z0-9]", "", name.lower()) else 0
        return (own, n, -len(name))
    return max(votes.items(), key=score)[0]


RESOLVERS = {
    "greenhouse": _greenhouse,
    "lever": _lever,
    "bamboohr": _bamboohr,
    "breezy": _breezy,
    "jazzhr": _jazzhr,
    "teamtailor": _teamtailor,
    "personio": _personio,
    "pinpoint": _pinpoint,
    "workday": _workday,
    "ashby": _ashby,
    "smartrecruiters": _smartrecruiters,
    "workable": _workable,
    "comeet": _comeet,
    "recruitee": _recruitee,
}


# What a board calls itself when nobody set a company name. Lemonade's
# Ashby page is titled just "Jobs", which _ashby's " Jobs" suffix strip
# leaves alone, and Corelight's Greenhouse board is named "Job Board".
# Thirteen companies showed one of these as their name (2026-09-17). No
# name is better: the board falls back to the domain.
GENERIC_NAMES = {"jobs", "job board", "job openings", "careers", "career site",
                 "open positions", "current openings", "home",
                 # Workday hiring organizations that are a page, not a company
                 "sign in to your account", "companies", "external", "corporate",
                 # the login a board redirected to, not the board (eggfarmersofcanada: "OneLogin")
                 "onelogin", "okta", "bamboohr", "microsoft", "sign in"}


# When the board itself gives nothing. Measured 2026-11-08: 462 companies
# with 14,561 open listings showed a bare domain, Capital One, Oracle,
# Cadence, ASML and BlackRock among them. Workday's hiringOrganization was
# empty for Capital One, BlackRock and Caterpillar, and Oracle, Experis,
# Deel, Matrix and Pinpoint have no resolver at all. Three more places a
# company names itself, tried in order:
#
#   the Workday site id      Capital_One, CaterpillarCareers, Northrop_Grumman_External_Site
#   the company's homepage   og:site_name, else a piece of <title>
#   Wikidata                 the item whose official website is the domain
#
# Every answer has to agree with what we already know (the domain's own
# label or the Workday tenant), because the domain is a guess for much of
# Workday: mckesson.fr is a health guide in Bordeaux, and a parked or
# challenge page has a title too. Agreeing means one name inside the
# other, or the name's initials leading the label (Northrop Grumman, ngc).
# A disagreement falls through to the next source; nothing is better than
# the wrong company.
_SITE_NOISE = {"external", "externalsite", "careers", "career", "careersite", "site", "jobs", "job", "search",
               "portal", "professional", "professionals", "opportunities", "recruiting", "hiring", "talent",
               "global", "ext", "en", "us", "usa", "uk", "emea", "apac", "intl", "international", "main",
               "university", "campus", "students", "student", "early", "veterans", "internal", "employee",
               "employees", "referral", "referrals", "experienced", "corporate", "home", "join", "joinus",
               "admin", "administrative", "staff", "faculty", "externe", "extern", "externo", "externa"}
_SITE_SUFFIX = re.compile(r"(?i)(?<=[a-z])(external|careers?|jobs|site|ext\d*)$")
_PAGE_JUNK = re.compile(r"(?i)\b(for sale|domain|coming soon|under construction|parked|not found|forbidden"
                        r"|access denied|just a moment|attention required|error|untitled|login|sign in)\b")
_LABEL_TLD = re.compile(r"(?i)^(www\d?|careers?|jobs)\.")


def _compact(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _labels(entry: dict) -> set[str]:
    """What the name has to agree with: the domain's first label and, on
    Workday, the tenant. Short ones prove nothing and are left out."""
    out = {_compact(_LABEL_TLD.sub("", entry.get("domain") or "").split(".")[0])}
    if entry.get("ats") == "workday" and entry.get("token"):
        out.add(_compact(entry["token"].split(":")[0]))
    return {x for x in out if len(x) >= 3}


def _agrees(name: str | None, labels: set[str]) -> bool:
    if not name:
        return False
    c = _compact(name)
    words = re.findall(r"[A-Za-z0-9]+", name)
    initials = "".join(w[0] for w in words).lower() if len(words) >= 2 else ""
    for label in labels:
        # One starts the other: Flex and flextronics, Caterpillar and cat,
        # not Spaces for livingspaces or Greg Johnson for johnson.io.
        if len(c) >= 3 and (c.startswith(label) or label.startswith(c)):
            return True
        # Initials are the label, or the label less a last letter for the
        # Inc or Corp: Northrop Grumman and ngc, Kontoor Brands and kbi.
        if len(initials) >= 2 and initials in (label, label[:-1]):
            return True
    return False


def _from_site(token: str | None) -> str | None:
    """A Workday site id as words: "Capital_One", "CaterpillarCareers" ->
    "Caterpillar". All-lowercase ids ("asmlext1") are slugs, not names."""
    try:
        site = token.split(":", 2)[2]
    except (AttributeError, IndexError):
        return None
    words = []
    for part in re.split(r"[_\-\s]+", site):
        part = _SITE_SUFFIX.sub("", re.sub(r"\d+$", "", part))
        if part and part.lower() not in _SITE_NOISE:
            words.append(part)
    name = " ".join(words)
    return name if re.search(r"[A-Z]", name) and len(name) >= 2 else None


_LEAD_IN = re.compile(r"(?i)^(?:join|welcome to|careers at|work at|jobs at|at|as|our|about|we are|home)\s+")
_ATS_HOSTS = ("myworkdayjobs.com", "greenhouse.io", "lever.co", "ashbyhq.com", "smartrecruiters.com",
              "workable.com", "bamboohr.com", "pinpointhq.com", "oraclecloud.com")


def _clean_candidate(name: str | None) -> str | None:
    name = _LEAD_IN.sub("", re.sub(r"\s*\([^)]*\)\s*$", "", re.sub(r"[®™©]", "", name or "").strip()))
    name = _strip_legal(_txt(name))
    name = re.sub(r"(?i)(?:[’']s|\s+(?:logo|careers|jobs))$", "", (name or "").rstrip(" &,-."))
    name = _txt(name.rstrip(" &,-."))
    if not name or len(name) > 60 or name.lower() in GENERIC_NAMES or name.lower() in _TITLE_NOISE:
        return None
    if _PAGE_JUNK.search(name) or re.search(r"\.[a-z]{2,}\b", name.lower()):
        return None
    return name


# A title's separators, plus the colon, », slash, comma and full stop a
# tagline hangs off ("Eco: Failsafe Execution for Onchain Money").
_SEPARATORS = re.compile(r"\s+[-–—|:·•»/]\s+|[:»]\s+|,\s+|(?<=[a-z]{2})\.\s+")


def _homepage_names(page: str | None) -> list[str]:
    out = []
    for whole in (_meta(page, "og:site_name"), _meta(page, "application-name"), _title(page)):
        out += [x.strip(" -–—|:·") for x in _SEPARATORS.split(whole or "")]
    return [n for n in (_clean_candidate(x) for x in out) if n]


# Runs of capitalised words ("Rolls-Royce", "Levi Strauss & Co.") in the
# career site's own sidebar copy, which a company writes about itself.
_PHRASE = re.compile(r"[A-Z][\w'’.&-]*(?: (?:&|of|and|for|de|du|the) [A-Z][\w'’.&-]*| [A-Z][\w'’.&-]*){0,4}")
# A full stop ends a phrase unless it follows an initial: "Indonesia. Cenovus"
# is two, "T. Rowe Price" is one.
_SENTENCE_END = re.compile(r"(?<![\s.][A-Z])(?<!^[A-Z])\.\s+")


def _sidebar_names(sess, token: str | None) -> list[str]:
    try:
        tenant, wd, site = token.split(":", 2)
        r = sess.get(f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/sidebar",
                     timeout=TIMEOUT, headers={"Accept": "application/json"})
        items = r.json() if r.status_code == 200 else []
    except (AttributeError, ValueError, requests.RequestException):
        return []
    # Fields and tags become line breaks, which a phrase never crosses:
    # an image's altText "Logo" ran into "Rolls-Royce" otherwise.
    text = "\n".join(html.unescape(re.sub(r"<[^>]{0,500}>", "\n", str(i.get(k) or "")))
                     for i in items if isinstance(i, dict) for k in ("title", "altText", "text"))
    pieces = [x for p in _PHRASE.findall(text[:20000]) for x in _SENTENCE_END.split(p)]
    return [n for n in (_clean_candidate(x) for x in pieces) if n]


def _pick(candidates: list[str], labels: set[str]) -> str | None:
    """The agreeing candidate that is exactly a label first, then the one
    said most often, then the shortest: a page says its name more than
    once and a tagline once."""
    ok = [c for c in candidates if _agrees(c, labels)]
    return min(set(ok), key=lambda c: (_compact(c) not in labels, -ok.count(c), len(c), c)) if ok else None


_WIKIDATA = "https://query.wikidata.org/sparql"
_wikidata_gate = threading.Semaphore(2)  # their policy asks for few concurrent queries


def _wikidata_names(sess, domain: str) -> list[str]:
    urls = " ".join(f"<{p}{h}{d}>" for p in ("https://", "http://") for h in ("www.", "") for d in (domain + "/", domain))
    q = ('SELECT ?l WHERE { VALUES ?u { %s } ?i wdt:P856 ?u . ?i rdfs:label ?l FILTER(LANG(?l) = "en") } LIMIT 10'
         % urls)
    with _wikidata_gate:
        try:
            r = sess.get(_WIKIDATA, params={"query": q, "format": "json"}, timeout=20,
                         headers={"Accept": "application/sparql-results+json"})
            rows = r.json()["results"]["bindings"] if r.status_code == 200 else []
        except (requests.RequestException, ValueError, KeyError):
            return []
    return sorted({n for n in (_clean_candidate(b["l"]["value"]) for b in rows) if n}, key=len)


def fallback_name(entry: dict, sess: requests.Session,
                  board: str | None = None) -> tuple[str | None, str | None]:
    """(name, source), or (None, None). board is Workday's own vote, tried
    last and only when it agrees: on the boards that reach this it was
    "Verizon Data Services", "Topgolf Payroll Services", "GPLA" for DPR."""
    labels = _labels(entry)
    domain = entry.get("domain") or ""
    # On Workday the domain is a guess from the tenant (sefl.de's homepage
    # is a German haulier, not Southeastern Freight Lines), so the tenant's
    # own pages go first there: its sidebar copy, then its site id.
    if entry.get("ats") == "workday":
        name = _pick(_sidebar_names(sess, entry.get("token")), labels)
        if name:
            return name, "sidebar"
        site = _from_site(entry.get("token"))
        # Ungated only when the domain gives nothing to check against
        # (cc.com, site ChanelCareers): the site id is the company's own.
        if site and len(site) >= 3 and (_agrees(site, labels) or not labels):
            return site, "site"
    if labels and not domain.endswith(_ATS_HOSTS):
        name = _pick(_homepage_names(_html(sess, f"https://{domain}/", same_site=True)), labels)
        if name:
            return name, "homepage"
    if labels and not domain.endswith(_ATS_HOSTS):
        name = _pick(_wikidata_names(sess, domain), labels)
        if name:
            return name, "wikidata"
    if board and _agrees(board, labels):
        return board, entry.get("ats")
    return None, None


def resolve_one(entry: dict, sess: requests.Session) -> tuple[str, str | None, str | None]:
    """(domain, name, source): the board's own answer first, the fallbacks
    when it has none. Workday is the exception: its answer is a legal
    entity often enough that the fallbacks go first and it goes last."""
    known = REFERRAL_BOARDS.get(entry.get("domain") or "")
    if known:
        return entry["domain"], known["name"], "referral"
    fn = RESOLVERS.get(entry.get("ats") or "")
    token = entry.get("token")
    name = None
    if fn and token:
        try:
            name = fn(sess, token, entry.get("domain")) if fn is _workday else fn(sess, token)
        except Exception:
            name = None
        name = _strip_legal(name)
        if name and name.strip().lower() in GENERIC_NAMES:
            name = None
    if name and fn is not _workday:
        return entry["domain"], name, entry.get("ats")
    try:
        name, source = fallback_name(entry, sess, board=name)
    except Exception:
        name, source = None, None
    return entry["domain"], name, source


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bucket", help="S3 bucket holding known.json and company-names.json")
    ap.add_argument("--known", type=Path, help="local known.json instead of S3")
    ap.add_argument("--out", type=Path, help="local output instead of S3")
    ap.add_argument("--limit", type=int, default=0, help="resolve at most N unnamed companies this run")
    ap.add_argument("--refresh", action="store_true",
                     help="re-resolve companies that already have a name (normally skipped)")
    ap.add_argument("--ats", help="only companies on this ATS (e.g. workday), for a targeted --refresh")
    args = ap.parse_args()

    s3 = None
    if args.bucket:
        import boto3
        s3 = boto3.client("s3")

    if args.known:
        known = json.loads(args.known.read_text(encoding="utf-8"))
    else:
        known = json.loads(s3.get_object(Bucket=args.bucket, Key="known.json")["Body"].read())

    names: dict[str, str] = {}
    if s3:
        try:
            names = json.loads(s3.get_object(Bucket=args.bucket, Key=NAMES_KEY)["Body"].read())
        except Exception:
            names = {}  # first run
    elif args.out and args.out.exists():
        names = json.loads(args.out.read_text(encoding="utf-8"))
    # A local copy beside the database, merged on top of S3's. A run's
    # answers are written here first, so a bucket that refuses the write
    # delays the sync rather than losing the work: the first bounded
    # batch on the box resolved 1,468 names in two minutes and lost every
    # one of them to an AccessDenied on the final put. The apply step
    # reads this file the same way.
    local = Path(os.environ.get("DATA_PATH", "/var/lib/otj/jobs.db")).with_name(NAMES_KEY)
    if s3 and local.exists():
        try:
            names.update(json.loads(local.read_text(encoding="utf-8")))
        except (OSError, ValueError) as e:
            print(f"ignoring unreadable {local}: {e}", file=sys.stderr)

    # Workday tenants live in their own registry, keyed the same way the
    # scraper reads them; known.json carries only a few dozen of them.
    tenants = Path(__file__).with_name("workday-tenants.json")
    if tenants.exists():
        have = {e.get("domain") for e in known if e.get("ats") == "workday"}
        for t in json.loads(tenants.read_text(encoding="utf-8")):
            if t.get("domain") and t["domain"] not in have and t.get("tenant") and t.get("wd") and t.get("site"):
                known.append({"domain": t["domain"], "ats": "workday",
                              "token": f"{t['tenant']}:{t['wd']}:{t['site']}"})
    # Every company with an open listing, from the database when this runs
    # beside one. known.json and workday-tenants.json miss whole boards
    # (Oracle, Experis, Deel, Matrix, Pinpoint, Workday tenants found some
    # other way), and a company missing from both was never asked at all.
    db = Path(os.environ.get("DATA_PATH", "/var/lib/otj/jobs.db"))
    if db.exists():
        have = {e.get("domain") for e in known}
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=30)
        try:
            for domain, ats, token in conn.execute(
                    "SELECT domain, ats, token FROM companies c WHERE EXISTS "
                    "(SELECT 1 FROM jobs j WHERE j.company_domain = c.domain AND j.closed_at IS NULL)"):
                if domain not in have:
                    known.append({"domain": domain, "ats": ats, "token": token})
        finally:
            conn.close()

    # Skip anything named. A board that answered with nothing is written
    # as "" so the next batch moves on to companies nobody has asked yet,
    # rather than asking the same first 1,500 every day; it is asked again
    # after TRY_AGAIN, since a board that failed once is not a company
    # with no name. --refresh asks everyone again.
    tried_path = (args.out.with_name(TRIED_FILE) if args.out else local.with_name(TRIED_FILE))
    try:
        tried = json.loads(tried_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        tried = {}
    now = datetime.now(timezone.utc)
    stale = (now - TRY_AGAIN).isoformat(timespec="seconds")

    def due(domain: str) -> bool:
        if domain in STATIC_NAMES:
            return False
        if domain not in names:
            return True
        return names[domain] == "" and tried.get(domain, "") <= stale

    todo, seen = [], set()
    for e in known:
        d = e.get("domain", "")
        if d and d not in seen and (not args.ats or e.get("ats") == args.ats) and (args.refresh or due(d)):
            seen.add(d)
            todo.append(e)
    backlog = len(todo)
    if args.limit:
        todo = todo[:args.limit]

    # The backlog before the cap, not the batch after it: a loop that ran
    # the batches read "1500 to resolve" on every run and stopped early,
    # taking the cap for the end of the queue.
    print(f"{len(known)} known companies, {len(names)} already tried, {backlog} still to resolve, "
          f"{len(todo)} this run", file=sys.stderr)
    if not todo:
        return 0

    sess = requests.Session()
    sess.headers.update({"User-Agent": UA, "Accept": "application/json,text/html"})
    adapter = requests.adapters.HTTPAdapter(pool_connections=WORKERS * 2, pool_maxsize=WORKERS * 2)
    sess.mount("https://", adapter)

    found = 0
    by_source: dict[str, int] = {}
    stamp = now.isoformat(timespec="seconds")
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for domain, name, source in pool.map(lambda e: resolve_one(e, sess), todo):
            if name:
                names[domain] = name
                found += 1
                by_source[source or "?"] = by_source.get(source or "?", 0) + 1
                tried.pop(domain, None)
            elif args.refresh or not names.get(domain):  # a retry that fails keeps the old name; --refresh retracts
                names[domain] = ""
                tried[domain] = stamp

    print(f"resolved {found}/{len(todo)} this run: " +
          ", ".join(f"{a}={n}" for a, n in sorted(by_source.items(), key=lambda kv: -kv[1])),
          file=sys.stderr)
    try:
        tried_path.write_text(json.dumps(tried, sort_keys=True), encoding="utf-8")
    except OSError as e:
        print(f"could not write {tried_path}: {e}", file=sys.stderr)

    for domain, name in STATIC_NAMES.items():
        names.setdefault(domain, name)
    body = json.dumps(names, ensure_ascii=False, sort_keys=True).encode("utf-8")
    if args.out:
        args.out.write_bytes(body)
        print(f"wrote {args.out} ({len(names)} names)", file=sys.stderr)
    if s3:
        # Local first, bucket second. The apply step reads the local copy,
        # so the run's answers count from here even if the put fails;
        # the put failing is then a warning to fix the role, not a
        # batch to redo.
        try:
            local.write_bytes(body)
        except OSError as e:
            print(f"could not write {local}: {e}", file=sys.stderr)
        try:
            s3.put_object(Bucket=args.bucket, Key=NAMES_KEY, Body=body, ContentType="application/json")
        except Exception as e:  # noqa: BLE001
            print(f"WARNING: {NAMES_KEY} not written to s3://{args.bucket} ({e!r}); "
                  f"the names are in {local} and will apply from there", file=sys.stderr)
        print(f"pushed {NAMES_KEY} ({len(names)} names) to s3://{args.bucket}/{NAMES_KEY}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
