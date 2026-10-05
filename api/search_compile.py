"""A SearchQuery (api/search_terms.py) turned into SQL, two ways.

where_sql decides which listings qualify; rank_sql decides their order.
Both read the same SearchQuery object and the same alternatives, so a
row can only score for what it matched on. The search this replaced
matched with FTS words and scored with substring LIKE, which is how
"soc" ranked a listing for "associate".

With the full five-column index (loader/fts_full.py), everything is
FTS5: column filters for where a phrase may appear, quoted phrases so
punctuation is never query syntax, a trailing * for the word being typed,
and NEAR so that two plain words hit in a description only when they sit
together. Without it (an older snapshot, the description-only index, or
none) the same groups fall back to substring LIKE, as search worked
before, and gain only the related phrases.

Weights and the NEAR distance are tuning values, not design: change them
only with tests/search_eval.py showing the same or a better score. What
must hold whatever the numbers is the order the tiers give: a title that
has every group literally, then one that has every group in any form,
then one with any title hit, then everything else.
"""

from search_terms import SearchQuery

META = "{title department company_domain location}"
# Two plain words found only in a description must sit this close.
SEARCH_NEAR_DISTANCE = 8
# Related phrases qualify a listing through its title, department,
# company or location; a description qualifies it only through what was
# typed. Descriptions name neighbouring roles all the time ("work with
# the security analysts"), and matching related phrases there widened
# results without making them better. A tuning switch, like the weights.
RELATED_IN_DESCRIPTION = False
RANK_WEIGHTS = {
    "title_literal": 12,
    "title_related": 9,
    # Department, company or location holding a typed word.
    "metadata": 5,
    # Per group, only when any group is enough to qualify.
    "description": 2,
    "ambiguous_in_title": 3,
    "phrase_in_title": 40,
    # Snapshots without the five-column index only (_rank_like).
    "all_in_title": 30,
}
# The smallest digit of the order. It outweighs anything the points and
# the recency penalty (handler.RELEVANCE_AGE_PENALTY, 5 a fortnight) can
# add or take, so the title tests decide first and the points order
# within them.
TIER_STEP = 1000
# Substring weights for snapshots without the five-column index, as the
# board has always ranked them there.
LIKE_WEIGHTS = {"title": 10, "company_domain": 7, "location": 6, "department": 5}
LIKE_DESCRIPTION = 2


def phrase(alt, prefix: bool = True) -> str:
    """An alternative as an FTS5 phrase: quoted, so C++, NEAR or a hyphen
    is never syntax, with * when its last word is still being typed.

    prefix=False for descriptions. The * is there to finish a title while
    it is typed; in descriptions a three-letter stem reads most of the
    index ("eng"* is in 630,000 of them, 0.9s on the box) and finds
    nothing a title would not, so there the word counts as typed."""
    return '"' + alt.text.replace('"', '""') + '"' + ("*" if alt.prefix and prefix else "")


def alternatives(alts, prefix: bool = True) -> str:
    return "(" + " OR ".join(phrase(a, prefix) for a in alts) + ")"


def _plain(group) -> bool:
    a = group.alternatives
    return len(a) == 1 and a[0].kind == "literal" and " " not in a[0].text


def _fts_in(expr_placeholder: str = "?") -> str:
    return f"jobs.rowid IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH {expr_placeholder})"


def match_expression(q: SearchQuery, near: int = SEARCH_NEAR_DISTANCE) -> str | None:
    """The whole query as one FTS5 MATCH over the five-column index, or
    None when no group can go through FTS (all C++-style terms)."""
    groups = [g for g in q.groups if g.fts]
    if not groups:
        return None
    plain = [g for g in groups if _plain(g)]
    near_expr = None
    if q.expand and q.combine == "all" and len(plain) >= 2:
        near_expr = f"description : NEAR({' '.join(phrase(g.alternatives[0], prefix=False) for g in plain)}, {near})"
    parts = []
    for g in groups:
        alts = alternatives(g.alternatives)
        desc_alts = g.alternatives if RELATED_IN_DESCRIPTION else [a for a in g.alternatives if a.kind == "literal"]
        desc = near_expr if (near_expr and g in plain) else f"description : {alternatives(desc_alts, prefix=False)}"
        parts.append(f"({META} : {alts} OR {desc})")
    return (" AND " if q.combine == "all" else " OR ").join(parts)


def _like_group(group, caps) -> tuple[str, list]:
    """One group as substring matches, for terms FTS5 cannot hold and for
    snapshots without the five-column index."""
    cols = ("title", "company_domain", "location", "department")
    parts, args = [], []
    for alt in group.alternatives:
        like = f"%{alt.text}%"
        parts += [f"LOWER(COALESCE({c}, '')) LIKE ?" for c in cols]
        args += [like] * len(cols)
    if caps.fts and all("+" not in a.text and "#" not in a.text for a in group.alternatives):
        parts.append(_fts_in())
        args.append(alternatives(group.alternatives))
    else:
        for alt in group.alternatives:
            parts.append("LOWER(COALESCE(description, '')) LIKE ?")
            args.append(f"%{alt.text}%")
    return "(" + " OR ".join(parts) + ")", args


def where_sql(q: SearchQuery, caps, rowset: tuple | None = None) -> tuple[list[str], list]:
    """The clauses that decide which rows qualify, to be ANDed into the
    WHERE ("all") or ORed together as one clause ("any").

    rowset is (temp table, expression) when a caller has already run this
    query's MATCH into a temp table (aggregates.search_rows); it is read
    instead of the index when it was built for the same expression."""
    clauses, args = [], []
    if q.empty:
        return clauses, args
    if caps.fts_full:
        expr = match_expression(q)
        if expr and rowset and rowset[1] == expr:
            clauses.append(f"jobs.rowid IN (SELECT rid FROM temp.{rowset[0]})")
        elif expr:
            clauses.append(_fts_in())
            args.append(expr)
        rest = [g for g in q.groups if not g.fts]
    else:
        rest = list(q.groups)
    for g in rest:
        sql, a = _like_group(g, caps)
        clauses.append(sql)
        args.extend(a)
    if q.combine == "any" and len(clauses) > 1:
        return ["(" + " OR ".join(clauses) + ")"], args
    return clauses, args


def _case_fts(expr: str, points: int) -> tuple[str, list]:
    return f"(CASE WHEN {_fts_in()} THEN {points} ELSE 0 END)", [expr]


def rank_sql(q: SearchQuery, caps) -> tuple[str, list]:
    """How well a row answers the query, highest first. "0" when there is
    nothing to rank against.

    SQLite reads each FTS subquery in full once per statement, however
    few rows it is then asked about, and a concept's related phrases make
    that read cost a third of a second (SOC: a dozen phrases sharing words
    like "security"). So every expression appears once. Each group's
    title test is one CASE whose branches carry the tier digits along
    with the points, and the order comes from adding them up: first how
    many groups the title holds in a specific form, then how many it
    holds as typed, then how many in any form, then the points. A title
    with every group as typed comes first, then one with every group in
    some specific form, then any title hit, then the rest, which is the
    order tests/test_search_fts.py pins down.
    """
    if q.empty:
        return "0", []
    if not caps.fts_full:
        return _rank_like(q, caps)
    w = RANK_WEIGHTS
    fts_groups = [g for g in q.groups if g.fts]
    n = len(fts_groups)
    # Digits. Each outweighs everything below it can add up to, the
    # points and the recency penalty included (TIER_STEP).
    any_form = TIER_STEP
    as_typed = any_form * (n + 1)
    specific = as_typed * (n + 1)
    parts, args = [], []
    firsts = [g.alternatives[0] for g in fts_groups]
    whole = None
    if sum(len(a.text.split()) for a in firsts) >= 2:
        whole = '"' + " ".join(a.text for a in firsts).replace('"', '""') + '"' + ("*" if firsts[-1].prefix else "")
    for g in fts_groups:
        # An ambiguous typed word ("soc" is also system-on-chip) matches,
        # but a title holding only it counts as a weak hit; it adds a
        # little on top, so "SOC Analyst" still edges "Security Analyst"
        # for a bare "soc".
        strong = [a for a in g.alternatives if not a.ambiguous]
        vague = [a for a in g.alternatives if a.ambiguous]
        lits = [a for a in strong if a.kind == "literal"]
        whens, wargs = [], []
        if lits:
            lit_expr = "title : " + alternatives(lits)
            points = specific + as_typed + any_form + w["title_literal"]
            # One group typed as one phrase: the whole-query phrase test
            # is this same expression, so it rides on this branch.
            if whole and n == 1 and len(lits) == 1 and "title : (" + whole + ")" == lit_expr:
                points += w["phrase_in_title"]
                whole = None
            if any(a.prefix for a in lits):
                # The word as typed outranks what its stem completes to:
                # "react" puts React Developer above Reactor Operator, which
                # matched only because the reader might still be typing.
                whens.append(f"WHEN {_fts_in()} THEN {points}")
                wargs.append("title : " + alternatives(lits, prefix=False))
                whens.append(f"WHEN {_fts_in()} THEN {specific + any_form + w['title_related']}")
                wargs.append(lit_expr)
            else:
                whens.append(f"WHEN {_fts_in()} THEN {points}")
                wargs.append(lit_expr)
        if len(lits) < len(strong):
            whens.append(f"WHEN {_fts_in()} THEN {specific + any_form + w['title_related']}")
            wargs.append("title : " + alternatives(strong))
        if vague:
            vague_expr = "title : " + alternatives(vague)
            whens.append(f"WHEN {_fts_in()} THEN {any_form}")
            wargs.append(vague_expr)
            sql, a = _case_fts(vague_expr, w["ambiguous_in_title"])
            parts.append(sql)
            args += a
        if whens:
            parts.append(f"(CASE {' '.join(whens)} ELSE 0 END)")
            args += wargs
        if q.combine == "any":
            # With any word enough to qualify, a description holding more
            # of them is the better answer. With all of them required,
            # every description hit holds every group and the test would
            # add the same points to each, so it is not run.
            typed = [a for a in g.alternatives if a.kind == "literal"]
            sql, a = _case_fts("description : " + alternatives(typed, prefix=False), w["description"])
            parts.append(sql)
            args += a
    # Department, company and location, for what was typed, in one test,
    # and without the * (a stem matched there already qualified the row;
    # scoring it again costs a second read of every word it opens to).
    typed_all = [a for g in fts_groups for a in g.alternatives if a.kind == "literal"]
    if typed_all:
        sql, a = _case_fts("{department company_domain location} : " + alternatives(typed_all, prefix=False), w["metadata"])
        parts.append(sql)
        args += a
    for g in (g for g in q.groups if not g.fts):
        sql, a = _rank_like_group(g, caps)
        parts.append(sql)
        args += a
    # The whole query, in order, as a phrase in the title: counted in
    # words, so "machine learning" earns it as one concept group just as
    # "machine" plus "learning" would as two.
    if whole:
        sql, a = _case_fts("title : " + whole, w["phrase_in_title"])
        parts.append(sql)
        args += a
    for b in q.boosts:
        sql, a = _case_fts("title : " + alternatives(b.alternatives), b.weight)
        parts.append(sql)
        args += a
    if not parts:
        return "0", []
    return "(" + " + ".join(parts) + ")", args


def _rank_like_group(group, caps) -> tuple[str, list]:
    parts, args = [], []
    for col, weight in LIKE_WEIGHTS.items():
        conds = " OR ".join(f"LOWER(COALESCE({col}, '')) LIKE ?" for _ in group.alternatives)
        parts.append(f"(CASE WHEN {conds} THEN {weight} ELSE 0 END)")
        args += [f"%{a.text}%" for a in group.alternatives]
    if caps.fts and group.fts:
        parts.append(f"(CASE WHEN {_fts_in()} THEN {LIKE_DESCRIPTION} ELSE 0 END)")
        args.append(alternatives(group.alternatives))
    else:
        conds = " OR ".join("LOWER(COALESCE(description, '')) LIKE ?" for _ in group.alternatives)
        parts.append(f"(CASE WHEN {conds} THEN {LIKE_DESCRIPTION} ELSE 0 END)")
        args += [f"%{a.text}%" for a in group.alternatives]
    return " + ".join(parts), args


def _rank_like(q: SearchQuery, caps) -> tuple[str, list]:
    """Ranking for snapshots without the five-column index: the board's
    substring weights, over the same groups."""
    parts, args = [], []
    for g in q.groups:
        sql, a = _rank_like_group(g, caps)
        parts.append(sql)
        args += a
    lit = [g.alternatives[0].text for g in q.groups]
    if len(" ".join(lit).split()) > 1:
        parts.append(f"(CASE WHEN LOWER(title) LIKE ? THEN {RANK_WEIGHTS['phrase_in_title']} ELSE 0 END)")
        args.append(f"%{' '.join(lit)}%")
    if len(q.groups) > 1:
        every = " AND ".join("(" + " OR ".join("LOWER(title) LIKE ?" for _ in g.alternatives) + ")" for g in q.groups)
        parts.append(f"(CASE WHEN {every} THEN {RANK_WEIGHTS['all_in_title']} ELSE 0 END)")
        for g in q.groups:
            args += [f"%{a.text}%" for a in g.alternatives]
    return "(" + " + ".join(parts) + ")", args
