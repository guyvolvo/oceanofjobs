import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "geonames_coverage", pathlib.Path(__file__).resolve().parents[1] / "scripts" / "geonames_coverage.py")
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)


def city(gid, name, cc, pop, admin1="01"):
    return {"id": gid, "name": name, "cc": cc, "admin1": admin1, "fcode": "PPL", "lat": 0.0, "lon": 0.0, "pop": pop}


def gazetteer():
    cities = {"1": city("1", "Austin", "US", 974447, "TX"), "2": city("2", "Austin", "US", 24563, "MN"),
              "3": city("3", "Ra'anana", "IL", 80000), "4": city("4", "Bengaluru", "IN", 8495492),
              "5": city("5", "Pine", "US", 1963, "AZ"), "6": city("6", "Bel Air", "US", 10190, "MD"),
              "7": city("7", "Bel Air", "US", 1258, "MD"), "293153": city("293153", "Yoqne'am 'Illit", "IL", 23796),
              "11979661": city("11979661", "Yoqneam", "IL", 1398),
              "8": city("8", "Kampung Perak", "MY", 44964, "06"), "9": city("9", "Bucharest", "RO", 1877155, "10")}
    exact = {("US", "austin"): {"1", "2"}, ("IL", "raanana"): {"3"}, ("IN", "bengaluru"): {"4"},
             ("US", "pine"): {"5"}, ("US", "bel air"): {"6", "7"}, ("IL", "yoqneam"): {"11979661"}}
    alias = {("IN", "bangalore"): {"4": "en"}, ("IL", gc.norm("רעננה")): {"3": "he"},
             ("IL", "yokneam"): {"11979661": "en"}, ("MY", "perak"): {"8": "en"},
             ("RO", "bucuresti"): {"9": "en"}}
    admin1 = {("name", "CA", "ontario"): "Ontario", ("code", "CA", "ontario"): "08",
              ("name", "MY", "perak"): "Perak", ("code", "MY", "perak"): "07",
              ("name", "RO", "bucuresti"): "Bucuresti", ("code", "RO", "bucuresti"): "10"}
    return cities, exact, alias, {}, admin1


def test_norm_folds_accents_quotes_and_hyphens():
    assert gc.norm("Ra’anana") == gc.norm("Raanana") == "raanana"
    assert gc.norm("Tel Aviv-Yafo") == "tel aviv yafo"
    assert gc.norm("Zürich") == "zurich"
    assert gc.norm('ראשל"צ') == "ראשלצ"


def test_methods():
    g = gazetteer()
    assert gc.classify("IL", "Raanana", g)[0] == "exact"
    assert gc.classify("IN", "Bangalore", g)[0] == "alias-en"
    assert gc.classify("IL", "רעננה", g)[0] == "alias-he"
    assert gc.classify("IL", "גוש דן", g)[:3:2] == ("region", "Gush Dan")
    assert gc.classify("CA", "Ontario", g)[0] == "region"
    assert gc.classify("US", "Main Campus", g)[0] == "unmatched"
    assert gc.classify("CA", "Austin", g)[0] == "unmatched"  # matching stays inside the place's country


def test_ambiguous_is_never_picked_without_a_state():
    cls, cands, _ = gc.classify("US", "Austin", gazetteer())
    assert cls == "ambiguous" and [c["id"] for c in cands] == ["1", "2"]


def test_state_resolves_only_when_it_leaves_one():
    g = gazetteer()
    cls, cands, _ = gc.classify("US", "Austin", g, "MN")
    assert cls == "state" and [c["id"] for c in cands] == ["2"]
    assert gc.classify("US", "Bel Air", g, "MD")[0] == "ambiguous"  # two in Maryland: still unresolved
    assert gc.classify("US", "Austin", g, "CA")[:3:2] == ("unmatched", "state-mismatch")
    assert gc.classify("US", "Pine", g, "AZ")[0] == "exact"
    assert gc.classify("US", "Pine", g, "NC")[:3:2] == ("unmatched", "state-mismatch")  # "Wilson - Pine", NC


def test_a_region_is_not_a_towns_alias():
    g = gazetteer()
    assert gc.classify("MY", "Perak", g)[:3:2] == ("region", "Perak")  # Kampung Perak is in Pahang
    assert gc.classify("RO", "Bucuresti", g)[0] == "alias-en"  # Bucharest is in Bucuresti


def test_manual_beats_geonames():
    cls, cands, _ = gc.classify("IL", "Yokneam", gazetteer())
    assert cls == "manual" and cands[0]["id"] == "293153"
