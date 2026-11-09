"""Match the board's places to GeoNames and record how each match was made.

Input:
  places TSV, one line per (country code, US state, city string):
    code, state, city, total, onsite, hybrid, remote, other, from_multi_country_rows
  The older 8-column form without the state column is still read.
  Lines starting "#REMOTE\tCC\tn" give remote jobs per country, "#META" the totals.
  A GeoNames folder holding cities1000.zip, admin1CodesASCII.txt and
  alt_he_en.txt (alternateNamesV2 rows filtered to he/en).

Output (to --out): matches.jsonl, every place with its class, method and candidates.

Methods, decided within the place's country only:
  exact      the string equals one city's GeoNames name or ASCII name
  state      several cities share the name, and the US state written beside
             it leaves exactly one
  alias-he   no exact hit; equals one city's Hebrew name in alternateNamesV2
  alias-en   no exact hit; equals one city's English name in alternateNamesV2
  manual     MANUAL below, for the few places GeoNames gets wrong
  region     no city hit; an IL region from IL_REGIONS, or an admin1 name
and two outcomes that place nothing:
  ambiguous  two or more cities still share the name; never picked from
  unmatched  nothing, or a single candidate in a different state than written

Aliases come only from the language-tagged, non-historic names in
alternateNamesV2. The untagged alternate-name list in cities1000.txt is not
used: hand-checked, 9 of 30 matches from it were wrong.

GeoNames data: CC BY 4.0, https://www.geonames.org/
"""
import argparse, collections, gzip, io, json, math, pathlib, sys, zipfile

_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(_ROOT / "loader"), str(_ROOT / "api")]
# The rules live with the loader, which stores what they decide; this script only reports on them.
from location_places import IL_REGIONS, MANUAL, classify, norm  # noqa: E402,F401

DEAD = {"PPLH", "PPLQ", "PPLW"}  # historical, abandoned, destroyed

def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def load_geonames(folder):
    cities = {}
    exact = collections.defaultdict(set)   # (cc, norm) -> ids
    alias = collections.defaultdict(dict)  # (cc, norm) -> {id: "he" or "en"}
    with zipfile.ZipFile(f"{folder}/cities1000.zip") as z:
        for line in io.TextIOWrapper(z.open("cities1000.txt"), encoding="utf-8"):
            f = line.rstrip("\n").split("\t")
            if f[7] in DEAD:
                continue
            gid, cc = f[0], f[8]
            cities[gid] = {"id": gid, "name": f[1], "cc": cc, "admin1": f[10], "fcode": f[7],
                           "lat": float(f[4]), "lon": float(f[5]), "pop": int(f[14] or 0)}
            for n in {norm(f[1]), norm(f[2])} - {""}:
                exact[(cc, n)].add(gid)
    names = collections.defaultdict(dict)  # gid -> {"en": .., "he": ..}
    for line in open(f"{folder}/alt_he_en.txt", encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        gid, lang, name = f[1], f[2], f[3]
        historic = len(f) > 7 and f[7] == "1"
        if gid in cities and not historic:
            lang = "he" if lang in ("he", "iw") else "en"
            alias[(cities[gid]["cc"], norm(name))].setdefault(gid, lang)
            preferred = len(f) > 4 and f[4] == "1"
            if preferred or lang not in names[gid]:
                names[gid][lang] = name
    admin1, by_gid = {}, {}
    for line in open(f"{folder}/admin1CodesASCII.txt", encoding="utf-8"):
        code, name, ascii_, gid = line.rstrip("\n").split("\t")
        cc, a1 = code.split(".", 1)
        admin1[(cc, a1)] = name
        by_gid[gid] = (cc, a1, name)
        for n in {norm(name), norm(ascii_)}:
            admin1.setdefault(("name", cc, n), name)
            admin1.setdefault(("code", cc, n), a1)
    # Regions' Hebrew and English names too, so classify() can tell a region from a town's alias.
    for line in open(f"{folder}/alt_he_en.txt", encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        if f[1] in by_gid and not (len(f) > 7 and f[7] == "1"):
            cc, a1, name = by_gid[f[1]]
            admin1.setdefault(("name", cc, norm(f[3])), name)
            admin1.setdefault(("code", cc, norm(f[3])), a1)
    return cities, exact, alias, names, admin1


def write_gazetteer(g, out_path, version):
    """The compact file loader/location_places.py reads on the box.

    Lines: "#version\tV", C (city), E (exact name), A (alias, he or en),
    R (first-level region name). Only what classify() reads.
    """
    cities, exact, alias, _, admin1 = g
    with gzip.open(out_path, "wt", encoding="utf-8", newline="\n") as f:
        f.write(f"#version\t{version}\n")
        for c in cities.values():
            f.write("\t".join(["C", c["id"], c["name"], c["cc"], c["admin1"], c["fcode"],
                               f"{c['lat']:.5f}", f"{c['lon']:.5f}", str(c["pop"])]) + "\n")
        for (cc, n), ids in exact.items():
            for gid in ids:
                f.write(f"E\t{cc}\t{n}\t{gid}\n")
        for (cc, n), ids in alias.items():
            for gid, lang in ids.items():
                f.write(f"A\t{cc}\t{n}\t{gid}\t{lang}\n")
        for key, name in admin1.items():
            if key[0] == "name":
                f.write(f"R\t{key[1]}\t{key[2]}\t{name}\t{admin1[('code', key[1], key[2])]}\n")


def read_pairs(path):
    pairs, remote, meta = [], {}, None
    for line in open(path, encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        if f[0] == "#META":
            meta = dict(zip(("jobs", "no_country", "no_city", "pairs", "secs"), f[1:]))
        elif f[0] == "#REMOTE":
            remote[f[1]] = int(f[2])
        elif len(f) == 8:
            pairs.append((f[0], "", f[1], *map(int, f[2:])))
        elif len(f) == 9:
            pairs.append((f[0], f[1], f[2], *map(int, f[3:])))
    return pairs, remote, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pairs")
    ap.add_argument("geonames")
    ap.add_argument("--out", required=True)
    ap.add_argument("--gazetteer-out", help="also write the compact gazetteer the box loader reads")
    ap.add_argument("--gazetteer-version", default="unversioned",
                    help="the GeoNames download date, stored in every row placed with it")
    a = ap.parse_args()
    g = load_geonames(a.geonames)
    if a.gazetteer_out:
        write_gazetteer(g, a.gazetteer_out, a.gazetteer_version)
    cities, _, _, names, admin1 = g
    pairs, remote, meta = read_pairs(a.pairs)
    rows = []
    for cc, state, city, total, onsite, hybrid, rem, other, multi in pairs:
        cls, cands, via = classify(cc, city, g, state or None)
        spread = max((km((c["lat"], c["lon"]), (d["lat"], d["lon"])) for c in cands for d in cands), default=0)
        rows.append({"cc": cc, "state": state, "city": city, "cls": cls, "via": via, "total": total, "onsite": onsite,
                     "hybrid": hybrid, "remote": rem, "other": other, "multi": multi,
                     "spread_km": round(spread, 1),
                     "also_admin1": cls in ("exact", "alias", "ambiguous") and bool(admin1.get(("name", cc, norm(city)))),
                     "cands": [{**c, "admin1_name": admin1.get((c["cc"], c["admin1"]), c["admin1"]),
                                "he": names.get(c["id"], {}).get("he", ""), "en": names.get(c["id"], {}).get("en", "")}
                               for c in cands],
                     "n_cands": len(cands)})
    with open(f"{a.out}/matches.jsonl", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    json.dump({"meta": meta, "remote": remote}, open(f"{a.out}/meta.json", "w"))
    by = collections.Counter(); jobs = collections.Counter()
    for r in rows:
        by[r["cls"]] += 1; jobs[r["cls"]] += r["total"]
    print({k: (by[k], jobs[k]) for k in by}, file=sys.stderr)


if __name__ == "__main__":
    main()
