"""What a search means, before anything decides how to look for it.

The search box's text goes in once and comes out as a SearchQuery: an
ordered set of groups, every one of which a listing has to satisfy (or
any one, in "any" mode), plus boosts that only ever change the order.
Inside a group the alternatives are interchangeable ways of saying the
same thing, each marked literal (what the reader typed) or related (a
role or spelling this file knows means much the same).

This file knows nothing about SQL or SQLite. api/search_compile.py turns
one SearchQuery into both the MATCH expressions that decide which rows
qualify and the score that orders them. One parse feeding both is the
point: the search this replaced matched rows with FTS words and ranked
them with substring LIKE, so "soc" qualified a row as a whole word and
then scored it for "associate".

    soc analyst tier 1
      groups:  [soc analyst | security analyst | secops | ...]
      boosts:  [tier 1 | l1 | level 1 | tier i]  (order only)

Search exactly (search_exact=1) turns concepts, tiers and the prefix off:
each word is its own literal group, the way search worked before this.

Adding a concept: put it in CONCEPTS below, then add a query for it to
tests/search_eval.json and keep it only if tests/search_eval.py scores
the same or better. This is a small, hand-kept role vocabulary, not a
synonym engine, and nothing here is generated.
"""

import re
from dataclasses import dataclass
from functools import lru_cache

# Past this many terms a query costs more than it can be worth. Callers
# are told which were dropped (route_jobs returns them).
MAX_SEARCH_TERMS = 10
# A last word this long or longer also matches as the start of a word,
# so "soc ana" finds "SOC Analyst" while it is still being typed.
PREFIX_MIN = 3
TIER_WEIGHT = 8


@dataclass(frozen=True)
class Alt:
    text: str             # lower-case words, as FTS5 tokenises them
    kind: str             # "literal" or "related"
    prefix: bool = False  # the last word also matches as a prefix
    ambiguous: bool = False  # a word with more than one sense ("soc"): matches, but ranks below the specific phrases


@dataclass(frozen=True)
class Group:
    """One thing a listing must match: any of its alternatives."""
    alternatives: tuple
    source: str           # what the reader typed for this group
    fts: bool = True      # False for C++, C#: FTS5 drops + and #, so these stay substring matches


@dataclass(frozen=True)
class Boost:
    """Ranks a listing higher when its title says so; never filters."""
    alternatives: tuple
    weight: int
    source: str


@dataclass(frozen=True)
class SearchQuery:
    groups: tuple
    boosts: tuple
    combine: str          # "all": every group; "any": at least one
    expand: bool          # concepts, tiers and prefix on
    terms: tuple          # the words used, for the reply
    ignored: tuple        # words past MAX_SEARCH_TERMS
    expanded: tuple       # related phrases added, for "Also matching"

    @property
    def empty(self) -> bool:
        return not self.groups


# The role vocabulary. Each concept lists the phrases that trigger it,
# longest wins, and the related phrases a triggered query also matches.
# Triggers are literal when typed; every other trigger and the related
# list come in as related. Ambiguous words get their own entry so the
# longer, more specific reading is taken first: "soc 2" is compliance,
# never the security operations center. A trigger listed in "broad"
# is ambiguous on its own ("soc" is also system-on-chip): it is used
# when the reader typed exactly that, and never added as an alternative
# to a more specific query like "soc analyst".
CONCEPTS = [
    {"name": "soc 2",
     "triggers": ["soc 2", "soc2", "soc ii"],
     "related": []},
    {"name": "security operations",
     "triggers": ["soc analyst", "soc analysts", "security operations center", "security operations centre",
                  "security operations analyst", "soc engineer", "soc", "secops"],
     "broad": ["soc"],
     # Every related phrase costs a read of its words in the index on
     # every search (tests/search_alt_cost.py). "detection and response",
     # "blue team" and "security operations centre" found 98, 15 and 7
     # titles between them for a fifth of the concept's cost, so they are
     # matched only when typed.
     "related": ["soc analyst", "security operations center",
                 "security operations analyst", "secops", "security analyst", "cyber analyst",
                 "cybersecurity analyst", "cyber security analyst", "information security analyst",
                 "incident response analyst", "threat detection analyst",
                 "siem analyst"]},
    {"name": "application security",
     "triggers": ["appsec", "application security"],
     "related": ["appsec", "application security", "product security"]},
    {"name": "information security",
     "triggers": ["infosec", "information security"],
     "related": ["infosec", "information security"]},
    {"name": "devsecops",
     "triggers": ["devsecops"],
     "related": ["devsecops", "security devops"]},
    {"name": "site reliability",
     "triggers": ["sre", "site reliability", "site reliability engineer"],
     "related": ["sre", "site reliability"]},
    {"name": "quality assurance",
     "triggers": ["qa", "quality assurance"],
     "related": ["qa", "quality assurance"]},
    {"name": "machine learning",
     "triggers": ["ml", "machine learning"],
     "related": ["ml", "machine learning"]},
]

# Tier and level words. "soc tier 1" ranks tier-1 titles first, but most
# SOC titles never say a tier, so tiers never decide what matches.
TIER_RE = re.compile(r"^(?:tier|level|lvl|l|t)[\s-]*(1|2|3|i{1,3})$")
TIER_NAMES = {"1": "1", "i": "1", "2": "2", "ii": "2", "3": "3", "iii": "3"}


def tier_alternatives(level: str) -> tuple:
    roman = {"1": "i", "2": "ii", "3": "iii"}[level]
    return (Alt(f"tier {level}", "literal"), Alt(f"l{level}", "related"), Alt(f"level {level}", "related"),
            Alt(f"tier {roman}", "related"), Alt(f"t{level}", "related"))


def normalise(term: str) -> str:
    return " ".join(term.lower().replace("-", " ").split())


def tokenize(raw: str) -> list[tuple[str, bool]]:
    """Whitespace-separated words and "quoted phrases", in order, each
    with whether it was quoted. Quotes keep a phrase whole and exact."""
    out = []
    for quoted, bare in re.findall(r'"([^"]*)"|(\S+)', raw or ""):
        term = (quoted or bare).strip()
        if term:
            out.append((term, bool(quoted)))
    return out


def _fts_safe(term: str) -> bool:
    return not any(ch in term for ch in "+#")


def _match_concept(words: list[str], start: int, last_is_open: bool):
    """The longest concept trigger starting at words[start], as
    (concept, trigger, words consumed), or None. The query's last word
    may be the start of the trigger's last word when it is still being
    typed: "soc ana" reaches "soc analyst".

    An exact trigger always beats a completed one, so "soc" is the
    security operations center and never "soc2". Completion only ever
    finishes the last word of a trigger of two or more words: a single
    partial word ("dev") is left to match as a prefix of itself rather
    than being read as a concept ("devsecops")."""
    best, best_key = None, None
    for concept in CONCEPTS:
        for trig in concept["triggers"]:
            tw = trig.split()
            if start + len(tw) > len(words):
                continue
            seg = words[start:start + len(tw)]
            ends_query = start + len(tw) == len(words)
            exact = seg == tw
            completed = (not exact and len(tw) >= 2 and seg[:-1] == tw[:-1] and last_is_open and ends_query
                         and len(seg[-1]) >= PREFIX_MIN and tw[-1].startswith(seg[-1]))
            if not (exact or completed):
                continue
            key = (len(tw), exact)
            if best_key is None or key > best_key:
                best, best_key = (concept, trig, len(tw)), key
    return best


@lru_cache(maxsize=512)
def parse(raw: str, combine: str = "all", expand: bool = True) -> SearchQuery:
    """The one place a search string is read. Cached, so every caller
    holding the same request gets the same SearchQuery object."""
    tokens = tokenize(raw)
    used, ignored = tokens[:MAX_SEARCH_TERMS], tokens[MAX_SEARCH_TERMS:]
    terms = tuple(t for t, _ in used)
    combine = "any" if combine == "any" else "all"

    if not expand:
        groups = tuple(Group((Alt(t.lower(), "literal"),), t, _fts_safe(t)) for t, _ in used)
        return SearchQuery(groups, (), combine, False, terms, tuple(t for t, _ in ignored), ())

    groups, boosts, expanded = [], [], []
    # Tiers first: "tier 1", "l1", "level 2", "t3" become boosts and drop
    # out of what must match.
    words, quoted, i = [], [], 0
    while i < len(used):
        t, q = used[i]
        pair = f"{t} {used[i + 1][0]}".lower() if i + 1 < len(used) and not q and not used[i + 1][1] else None
        m = TIER_RE.match(pair) if pair else None
        if m:
            level = TIER_NAMES[m.group(1)]
            boosts.append(Boost(tier_alternatives(level), TIER_WEIGHT, pair))
            i += 2
            continue
        m = TIER_RE.match(t.lower()) if not q else None
        if m and not t.isdigit():
            level = TIER_NAMES[m.group(1)]
            boosts.append(Boost(tier_alternatives(level), TIER_WEIGHT, t))
            i += 1
            continue
        words.append(t)
        quoted.append(q)
        i += 1

    norm = [normalise(w) if not q else w.lower() for w, q in zip(words, quoted)]
    last_open = bool(words) and not quoted[-1]
    i = 0
    while i < len(words):
        if quoted[i]:
            groups.append(Group((Alt(norm[i], "literal"),), words[i], _fts_safe(words[i])))
            i += 1
            continue
        # A concept may span several unquoted words, never a quoted one.
        span_end = i
        while span_end < len(words) and not quoted[span_end]:
            span_end += 1
        flat = " ".join(norm[i:span_end]).split()
        hit = _match_concept(flat, 0, last_open and span_end == len(words))
        if hit and _fts_safe(" ".join(words[i:span_end])):
            concept, trig, n_words = hit
            # Map consumed normalised words back to typed words.
            consumed, taken = 0, i
            while taken < span_end and consumed < n_words:
                consumed += len(norm[taken].split())
                taken += 1
            broad = set(concept.get("broad", ()))
            alts = [Alt(trig, "literal", ambiguous=trig in broad)]
            for phrase in concept["triggers"] + concept["related"]:
                if phrase in broad and phrase != trig:
                    continue
                if phrase != trig and phrase not in (a.text for a in alts):
                    alts.append(Alt(phrase, "related"))
                    if phrase not in expanded:
                        expanded.append(phrase)
            groups.append(Group(tuple(alts), " ".join(words[i:taken])))
            i = taken
            continue
        w = words[i]
        is_last = i == len(words) - 1
        prefix = (is_last and last_open and len(norm[i]) >= PREFIX_MIN
                  and _fts_safe(w) and not norm[i].isdigit() and " " not in norm[i])
        groups.append(Group((Alt(norm[i], "literal", prefix=prefix),), w, _fts_safe(w)))
        i += 1

    return SearchQuery(tuple(groups), tuple(boosts), combine, True, terms,
                       tuple(t for t, _ in ignored), tuple(expanded))


def search_query(params: dict) -> SearchQuery:
    """The request's SearchQuery. Both compilers take it from here."""
    return parse((params.get("search") or "").strip(),
                 "any" if (params.get("search_mode") or "").lower() == "any" else "all",
                 (params.get("search_exact") or "").lower() not in ("1", "true", "yes"))
