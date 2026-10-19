"""Report ATS boards that may be stored under more than one domain.

    python scripts/audit_duplicate_boards.py                # known.json from S3
    python scripts/audit_duplicate_boards.py known.json     # a local copy

Report only. It changes nothing: a pair it calls the same board goes into
api/same_company.py by hand, after a look, the way Wix did on 2026-10-19.

The loader demotes a second domain only when its (ats, token) matches
another exactly. That misses one board under two spellings: wix.com
polled SmartRecruiters as "Wix2" and wix2.com as "wix2", and every Wix
role showed twice. Spelling alone does not prove anything either way,
so candidates come from the tokens and the verdict from the listings:

  candidates  tokens on the same ATS that are equal once case and
              punctuation are ignored ("same spelling"), or once a
              trailing number or company suffix is also dropped
              ("same stem": tenableinc / tenable, wix2 / wix)
  verdict     the open jobs each domain has on Ocean of Jobs, compared
              by the employer's own job URL, ignoring case. Most shared:
              same board. None shared: different boards. Otherwise, or
              when a side has no open jobs, unclear. Only the 200 newest
              jobs per domain are compared, so for a bigger board "none
              shared" proves nothing and is reported as unclear too
              (amazon.com / aws.amazon.com).
"""

import json
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from collections import defaultdict
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
from same_company import SAME_COMPANY  # noqa: E402

API = "https://oceanofjobs.com/api/jobs"
SAMPLE = 200
SUFFIX = re.compile(r"(inc|ltd|llc|jobs|careers|career|hr|group|global|io|co|\d+)$")


def spelling(token: str) -> str:
    return ":".join(re.sub(r"[^a-z0-9]", "", part.lower()) for part in token.split(":"))


def stem(token: str) -> str:
    parts = spelling(token).split(":")
    parts[0] = SUFFIX.sub("", parts[0]) or parts[0]
    return ":".join(parts)


def load_known(path: str | None) -> list[dict]:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "known.json"
        subprocess.run(["aws", "s3", "cp", "s3://iljobs-data-876913698688/known.json", str(out),
                        "--region", "il-central-1", "--only-show-errors"], check=True)
        return json.loads(out.read_text(encoding="utf-8"))


_jobs: dict[str, set[str] | None] = {}


def job_urls(domain: str) -> set[str] | None:
    """The employer URLs of a domain's open jobs, or None if the API failed."""
    if domain not in _jobs:
        q = urllib.parse.urlencode({"company": domain, "limit": SAMPLE, "sort": "age"})
        try:
            req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "otj-duplicate-audit"})
            with urllib.request.urlopen(req, timeout=60) as r:
                _jobs[domain] = {(j.get("url") or "").lower() for j in json.load(r)["jobs"] if j.get("url")}
        except Exception:  # noqa: BLE001 -- one failed read is "unclear", not a crash
            _jobs[domain] = None
    return _jobs[domain]


def verdict(a: str, b: str) -> tuple[str, str]:
    ja, jb = job_urls(a), job_urls(b)
    if ja is None or jb is None:
        return "unclear", "could not read one side's jobs"
    if not ja or not jb:
        return "unclear", f"open jobs {len(ja)} / {len(jb)}"
    shared = len(ja & jb)
    small = min(len(ja), len(jb))
    detail = f"{shared} of {small} shared (open {len(ja)} / {len(jb)})"
    if shared == 0 and max(len(ja), len(jb)) >= SAMPLE:
        return "unclear", detail + f", sample capped at the {SAMPLE} newest"
    if shared == 0:
        return "different", detail
    if shared >= 0.8 * small:
        return "same board", detail
    return "unclear", detail


def main() -> None:
    known = [k for k in load_known(sys.argv[1] if len(sys.argv) > 1 else None) if k.get("ats") and k.get("token")]
    groups = {"same spelling": defaultdict(set), "same stem": defaultdict(set)}
    for k in known:
        groups["same spelling"][(k["ats"], spelling(str(k["token"])))].add(k["domain"])
        groups["same stem"][(k["ats"], stem(str(k["token"])))].add(k["domain"])
    seen_pairs = set()
    rows = []
    for kind, by_key in groups.items():
        for (ats, key), domains in sorted(by_key.items()):
            for a, b in combinations(sorted(domains), 2):
                if (a, b) in seen_pairs:
                    continue
                seen_pairs.add((a, b))
                if SAME_COMPANY.get(a) == b or SAME_COMPANY.get(b) == a:
                    rows.append((kind, ats, key, a, b, "handled", "in api/same_company.py"))
                    continue
                rows.append((kind, ats, key, a, b, *verdict(a, b)))
    print(f"{len(known)} resolved domains; {len(rows)} candidate pairs\n")
    order = {"same board": 0, "unclear": 1, "different": 2, "handled": 3}
    for r in sorted(rows, key=lambda r: (order[r[5]], r[0], r[1], r[3])):
        print(f"{r[5]:11} {r[0]:13} {r[1]:16} {r[3]:32} {r[4]:32} {r[6]}")


if __name__ == "__main__":
    main()
