"""location_places: every location string's places, with the method and rules version that made them."""
import gzip
import pathlib
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "loader"), str(ROOT / "api")]

import location_places as lp  # noqa: E402

GAZ = [
    "#version\tgeonames-test",
    "C\t1\tAustin\tUS\tTX\tPPLA\t30.26715\t-97.74306\t974447",
    "C\t2\tAustin\tUS\tMN\tPPLA2\t43.66663\t-92.97464\t24563",
    "C\t3\tTel Aviv\tIL\t05\tPPLA\t32.08088\t34.78057\t432892",
    "C\t293153\tYoqne'am 'Illit\tIL\t03\tPPL\t32.65950\t35.11000\t23796",
    "E\tUS\taustin\t1", "E\tUS\taustin\t2", "E\tIL\ttel aviv\t3",
    "A\tIL\tתל אביב\t3\the",
    "R\tCA\tontario\tOntario\t08",
]


def gazetteer(tmp_path):
    p = tmp_path / "gazetteer.tsv.gz"
    with gzip.open(p, "wt", encoding="utf-8") as f:
        f.write("\n".join(GAZ) + "\n")
    return p


def db(*locations, closed=()):
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, location TEXT, closed_at TEXT)")
    conn.executemany("INSERT INTO jobs VALUES (?, ?, ?)",
                     [(str(i), loc, "2026-11-01" if loc in closed else None) for i, loc in enumerate(locations)])
    return conn


def rows(conn, location):
    return conn.execute("SELECT ord, country, state, city, geonameid, method, detail, rules_version "
                        "FROM location_places WHERE location = ? ORDER BY ord", (location,)).fetchall()


def test_methods_and_original_string_are_recorded(tmp_path):
    conn = db("Austin, TX", "Austin", "Tel Aviv, Israel; Austin, Minnesota", "תל אביב", "Yokneam",
              "Remote", None, "Main Campus, TX")
    done = lp.backfill(conn, gazetteer(tmp_path), "2026-11-09T00:00:00Z")
    v = f"{lp.RULES_VERSION}/geonames-test"
    assert done["version"] == v and done["placed"] == 8
    assert rows(conn, "Austin, TX") == [(0, "US", "TX", "Austin", 1, "state", None, v)]
    # Two Austins and no state: recorded, never picked.
    assert rows(conn, "Austin") == [(0, "US", None, "Austin", None, "unresolved", "ambiguous", v)]
    assert rows(conn, "Tel Aviv, Israel; Austin, Minnesota") == [
        (0, "IL", None, "Tel Aviv", 3, "exact", None, v), (1, "US", "MN", "Austin", 2, "state", None, v)]
    assert rows(conn, "תל אביב")[0][3:6] == ("Tel Aviv", 3, "exact")  # the board's own alias, then exact
    assert rows(conn, "Yokneam")[0][4:6] == (293153, "manual")
    assert rows(conn, "Remote") == [(0, None, None, None, None, "unresolved", "no city", v)]
    assert rows(conn, "") == [(0, None, None, None, None, "unresolved", "no city", v)]  # NULL location
    assert rows(conn, "Main Campus, TX")[0][5:7] == ("unresolved", "unmatched")


def test_runs_are_idempotent_and_capped(tmp_path):
    conn = db("Austin, TX", "Tel Aviv", "Remote", "Austin, TX")
    g = gazetteer(tmp_path)
    assert lp.backfill(conn, g, "t1", max_locations=2)["placed"] == 2
    assert lp.backfill(conn, g, "t2", max_locations=2)["placed"] == 1
    assert lp.backfill(conn, g, "t3") == {"placed": 0, "rerun": 0, "version": f"{lp.RULES_VERSION}/geonames-test"}
    assert conn.execute("SELECT COUNT(*) FROM location_places").fetchone()[0] == 3


def test_closed_jobs_are_left_alone(tmp_path):
    conn = db("Austin, TX", "Tel Aviv", closed=("Tel Aviv",))
    lp.backfill(conn, gazetteer(tmp_path), "t")
    assert rows(conn, "Tel Aviv") == []


def test_new_rules_rerun_only_their_rows(tmp_path):
    conn = db("Austin, TX", "Tel Aviv")
    g = gazetteer(tmp_path)
    lp.backfill(conn, g, "t1")
    conn.execute("UPDATE location_places SET rules_version = 'old', method = 'exact' WHERE location = 'Tel Aviv'")
    done = lp.backfill(conn, g, "t2")
    assert done["rerun"] == 1 and done["placed"] == 0
    assert rows(conn, "Tel Aviv")[0][5:] == ("exact", None, f"{lp.RULES_VERSION}/geonames-test")
    assert conn.execute("SELECT assigned_at FROM location_places WHERE location = 'Austin, TX'").fetchone()[0] == "t1"


def test_the_table_is_a_side_table(tmp_path):
    conn = db("Austin, TX")
    before = conn.execute("SELECT sql FROM sqlite_master WHERE name = 'jobs'").fetchone()[0]
    lp.backfill(conn, gazetteer(tmp_path), "t")
    lp.ensure_table(conn)  # and creating it twice is harmless
    assert conn.execute("SELECT sql FROM sqlite_master WHERE name = 'jobs'").fetchone()[0] == before
    methods = {m for (m,) in conn.execute("SELECT DISTINCT method FROM location_places")}
    assert methods <= set(lp.METHODS)


def test_without_a_gazetteer_nothing_is_placed():
    rows_ = lp.assign("Austin, TX", None, "1/none", "t")
    assert rows_ == [("Austin, TX", 0, "US", "TX", "Austin", None, "unresolved", "no gazetteer", "1/none", "t")]
