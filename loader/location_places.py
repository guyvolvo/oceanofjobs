"""Where each location string puts its jobs, and how that was decided.

One row per city a raw location string names, in the side table
location_places, keyed by the string itself. A place depends on nothing
but the string and the rules, so 1.3 million jobs share about 230,000
strings and the table stays small. jobs is never altered: the box is
disk-bound and a rewrite of jobs is what this design avoids.

Each row keeps the original string (the key), the method that placed it,
and the rules version that made it, so an assignment can always be traced
and a rule change re-run only where it applies:

  exact      the city equals one GeoNames city's name in that country
  state      several share the name; the US state written beside it leaves one
  alias-he   the city equals one GeoNames city's Hebrew name
  alias-en   the city equals one GeoNames city's English alternate name
  manual     MANUAL below, for the few places GeoNames gets wrong
  region     a region, not a city: an Israeli region or a first-level one
  unresolved nothing placed; detail says why (ambiguous, unmatched,
             state-mismatch, no country, no city, no gazetteer)

The board's own columns (jobs.country, jobs.city) are unchanged by this;
they are the filter values. This table is for anything that needs one
point per city, such as the map, and for auditing it.

Box only. Imported lazily by load_to_sqlite.py's box sweep, never by the
scrape Lambdas, and it writes nothing unless the sweep calls backfill().
"""

import gzip
import re
import unicodedata

from countries import places_of

# Bump when countries.py's place rules or classify() below change. Rows made
# under another version are re-run, oldest first, a batch per sweep.
RULES_VERSION = "1"

SCHEMA = """
CREATE TABLE IF NOT EXISTS location_places (
    location      TEXT NOT NULL,
    ord           INTEGER NOT NULL,
    country       TEXT,
    state         TEXT,
    city          TEXT,
    geonameid     INTEGER,
    method        TEXT NOT NULL,
    detail        TEXT,
    rules_version TEXT NOT NULL,
    assigned_at   TEXT NOT NULL,
    PRIMARY KEY (location, ord)
) WITHOUT ROWID
"""

METHODS = ("exact", "state", "alias-he", "alias-en", "manual", "region", "unresolved")

# Israeli regions the boards use. They become Ocean of Jobs' own entities
# listing member cities, not GeoNames matches. Keys are normalised by norm().
IL_REGIONS = {
    "gush dan": "Gush Dan", "גוש דן": "Gush Dan",
    "shfela": "Shfela", "shephelah": "Shfela", "שפלה": "Shfela", "אזור השפלה": "Shfela", "השפלה": "Shfela",
    "sharon": "Sharon", "hasharon": "Sharon", "השרון": "Sharon", "אזור השרון": "Sharon", "שרון": "Sharon",
    "central district": "Center", "center": "Center", "central": "Center", "central israel": "Center",
    "מרכז": "Center", "אזור המרכז": "Center", "המרכז": "Center",
    "northern district": "North", "north": "North", "צפון": "North", "אזור הצפון": "North", "הצפון": "North",
    "southern district": "South", "south": "South", "דרום": "South", "אזור הדרום": "South", "הדרום": "South",
    "haifa district": "Haifa District", "tel aviv district": "Tel Aviv District",
    "jerusalem district": "Jerusalem District", "judea and samaria": "Judea and Samaria",
    "יהודה ושומרון": "Judea and Samaria", "השומרון": "Judea and Samaria", "שומרון": "Judea and Samaria",
    "עמק יזרעאל": "Jezreel Valley", "emek yizrael": "Jezreel Valley", "jezreel valley": "Jezreel Valley",
    "הגליל": "Galilee", "galilee": "Galilee", "גליל": "Galilee", "הגליל העליון": "Upper Galilee",
    "upper galilee": "Upper Galilee", "גליל עליון": "Upper Galilee", "הנגב": "Negev", "negev": "Negev", "נגב": "Negev",
    "הקריות": "Haifa Bay (Krayot)", "krayot": "Haifa Bay (Krayot)", "השפלה והדרום": "Shfela",
    "ירושלים והסביבה": "Jerusalem area", "jerusalem area": "Jerusalem area",
    "center district": "Center", "hamerkaz": "Center", "north district": "North", "south district": "South",
    "גוש עציון": "Gush Etzion", "מטה בנימין": "Binyamin", "במטה בנימין": "Binyamin",
    "רמת הגולן": "Golan Heights", "golan heights": "Golan Heights", "איזור הבקעה": "Jordan Valley",
}

# Places GeoNames gets wrong for this board, by geonameid. Yokneam: the
# postings mean Yokneam Illit (293153), not the old moshava (11979661).
# Yehud: GeoNames calls it Yehud Monosson and has no Hebrew name for it.
# Bangalore and Gurgaon are the names the board files these cities under
# (api/countries.py CITY_ALIASES); GeoNames has them only as old names.
MANUAL = {("IL", "yokneam"): "293153", ("IL", "yehud"): "293207", ("IL", "יהוד"): "293207",
          ("IN", "bangalore"): "1277333", ("IN", "gurgaon"): "1270642"}

_PUNCT = re.compile(r"[׳״'’‘`\"“”.]")
_SEP = re.compile(r"[\s\-‐-―_/]+")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = _PUNCT.sub("", s.casefold())
    return _SEP.sub(" ", s).strip()


IL_REGIONS_N = {norm(k): v for k, v in IL_REGIONS.items()}


def classify(cc, city, g, state=None):
    """(class, candidates, note) for one city in one country.

    g is (cities, exact, alias, names, admin1): cities by geonameid; exact
    and alias map (country, norm(name)) to geonameids, alias to {id: "he" or
    "en"}; admin1 maps ("name", country, norm(name)) to a region's name and
    ("code", country, norm(name)) to its GeoNames admin1 code.
    The class is the method for a placed city, else "ambiguous" or
    "unmatched". Several candidates are never picked from.
    """
    cities, exact, alias, names, admin1 = g
    n = norm(city)
    if (cc, n) in MANUAL and MANUAL[(cc, n)] in cities:
        return "manual", [cities[MANUAL[(cc, n)]]], ""
    if cc == "IL" and n in IL_REGIONS_N:
        return "region", [], IL_REGIONS_N[n]
    for kind, ids in (("exact", exact.get((cc, n))), ("alias", alias.get((cc, n)))):
        if not ids:
            continue
        cands = sorted((cities[i] for i in ids), key=lambda c: -c["pop"])
        # A region's name is also some town's alternate name: "Perak" is a
        # Malaysian state and Kampung Perak a village in another state. The
        # region wins, unless the town sits in that region (Bucuresti).
        region_code = admin1.get(("code", cc, n))
        if kind == "alias" and region_code and all(c["admin1"] != region_code for c in cands):
            return "region", [], admin1[("name", cc, n)]
        single = "exact" if kind == "exact" else "alias-" + ids[cands[0]["id"]]
        if state and cc == "US":
            in_state = [c for c in cands if c["admin1"] == state]
            if not in_state:
                return "unmatched", cands, "state-mismatch"
            if len(in_state) > 1:
                return "ambiguous", in_state, "same state"
            return (single if len(cands) == 1 else "state"), in_state, kind
        return (single if len(cands) == 1 else "ambiguous"), cands, kind
    a1 = admin1.get(("name", cc, n))
    if a1:
        return "region", [], a1
    return "unmatched", [], ""


def assign(location: str, g, version: str, now: str) -> list[tuple]:
    """The rows for one location string. g is None when there is no gazetteer."""
    rows = []
    for ord_, (country, state, city) in enumerate(places_of(location)):
        geonameid, detail = None, None
        if g is None:
            method, detail = "unresolved", "no gazetteer"
        elif not country:
            method, detail = "unresolved", "no country"
        else:
            cls, cands, note = classify(country, city, g, state)
            if cls in ("ambiguous", "unmatched"):
                method, detail = "unresolved", note if note == "state-mismatch" else cls
            else:
                method = cls
                if cls == "region":
                    detail = note
                else:
                    geonameid = int(cands[0]["id"])
        rows.append((location, ord_, country, state, city, geonameid, method, detail, version, now))
    if not rows:
        # Recorded all the same, so the string is known to be done.
        rows.append((location, 0, None, None, None, None, "unresolved", "no city", version, now))
    return rows


def wanted_keys(locations) -> set:
    """(country, norm(city)) for every city these strings name: all a
    gazetteer load needs to keep."""
    return {(c, norm(city)) for loc in locations for c, _, city in places_of(loc) if c}


def load_gazetteer(path, wanted: set):
    """(g, version) from a gazetteer file, keeping only the wanted names.

    The file is built by scripts/geonames_coverage.py --gazetteer-out. It is
    read twice rather than held whole: a sweep needs a few thousand of its
    150,000 cities, and the box has the memory for those, not all of them.
    """
    version, exact, alias, admin1 = "none", {}, {}, {}
    ids = {gid for key, gid in MANUAL.items() if key in wanted}
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            r = line.rstrip("\n").split("\t")
            if r[0] == "#version":
                version = r[1]
            elif r[0] == "E" and (r[1], r[2]) in wanted:
                exact.setdefault((r[1], r[2]), set()).add(r[3]); ids.add(r[3])
            elif r[0] == "A" and (r[1], r[2]) in wanted:
                alias.setdefault((r[1], r[2]), {}).setdefault(r[3], r[4]); ids.add(r[3])
            elif r[0] == "R" and (r[1], r[2]) in wanted:
                admin1[("name", r[1], r[2])] = r[3]
                admin1[("code", r[1], r[2])] = r[4]
    cities = {}
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            r = line.rstrip("\n").split("\t")
            if r[0] == "C" and r[1] in ids:
                cities[r[1]] = {"id": r[1], "name": r[2], "cc": r[3], "admin1": r[4], "fcode": r[5],
                                "lat": float(r[6]), "lon": float(r[7]), "pop": int(r[8])}
    return (cities, exact, alias, {}, admin1), version


def ensure_table(conn) -> None:
    conn.execute(SCHEMA)


def backfill(conn, gazetteer_path, now: str, max_locations: int = 20_000) -> dict:
    """Place every open job's location string that has no rows yet, and
    re-place strings whose rows came from other rules. Capped per run; the
    rest goes next sweep. Returns what it did, for the sweep's log line.
    """
    ensure_table(conn)
    g_version = "none"
    if gazetteer_path:
        with gzip.open(gazetteer_path, "rt", encoding="utf-8") as f:
            first = f.readline().rstrip("\n").split("\t")
            g_version = first[1] if first[0] == "#version" else "unknown"
    version = f"{RULES_VERSION}/{g_version}"
    stale = [r[0] for r in conn.execute(
        "SELECT DISTINCT location FROM location_places WHERE rules_version != ? LIMIT ?",
        (version, max_locations))]
    # The one scan of open jobs. It stops at the cap; once everything is
    # placed it reads every open row to find nothing new.
    missing = [r[0] for r in conn.execute(
        "SELECT DISTINCT COALESCE(j.location, '') FROM jobs j WHERE j.closed_at IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM location_places p WHERE p.location = COALESCE(j.location, '')) LIMIT ?",
        (max(0, max_locations - len(stale)),))]
    todo = stale + missing
    if not todo:
        return {"placed": 0, "rerun": 0, "version": version}
    g = None
    if gazetteer_path:
        g, _ = load_gazetteer(gazetteer_path, wanted_keys(todo))
    rows = [row for loc in todo for row in assign(loc, g, version, now)]
    conn.executemany("DELETE FROM location_places WHERE location = ?", [(loc,) for loc in stale])
    conn.executemany("INSERT OR REPLACE INTO location_places VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return {"placed": len(missing), "rerun": len(stale), "rows": len(rows), "version": version}
