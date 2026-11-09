"""Match the board's (country, city) strings to GeoNames and classify each pair.

Input:
  pairs TSV, one line per stored (country code, city string) pair:
    code, city, total, onsite, hybrid, remote, other, from_multi_country_rows
  lines starting "#REMOTE\tCC\tn" give remote jobs per country, "#META" the totals.
  A GeoNames folder holding cities1000.zip, admin1CodesASCII.txt and
  alt_he_en.txt (alternateNamesV2 rows filtered to he/en).

Output (to --out):
  matches.tsv  every pair with its class and candidates
  summary.json the numbers the coverage report is written from

Classes, decided within the pair's country only:
  exact      the string equals one city's GeoNames name or ASCII name
  alias      no exact hit; equals one city's alternate name (any language,
             Hebrew and English from alternateNamesV2 included)
  ambiguous  two or more cities share the winning name; never resolved here
  region     no city hit; an IL region from IL_REGIONS, or an admin1 name
  unmatched  nothing

GeoNames data: CC BY 4.0, https://www.geonames.org/
"""
import argparse, collections, gzip, io, json, math, re, sys, unicodedata, zipfile

DEAD = {"PPLH", "PPLQ", "PPLW"}  # historical, abandoned, destroyed

# Israeli regions the boards use. They become Ocean of Jobs' own entities
# listing member cities, not GeoNames matches. Keys are normalised strings.
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

_PUNCT = re.compile(r"[׳״'’‘`\"“”.]")
_SEP = re.compile(r"[\s\-‐-―_/]+")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = _PUNCT.sub("", s.casefold())
    return _SEP.sub(" ", s).strip()


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def load_geonames(folder):
    cities = {}
    exact = collections.defaultdict(set)   # (cc, norm) -> ids
    alias = collections.defaultdict(set)
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
            for a in f[3].split(","):
                if a:
                    alias[(cc, norm(a))].add(gid)
    names = collections.defaultdict(dict)  # gid -> {"en": .., "he": ..}
    for line in open(f"{folder}/alt_he_en.txt", encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        gid, lang, name = f[1], f[2], f[3]
        historic = len(f) > 7 and f[7] == "1"
        if gid in cities and not historic:
            alias[(cities[gid]["cc"], norm(name))].add(gid)
            lang = "he" if lang in ("he", "iw") else "en"
            preferred = len(f) > 4 and f[4] == "1"
            if preferred or lang not in names[gid]:
                names[gid][lang] = name
    admin1 = {}
    for line in open(f"{folder}/admin1CodesASCII.txt", encoding="utf-8"):
        code, name, ascii_, _ = line.rstrip("\n").split("\t")
        cc, a1 = code.split(".", 1)
        admin1[(cc, a1)] = name
        for n in {norm(name), norm(ascii_)}:
            admin1.setdefault(("name", cc, n), name)
    return cities, exact, alias, names, admin1


def classify(cc, city, g):
    cities, exact, alias, names, admin1 = g
    n = norm(city)
    if cc == "IL" and n in IL_REGIONS_N:
        return "region", [], IL_REGIONS_N[n]
    for cls, index in (("exact", exact), ("alias", alias)):
        ids = index.get((cc, n))
        if ids:
            cands = sorted((cities[i] for i in ids), key=lambda c: -c["pop"])
            return (cls if len(cands) == 1 else "ambiguous"), cands, cls
    a1 = admin1.get(("name", cc, n))
    if a1:
        return "region", [], a1
    return "unmatched", [], ""


IL_REGIONS_N = {norm(k): v for k, v in IL_REGIONS.items()}


def read_pairs(path):
    pairs, remote, meta = [], {}, None
    for line in open(path, encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        if f[0] == "#META":
            meta = dict(zip(("jobs", "no_country", "no_city", "pairs", "secs"), f[1:]))
        elif f[0] == "#REMOTE":
            remote[f[1]] = int(f[2])
        elif len(f) == 8:
            pairs.append((f[0], f[1], *map(int, f[2:])))
    return pairs, remote, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pairs")
    ap.add_argument("geonames")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    g = load_geonames(a.geonames)
    cities, _, _, names, admin1 = g
    pairs, remote, meta = read_pairs(a.pairs)
    rows = []
    for cc, city, total, onsite, hybrid, rem, other, multi in pairs:
        cls, cands, via = classify(cc, city, g)
        spread = max((km((c["lat"], c["lon"]), (d["lat"], d["lon"])) for c in cands for d in cands), default=0)
        rows.append({"cc": cc, "city": city, "cls": cls, "via": via, "total": total, "onsite": onsite,
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
