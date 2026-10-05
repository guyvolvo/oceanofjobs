"""Score search against tests/search_eval.json, and time each stage.

Runs read-only against a real jobs database with whichever api/ code is
put first on the path, so the same script measures today's search and a
change to it side by side:

    DATA_PATH=/var/lib/otj/jobs.db python3 tests/search_eval.py --api /srv/otj/app/api --out before.json
    DATA_PATH=/var/lib/otj/jobs.db python3 tests/search_eval.py --api /tmp/new/api --out after.json
    python3 tests/search_eval.py --compare before.json after.json

Per query: precision@20 (top-20 titles matching the 'relevant' regex),
forbidden@20 (titles matching 'forbidden': must stay 0), relevant@100,
the total count, and timings for matching (the count), ranking (the first
page in relevance order), pagination (a deep page), facets with the
search applied, and the whole route_jobs request. Each query runs twice
and the second, warm run is the one timed; the first is kept as cold.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(api_dir: str, out: str, only: str | None) -> None:
    sys.path.insert(0, api_dir)
    for k, v in {"ALERTS_TABLE": "x", "AWS_DEFAULT_REGION": "il-central-1"}.items():
        os.environ.setdefault(k, v)
    import handler  # noqa: E402
    from db import get_connection  # noqa: E402
    from job_filters import build_jobs_where, has_fts_index, relevance_score_sql  # noqa: E402

    spec = json.loads((HERE / "search_eval.json").read_text(encoding="utf-8"))
    conn = get_connection()
    caps = has_fts_index(conn)
    results = []
    for item in spec["queries"]:
        if only and item["q"] != only:
            continue
        params = {"search": item["q"], "sort": "relevance", "limit": 100}
        rel = re.compile(item["relevant"], re.I)
        bad = re.compile(item["forbidden"], re.I) if item.get("forbidden") else None
        timings = {}
        for attempt in ("cold", "warm"):
            t = {}
            where, wargs = build_jobs_where(params, caps)
            rank, rargs = relevance_score_sql(params, caps)
            s = time.perf_counter()
            total = conn.execute(f"SELECT COUNT(*) FROM jobs WHERE {where}", wargs).fetchone()[0]
            t["match"] = time.perf_counter() - s
            s = time.perf_counter()
            conn.execute(f"SELECT id FROM jobs WHERE {where} ORDER BY {rank} DESC, id DESC LIMIT 50",
                         [*wargs, *rargs]).fetchall()
            t["rank"] = time.perf_counter() - s
            s = time.perf_counter()
            conn.execute(f"SELECT id FROM jobs WHERE {where} ORDER BY {rank} DESC, id DESC LIMIT 50 OFFSET 200",
                         [*wargs, *rargs]).fetchall()
            t["page"] = time.perf_counter() - s
            # Facets keep a per-worker cache; empty it so every run times
            # the real computation, not a dictionary lookup.
            getattr(handler, "_scoped_cache", {}).clear()
            s = time.perf_counter()
            try:
                handler.route_facets(dict(params))
                t["facets"] = time.perf_counter() - s
            except Exception as e:  # noqa: BLE001
                t["facets"] = None
                t["facets_error"] = repr(e)[:120]
            s = time.perf_counter()
            reply = handler.route_jobs(dict(params))
            t["request"] = time.perf_counter() - s
            timings[attempt] = t
        titles = [j.get("title") or "" for j in reply.get("jobs", [])]
        top20 = titles[:20]
        results.append({
            "q": item["q"], "total": total,
            "p20": sum(bool(rel.search(x)) for x in top20) / max(1, len(top20)) if top20 else 0.0,
            "forbidden20": [x for x in top20 if bad and bad.search(x)],
            "rel100": sum(bool(rel.search(x)) for x in titles[:100]),
            "top5": top20[:5],
            "expanded": (reply.get("search") or {}).get("expanded", []),
            "timings": timings,
        })
        r = results[-1]
        print(f"{r['q'][:24]:24} total={total:>7} p@20={r['p20']:.2f} forb={len(r['forbidden20'])} "
              f"rel@100={r['rel100']:>3} req={timings['warm']['request']:.2f}s facets={timings['warm']['facets'] or 0:.2f}s",
              flush=True)
    Path(out).write_text(json.dumps({"api": api_dir, "results": results}, indent=1, ensure_ascii=False), encoding="utf-8")


def pct(xs, p):
    xs = sorted(x for x in xs if x is not None)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))] if xs else None


def compare(before: str, after: str) -> None:
    a = {r["q"]: r for r in json.loads(Path(before).read_text(encoding="utf-8"))["results"]}
    b = {r["q"]: r for r in json.loads(Path(after).read_text(encoding="utf-8"))["results"]}
    qs = [q for q in a if q in b]
    print(f"{'query':26}{'total':>17}{'p@20':>12}{'forb@20':>10}{'rel@100':>10}{'request s':>14}{'facets s':>14}")
    for q in qs:
        x, y = a[q], b[q]
        print(f"{q[:25]:26}{x['total']:>8}->{y['total']:<8}{x['p20']:>5.2f}->{y['p20']:<5.2f}"
              f"{len(x['forbidden20']):>4}->{len(y['forbidden20']):<4}{x['rel100']:>4}->{y['rel100']:<4}"
              f"{x['timings']['warm']['request']:>6.2f}->{y['timings']['warm']['request']:<6.2f}"
              f"{(x['timings']['warm']['facets'] or 0):>6.2f}->{(y['timings']['warm']['facets'] or 0):<6.2f}")
    mean = lambda rs, k: sum(r[k] for r in rs) / len(rs)
    A, B = [a[q] for q in qs], [b[q] for q in qs]
    print()
    print(f"mean precision@20   {mean(A, 'p20'):.3f} -> {mean(B, 'p20'):.3f}")
    print(f"mean relevant@100   {mean(A, 'rel100'):.1f} -> {mean(B, 'rel100'):.1f}")
    print(f"forbidden in top 20 {sum(len(r['forbidden20']) for r in A)} -> {sum(len(r['forbidden20']) for r in B)}")
    for stage in ("match", "rank", "page", "facets", "request"):
        xa = [r["timings"]["warm"][stage] for r in A]
        xb = [r["timings"]["warm"][stage] for r in B]
        print(f"{stage:8} warm p50 {pct(xa, .5) or 0:.3f}s -> {pct(xb, .5) or 0:.3f}s   p95 {pct(xa, .95) or 0:.3f}s -> {pct(xb, .95) or 0:.3f}s")
    xa = [r["timings"]["cold"]["request"] for r in A]
    xb = [r["timings"]["cold"]["request"] for r in B]
    print(f"request  cold p50 {pct(xa, .5) or 0:.3f}s -> {pct(xb, .5) or 0:.3f}s   p95 {pct(xa, .95) or 0:.3f}s -> {pct(xb, .95) or 0:.3f}s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=str(HERE.parent / "api"))
    ap.add_argument("--out", default="search_eval_result.json")
    ap.add_argument("--only")
    ap.add_argument("--compare", nargs=2)
    a = ap.parse_args()
    if a.compare:
        compare(*a.compare)
    else:
        run(a.api, a.out, a.only)
