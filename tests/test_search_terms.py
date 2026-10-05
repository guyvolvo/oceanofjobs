"""The search parser (api/search_terms.py): text in, SearchQuery out.

No database. Checks what each kind of query is read as: concepts and
their alternatives, tiers as boosts that never filter, the prefix on the
word being typed, ambiguous words kept apart, quotes kept exact, and the
four mode combinations.

Run directly, no framework:  python tests/test_search_terms.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import search_terms as S  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        failures.append(name)


def alts(q, i=0):
    return [(a.text, a.kind) for a in q.groups[i].alternatives]


q = S.parse("soc")
check("bare soc keeps the literal word first", alts(q)[0] == ("soc", "literal"), alts(q))
check("and adds the security operations family as related",
      ("security analyst", "related") in alts(q) and ("secops", "related") in alts(q), alts(q))
check("and says what it added", "security analyst" in q.expanded and "soc" not in q.expanded, q.expanded)

q = S.parse("soc analyst")
check("soc analyst is one group, the phrase literal", len(q.groups) == 1 and alts(q)[0] == ("soc analyst", "literal"), alts(q))
check("soc analyst never carries the ambiguous bare soc", "soc" not in [t for t, _ in alts(q)], alts(q))

q = S.parse("soc tier 1")
check("a tier is a boost, not a group", len(q.groups) == 1 and len(q.boosts) == 1, (q.groups, q.boosts))
check("the boost knows every way to write tier 1",
      {"tier 1", "l1", "level 1", "tier i", "t1"} <= {a.text for a in q.boosts[0].alternatives})
for spelled in ("soc l1", "soc level 1", "soc tier-1", "soc t1", "soc tier i"):
    sq = S.parse(spelled)
    check(f"{spelled!r} reads its tier the same way", len(sq.boosts) == 1 and len(sq.groups) == 1, (sq.groups, sq.boosts))
check("tier 2 and 3 too", S.parse("analyst l2").boosts[0].alternatives[0].text == "tier 2"
      and S.parse("analyst tier 3").boosts[0].alternatives[0].text == "tier 3")
check("a bare number is not a tier", not S.parse("python 3").boosts and len(S.parse("python 3").groups) == 2)

q = S.parse("soc ana")
check("soc ana completes to the soc analyst concept", len(q.groups) == 1 and alts(q)[0] == ("soc analyst", "literal"), alts(q))
q = S.parse("soc")
check("an exact trigger beats a completion (soc is not soc2)", alts(q)[0] == ("soc", "literal"))
q = S.parse("python dev")
check("a lone partial word is a prefix, not a concept", alts(q, 1) == [("dev", "literal")] and q.groups[1].alternatives[0].prefix, alts(q, 1))
check("only the last word is a prefix", not q.groups[0].alternatives[0].prefix)
check("a short last word is not a prefix", not S.parse("data ai").groups[-1].alternatives[0].prefix)
check("a number is never a prefix", not S.parse("python 3").groups[-1].alternatives[0].prefix)

q = S.parse("SOC 2 auditor")
check("SOC 2 is compliance, its own concept", alts(q)[0] == ("soc 2", "literal")
      and "security analyst" not in [t for t, _ in alts(q)], alts(q))

q = S.parse('"soc analyst" remote')
check("a quoted phrase stays one exact literal", alts(q) == [("soc analyst", "literal")], alts(q))
check("and is never a prefix", not q.groups[0].alternatives[0].prefix)

q = S.parse("c++ developer")
check("C++ keeps its substring path", not q.groups[0].fts and q.groups[1].fts)

q = S.parse("secops engineer")
check("acronyms reach their family", alts(q)[0] == ("secops", "literal") and ("soc analyst", "related") in alts(q))
check("appsec and application security are each other's alternatives",
      ("application security", "related") in alts(S.parse("appsec"))
      and ("appsec", "related") in alts(S.parse("application security")))

# Modes: two axes, combine (all/any) and expand (smart/exact).
smart_all = S.parse("soc analyst tier 1")
smart_any = S.parse("soc analyst tier 1", combine="any")
exact_all = S.parse("soc analyst tier 1", expand=False)
exact_any = S.parse("soc analyst tier 1", combine="any", expand=False)
check("smart, all: concept + boost, combine all", smart_all.combine == "all" and smart_all.boosts and len(smart_all.groups) == 1)
check("smart, any: same groups, combine any", smart_any.combine == "any" and smart_any.groups == smart_all.groups)
check("exact, all: one literal group per word, no boosts, no prefix",
      [g.alternatives[0].text for g in exact_all.groups] == ["soc", "analyst", "tier", "1"]
      and not exact_all.boosts and not exact_all.expanded
      and all(len(g.alternatives) == 1 and not g.alternatives[0].prefix for g in exact_all.groups))
check("exact, any: the same, combined with any", exact_any.combine == "any" and exact_any.groups == exact_all.groups)

q = S.search_query({"search": "soc", "search_exact": "1"})
check("search_exact=1 turns expansion off", not q.expand and len(q.groups[0].alternatives) == 1)
check("search_mode=any reaches combine", S.search_query({"search": "a b", "search_mode": "ANY"}).combine == "any")

many = " ".join(f"w{i}" for i in range(14))
q = S.parse(many)
check("the term cap still applies and reports what it dropped", len(q.terms) == 10 and len(q.ignored) == 4)
check("Hebrew passes through untouched", alts(S.parse("פרויקט"))[0][0] == "פרויקט")
check("one parse per request: the same params give the same object",
      S.search_query({"search": "soc analyst"}) is S.search_query({"search": "soc analyst"}))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
