import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "geonames_coverage", pathlib.Path(__file__).resolve().parents[1] / "scripts" / "geonames_coverage.py")
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)


def city(gid, name, cc, pop):
    return {"id": gid, "name": name, "cc": cc, "admin1": "01", "fcode": "PPL", "lat": 0.0, "lon": 0.0, "pop": pop}


def gazetteer():
    cities = {"1": city("1", "Austin", "US", 974447), "2": city("2", "Austin", "US", 24563),
              "3": city("3", "Ra'anana", "IL", 80000), "4": city("4", "Bengaluru", "IN", 8495492)}
    exact = {("US", "austin"): {"1", "2"}, ("IL", "raanana"): {"3"}, ("IN", "bengaluru"): {"4"}}
    alias = {("IN", "bangalore"): {"4"}, ("IL", gc.norm("רעננה")): {"3"}}
    admin1 = {("name", "CA", "ontario"): "Ontario"}
    return cities, exact, alias, {}, admin1


def test_norm_folds_accents_quotes_and_hyphens():
    assert gc.norm("Ra’anana") == gc.norm("Raanana") == "raanana"
    assert gc.norm("Tel Aviv-Yafo") == "tel aviv yafo"
    assert gc.norm("Zürich") == "zurich"
    assert gc.norm('ראשל"צ') == "ראשלצ"


def test_classes():
    g = gazetteer()
    assert gc.classify("IL", "Raanana", g)[0] == "exact"
    assert gc.classify("IN", "Bangalore", g)[0] == "alias"
    assert gc.classify("IL", "רעננה", g)[0] == "alias"
    cls, cands, _ = gc.classify("US", "Austin", g)
    assert cls == "ambiguous" and [c["id"] for c in cands] == ["1", "2"]  # never picks one, largest first
    assert gc.classify("IL", "גוש דן", g)[:3:2] == ("region", "Gush Dan")
    assert gc.classify("CA", "Ontario", g)[0] == "region"
    assert gc.classify("US", "Main Campus", g)[0] == "unmatched"
    assert gc.classify("CA", "Austin", g)[0] == "unmatched"  # matching stays inside the pair's country
