"""Git merge driver for pending-discovery-candidates.json.

Two workflows rewrite the queue: discover-companies.yml adds candidates
and merge-discovered-companies.yml pops them. Each rebased onto the other
with -X theirs, which kept one side's whole file, so the other side's
adds were lost or its pops came back and merged twice. This keeps both
sides' changes instead, keyed on (ats, token):

  - a candidate either side removed since the common ancestor is gone,
  - a candidate either side added is kept,
  - order is the first side's, then the second side's new candidates.

Registered by the two workflows (.gitattributes names it):
    git config merge.discovery-queue.driver "python scripts/merge_discovery_queue.py %O %A %B"
Writes the result over %A and exits 0, as git expects of a merge driver.
"""

import json
import sys


def key(c: dict) -> tuple:
    return (c.get("ats"), c.get("token") or c.get("domain"))


def merge(base: list, ours: list, theirs: list) -> list:
    base_keys = {key(c) for c in base}
    ours_keys = {key(c) for c in ours}
    theirs_keys = {key(c) for c in theirs}
    # In both sides and not removed by either, or new on one side.
    keep = (ours_keys & theirs_keys) | (ours_keys - base_keys) | (theirs_keys - base_keys)
    out, seen = [], set()
    for c in ours + theirs:
        k = key(c)
        if k in keep and k not in seen:
            seen.add(k)
            out.append(c)
    return out


def _load(path: str) -> list:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main(argv: list[str]) -> int:
    base_path, ours_path, theirs_path = argv[1:4]
    try:
        base = _load(base_path)
    except ValueError:
        base = []  # git passes an empty file when there is no common ancestor
    # An unreadable side raises, exits non-zero and leaves a conflict, never an empty queue.
    result = merge(base, _load(ours_path), _load(theirs_path))
    with open(ours_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--selftest"]:
        a = {"ats": "workable", "token": "a"}
        b = {"ats": "workable", "token": "b"}
        c = {"ats": "comeet", "token": "1:c"}
        d = {"ats": "lever", "token": "d"}
        # The merge popped a; discovery added d and re-sorted.
        got = merge([a, b, c], [b, c], [d, c, a, b])
        assert got == [b, c, d], got
        # Nothing changed on one side: the other side wins outright.
        assert merge([a, b], [a, b], [b]) == [b]
        print("ok")
        sys.exit(0)
    sys.exit(main(sys.argv))
