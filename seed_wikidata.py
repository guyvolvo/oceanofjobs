"""Seed domains.txt with Israeli organisations from Wikidata.

Discovery only finds companies through hosted ATS URLs, so big employers
on their own careers systems never get in. Wikidata lists them by
headquarters. This asks for every organisation with an official website
(P856) that is in Israel (P17), headquartered somewhere in Israel (P159),
or listed on the Tel Aviv Stock Exchange (P414), keeps one bare domain
per company that is TASE-listed or has at least --min-employees (P1128),
drops what domains.txt already has, and writes the rest as one dated
block, largest employer first.

Wikidata is CC0, so no credit line is owed; the comment names it anyway.
The script owns that block: a re-run regenerates it in place, and leaves
the file untouched when nothing changed.

    python seed_wikidata.py --dry-run
    python seed_wikidata.py [--min-employees 200]
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOMAINS_PATH = ROOT / "domains.txt"
# Wikidata's own query service first. QLever serves the same Wikidata
# data and answers this query in seconds; it is the fallback because
# WDQS rate-limits hard and times out on it when under load (Nov 2026).
ENDPOINTS = ("https://query.wikidata.org/sparql", "https://qlever.dev/api/wikidata")
USER_AGENT = "OceanOfJobs-seed/1.0 (domain seed list; stdlib urllib)"

# P279* Q43229: any kind of organisation. P576: dissolved, so no longer
# hiring. Embassies, political parties and Knesset factions are
# organisations too, about 300 of them, and none has a careers page.
# Plain SPARQL with no WDQS label service or hints, so both
# endpoints run it unchanged.
QUERY = """
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item ?en ?he ?website ?employees ?tase WHERE {
  { ?item wdt:P17 wd:Q801 }
  UNION { ?item wdt:P159 ?hq . ?hq wdt:P17 wd:Q801 }
  UNION { ?item wdt:P414 wd:Q1507974 }
  ?item wdt:P856 ?website .
  ?item wdt:P31 ?type .
  ?type wdt:P279* wd:Q43229 .
  MINUS { ?item wdt:P576 ?end }
  MINUS { VALUES ?skip { wd:Q3917681 wd:Q7278 wd:Q848197 } ?item wdt:P31 ?skip }
  OPTIONAL { ?item wdt:P1128 ?employees }
  OPTIONAL { ?item wdt:P414 ?tase FILTER(?tase = wd:Q1507974) }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item rdfs:label ?he FILTER(LANG(?he) = "he") }
}
"""

# Second-level labels under a country TLD that are registries, not
# companies: iai.co.il, tau.ac.il, hot.net.il.
# shortcut: a hand list, not the Public Suffix List; switch to the PSL if odd ccTLD sites start collapsing to the registry.
SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov", "edu", "muni", "ltd", "plc", "gob", "ne", "or", "k12", "idf"}

# Shared hosts some items give as their "official website". The
# registrable domain there belongs to the host, not the company.
SHARED_HOSTS = {
    "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com",
    "wixsite.com", "blogspot.com", "wordpress.com", "github.io", "tumblr.com", "medium.com",
    "t.me", "wikipedia.org", "google.com", "sites.google.com", "linktr.ee", "weebly.com",
}

# Government ministries and the army do not hire through careers pages.
DROP_SUFFIXES = (".gov.il", ".idf.il", ".mil.il")

# Every domain costs the full sweep up to 45s of guessing per shard, and
# the sweep already hits its deadline, so only companies likely to have
# a careers page get in: TASE-listed, or at least this many employees.
MIN_EMPLOYEES = 200

# This script owns one block of domains.txt and rewrites it in place.
HEADER = "# Wikidata seed (seed_wikidata.py"


def normalize(url: str) -> str | None:
    """A website URL as a bare registrable domain, or None if it is not one."""
    url = url.strip().lower()
    if "://" not in url:
        url = "http://" + url
    host = (urllib.parse.urlsplit(url).hostname or "").strip(".")
    labels = [l for l in host.split(".") if l]
    # An IP address, a bare name, or a Hebrew-script domain, which
    # domains.txt does not take (tests/test_discover_sweep_budget.py).
    if len(labels) < 2 or not host.isascii() or not labels[-1].isalpha():
        return None
    keep = 3 if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in SECOND_LEVEL else 2
    domain = ".".join(labels[-keep:])
    if domain in SHARED_HOSTS or host in SHARED_HOSTS or ("." + domain).endswith(DROP_SUFFIXES):
        return None
    return domain


def listed_domains(text: str) -> set[str]:
    return {l.strip().lower() for l in text.splitlines() if l.strip() and not l.lstrip().startswith("#")}


def candidates(rows: list[dict], listed: set[str],
               min_employees: int = MIN_EMPLOYEES) -> list[tuple[str, str, int | None, bool]]:
    """(domain, name, employees, on_tase), one per company not already
    listed that is on the TASE or has at least `min_employees`, largest
    employer first, then by name.

    Wikidata gives one company several websites and several headcounts
    over time. A company is already listed if any of its domains is
    (Teva is tevapharm.com in domains.txt and teva.co.il here too), else
    it gets its shortest domain once, with its largest headcount.
    """
    items: dict[str, dict] = {}
    for r in rows:
        domain = normalize(r.get("website", ""))
        if not domain:
            continue
        it = items.setdefault(r.get("item") or domain, {"domains": set(), "name": "", "emp": None, "tase": False})
        it["domains"].add(domain)
        it["name"] = it["name"] or r.get("name") or ""
        it["tase"] = it["tase"] or bool(r.get("tase"))
        try:
            emp = int(float(r["employees"])) if r.get("employees") else None
        except ValueError:
            emp = None
        if emp is not None and (it["emp"] is None or emp > it["emp"]):
            it["emp"] = emp
    best: dict[str, tuple[str, int | None, bool]] = {}
    for it in items.values():
        if it["domains"] & listed:
            continue
        if not it["tase"] and (it["emp"] is None or it["emp"] < min_employees):
            continue
        domain = min(it["domains"], key=lambda d: (len(d), d))
        old = best.get(domain)
        if old is None or (it["emp"] or -1) > (old[1] or -1):
            best[domain] = (it["name"] or domain, it["emp"], it["tase"] or (old is not None and old[2]))
    return sorted(((d, n, e, t) for d, (n, e, t) in best.items()), key=lambda t: (-(t[2] or -1), t[1].lower(), t[0]))


def split_block(text: str) -> tuple[list[str], list[str], list[str]]:
    """domains.txt as (lines before this script's block, the block's
    domains, lines after it). The block is the HEADER comment lines and
    the domains under them, up to the next blank or comment line.
    """
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith(HEADER)), None)
    if start is None:
        return lines, [], []
    end = start + 1
    while end < len(lines) and lines[end].startswith("#"):
        end += 1
    body = end
    while end < len(lines) and lines[end].strip() and not lines[end].startswith("#"):
        end += 1
    return lines[:start], [l.strip() for l in lines[body:end]], lines[end:]


def fetch() -> list[dict]:
    data = None
    for endpoint in ENDPOINTS:
        req = urllib.request.Request(
            endpoint + "?" + urllib.parse.urlencode({"query": QUERY}),
            headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.load(resp)
            print(f"queried {endpoint}", file=sys.stderr)
            break
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"{endpoint} failed ({e}), trying the next endpoint", file=sys.stderr)
    if data is None:
        sys.exit("every SPARQL endpoint failed, nothing written")
    v = lambda b, k: b.get(k, {}).get("value")  # noqa: E731
    return [{"item": v(b, "item"), "name": v(b, "en") or v(b, "he") or "", "website": v(b, "website") or "",
             "employees": v(b, "employees"), "tase": v(b, "tase")} for b in data["results"]["bindings"]]


def rewrite(text: str, rows: list[dict], min_employees: int) -> tuple[str | None, list]:
    """domains.txt with this script's block regenerated, or None when the
    block would not change, and the block's (domain, name, employees,
    on_tase) rows. The block is compared without its own domains, so a
    re-run, or a run with a new threshold, replaces it instead of adding
    to it.
    """
    before, old, after = split_block(text)
    new = candidates(rows, listed_domains("\n".join(before + after)), min_employees)
    if [d for d, *_ in new] == old:
        return None, new
    while before and not before[-1].strip():
        before.pop()
    block = [] if not new else [
        "",
        f"{HEADER}, {date.today().isoformat()}): organisations in Israel,",
        "# headquartered in Israel, or listed on the Tel Aviv Stock Exchange, with an",
        f"# official website and either a TASE listing or at least {min_employees} employees.",
        "# Largest headcount first. Wikidata is CC0.",
    ] + [d for d, *_ in new]
    return "\n".join(before + block + after) + "\n", new


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="print counts and the largest new domains, write nothing")
    ap.add_argument("--min-employees", type=int, default=MIN_EMPLOYEES,
                    help=f"keep a company not on the TASE only with this many employees (default {MIN_EMPLOYEES})")
    args = ap.parse_args()

    rows = fetch()
    text = DOMAINS_PATH.read_text(encoding="utf-8-sig")
    out, new = rewrite(text, rows, args.min_employees)
    tase = sum(1 for *_, t in new if t)
    print(f"{len(rows)} Wikidata rows, {len(new)} domains in the block: {tase} on the TASE, "
          f"{len(new) - tase} by headcount alone", file=sys.stderr)
    for d, n, e, t in new[:30]:
        print(f"  {e if e is not None else '-':>8} {'TASE' if t else '    '}  {d:<32} {n}", file=sys.stderr)
    if args.dry_run or out is None:
        print("domains.txt unchanged", file=sys.stderr)
        return 0
    DOMAINS_PATH.write_text(out, encoding="utf-8")
    print(f"rewrote the Wikidata block of domains.txt: {len(new)} domains", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
