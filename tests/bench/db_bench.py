"""Time the board's heaviest routes in-process against one database file.

    DATA_PATH=/path/to/jobs.db python tests/bench/db_bench.py [--out result.json]

Read-only. Calls handler.route_jobs, route_facets and route_job_detail
directly, so no server and no S3 (DATA_BUCKET unset means no description
blob and live facets, which is the path a missing precomputed artifact
takes). Each route runs once in a fresh process, which is the first read
after the file is opened, then three more times; the median of those is
"warm". Beside each time it reports the bytes SQLite asked the OS for:
SQLite's own cache is 2MB, so that is close to the pages a query touches,
and it is what a cold page cache has to read from disk.
"""

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

ROUTES = [
    ("jobs", {"limit": "50"}),
    ("jobs", {"limit": "50", "search": "azure"}),
    ("jobs", {"limit": "50", "search": "devops"}),
    ("jobs", {"limit": "50", "country": "US"}),
    ("jobs", {"limit": "50", "country": "IL"}),
    ("facets", {}),
    ("facets", {"search": "devops"}),
    ("facets", {"country": "US"}),
    ("facets", {"roles": "tech"}),
    ("facets", {"confidence": "all"}),
    ("facets", {"confidence": "all", "roles": "tech", "country": "IL"}),
    ("detail", {}),
]


def read_bytes() -> int:
    """Bytes this process has read through the OS so far, cache hits included."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
        io = IO()
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.GetProcessIoCounters.argtypes = [wintypes.HANDLE, ctypes.POINTER(IO)]
        k32.GetProcessIoCounters(k32.GetCurrentProcess(), ctypes.byref(io))
        return io.ReadTransferCount
    for line in open("/proc/self/io"):
        if line.startswith("rchar:"):
            return int(line.split()[1])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    args = ap.parse_args()
    os.environ.pop("DATA_BUCKET", None)
    os.environ.setdefault("ALERTS_TABLE", "x")
    os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
    # handler and db make S3 clients at import; this never calls them.
    os.environ.setdefault("AWS_ACCESS_KEY_ID", "bench")
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "bench")
    sys.path.insert(0, str(ROOT / "api"))
    import handler
    from db import get_connection

    conn = get_connection()
    # A listing that exists, fixed per file so every run asks for the same one.
    job_id = conn.execute("SELECT id FROM jobs WHERE closed_at IS NULL ORDER BY id LIMIT 1 OFFSET 1000").fetchone()[0]
    results = []
    for name, params in ROUTES:
        times, reads = [], []
        for _ in range(4):
            handler._scoped_cache.clear()
            before, t = read_bytes(), time.perf_counter()
            if name == "jobs":
                handler.route_jobs(dict(params))
            elif name == "facets":
                handler.route_facets(dict(params))
            else:
                handler.route_job_detail(job_id)
            times.append(time.perf_counter() - t)
            reads.append(read_bytes() - before)
        label = name + ("?" + "&".join(f"{k}={v}" for k, v in params.items()) if params else "")
        row = {"route": label, "first_s": round(times[0], 3), "warm_s": round(statistics.median(times[1:]), 3),
               "first_mb": round(reads[0] / 1e6, 1), "warm_mb": round(statistics.median(reads[1:]) / 1e6, 1)}
        results.append(row)
        print(f"{label:40} first {row['first_s']:7.3f}s {row['first_mb']:8.1f}MB   "
              f"warm {row['warm_s']:7.3f}s {row['warm_mb']:8.1f}MB", flush=True)
    if args.out:
        Path(args.out).write_text(json.dumps({"db": os.environ.get("DATA_PATH"), "results": results}, indent=1),
                                  encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
