"""The two expensive aggregate routes, with the database passed in.

Both used to live in handler.py and open their own connection. They are
here because something other than the API now needs to run them: the
5-minute applier computes both against the snapshot it just built and
ships the answers as JSON, so a request can read a finished number
instead of deriving it.

Measured before that change, with the edge cache bypassed: /api/stats
took 7.03s and /api/facets 5.02s, against 0.44s for /api/jobs. Both are
fired on every page load. That was most of the API's whole compute bill,
and none of it was work that differs between one visitor and the next.

Nothing in here imports db.py, deliberately. That module builds an S3
client at import time, which is right for a Lambda serving requests and
wrong for a loader that already has a file open on disk.
"""

import contextlib
from datetime import datetime, timedelta, timezone

from countries import label_for
from job_filters import (FRESH_CLAUSE, bool_param, build_jobs_where, category_sql,
                         has_fts_index, has_places, israel_clause)
from hot_companies import GOOGLE_FAVICON, HOT_COMPANIES, LOGO_PINS


def _with_logos(conn, rows: list[dict]) -> list[dict]:
    """Attach each company's resolved logo_url to a bar list's rows.

    The company chart drew its icons by guessing favicon paths on the
    domain, which misses every company whose icon lives anywhere else.
    Elbit's is under www.elbitsystems.com/themes/elbit/favicon/, so the
    biggest employer on the board showed a monogram in the chart while its
    own listing rows, which carry the resolved URL, showed the logo.
    Reported live.

    Looked up for the ten or so rows a list shows rather than joined into
    the grouping, which runs over every company.
    """
    domains = [r["domain"] for r in rows if r.get("domain")]
    if not domains:
        return rows
    try:
        found = {d: url for d, url in conn.execute(
            f"SELECT domain, logo_url FROM companies WHERE domain IN ({','.join('?' * len(domains))})",
            domains)}
    except Exception:
        # No companies table or no logo_url column yet (deploy skew). The
        # chart falls back to guessing, as it always did.
        return rows
    for r in rows:
        if r.get("domain"):
            r["logo_url"] = found.get(r["domain"])
    return rows


_HISTORY_CACHE: dict = {}
_HISTORY_TTL_S = 600


def skills_history(conn, params: dict, days: int = 90) -> dict:
    """The account page's market chart: for each of the last `days`
    days, how many roles carrying at least `min_match` of the reader's
    skills were open, and how many were first seen that day. A country
    narrows it the way the board's country filter does.

    Reconstructed from first_seen and closed_at rather than read from a
    table, since no table keeps a history per skill set: a baseline of
    what was open before the window, then each day's arrivals less its
    departures. One pass over the table, a LIKE per skill, and the
    answer is kept per worker for ten minutes.
    """
    from datetime import datetime, timedelta, timezone

    from job_filters import skills_score_sql, wanted_country_codes, wanted_skills

    wanted = wanted_skills(params)
    if not wanted:
        raise ValueError("skills is required")
    try:
        min_match = int(params.get("min_match") or 3)
    except ValueError:
        min_match = 3
    min_match = max(1, min(min_match, len(wanted)))
    countries = wanted_country_codes(params)
    key = (tuple(wanted), min_match, tuple(countries), days)
    now = datetime.now(timezone.utc)
    hit = _HISTORY_CACHE.get(key)
    if hit and (now - hit[0]).total_seconds() < _HISTORY_TTL_S:
        return hit[1]

    score_sql, score_args = skills_score_sql(wanted)
    where = [f"{score_sql} >= ?"]
    args: list = [*score_args, min_match]
    if countries:
        where.append("(" + " OR ".join("(',' || COALESCE(country, '') || ',') LIKE ?" for _ in countries) + ")")
        args += [f"%,{c},%" for c in countries]
    scope = " AND ".join(where)
    start = (now - timedelta(days=days - 1)).date()
    start_iso = start.isoformat()
    # One pass: every matching row that was open at any point in the
    # window, with the two dates, aggregated here. Three separate
    # GROUP BYs each scanned the table; this scans it once.
    from expensive import guard
    baseline, seen, closed = 0, {}, {}
    with guard("live_aggregate"):
        for first, last in conn.execute(
                f"SELECT date(first_seen), date(closed_at) FROM jobs WHERE {scope} "
                f"AND (closed_at IS NULL OR date(closed_at) >= ?)", [*args, start_iso]):
            if first is None:
                continue
            if first < start_iso:
                baseline += 1
            else:
                seen[first] = seen.get(first, 0) + 1
            if last is not None:
                closed[last] = closed.get(last, 0) + 1
    rows, open_n = [], baseline
    for i in range(days):
        day = (start + timedelta(days=i)).isoformat()
        open_n += seen.get(day, 0) - closed.get(day, 0)
        rows.append({"day": day, "open": max(0, open_n), "new": seen.get(day, 0)})
    out = {"skills": wanted, "min_match": min_match, "country": countries, "days": rows}
    if len(_HISTORY_CACHE) > 256:
        _HISTORY_CACHE.clear()
    _HISTORY_CACHE[key] = (now, out)
    return out


_SKILL_COUNTS_CACHE: dict = {}


def skill_counts(conn, params: dict) -> dict:
    """How many open roles ask for each of the skills named, in one pass:
    one SUM of a LIKE per skill over the rows the board's own filters
    (country, confidence) leave, rather than a count query per skill.
    The account page asks for a dozen at once; a scan each put the box
    on its knees (2026-10-01). Kept per worker for ten minutes."""
    from datetime import datetime, timezone

    from job_filters import build_jobs_where, has_fts_index, has_places, wanted_skills

    wanted = wanted_skills(params)
    if not wanted:
        raise ValueError("skills is required")
    scoped = {k: v for k, v in params.items() if k != "skills"}
    where_sql, args = build_jobs_where(scoped, has_fts_index(conn), has_places(conn))
    key = (tuple(wanted), where_sql, tuple(args))
    now = datetime.now(timezone.utc)
    hit = _SKILL_COUNTS_CACHE.get(key)
    if hit and (now - hit[0]).total_seconds() < _HISTORY_TTL_S:
        return hit[1]
    from expensive import guard
    sums = ", ".join("SUM((',' || COALESCE(skills, '') || ',') LIKE ?)" for _ in wanted)
    with guard("live_aggregate"):
        row = conn.execute(f"SELECT {sums} FROM jobs WHERE {where_sql}",
                           [*[f"%,{s},%" for s in wanted], *args]).fetchone()
    out = {"counts": {s: int(row[i] or 0) for i, s in enumerate(wanted)}}
    if len(_SKILL_COUNTS_CACHE) > 256:
        _SKILL_COUNTS_CACHE.clear()
    _SKILL_COUNTS_CACHE[key] = (now, out)
    return out


def _company_columns(conn) -> set[str]:
    return {r[1] for r in conn.execute("PRAGMA table_info(companies)")}


_DIRECTORY_CACHE: dict = {}
_DIRECTORY_TTL_S = 1800


def company_directory(conn, params: dict, limit: int = 500) -> dict:
    """The companies directory (/companies): who has open roles under the
    board's filters, busiest first, with how many of those roles were
    first seen in the past week. The same WHERE as /api/jobs minus the
    company filter, so the list answers the question the board's own
    filters ask; a country narrows it to the companies hiring there,
    and the counts are their roles there.

    Capped, and says so: the facets' company list is capped the same
    way, and a page of 20,000 rows is not a directory anyone reads.
    """
    from datetime import datetime, timedelta, timezone

    from job_filters import build_jobs_where, has_fts_index, has_places

    scoped = {k: v for k, v in params.items() if k != "company"}
    # Kept per worker for half an hour. The list for everywhere groups
    # every open row by company, a walk of the whole company index, 10s
    # idle and 100s under an apply (2026-10-02); the list barely moves
    # in that time and every visitor asks the same question first.
    ckey = (limit, tuple(sorted((k, v) for k, v in scoped.items() if v not in (None, ""))))
    now = datetime.now(timezone.utc)
    hit = _DIRECTORY_CACHE.get(ckey)
    if hit and (now - hit[0]).total_seconds() < _DIRECTORY_TTL_S:
        return hit[1]
    week_ago = (now - timedelta(days=7)).isoformat()
    from expensive import guard
    with guard("directory"), place_rows(conn, scoped):
        where_sql, args = build_jobs_where(scoped, has_fts_index(conn), has_places(conn))
        rows = [dict(r) for r in conn.execute(
            f"""
            SELECT company_domain AS domain, COUNT(*) AS n,
                   SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END) AS new_7d
            FROM jobs
            WHERE {where_sql} AND company_domain IS NOT NULL AND company_domain != ''
            GROUP BY company_domain
            ORDER BY n DESC, company_domain
            LIMIT ?
            """,
            [week_ago, *args, limit],
        )]
    cols = _company_columns(conn)
    if rows:
        pick = ", ".join(c for c in ("domain", "ats", "company_name", "logo_url") if c in cols)
        domains = [r["domain"] for r in rows]
        known = {c["domain"]: dict(c) for c in conn.execute(
            f"SELECT {pick} FROM companies WHERE domain IN ({','.join('?' * len(domains))})", domains)}
        trends = company_trends(conn, domains)
        for r in rows:
            c = known.get(r["domain"], {})
            r["name"] = c.get("company_name") or None
            r["ats"] = c.get("ats")
            r["has_logo"] = bool(c.get("logo_url"))
            r["trend"] = trends.get(r["domain"], [])
    out = {"companies": rows, "capped": len(rows) >= limit, "limit": limit}
    if len(_DIRECTORY_CACHE) > 64:
        _DIRECTORY_CACHE.clear()
    _DIRECTORY_CACHE[ckey] = (now, out)
    return out


def company_trends(conn, domains: list[str], days: int = 7) -> dict[str, list]:
    """Each company's open roles over the last `days` days, one number a
    day (None for a day with nothing), oldest first, today last, from
    company_daily. Worldwide, whatever the directory is filtered to: the
    table counts a company's roles, not a country's share of them. Empty
    before the table exists."""
    from datetime import datetime, timedelta, timezone

    if not domains or not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'company_daily'").fetchone():
        return {}
    today = datetime.now(timezone.utc).date()
    since = (today - timedelta(days=days - 1)).isoformat()
    out: dict[str, list] = {d: [None] * days for d in domains}
    for d, day, n in conn.execute(
            f"SELECT domain, day, open_n FROM company_daily WHERE day >= ? "
            f"AND domain IN ({','.join('?' * len(domains))})",
            [since, *domains]):
        age = (today - datetime.strptime(day, "%Y-%m-%d").date()).days
        if 0 <= age < days:
            out[d][days - 1 - age] = n
    return {d: v for d, v in out.items() if any(x is not None for x in v)}


def company_profile(conn, domain: str) -> dict | None:
    """One company for the directory's panel: what the companies table
    knows, its open roles worldwide and how many are a week old or
    less, and its daily history (company_daily, written once a day by
    the publish run) for the last twelve weeks. None for a domain the
    board has never seen.
    """
    from datetime import datetime, timedelta, timezone

    from job_filters import build_jobs_where, has_fts_index, has_places

    cols = _company_columns(conn)
    pick = ", ".join(c for c in ("domain", "ats", "company_name", "logo_url", "first_seen") if c in cols)
    row = conn.execute(f"SELECT {pick} FROM companies WHERE domain = ? COLLATE NOCASE", (domain,)).fetchone()
    if not row:
        return None
    company = dict(row)
    where_sql, args = build_jobs_where({"company": company["domain"]}, has_fts_index(conn), has_places(conn))
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    counts = conn.execute(
        f"""
        SELECT COUNT(*) AS open_n, SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END) AS new_7d
        FROM jobs WHERE {where_sql}
        """,
        [week_ago, *args],
    ).fetchone()
    history: list[dict] = []
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'company_daily'").fetchone():
        since = (datetime.now(timezone.utc) - timedelta(days=84)).date().isoformat()
        history = [dict(r) for r in conn.execute(
            "SELECT day, open_n, new_n FROM company_daily WHERE domain = ? AND day >= ? ORDER BY day",
            (company["domain"], since))]
    return {
        "domain": company["domain"],
        "name": company.get("company_name") or None,
        "ats": company.get("ats"),
        "has_logo": bool(company.get("logo_url")),
        "tracked_since": company.get("first_seen"),
        "open_jobs": counts["open_n"] or 0,
        "new_jobs_7d": counts["new_7d"] or 0,
        "history": history,
    }


def top_companies_with_logos(conn, limit: int = 30) -> list[dict]:
    """The companies on the landing page's logo row, hand-picked ones first.

    HOT_COMPANIES (hot_companies.py) is big tech and well-known startups,
    picked by hand because nothing in the data says which companies those
    are. The picked companies with open jobs come first, busiest first. One
    without a resolved logo gets its LOGO_PINS image or Google's favicon for
    its domain. If fewer than `limit` qualify, the busiest companies not
    already shown fill the rest, and those need a resolved logo of their
    own: a row of monograms says nothing about who is hiring. Two domains
    that resolved to the same image show once.

    Counts every company's open jobs rather than a top slice, because a
    picked company can be far down the list. Once per precompute, over a
    few thousand groups.
    """
    ranked = [dict(r) for r in conn.execute(
        f"""
        SELECT company_domain AS domain, COUNT(*) AS n
        FROM jobs
        WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE}
        GROUP BY company_domain
        ORDER BY n DESC
        """
    )]
    hot = [r for r in ranked if r["domain"] in HOT_COMPANIES]
    rest = [r for r in ranked if r["domain"] not in HOT_COMPANIES][:limit * 6]
    candidates = _with_logos(conn, hot + rest)
    names: dict[str, str] = {}
    if candidates and any(c[1] == "company_name" for c in conn.execute("PRAGMA table_info(companies)")):
        domains = [r["domain"] for r in candidates]
        names = {d: n for d, n in conn.execute(
            f"SELECT domain, company_name FROM companies WHERE domain IN ({','.join('?' * len(domains))})",
            domains) if n}
    out, seen = [], set()
    for r in candidates:
        domain = r["domain"]
        url = LOGO_PINS.get(domain) or r.get("logo_url")
        if not url and domain in HOT_COMPANIES:
            url = GOOGLE_FAVICON.format(domain=domain)
        if not url or url in seen:
            continue
        seen.add(url)
        out.append({"domain": domain, "name": names.get(domain), "n": r["n"], "logo_url": url})
        if len(out) == limit:
            break
    return out


@contextlib.contextmanager
def place_rows(conn, params: dict):
    """For the length of the block, the open jobs in the request's
    countries and cities sit in a temp table and build_jobs_where reads
    it instead of repeating the LIKE scans (see job_filters.place_rowset).
    One scan of the open jobs up front, rather than one per count."""
    import uuid
    from job_filters import city_clauses, place_rowset, wanted_city_pairs, wanted_country_codes

    places = has_places(conn)
    countries = wanted_country_codes(params) if places else []
    cities = wanted_city_pairs(params) if places else []
    # With city in the board indexes the place test is answered from the
    # index on every path, and the rowset would only add a scan.
    if not (countries or cities) or bool_param(params, "include_closed") or has_fts_index(conn).place_index:
        yield
        return
    where, args = ["closed_at IS NULL"], []
    if countries:
        where.append("(" + " OR ".join("(',' || COALESCE(country, '') || ',') LIKE ?" for _ in countries) + ")")
        args += [f"%,{c},%" for c in countries]
    if cities:
        clauses, city_args = city_clauses(cities)
        where.append(f"({clauses})")
        args += city_args
    name = "place_rows_" + uuid.uuid4().hex[:12]
    conn.execute(f"CREATE TEMP TABLE {name} AS SELECT rowid AS rid FROM jobs WHERE {' AND '.join(where)}", args)
    token = place_rowset.set((name, (tuple(countries), tuple(cities))))
    try:
        yield
    finally:
        place_rowset.reset(token)
        conn.execute(f"DROP TABLE IF EXISTS temp.{name}")


@contextlib.contextmanager
def search_rows(conn, params: dict):
    """For the length of the block, the rows the request's search matches
    sit in a temp table and build_jobs_where reads it instead of running
    the MATCH again (see job_filters.search_rowset). One read of the index
    up front, rather than one per count."""
    import uuid
    import search_compile
    from job_filters import search_query, search_rowset

    q = search_query(params) if params.get("search") else None
    expr = search_compile.match_expression(q) if q and not q.empty and has_fts_index(conn).fts_full else None
    if not expr:
        yield
        return
    name = "search_rows_" + uuid.uuid4().hex[:12]
    # One CREATE ... AS SELECT, as place_rows and the skill table do, and
    # never CREATE then INSERT. Python's sqlite3 opens a transaction before
    # an INSERT and leaves it open, and on these long-lived per-thread
    # connections an open transaction pins the snapshot it started on: the
    # thread stops seeing new listings for good. 2026-10-05 05:36 to 08:30
    # UTC, every worker that had served a searched facet answered from the
    # data as it was then, and jobs the alert email had just sent 404'd.
    conn.execute(f"CREATE TEMP TABLE {name} AS SELECT rowid AS rid FROM jobs_fts WHERE jobs_fts MATCH ?", [expr])
    token = search_rowset.set((name, expr))
    try:
        yield
    finally:
        search_rowset.reset(token)
        conn.execute(f"DROP TABLE IF EXISTS temp.{name}")
        if conn.in_transaction:
            conn.commit()


def compute_facets(conn, params: dict, locations: list | None = None) -> dict:
    with search_rows(conn, params):
        return _compute_facets_searched(conn, params, locations)


def _compute_facets_searched(conn, params: dict, locations: list | None = None) -> dict:
    """The rail's counts. With skills in the request, the open jobs that
    match them are found once into a temp table and every count reads it
    (see job_filters.skill_rowset), instead of each of the rail's passes
    running every skill test over every row again."""
    import uuid
    from job_filters import skill_key, skill_rowset, wanted_skills

    wanted = wanted_skills(params)
    if not wanted or bool_param(params, "include_closed"):
        with place_rows(conn, params):
            return _compute_facets(conn, params, locations)
    name = "skill_rows_" + uuid.uuid4().hex[:12]
    conn.execute(f"CREATE TEMP TABLE {name} AS SELECT rowid AS rid FROM jobs "
                 f"WHERE closed_at IS NULL AND skill_hits(skills, ?) > 0", [skill_key(wanted)])
    token = skill_rowset.set(name)
    try:
        with place_rows(conn, params):
            return _compute_facets(conn, params, locations)
    finally:
        skill_rowset.reset(token)
        conn.execute(f"DROP TABLE IF EXISTS temp.{name}")


def _compute_facets(conn, params: dict, locations: list | None = None) -> dict:

    def counts_by(column_expr: str, exclude_param: str, limit: int) -> list[dict]:
        scoped = dict(params)
        scoped.pop(exclude_param, None)
        where_sql, args = build_jobs_where(scoped, has_fts_index(conn), has_places(conn))
        rows = conn.execute(
            f"""
            SELECT {column_expr} AS value, COUNT(*) AS n
            FROM jobs
            WHERE {where_sql} AND {column_expr} IS NOT NULL AND TRIM({column_expr}) != ''
            GROUP BY {column_expr}
            ORDER BY n DESC, value
            LIMIT ?
            """,
            [*args, limit],
        ).fetchall()
        return [dict(r) for r in rows]

    # Both place facets drop both place params, not just their own.
    #
    # counts_by's rule is that a facet is computed with every OTHER
    # filter applied, so ticking one of its own values never empties its
    # own list. Country and city are one control here, so the rule
    # applies to the pair. Scoping cities by the country already chosen
    # would be defensible, but scoping countries by the city already
    # chosen leaves exactly one country standing and no way back to the
    # rest.
    def _place_scope():
        scoped = dict(params)
        scoped.pop("country", None)
        scoped.pop("city", None)
        return build_jobs_where(scoped, has_fts_index(conn), has_places(conn))

    def country_counts(limit: int = 60) -> list[dict]:
        """One row per country, not per country LIST.

        country is comma-joined, so a plain GROUP BY would file
        "CA,IL,GB" as its own facet value and offer the reader a
        three-country checkbox that matches nothing else. The CTE splits
        it, which also means a job listing four offices in one country
        counts once rather than four times, since countries_of already
        deduplicated it before it was stored.
        """
        where_sql, args = _place_scope()
        rows = conn.execute(
            f"""
            WITH RECURSIVE split(code, rest) AS (
                SELECT '', country || ','
                FROM jobs
                WHERE {where_sql} AND country IS NOT NULL AND country != ''
                UNION ALL
                SELECT SUBSTR(rest, 1, INSTR(rest, ',') - 1),
                       SUBSTR(rest, INSTR(rest, ',') + 1)
                FROM split
                WHERE rest != ''
            )
            SELECT code AS value, COUNT(*) AS n
            FROM split
            WHERE code != ''
            GROUP BY code
            ORDER BY n DESC
            LIMIT ?
            """,
            [*args, limit],
        ).fetchall()
        return [{"value": r["value"], "label": label_for(r["value"]), "n": r["n"]}
                for r in rows]

    def city_counts_by_country() -> dict[str, list[dict]]:
        """City counts, counted per country rather than board-wide.

        A city on its own is not a facet a reader can use. There is a
        Cambridge in England and one in Massachusetts and the board
        carries both, so the pair is the answer. Both columns are split
        by the same kind of CTE the country facet uses, then joined back
        on the row they came from.

        That join is a cross product within one row, which is the
        definition being applied: a city belongs under a country when
        some job names both. A posting reading "Tel Aviv, Israel; New
        York, US" therefore files Tel Aviv under US too. That is wrong,
        and it is the price of a location column that never said which
        city went with which country. Jobs naming a single country,
        which is nearly all of them, come out exact.
        """
        where_sql, args = _place_scope()
        rows = conn.execute(
            f"""
            WITH RECURSIVE
            csplit(job, code, rest) AS (
                SELECT rowid, '', country || ','
                FROM jobs
                WHERE {where_sql} AND country IS NOT NULL AND country != ''
                  AND city IS NOT NULL AND city != ''
                UNION ALL
                SELECT job, SUBSTR(rest, 1, INSTR(rest, ',') - 1),
                       SUBSTR(rest, INSTR(rest, ',') + 1)
                FROM csplit
                WHERE rest != ''
            ),
            tsplit(job, name, rest) AS (
                SELECT rowid, '', city || ','
                FROM jobs
                WHERE {where_sql} AND country IS NOT NULL AND country != ''
                  AND city IS NOT NULL AND city != ''
                UNION ALL
                SELECT job, SUBSTR(rest, 1, INSTR(rest, ',') - 1),
                       SUBSTR(rest, INSTR(rest, ',') + 1)
                FROM tsplit
                WHERE rest != ''
            )
            SELECT csplit.code AS code, tsplit.name AS name, COUNT(*) AS n
            FROM csplit
            JOIN tsplit ON tsplit.job = csplit.job
            WHERE csplit.code != '' AND tsplit.name != ''
            GROUP BY csplit.code, tsplit.name
            ORDER BY n DESC, tsplit.name
            """,
            # The scope clause is written twice, so its arguments go in
            # twice as well.
            [*args, *args],
        ).fetchall()
        out: dict[str, list[dict]] = {}
        for r in rows:
            out.setdefault(r["code"], []).append({"value": r["name"], "n": r["n"]})
        return out

    def location_tree(country_limit: int = 40) -> list[dict]:
        """One entry per country, its cities nested underneath.

        Empty while the snapshot in hand predates the columns (see
        has_places). An empty filter list is a dropdown with nothing in
        it for one merge cycle; querying the columns anyway would 500
        every /api/facets call for that same cycle, which takes the
        category and company filters down with it.

        This replaces a flat facet over the raw location column, which
        offered "Tel Aviv", "Tel Aviv-Yafo, Tel Aviv, ISR" and
        "tel-aviv" as three separate choices for one place, and named no
        country anywhere. Both levels are deduplicated per job before
        they are stored, so a company listing four Tel Aviv offices on
        one posting counts once.

        The SQL orders both levels by n descending. Each country keeps
        its biggest CITY_TOP cities whatever their size, so a small
        country still has a list, then every further city with at least
        CITY_MIN_LISTINGS, up to CITY_LIMIT. It used to stop at 25, which
        cut Israel off at Caesarea (48 listings) and left Modi'in (21)
        unreachable even by typing it into the dropdown's search, which
        only filters what was sent. The query counts every city either
        way; the slice only decides what goes over the wire.
        """
        if not has_places(conn):
            return []
        cities = city_counts_by_country()

        def kept(rows):
            return [r for i, r in enumerate(rows[:CITY_LIMIT]) if i < CITY_TOP or r["n"] >= CITY_MIN_LISTINGS]

        return [
            {**c, "cities": kept(cities.get(c["value"], []))}
            for c in country_counts(country_limit)
        ]

    # The company list ignores the company filter, so for a given set of
    # other filters it is one answer; grouping every open row by company
    # is a walk of the whole company index (10s idle, up to 100s under an
    # apply), so that answer is kept per worker for half an hour, the
    # way the directory's is.
    from datetime import datetime, timezone
    cscoped = {k: v for k, v in params.items() if k != "company" and v not in (None, "")}
    ckey = ("facet-companies", tuple(sorted(cscoped.items())))
    cnow = datetime.now(timezone.utc)
    chit = _DIRECTORY_CACHE.get(ckey)
    if chit and (cnow - chit[0]).total_seconds() < _DIRECTORY_TTL_S:
        companies = chit[1]
    else:
        companies = counts_by("company_domain", "company", 500)
        if len(_DIRECTORY_CACHE) > 64:
            _DIRECTORY_CACHE.clear()
        _DIRECTORY_CACHE[ckey] = (cnow, companies)
    # The name beside the count, so the rail and the overview's Hiring
    # most can say "NVIDIA" rather than "nvidia.com". One IN query over
    # the same companies table the rows read from; guarded on the column
    # the way every other reader here is, since a snapshot can predate it.
    if companies and any(c[1] == "company_name" for c in conn.execute("PRAGMA table_info(companies)")):
        domains = [c["value"] for c in companies]
        names = {d: n for d, n in conn.execute(
            f"SELECT domain, company_name FROM companies WHERE domain IN ({','.join('?' * len(domains))})",
            domains) if n}
        for c in companies:
            c["name"] = names.get(c["value"])

    out = {
        "categories": counts_by(category_sql(conn), "department", 20),
        # Handed in when the caller already has it: the tree drops the
        # place filters, so every city picked under the same other
        # filters has the same one (see handler.route_facets).
        "locations": location_tree() if locations is None else locations,
        "companies": companies,
    }
    salary = salary_bounds(conn, params)
    if salary:
        out["salary"] = salary
    disclosed = disclosed_count(conn, params)
    if disclosed:
        out["salary_disclosed"] = disclosed
    return out


def disclosed_count(conn, params: dict) -> int:
    """How many listings in the result set carry the employer's own pay
    figure, for the rail's "Only with a disclosed salary" option. Through
    idx_jobs_salary_disclosed, or not at all where that index is absent,
    for the same reason as salary_bounds."""
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'index' "
                    "AND name = 'idx_jobs_salary_disclosed'").fetchone() is None:
        return 0
    scoped = {k: v for k, v in params.items() if k != "salary_disclosed"}
    where_sql, args = build_jobs_where(scoped, has_fts_index(conn), has_places(conn))
    return conn.execute(
        f"SELECT COUNT(*) FROM jobs INDEXED BY idx_jobs_salary_disclosed "
        f"WHERE salary_source = 'disclosed' AND {where_sql}", args).fetchone()[0]


def salary_bounds(conn, params: dict) -> dict:
    """The shekel range the current result set occupies, for the board's
    salary track: its ends, how many listings have a figure, and the
    median of their midpoints.

    Measured rather than fixed, and with the salary filter itself
    dropped, so dragging a handle cannot walk the track out from under
    the hand holding it. Every query carries salary_min_ils IS NOT NULL,
    which is the partial index idx_jobs_salary_ils's own condition: the
    walk is the few thousand rows with a figure, not the table. An empty
    dict when the result set has none, so the board leaves the control
    out instead of drawing one that cannot move.
    """
    if not has_fts_index(conn).salary_ils:
        return {}
    scoped = {k: v for k, v in params.items() if k not in ("salary_min", "salary_max", "salary_known")}
    where_sql, args = build_jobs_where(scoped, has_fts_index(conn), has_places(conn))
    mids = [r[0] for r in conn.execute(
        f"SELECT (salary_min_ils + salary_max_ils) / 2.0 AS mid, salary_min_ils, salary_max_ils "
        f"FROM jobs INDEXED BY idx_jobs_salary_ils "
        f"WHERE salary_min_ils IS NOT NULL AND {where_sql} ORDER BY mid",
        args,
    ).fetchall()] if _has_salary_index(conn) else []
    if not mids:
        return {}
    lo, hi = conn.execute(
        f"SELECT MIN(salary_min_ils), MAX(salary_max_ils) FROM jobs INDEXED BY idx_jobs_salary_ils "
        f"WHERE salary_min_ils IS NOT NULL AND {where_sql}", args).fetchone()
    half = len(mids) // 2
    median = mids[half] if len(mids) % 2 else (mids[half - 1] + mids[half]) / 2
    return {"min": int(lo), "max": int(hi), "known": len(mids), "median": int(round(median))}


def _has_salary_index(conn) -> bool:
    # Only the box builds it (loader BOX_INDEXES). Without it the query
    # would be a table scan per facet request, which is what took the
    # board down once already, so no index means no salary facet.
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_salary_ils'").fetchone() is not None


COMPANY_SEARCH_LIMIT = 50


def search_companies(conn, params: dict) -> dict:
    """Companies whose domain or name contains `name`, with open-listing
    counts under every other active filter.

    The Companies dropdown lists the 500 biggest employers and its search
    box only filtered those, so any company past that line could not be
    found at all: typing "micr" said No matches while Microsoft had 18
    Israeli listings. Reported live. This asks the snapshot instead.

    Counted the way the facet is, with the company filter itself dropped,
    so a company already ticked does not narrow its own search. Two
    characters at least: one matches half the board and tells nobody
    anything.
    """
    name = str(params.get("name") or "").strip().lower()[:60]
    if len(name) < 2:
        return {"companies": []}
    scoped = dict(params)
    scoped.pop("company", None)
    scoped.pop("name", None)
    where_sql, args = build_jobs_where(scoped, has_fts_index(conn), has_places(conn))
    needle = "%" + name.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    try:
        has_name = any(r[1] == "company_name" for r in conn.execute("PRAGMA table_info(companies)"))
    except Exception:
        has_name = False
    name_clause = (" OR company_domain IN (SELECT domain FROM companies"
                   " WHERE LOWER(company_name) LIKE ? ESCAPE '\\')") if has_name else ""
    # The resolved name beside the count, so the rail's search results
    # read the same way its facet rows do. NULL when the snapshot has no
    # column for it, which is the same guard the LIKE clause takes.
    name_select = ("(SELECT company_name FROM companies WHERE domain = jobs.company_domain) AS name"
                   if has_name else "NULL AS name")
    rows = conn.execute(
        f"""
        SELECT company_domain AS value, COUNT(*) AS n, {name_select}
        FROM jobs
        WHERE {where_sql}
          AND (LOWER(company_domain) LIKE ? ESCAPE '\\'{name_clause})
        GROUP BY company_domain
        ORDER BY n DESC, company_domain
        LIMIT ?
        """,
        [*args, needle, *([needle] if has_name else []), COMPANY_SEARCH_LIMIT],
    ).fetchall()
    return {"companies": [dict(r) for r in rows]}


# The filters a precomputed scoped block can stand for: the board's
# common first clicks. Anything else narrowing the view is computed live.
SCOPED_VARIANT_KEYS = ("roles", "country", "department")


def scoped_variant_key(params: dict) -> str | None:
    """The artifact key for a request precompute.py covers, else None.

    Only when confidence is "all" (the board's own), every other set
    parameter is one of SCOPED_VARIANT_KEYS, and each holds one value.
    """
    if (params.get("confidence") or "verified") != "all":
        return None
    set_ = {k: str(v).strip() for k, v in params.items()
            if k != "confidence" and v not in (None, "", False, "0")}
    if not set_ or any(k not in SCOPED_VARIANT_KEYS for k in set_) or any("," in v for v in set_.values()):
        return None
    if "country" in set_:
        set_["country"] = set_["country"].upper()
    return "&".join(f"{k}={set_[k]}" for k in sorted(set_))


def has_board_filters(params: dict) -> bool:
    """Whether this request narrows the board at all.

    Decided from the WHERE the params produce, not from a list of
    parameter names, so a filter added to build_jobs_where later cannot
    quietly read as unfiltered here and get handed a global answer.
    handler.py's _unfiltered_confidence asks the same question for
    /api/facets and now calls this rather than keeping a second copy of
    the comparison that could drift from it.

    confidence is held constant on both sides, and that is the whole
    subtlety. The board sends a confidence on every single request: it
    defaults to "all" where the API defaults to "verified". Counting it
    as a filter would make every request read as filtered, so the
    precomputed artifact would never be used again and the scoped block
    would run on the plain page load it exists to stay out of. A request
    carrying nothing but confidence is therefore the unfiltered case.

    The FTS flag is constant on both sides too, for the same reason it
    is in _unfiltered_confidence: it only changes the keywords branch,
    and a request with keywords is filtered either way.

    A value build_jobs_where cannot use (a country code outside ALPHA2,
    a malformed job id) adds no clause, so it reads as unfiltered here
    as well. That is the same degrading every other caller of that
    function gets, and it is the right answer: the board itself was not
    narrowed either, so a global number is what matches what the reader
    is looking at.
    """
    # roles is held constant as well, and for the same reason: the board
    # sends roles=tech on every plain page load since 2026-09-21. The
    # precomputed artifacts carry a tech variant (loader/precompute.py),
    # so a request narrowed by nothing but roles has a ready answer.
    probe = {**params, "confidence": "verified"}
    probe.pop("roles", None)
    return build_jobs_where(probe, True) != build_jobs_where({"confidence": "verified"}, True)


# The location filter's cities per country: the biggest CITY_TOP always,
# then any with at least CITY_MIN_LISTINGS open listings, CITY_LIMIT at
# most (see location_tree).
CITY_TOP = 25
CITY_MIN_LISTINGS = 3
CITY_LIMIT = 150

# Matches the global top_companies' own LIMIT 10, so the frontend can
# swap one list for the other without re-cutting it.
SCOPED_TOP_COMPANIES = 10


def compute_scoped_stats(conn, params: dict) -> dict:
    with place_rows(conn, params), search_rows(conn, params):
        return _compute_scoped_stats(conn, params)


def _compute_scoped_stats(conn, params: dict) -> dict:
    """The few stats numbers that are properties of a result set rather
    than of the market, counted over the caller's own filters.

    Three queries, and that budget is the design rather than an
    accident. compute_stats runs twenty, most of them in the 14-day
    series and the day-by-day open-jobs reconstruction, and /api/facets
    already measures 0.30s served from the precomputed artifact against
    2.88s computed live off three. Scoping all twenty would put a
    multi-second request behind every filter change, so everything that
    only describes the whole market stays global and what is left is
    read in one grouped pass, one age pass and one throughput pass.
    Conditional SUM inside a pass, never a query per number.

    The scope is build_jobs_where's, unmodified, which is what makes
    open_jobs the same number /api/jobs reports as `total` for the same
    query string. Two figures on one screen disagreeing is worse than
    either being missing.
    """
    # Probed once and reused by both build_jobs_where calls below. Each
    # probe is its own read (sqlite_master, then PRAGMA table_info), and
    # calling them per clause the way compute_facets does would triple
    # that for no new information.
    fts, places = has_fts_index(conn), has_places(conn)
    where_sql, args = build_jobs_where(params, fts, places)

    # One grouped pass answers three fields. Summing the groups gives
    # the row count, counting the groups gives the companies, and the
    # first ten rows are the list. A separate COUNT and COUNT(DISTINCT)
    # would be two more scans for numbers already sitting here.
    per_company = conn.execute(
        f"""
        SELECT company_domain AS domain, COUNT(*) AS n
        FROM jobs
        WHERE {where_sql}
        GROUP BY company_domain
        ORDER BY n DESC, domain
        """,
        args,
    ).fetchall()
    open_jobs = sum(r["n"] for r in per_company)
    # A NULL domain is a group here but not a company, and the global
    # COUNT(DISTINCT company_domain) does not count it either.
    companies_hiring = sum(1 for r in per_company if r["domain"] is not None)
    top_companies = _with_logos(conn, [{"domain": r["domain"], "n": r["n"]}
                                       for r in per_company[:SCOPED_TOP_COMPANIES]])

    # A row per job, same as the global age block: SQLite has no median,
    # and the sort runs over the filtered set, which is smaller than the
    # board by definition. A NULL posted_at is left out rather than read
    # as age zero, matching that query.
    ages = sorted(
        r["d"] for r in conn.execute(
            f"""
            SELECT julianday('now') - julianday(posted_at) AS d
            FROM jobs
            WHERE {where_sql} AND posted_at IS NOT NULL
            """,
            args,
        ).fetchall()
    )
    n = len(ages)
    median_days = None
    if n:
        mid = n // 2
        median_days = ages[mid] if n % 2 else (ages[mid - 1] + ages[mid]) / 2

    # Throughput is the one part that cannot run on the board's own
    # WHERE. It counts closings, the board hides closed rows by default,
    # so closed_jobs_* under the unmodified scope would be zero for
    # every caller. These two params lift exactly the two clauses the
    # global throughput query leaves out (it reads confidence and
    # nothing else), and every filter the caller did set still applies.
    flow_sql, flow_args = build_jobs_where(
        {**params, "include_closed": "1", "include_outdated": "1"}, fts, places)
    flow = conn.execute(
        f"""
        SELECT
          SUM(CASE WHEN julianday('now') - julianday(first_seen) <= 1 THEN 1 ELSE 0 END) AS added_24h,
          SUM(CASE WHEN julianday('now') - julianday(first_seen) <= 7 THEN 1 ELSE 0 END) AS added_7d,
          SUM(CASE WHEN closed_at IS NOT NULL
                    AND julianday('now') - julianday(closed_at) <= 1 THEN 1 ELSE 0 END) AS closed_24h,
          SUM(CASE WHEN julianday('now') - julianday(first_seen) > 1
                    AND julianday('now') - julianday(first_seen) <= 2 THEN 1 ELSE 0 END) AS added_prev_24h,
          SUM(CASE WHEN julianday('now') - julianday(first_seen) > 7
                    AND julianday('now') - julianday(first_seen) <= 14 THEN 1 ELSE 0 END) AS added_prev_7d,
          SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open_now,
          SUM(CASE WHEN julianday('now') - julianday(first_seen) > 7
                    AND (closed_at IS NULL OR julianday('now') - julianday(closed_at) < 7) THEN 1 ELSE 0 END) AS open_7d_ago,
          COUNT(DISTINCT CASE WHEN closed_at IS NULL THEN company_domain END) AS companies_now,
          COUNT(DISTINCT CASE WHEN julianday('now') - julianday(first_seen) > 7
                    AND (closed_at IS NULL OR julianday('now') - julianday(closed_at) < 7)
                    THEN company_domain END) AS companies_7d_ago,
          SUM(CASE WHEN closed_at IS NOT NULL
                    AND julianday('now') - julianday(closed_at) <= 7 THEN 1 ELSE 0 END) AS closed_7d
        FROM jobs
        WHERE {flow_sql}
        """,
        flow_args,
    ).fetchone()

    return {
        "open_jobs": open_jobs,
        "companies_hiring": companies_hiring,
        "new_jobs_24h": flow["added_24h"] or 0,
        "new_jobs_7d": flow["added_7d"] or 0,
        "closed_jobs_24h": flow["closed_24h"] or 0,
        "closed_jobs_7d": flow["closed_7d"] or 0,
        # Last period, for the overview's arrows. See the query.
        "prev_new_jobs_24h": flow["added_prev_24h"] or 0,
        "prev_new_jobs_7d": flow["added_prev_7d"] or 0,
        "open_now_basis": flow["open_now"] or 0,
        "open_jobs_7d_ago": flow["open_7d_ago"] or 0,
        "companies_now_basis": flow["companies_now"] or 0,
        "companies_7d_ago": flow["companies_7d_ago"] or 0,
        "median_open_days": round(median_days, 1) if median_days is not None else None,
        "oldest_open_days": round(ages[-1], 1) if n else None,
        "top_companies": top_companies,
    }


def compute_stats(conn, params: dict | None = None) -> dict:
    """Everything the homepage dashboard needs, as a handful of cheap SQL
    aggregates. All "since" comparisons use julianday() diffs rather than
    string comparison, since ISO8601-with-offset and datetime('now')'s
    format don't sort reliably against each other at day boundaries.

    params reads israel_only, which scopes top_locations to IL-tagged
    postings for the frontend's Location filter. Every other field here
    stays global and independent of the job board's own local filters.

    The exception is the "scoped" key, added only when the request
    carries a real filter. It answers "what does the market look like
    for the filters I have on right now" for the handful of numbers
    where that question means something, and it costs three queries
    against this function's twenty. See compute_scoped_stats for what
    is in it and why the rest is not.
    """
    params = params or {}
    meta = {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM meta")}

    by_ats = conn.execute(
        f"""
        SELECT ats, COUNT(*) AS n FROM jobs
        WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE}
        GROUP BY ats ORDER BY n DESC
        """
    ).fetchall()

    # companies_total/resolved describe scraper coverage, kept in the
    # response for API polling, not surfaced as a homepage metric.
    companies_total = int(meta.get("companies_total", 0))
    companies_resolved = int(meta.get("companies_resolved", 0))
    # The loader's raw all-time count (ghost listings included), kept as
    # open_jobs_all_time for transparency, but the headline number below
    # must respect the same archive cutoff as the board itself.
    open_jobs_all_time = int(meta.get("open_jobs_verified", 0))
    open_jobs_fresh, companies_hiring = conn.execute(
        f"""
        SELECT COUNT(*), COUNT(DISTINCT company_domain)
        FROM jobs WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE}
        """
    ).fetchone()

    last_checked = conn.execute("SELECT MAX(last_checked) AS latest FROM companies").fetchone()["latest"]
    minutes_since_update = None
    if last_checked is not None:
        mins = conn.execute(
            "SELECT (julianday('now') - julianday(?)) * 1440.0 AS mins", (last_checked,)
        ).fetchone()["mins"]
        if mins is not None:
            minutes_since_update = round(mins, 1)

    throughput = conn.execute(
        """
        SELECT
          SUM(CASE WHEN julianday('now') - julianday(first_seen) <= 1 THEN 1 ELSE 0 END) AS added_24h,
          SUM(CASE WHEN julianday('now') - julianday(first_seen) <= 7 THEN 1 ELSE 0 END) AS added_7d,
          SUM(CASE WHEN closed_at IS NOT NULL
                    AND julianday('now') - julianday(closed_at) <= 1 THEN 1 ELSE 0 END) AS closed_24h,
          SUM(CASE WHEN julianday('now') - julianday(first_seen) > 1
                    AND julianday('now') - julianday(first_seen) <= 2 THEN 1 ELSE 0 END) AS added_prev_24h,
          SUM(CASE WHEN julianday('now') - julianday(first_seen) > 7
                    AND julianday('now') - julianday(first_seen) <= 14 THEN 1 ELSE 0 END) AS added_prev_7d,
          SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open_now,
          SUM(CASE WHEN julianday('now') - julianday(first_seen) > 7
                    AND (closed_at IS NULL OR julianday('now') - julianday(closed_at) < 7) THEN 1 ELSE 0 END) AS open_7d_ago,
          COUNT(DISTINCT CASE WHEN closed_at IS NULL THEN company_domain END) AS companies_now,
          COUNT(DISTINCT CASE WHEN julianday('now') - julianday(first_seen) > 7
                    AND (closed_at IS NULL OR julianday('now') - julianday(closed_at) < 7)
                    THEN company_domain END) AS companies_7d_ago,
          SUM(CASE WHEN closed_at IS NOT NULL
                    AND julianday('now') - julianday(closed_at) <= 7 THEN 1 ELSE 0 END) AS closed_7d
        FROM jobs
        WHERE confidence = 'verified'
        """
    ).fetchone()

    # Verified only: best_effort postings don't carry a trustworthy posted_at.
    ages = sorted(
        r["d"] for r in conn.execute(
            f"""
            SELECT julianday('now') - julianday(posted_at) AS d
            FROM jobs
            WHERE closed_at IS NULL AND confidence = 'verified' AND posted_at IS NOT NULL AND {FRESH_CLAUSE}
            """
        ).fetchall()
    )
    n = len(ages)
    median_days = None
    if n:
        mid = n // 2
        median_days = ages[mid] if n % 2 else (ages[mid - 1] + ages[mid]) / 2

    # "Who's hiring" is the front-page question, not which ATS vendor a
    # listing came from (that's plumbing, not a market signal).
    top_companies = conn.execute(
        f"""
        SELECT company_domain AS domain, COUNT(*) AS n
        FROM jobs
        WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE}
        GROUP BY company_domain
        ORDER BY n DESC
        LIMIT 10
        """
    ).fetchall()

    # Shown to users as "Category". Used to be a GROUP BY on the raw
    # department column -- one company's "R&D" is another's
    # "Engineering", so that was really just "the top 20 raw strings by
    # count," not a real taxonomy. category_of() (job_filters.py,
    # registered on this connection by db.py) normalizes department+title
    # into a small fixed set instead (Security, Infrastructure, Software
    # Engineering, ...), same function build_jobs_where's "department"
    # filter now matches against, so what a user picks here is exactly
    # what they filter by. LIMIT 20 is moot now (<=len(CATEGORIES)
    # possible rows) but harmless to leave as a cap.
    # Grouped by category AND seniority in one pass, with the plain
    # category list derived from it below. category_of() is a Python
    # function called per row, and it is most of what makes this
    # function slow, so the cross-tab must not cost a second pass.
    category = category_sql(conn)
    category_seniority_rows = conn.execute(
        f"""
        SELECT {category} AS category, seniority, COUNT(*) AS n
        FROM jobs
        WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE}
          AND {category} IS NOT NULL
        GROUP BY {category}, seniority
        """
    ).fetchall()
    by_category: dict = {}
    for r in category_seniority_rows:
        by_category[r["category"]] = by_category.get(r["category"], 0) + r["n"]
    top_departments = [
        {"department": c, "n": n}
        for c, n in sorted(by_category.items(), key=lambda kv: -kv[1])[:20]
    ]
    # NULL seniority is most rows and is a real answer ("unstated"),
    # kept rather than dropped so the heatmap's row totals reconcile
    # with the category list.
    category_seniority = [
        {"category": r["category"], "seniority": r["seniority"] or "unstated", "n": r["n"]}
        for r in category_seniority_rows
    ]

    # The stats page's own panels. Three group-bys the homepage never
    # renders, over columns nothing else surfaces.
    #
    # workplace_type: remote/hybrid/onsite. Roughly half of listings say
    # nothing, and that half is reported as its own row rather than
    # hidden, because "most employers do not say" is the finding.
    workplace = conn.execute(
        f"""
        SELECT COALESCE(workplace_type, 'unstated') AS workplace, COUNT(*) AS n
        FROM jobs
        WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE}
        GROUP BY workplace_type
        ORDER BY n DESC
        """
    ).fetchall()

    # skills is comma-joined text, up to five terms per listing, on about
    # a third of rows. Split in Python: SQLite has no split, and pulling
    # 111k short strings is well under a second.
    skill_counts: dict = {}
    skilled = 0
    for (raw,) in conn.execute(
        f"""
        SELECT skills FROM jobs
        WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE}
          AND skills IS NOT NULL AND skills != ''
        """
    ):
        skilled += 1
        for term in raw.split(","):
            term = term.strip().lower()
            if term:
                skill_counts[term] = skill_counts.get(term, 0) + 1
    top_skills = [
        {"skill": k, "n": v}
        for k, v in sorted(skill_counts.items(), key=lambda kv: -kv[1])[:30]
    ]

    # `location` is raw ATS text, not a normalized place. "Austin" and
    # "Austin, TX" are different rows here, not merged. A top-N of literal
    # strings, not a geocoded facet. The Israel match comes from
    # israel_clause rather than being spelled out again here, so this and
    # route_jobs' israel_only stay one heuristic instead of two that drift.
    il_clause, il_args = israel_clause(has_places(conn))

    top_locations = conn.execute(
        f"""
        SELECT location, COUNT(*) AS n
        FROM jobs
        WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE}
          AND location IS NOT NULL AND TRIM(location) != ''
          {f"AND ({il_clause})" if bool_param(params, "israel_only") else ""}
        GROUP BY location
        ORDER BY n DESC
        LIMIT 40
        """,
        il_args if bool_param(params, "israel_only") else [],
    ).fetchall()

    location_row = conn.execute(
        f"""
        SELECT
          SUM(CASE WHEN {il_clause} THEN 1 ELSE 0 END) AS israel,
          COUNT(*) AS total
        FROM jobs
        WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE}
        """,
        il_args,
    ).fetchone()
    israel_count = location_row["israel"] or 0
    location_total = location_row["total"] or 0

    # Hiring velocity: who's added the most open reqs in the last week.
    # Different question from top_companies (total open headcount).
    # This surfaces a company ramping up right now even if its absolute
    # req count is still small.
    top_movers = conn.execute(
        f"""
        SELECT company_domain AS domain, COUNT(*) AS n
        FROM jobs
        WHERE confidence = 'verified' AND julianday('now') - julianday(first_seen) <= 7 AND {FRESH_CLAUSE}
        GROUP BY company_domain
        ORDER BY n DESC
        LIMIT 5
        """
    ).fetchall()

    # Excludes NULL. Most postings state no level, and an "unspecified"
    # bar would bury the real signal. The frontend derives that percentage
    # itself from totals.open_jobs minus this list's sum.
    seniority_breakdown = conn.execute(
        f"""
        SELECT seniority, COUNT(*) AS n
        FROM jobs
        WHERE closed_at IS NULL AND confidence = 'verified' AND {FRESH_CLAUSE} AND seniority IS NOT NULL
        GROUP BY seniority
        ORDER BY n DESC
        """
    ).fetchall()

    # "Ghost job" signal: reuses `ages`, already computed above.
    # threshold_days is a response field, not a frontend assumption, so
    # changing it here needs no matching frontend edit.
    GHOST_THRESHOLD_DAYS = 60
    dormant_count = sum(1 for a in ages if a > GHOST_THRESHOLD_DAYS)

    # error_count: domains currently failing to resolve at all.
    # oldest_resolved_check: is the slowest part of the pipeline still
    # healthy. Distinct from freshness.last_checked below, which only
    # reflects the single most-recent company and would miss a straggler.
    pipeline_row = conn.execute(
        """
        SELECT
          SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS error_count,
          MIN(CASE WHEN ats IS NOT NULL THEN last_checked END) AS oldest_resolved_check
        FROM companies
        """
    ).fetchone()
    oldest_resolved_check = pipeline_row["oldest_resolved_check"]
    oldest_check_minutes = None
    if oldest_resolved_check is not None:
        mins = conn.execute(
            "SELECT (julianday('now') - julianday(?)) * 1440.0 AS mins", (oldest_resolved_check,)
        ).fetchone()["mins"]
        if mins is not None:
            oldest_check_minutes = round(mins, 1)

    # New verified listings per day, last 14 days, zero-filled so the
    # frontend's chart gets a consistent 14-point series. Closed uses the
    # same shape/window from closed_at: the chart's other half.
    today = datetime.now(timezone.utc).date()
    window = [(today - timedelta(days=i)).isoformat() for i in range(13, -1, -1)]

    new_rows = conn.execute(
        """
        SELECT date(first_seen) AS d, COUNT(*) AS n
        FROM jobs
        WHERE confidence = 'verified' AND julianday('now') - julianday(first_seen) <= 14
        GROUP BY d
        """
    ).fetchall()
    closed_rows = conn.execute(
        """
        SELECT date(closed_at) AS d, COUNT(*) AS n
        FROM jobs
        WHERE confidence = 'verified' AND closed_at IS NOT NULL
          AND julianday('now') - julianday(closed_at) <= 14
        GROUP BY d
        """
    ).fetchall()
    new_counts = {r["d"]: r["n"] for r in new_rows}
    closed_counts = {r["d"]: r["n"] for r in closed_rows}
    daily_new_jobs = [
        {"date": day, "n": new_counts.get(day, 0), "closed": closed_counts.get(day, 0)} for day in window
    ]

    # Open-jobs-over-time, reconstructed rather than snapshotted. This DB
    # has no periodic-snapshot mechanism, but nothing is ever deleted (jobs
    # get closed_at set, not removed), so "was this job open on day X" is
    # answerable from first_seen/closed_at alone. Done in Python, not SQL,
    # since it reads far more clearly as a loop than as a CTE.
    lifecycle_rows = conn.execute(
        "SELECT date(first_seen) AS fs, date(closed_at) AS ca FROM jobs WHERE confidence = 'verified'"
    ).fetchall()
    open_jobs_history = [
        {
            "date": day,
            "n": sum(1 for r in lifecycle_rows if r["fs"] and r["fs"] <= day and (r["ca"] is None or r["ca"] > day)),
        }
        for day in window
    ]

    payload = {
        "meta": meta,
        "open_jobs_by_ats": [dict(r) for r in by_ats],
        "category_seniority": category_seniority,
        "workplace": [dict(r) for r in workplace],
        "top_skills": top_skills,
        "skills_coverage": {"with_skills": skilled, "open_jobs": open_jobs_fresh},
        "top_companies": _with_logos(conn, [dict(r) for r in top_companies]),
        "top_departments": [dict(r) for r in top_departments],
        "top_locations": [dict(r) for r in top_locations],
        "top_movers_7d": _with_logos(conn, [dict(r) for r in top_movers]),
        "daily_new_jobs": daily_new_jobs,
        "open_jobs_history": open_jobs_history,
        "seniority_breakdown": [dict(r) for r in seniority_breakdown],
        "ghost": {
            "threshold_days": GHOST_THRESHOLD_DAYS,
            "dormant_count": dormant_count,
            "dormant_pct": round(dormant_count / n, 4) if n else 0,
            "sample_size": n,
        },
        "pipeline": {
            "error_count": pipeline_row["error_count"] or 0,
            "oldest_resolved_check_minutes": oldest_check_minutes,
        },
        "location": {
            "israel": israel_count,
            "other": location_total - israel_count,
            "total": location_total,
        },
        "totals": {
            "open_jobs": open_jobs_fresh,
            "open_jobs_all_time": open_jobs_all_time,
            "companies_hiring": companies_hiring,
            "companies_total": companies_total,
            "companies_resolved": companies_resolved,
            "resolution_rate": round(companies_resolved / companies_total, 4) if companies_total else 0,
        },
        "freshness": {
            "last_checked": last_checked,
            "minutes_since_update": minutes_since_update,
        },
        "throughput": {
            "new_jobs_24h": throughput["added_24h"] or 0,
            "new_jobs_7d": throughput["added_7d"] or 0,
            "closed_jobs_24h": throughput["closed_24h"] or 0,
            "closed_jobs_7d": throughput["closed_7d"] or 0,
            # Last period, for the overview's arrows. See the query.
            "prev_new_jobs_24h": throughput["added_prev_24h"] or 0,
            "prev_new_jobs_7d": throughput["added_prev_7d"] or 0,
            "open_now_basis": throughput["open_now"] or 0,
            "open_jobs_7d_ago": throughput["open_7d_ago"] or 0,
            "companies_now_basis": throughput["companies_now"] or 0,
            "companies_7d_ago": throughput["companies_7d_ago"] or 0,
        },
        "age": {
            "avg_open_days": round(sum(ages) / n, 1) if n else None,
            "median_open_days": round(median_days, 1) if median_days is not None else None,
            "oldest_open_days": round(ages[-1], 1) if n else None,
        },
    }
    # Absent, not empty, when nothing is filtered. The key existing is
    # how the frontend knows there is a result set worth describing, and
    # an unfiltered request must keep answering exactly what it answered
    # before this shipped, precomputed artifact included.
    if has_board_filters(params):
        payload["scoped"] = compute_scoped_stats(conn, params)
    return payload
