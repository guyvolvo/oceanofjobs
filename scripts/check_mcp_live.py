"""Check the live MCP endpoint, and that the site around it is unchanged.

    python scripts/check_mcp_live.py            # the server is meant to be up
    python scripts/check_mcp_live.py --down     # the route is deleted: expect CloudFront's 503
    python scripts/check_mcp_live.py --ttl      # also wait out a cache entry (about 3 minutes)
    python scripts/check_mcp_live.py --burst    # also trip the origin limiter (about 140 box reads)

Prints one line per check and exits 1 if any failed.
"""

import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

MCP = "https://oceanofjobs.com/mcp"
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


def http(url: str, body=None, method=None, headers=None) -> tuple[int, dict, str]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"), headers={
        "User-Agent": "otj-mcp-check", "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read().decode("utf-8")


_id = 0


def rpc(method: str, params=None, version="2025-11-25"):
    global _id
    _id += 1
    status, headers, text = http(MCP, {"jsonrpc": "2.0", "id": _id, "method": method, **({"params": params} if params is not None else {})},
                                 headers={"MCP-Protocol-Version": version})
    return status, headers, (json.loads(text) if text else None)


def tool(name: str, args: dict):
    status, headers, body = rpc("tools/call", {"name": name, "arguments": args})
    return headers, body["result"]


def site_unchanged() -> None:
    status, headers, text = http("https://oceanofjobs.com/")
    check("homepage still 200 HTML", status == 200 and "text/html" in headers.get("content-type", ""), str(status))
    status, headers, _ = http("https://oceanofjobs.com/board")
    check("board still 200", status == 200, str(status))
    status, headers, text = http(f"https://oceanofjobs.com/api/health?r={time.time_ns()}")
    check("API still answers through otj-box-router", status == 200 and headers.get("x-otj-origin") == "box", f"{status} {headers.get('x-otj-origin')}")
    # The board's own first request. An unfiltered /api/jobs counts every
    # row and can hit the box's 25s guard during an apply, MCP or not.
    status, _, text = http(f"https://oceanofjobs.com/api/jobs?country=IL&sort=age&limit=50&r={time.time_ns()}")
    check("the board's jobs query still 200 JSON", status == 200 and text.startswith("{"), str(status))


def down() -> None:
    status, headers, text = http(MCP, {"jsonrpc": "2.0", "id": 1, "method": "ping"})
    body = json.loads(text) if text.startswith("{") else {}
    check("POST /mcp answers 503", status == 503, str(status))
    check("the body is a JSON-RPC error", body.get("jsonrpc") == "2.0" and body.get("error", {}).get("code") == -32000, text[:200])
    check("Retry-After is set", int(headers.get("retry-after", "0")) >= 60, str(headers.get("retry-after")))
    check("served by CloudFront, not the Worker", "x-otj-cache" not in headers and "cloudfront" in headers.get("x-cache", "").lower(), str(headers))
    site_unchanged()


def up(ttl: bool, burst: bool) -> None:
    for v in ("2025-11-25", "2025-06-18", "2025-03-26"):
        status, _, body = rpc("initialize", {"protocolVersion": v, "capabilities": {}, "clientInfo": {"name": "otj-mcp-check", "version": "1"}}, v)
        check(f"initialize on {v}", status == 200 and body["result"]["protocolVersion"] == v, json.dumps(body)[:200])
    status, _, body = http(MCP, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    check("notification gets 202", status == 202, str(status))
    status, _, body = rpc("tools/list")
    names = [t["name"] for t in body["result"]["tools"]]
    check("tools/list has the three tools", names == ["search_jobs", "get_job", "get_company"], str(names))
    status, _, _ = http(MCP)
    check("GET /mcp is 405", status == 405, str(status))

    args = {"query": "devops", "country": "IL", "limit": 3}
    h1, r1 = tool("search_jobs", args)
    jobs = r1["structuredContent"]["jobs"] if not r1["isError"] else []
    check("search_jobs returns jobs", len(jobs) > 0, r1["content"][0]["text"][:200])
    if jobs:
        j = jobs[0]
        keys = list(j)
        check("permalink first, ATS link second", keys.index("url") < keys.index("apply_url") and j["url"].endswith("?ref=mcp"), str(keys))
        check("lifetime present", j["lifetime"]["status"] in ("open", "closed") and "first seen" in j["lifetime"]["summary"], str(j["lifetime"]))
    h2, r2 = tool("search_jobs", {"limit": 3, "country": "il", "query": "DevOps"})
    check("the same search again is a cache hit", h2.get("x-otj-cache") == "hit=1 miss=0", f"{h1.get('x-otj-cache')} then {h2.get('x-otj-cache')}")
    if jobs:
        h3, r3 = tool("get_job", {"id": jobs[0]["id"]})
        out = r3.get("structuredContent") or {}
        check("get_job returns the job", not r3["isError"] and out.get("id") == jobs[0]["id"], r3["content"][0]["text"][:200])
        check("description is text or null", out.get("description") is None or "<" not in out["description"][:2000], "")
        h4, _ = tool("get_job", {"id": jobs[0]["id"]})
        check("get_job again is a cache hit", h4.get("x-otj-cache") == "hit=1 miss=0", str(h4.get("x-otj-cache")))
    _, r5 = tool("get_company", {"company": "Wix"})
    check("get_company finds Wix", not r5["isError"] and r5["structuredContent"]["domain"] == "wix.com", r5["content"][0]["text"][:200])
    _, r6 = tool("search_jobs", {"offset": 201})
    check("offset past 200 is a tool error", r6["isError"], json.dumps(r6)[:200])
    _, r7 = tool("get_job", {"id": "0000000000000000"})
    check("an unknown job id is a tool error", r7["isError"], json.dumps(r7)[:200])
    site_unchanged()

    if ttl:
        print("waiting 185s for the cache entry to expire ...")
        time.sleep(185)
        h8, _ = tool("search_jobs", args)
        check("after its TTL the search is a miss again", h8.get("x-otj-cache") == "hit=0 miss=1", str(h8.get("x-otj-cache")))

    if burst:
        ids = []
        for offset in range(0, 200, 25):
            _, r = tool("search_jobs", {"country": "IL", "limit": 25, "offset": offset})
            ids += [j["id"] for j in r["structuredContent"]["jobs"]]
        ids = ids[:140]

        def one(i):
            _, r = tool("get_job", {"id": i})
            return "limited" if r["isError"] and "too many" in r["content"][0]["text"] else ("error" if r["isError"] else "ok")

        with ThreadPoolExecutor(8) as ex:
            outcomes = list(ex.map(one, ids))
        counts = {k: outcomes.count(k) for k in ("ok", "limited", "error")}
        print(f"burst of {len(ids)} new get_job calls: {counts}")
        check("the origin limiter trips under a burst", counts["limited"] > 0, str(counts))
        _, again = tool("get_job", {"id": ids[0]})
        check("cached answers still serve while limited", not again["isError"], again["content"][0]["text"][:200])


if __name__ == "__main__":
    if "--down" in sys.argv:
        down()
    else:
        up("--ttl" in sys.argv, "--burst" in sys.argv)
    print(f"\n{len(failures)} failed" if failures else "\nall passed")
    sys.exit(1 if failures else 0)
