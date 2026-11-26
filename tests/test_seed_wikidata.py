"""seed_wikidata.py turns Wikidata websites into bare domains and adds
only the ones domains.txt does not already have. No network.

Run directly:  python tests/test_seed_wikidata.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from seed_wikidata import HEADER, candidates, listed_domains, normalize, rewrite, split_block  # noqa: E402

failed = []


def check(name, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else f'  got {got!r}, want {want!r}'}")
    if not ok:
        failed.append(name)


check("scheme, www and path go", normalize("https://www.Teva.com/careers/"), "teva.com")
check("a .co.il domain keeps three labels", normalize("http://www.bankhapoalim.co.il"), "bankhapoalim.co.il")
check("a subdomain under .ac.il collapses to the university", normalize("https://english.tau.ac.il/"), "tau.ac.il")
check("a subdomain under .com collapses", normalize("https://careers.elbitsystems.com"), "elbitsystems.com")
check("a bare host with no scheme", normalize("rafael.co.il"), "rafael.co.il")
check("a port is dropped", normalize("http://example.co.il:8080/x"), "example.co.il")
check("an .io subdomain is not mistaken for a registry", normalize("https://app.wiz.io"), "wiz.io")
check("government sites are dropped", normalize("https://www.health.gov.il"), None)
check("a Facebook page is not a company domain", normalize("https://www.facebook.com/somecompany"), None)
check("a Wix subsite is not a company domain", normalize("https://foo.wixsite.com/bar"), None)
check("an IP address is not a domain", normalize("http://192.168.0.1/"), None)
check("a Hebrew-script domain is skipped", normalize("https://איגוד.ישראל/"), None)

text = "# a comment mentioning ignored.com\nMonday.com\n\nwiz.io\n"
listed = listed_domains(text)
check("comments and blanks are not listed, case is folded", listed, {"monday.com", "wiz.io"})

rows = [
    {"item": "Q1", "name": "Monday", "website": "https://monday.com", "employees": "2000"},
    # Same company, a second website: already listed through monday.com.
    {"item": "Q1", "name": "Monday", "website": "https://monday.co.il", "employees": "2000"},
    {"item": "Q2", "name": "Small Co", "website": "https://small.co.il", "employees": None},
    {"item": "Q3", "name": "Big Co", "website": "https://www.big.co.il", "employees": "500"},
    {"item": "Q3", "name": "Big Co", "website": "https://big.co.il/en", "employees": "900"},
    # Two websites, neither listed: one domain, the shorter.
    {"item": "Q3", "name": "Big Co", "website": "https://bigcompany.com", "employees": "900"},
    # No headcount, but on the TASE: kept.
    {"item": "Q4", "name": "Alpha", "website": "https://alpha.com", "employees": None, "tase": "Q1507974"},
    # On the TASE with a small headcount: kept anyway.
    {"item": "Q5", "name": "Tiny Listed", "website": "https://tiny.co.il", "employees": "40", "tase": "Q1507974"},
    # 199 employees, not listed: dropped at the default 200.
    {"item": "Q6", "name": "Mid Co", "website": "https://mid.co.il", "employees": "199"},
    {"item": "Q7", "name": "Edge Co", "website": "https://edge.co.il", "employees": "200"},
]
got = candidates(rows, listed)
check("TASE or >= 200 employees; listed companies dropped under any domain; one domain each; largest first",
      got, [("big.co.il", "Big Co", 900, False), ("edge.co.il", "Edge Co", 200, False),
            ("tiny.co.il", "Tiny Listed", 40, True), ("alpha.com", "Alpha", None, True)])
check("--min-employees moves the cut", [d for d, *_ in candidates(rows, listed, min_employees=100)],
      ["big.co.il", "edge.co.il", "mid.co.il", "tiny.co.il", "alpha.com"])

relisted = listed | {d for d, *_ in got}
check("re-running against the updated list adds nothing", candidates(rows, relisted), [])

# The block is rewritten in place, not appended a second time.
start = "# Seed\nmonday.com\nwiz.io\n"
later = "\n# Common Crawl discovery batch (merge_discovered_batch.py)\nlater.com\n"
first, kept = rewrite(start + later, rows, 200)
check("a first run adds one block", first.count(HEADER), 1)
check("the block's domains, largest first", split_block(first)[1], [d for d, *_ in kept])
check("a re-run leaves the file alone", rewrite(first, rows, 200)[0], None)
second, _ = rewrite(first + later.replace("later", "after"), rows, 100)
check("a new threshold replaces the block in place", second.count(HEADER), 1)
check("lines outside the block survive the rewrite",
      [l for l in second.splitlines() if not l.startswith("#") and l and l not in split_block(second)[1]],
      ["monday.com", "wiz.io", "later.com", "after.com"])
check("the regenerated block has the lower threshold's extra domain", "mid.co.il" in split_block(second)[1], True)
domain_lines = [l for l in second.splitlines() if l.strip() and not l.startswith("#")]
check("domains.txt keeps no duplicates", len(domain_lines), len(set(domain_lines)))
empty, _ = rewrite(first, [], 200)
check("no candidates removes the block", HEADER in empty, False)
check("removing the block keeps everything else", listed_domains(empty), {"monday.com", "wiz.io", "later.com"})

if failed:
    sys.exit(f"{len(failed)} failed")
print("all passed")
