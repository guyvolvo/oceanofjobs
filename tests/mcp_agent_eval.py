"""How an AI client uses the MCP server on one realistic request.

    python tests/mcp_agent_eval.py [https://oceanofjobs.com/mcp]

Runs the prompt below through Claude Code (claude -p) against the live
server, records every tool call, and checks the answer. It costs a model
session each run, about $0.5 to $1.7 in Claude usage, so it is run by
hand after changing the tool descriptions or instructions, never in CI.

The prompt is the one that, on 2026-10-19, took 17 tool calls and $1.65:
seven searches, each loosening a query that required every word, and
ten get_job calls. The search guidance in search_jobs' description was
written against it.

Fails (exit 1) when the answer is wrong in kind: a recommended job never
opened with get_job, a recommendation without both links, or fewer
recommendations than asked for. Warns on the targets, which are not
guarantees: at most 2 searches and 8 tool calls. A second search that
finds better jobs is worth it.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

PROMPT = ("I'm a senior backend engineer (Python, Kubernetes) in Tel Aviv. Using Ocean of Jobs, find me the 3 "
          "best-fitting open roles posted in the last two weeks, and tell me whether any of them is a repost or has "
          "been open a long time.")
WANTED = 3
MAX_SEARCHES = 2
MAX_CALLS = 8
TOOLS = ["mcp__oceanofjobs__search_jobs", "mcp__oceanofjobs__get_job", "mcp__oceanofjobs__get_company"]


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else "https://oceanofjobs.com/mcp"
    with tempfile.TemporaryDirectory() as tmp:
        cfg = os.path.join(tmp, "mcp.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {"oceanofjobs": {"type": "http", "url": url}}}, f)
        run = subprocess.run(
            ["claude", "-p", PROMPT, "--mcp-config", cfg, "--strict-mcp-config", "--allowedTools", ",".join(TOOLS),
             "--max-turns", "20", "--output-format", "stream-json", "--verbose"],
            capture_output=True, text=True, encoding="utf-8", timeout=900, cwd=tmp)
    calls, opened, final, cost = [], set(), "", None
    for line in run.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "assistant":
            for block in event["message"].get("content", []):
                if block.get("type") == "tool_use" and block["name"].startswith("mcp__oceanofjobs__"):
                    name = block["name"].rsplit("__", 1)[-1]
                    calls.append((name, block["input"]))
                    if name == "get_job":
                        opened.add(str(block["input"].get("id")))
        elif event.get("type") == "result":
            final, cost = event.get("result") or "", event.get("total_cost_usd")
    if not final:
        print("no answer from claude -p:", (run.stderr or run.stdout)[-800:])
        return 1

    searches = [a for n, a in calls if n == "search_jobs"]
    recommended = list(dict.fromkeys(re.findall(r"oceanofjobs\.com/job/([A-Za-z0-9_-]+)", final)))[:WANTED]
    links = re.findall(r"https?://[^\s)>\]]+", final)
    employer_links = [u for u in links if "oceanofjobs.com" not in u]

    print(f"{len(calls)} tool calls ({len(searches)} searches, {len(opened)} get_job), cost ${cost}")
    for name, args in calls:
        print(f"  {name} {json.dumps(args, ensure_ascii=False)[:150]}")
    print("\n" + final + "\n")

    failures = []
    if len(recommended) < WANTED:
        failures.append(f"{len(recommended)} recommendations with an Ocean of Jobs link, wanted {WANTED}")
    unread = [r for r in recommended if r not in opened]
    if unread:
        failures.append(f"recommended without get_job: {unread}")
    if len(employer_links) < len(recommended):
        failures.append(f"{len(employer_links)} employer links for {len(recommended)} recommendations")
    warnings = []
    if len(searches) > MAX_SEARCHES:
        warnings.append(f"{len(searches)} searches, target {MAX_SEARCHES}")
    if len(calls) > MAX_CALLS:
        warnings.append(f"{len(calls)} tool calls, target {MAX_CALLS}")
    for w in warnings:
        print("WARN:", w)
    for f in failures:
        print("FAIL:", f)
    print("passed" if not failures else f"{len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
