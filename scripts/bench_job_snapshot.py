"""Times the job page's hiring-snapshot queries (api/handler.py
_job_page_sidebar) read-only on the box, for the company with the most
open jobs and for wix.com, before shipping them.

    python scripts/bench_job_snapshot.py

Opens the database read-only at low CPU priority; changes nothing.
Needs the openmarket-tf AWS profile and gh signed in to the repo.
"""
import json
import subprocess
import time

P = ["--profile", "openmarket-tf", "--region", "il-central-1", "--output", "json"]
SCRIPT = r'''
import sqlite3, time
c = sqlite3.connect("file:/var/lib/otj/jobs.db?mode=ro", uri=True, timeout=5)
t = time.time()
big = c.execute("SELECT company_domain, COUNT(*) n FROM jobs INDEXED BY idx_jobs_open_company WHERE closed_at IS NULL "
                "GROUP BY company_domain ORDER BY n DESC LIMIT 1").fetchone()
print("biggest", big, round((time.time() - t) * 1000), "ms to find")
for d in (big[0], "wix.com"):
    for col in ("city", "category"):
        t = time.time()
        r = c.execute(f"SELECT {col}, COUNT(*) FROM jobs INDEXED BY idx_jobs_open_facets WHERE company_domain = ? AND closed_at IS NULL "
                      f"AND {col} IS NOT NULL AND {col} != '' GROUP BY {col} ORDER BY 2 DESC LIMIT 12", (d,)).fetchall()
        print(d, col, round((time.time() - t) * 1000, 1), "ms", r[:3])
    t = time.time()
    r = c.execute("SELECT COUNT(*) FROM jobs INDEXED BY idx_jobs_open_facets WHERE company_domain = ? AND closed_at IS NULL "
                  "AND workplace_type = 'remote'", (d,)).fetchone()
    print(d, "remote", round((time.time() - t) * 1000, 1), "ms", r)
    t = time.time()
    r = c.execute("SELECT COUNT(*) FROM jobs WHERE company_domain = ? AND closed_at IS NULL AND first_seen >= ?",
                  (d, "2026-10-18")).fetchone()
    print(d, "new_7d", round((time.time() - t) * 1000, 1), "ms", r)
'''


def main() -> None:
    inst = subprocess.run("gh variable get BOX_INSTANCE_ID", shell=True, capture_output=True, text=True).stdout.strip()
    cmd = "nice -n 10 python3 - <<'PYEOF'\n" + SCRIPT + "\nPYEOF"
    cid = json.loads(subprocess.run(["aws", "ssm", "send-command", "--instance-ids", inst, "--document-name", "AWS-RunShellScript",
                                     "--parameters", json.dumps({"commands": [cmd]}), *P], capture_output=True, text=True).stdout)["Command"]["CommandId"]
    for _ in range(60):
        time.sleep(3)
        r = subprocess.run(["aws", "ssm", "get-command-invocation", "--command-id", cid, "--instance-id", inst, *P], capture_output=True, text=True)
        if r.returncode == 0 and json.loads(r.stdout)["Status"] not in ("Pending", "InProgress", "Delayed"):
            out = json.loads(r.stdout)
            print(out["Status"], out["StandardOutputContent"][-3000:], out["StandardErrorContent"][-1500:], sep="\n")
            return
    print("no answer after three minutes")


if __name__ == "__main__":
    main()
