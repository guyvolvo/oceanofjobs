"""f_smartrecruiters reads every page, not the first hundred.

Reported live 2026-09-30: Ubisoft's board (301 roles) loaded as 100.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import probe  # noqa: E402

failed = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failed.append(name)


def posting(i):
    return {"id": str(i), "name": f"Role {i}", "location": {"city": "Paris", "country": "France"},
            "releasedDate": "2026-09-01T00:00:00.000Z", "department": {"label": "Games"}}


def board(total, fail_offsets=()):
    """A fake get_json answering the list endpoint by offset."""
    urls = []

    def fake(sess, url):
        urls.append(url)
        m = re.search(r"offset=(\d+)", url)
        off = int(m.group(1)) if m else 0
        if off in fail_offsets:
            return None
        return {"totalFound": total, "content": [posting(i) for i in range(off, min(off + 100, total))]}
    return fake, urls


orig = probe.get_json
try:
    probe.get_json, urls = board(250)
    jobs = probe.f_smartrecruiters(None, "Ubisoft2")
    check("every page is read", jobs is not None and len(jobs) == 250, str(len(jobs or [])))
    check("the pages after the first are asked for by offset",
          sorted(urls) == sorted(["https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings?limit=100",
                                  "https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings?limit=100&offset=100",
                                  "https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings?limit=100&offset=200"]), repr(urls))
    check("no posting is read twice", len({j.external_id for j in jobs}) == 250)

    probe.get_json, urls = board(80)
    jobs = probe.f_smartrecruiters(None, "small")
    check("a board under a hundred is one request", len(jobs) == 80 and len(urls) == 1, repr(urls))

    probe.get_json, urls = board(250, fail_offsets={200})
    check("a page that never answers makes the whole read fail rather than close its roles",
          probe.f_smartrecruiters(None, "Ubisoft2") is None)

    probe.get_json, urls = board(0)
    check("a known board re-polled empty says zero, so its last roles close",
          probe.f_smartrecruiters(None, "Ubisoft2") == [])
    probe._cond.guessing = True
    check("an empty board while guessing is still no match", probe.f_smartrecruiters(None, "anyslug") is None)
finally:
    probe._cond.guessing = False
    probe.get_json = orig

print()
if failed:
    print(f"{len(failed)} failed:")
    for f in failed:
        print(f"  - {f}")
    sys.exit(1)
print("all passed")
