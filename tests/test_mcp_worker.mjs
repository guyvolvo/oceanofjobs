// The MCP Worker, driven through its own fetch handler with a stub box
// and an in-memory stand-in for Cloudflare's cache that honours max-age
// against a clock the test moves.
//
// Run:  node --test tests/test_mcp_worker.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../infra/mcp-worker.mjs";

let clock = 0;
let store;
let calls;
let routes;
let pending;
let points;
let limiterOpen;

class MemCache {
  async match(req) {
    const e = store.get(req.url);
    if (!e || clock >= e.expires) return undefined;
    return new Response(e.body, { headers: e.headers });
  }
  async put(req, res) {
    const m = (res.headers.get("cache-control") || "").match(/max-age=(\d+)/);
    store.set(req.url, { body: await res.text(), headers: Object.fromEntries(res.headers), expires: clock + Number(m[1]) * 1000, cc: res.headers.get("cache-control") });
  }
}
globalThis.caches = { default: new MemCache() };

const PUBLIC = { "content-type": "application/json", "cache-control": "public, max-age=60, s-maxage=180" };

function job(over = {}) {
  return {
    id: "67ff4ef965d91ef7", company_domain: "acme.com", company_name: "Acme", title: "Backend Engineer",
    location: "Tel Aviv, Israel", workplace_type: "hybrid", seniority: "senior", category: "Software Engineering",
    url: "https://boards.greenhouse.io/acme/jobs/1", posted_at: "2026-10-01T00:00:00+00:00",
    first_seen: "2026-10-09T00:00:00+00:00", last_seen: "2026-10-18T06:00:00+00:00", closed_at: null,
    salary_text: "₪30K–40K", salary_is_estimate: 1, ...over,
  };
}

function route(prefix, status, body, headers = PUBLIC) {
  routes.push({ prefix, status, body, headers });
}

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), headers: init && init.headers });
  const path = String(url).replace("https://box.oceanofjobs.com", "");
  const r = routes.find((x) => path.startsWith(x.prefix));
  if (!r) return new Response("{}", { status: 404, headers: PUBLIC });
  const body = r.status === 204 ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return new Response(body, { status: r.status, headers: r.headers });
};

const env = {
  ORIGIN_KEY: "test-key",
  ORIGIN_LIMIT: { limit: async () => ({ success: limiterOpen }) },
  MCP_EVENTS: { writeDataPoint: (p) => points.push(p) },
};
const ctx = { waitUntil: (p) => pending.push(p) };

beforeEach(() => {
  clock = Date.parse("2026-10-19T12:00:00Z");
  store = new Map();
  calls = [];
  routes = [];
  pending = [];
  points = [];
  limiterOpen = true;
});

async function post(body, headers = {}) {
  const res = await worker.fetch(new Request("https://oceanofjobs.com/mcp", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env, ctx);
  await Promise.all(pending.splice(0));
  return res;
}

let nextId = 1;
async function call(name, args) {
  const res = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
  const body = await res.json();
  return { res, body, result: body.result, out: body.result && body.result.structuredContent };
}

// Date.now inside the Worker follows the test clock.
const realNow = Date.now;
Date.now = () => clock;

test("initialize echoes a supported revision and falls back to the newest", async () => {
  for (const [asked, expected] of [["2025-06-18", "2025-06-18"], ["2025-03-26", "2025-03-26"], ["2099-01-01", "2025-11-25"]]) {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const body = await res.json();
    assert.equal(body.result.protocolVersion, expected);
    assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(body.result.serverInfo.name, "oceanofjobs");
    assert.match(body.result.instructions, /first_seen/);
  }
  assert.equal(points.at(-1).blobs[3], "t", "the client's name is counted on initialize");
});

test("notifications get 202 with no body", async () => {
  const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("tools/list has the three public read-only tools, then the account's saved-job, queue, alert and preference tools", async () => {
  const body = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(body.result.tools.map((t) => t.name),
    ["search_jobs", "get_job", "get_company", "save_job", "list_saved_jobs", "remove_saved_job",
      "queue_for_auto_apply", "list_auto_apply_queue", "remove_from_auto_apply_queue",
      "list_alerts", "create_alert", "update_alert", "delete_alert", "get_preferences", "update_preferences"]);
  const hints = Object.fromEntries(body.result.tools.map((t) => [t.name, t.annotations]));
  for (const n of ["search_jobs", "get_job", "get_company", "list_saved_jobs", "list_auto_apply_queue"]) assert.equal(hints[n].readOnlyHint, true, n);
  assert.equal(hints.queue_for_auto_apply.readOnlyHint, false);
  assert.equal(hints.remove_from_auto_apply_queue.destructiveHint, true);
  assert.equal(hints.save_job.readOnlyHint, false);
  assert.equal(hints.remove_saved_job.destructiveHint, true);
  for (const n of ["list_alerts", "get_preferences"]) assert.equal(hints[n].readOnlyHint, true, n);
  for (const n of ["create_alert", "update_alert", "update_preferences"]) assert.equal(hints[n].readOnlyHint, false, n);
  assert.equal(hints.delete_alert.destructiveHint, true);
  for (const t of body.result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.outputSchema.type, "object");
  }
});

const TOKEN = "ooj_dTE.0a1b2c3d.abcdefghijklmnopqrstuvwxyz012345";
const BOX_URL = "https://box.oceanofjobs.com";

test("saved-job tools need a token and say how to get one", async () => {
  for (const [name, args] of [["save_job", { id: "67ff4ef965d91ef7" }], ["list_saved_jobs", {}], ["remove_saved_job", { id: "67ff4ef965d91ef7" }],
    ["queue_for_auto_apply", { id: "67ff4ef965d91ef7" }], ["list_auto_apply_queue", {}], ["remove_from_auto_apply_queue", { id: "67ff4ef965d91ef7" }],
    ["list_alerts", {}], ["create_alert", { filter: { search: "devops" } }], ["get_preferences", {}], ["update_preferences", { cadence: "daily" }]]) {
    const { result } = await call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /personal access token/);
  }
  assert.equal(calls.length, 0, "nothing reached the box");
});

test("save, list and remove send the token to the box and are never cached", async () => {
  route("/api/me/saved/", 204, null, { "cache-control": "public, max-age=300" });
  route("/api/me/saved", 200, { saved: [{ job_id: "67ff4ef965d91ef7", saved_at: "2026-10-20T10:00:00+00:00" }, { job_id: "deadbeefdeadbeef", saved_at: null }] },
    { "content-type": "application/json", "cache-control": "public, max-age=300" });
  route("/api/jobs/67ff4ef965d91ef7", 200, job());
  const auth = { authorization: "Bearer " + TOKEN };
  const res = await post({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "save_job", arguments: { id: "67ff4ef965d91ef7" } } }, auth);
  const saved = (await res.json()).result.structuredContent;
  assert.deepEqual(saved, { id: "67ff4ef965d91ef7", saved: true, url: "https://oceanofjobs.com/job/67ff4ef965d91ef7?ref=mcp" });
  assert.equal(calls[0].url, "https://box.oceanofjobs.com/api/me/saved/67ff4ef965d91ef7");
  assert.equal(calls[0].headers.authorization, "Bearer " + TOKEN);
  assert.equal(calls[0].headers["x-otj-origin-key"], "test-key");
  for (let i = 0; i < 2; i++) {
    const list = await post({ jsonrpc: "2.0", id: 51 + i, method: "tools/call", params: { name: "list_saved_jobs", arguments: {} } }, auth);
    const out = (await list.json()).result.structuredContent;
    assert.equal(out.total, 2);
    assert.deepEqual(out.jobs.map((j) => [j.id, j.saved_at]), [["67ff4ef965d91ef7", "2026-10-20T10:00:00+00:00"]]);
    assert.deepEqual(out.gone, ["deadbeefdeadbeef"]);
  }
  assert.equal(calls.filter((c) => c.url.endsWith("/api/me/saved")).length, 2, "the saved list is asked for every time, never served from the cache");
  assert.ok(![...store.keys()].some((k) => k.includes("/api/me/")), "nothing personal is in the shared cache");
});

test("queue, list and remove send the token to the box, and a refusal reads as the box's reason", async () => {
  route("/api/me/apply/queue/", 204, null);
  route("/api/me/apply/queue", 200, { queue: [{ job_id: "67ff4ef965d91ef7", added_at: "2026-10-20T10:00:00+00:00" }] }, { "content-type": "application/json" });
  route("/api/jobs/67ff4ef965d91ef7", 200, job());
  const auth = { authorization: "Bearer " + TOKEN };
  const tool = async (id, name, args) => (await (await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, auth)).json()).result;
  const queued = await tool(70, "queue_for_auto_apply", { id: "67ff4ef965d91ef7" });
  assert.deepEqual(queued.structuredContent, { id: "67ff4ef965d91ef7", queued: true, url: "https://oceanofjobs.com/job/67ff4ef965d91ef7?ref=mcp" });
  assert.equal(calls[0].url, "https://box.oceanofjobs.com/api/me/apply/queue/67ff4ef965d91ef7");
  assert.equal(calls[0].headers.authorization, "Bearer " + TOKEN);
  const list = await tool(71, "list_auto_apply_queue", {});
  assert.deepEqual(list.structuredContent.jobs.map((j) => [j.id, j.added_at]), [["67ff4ef965d91ef7", "2026-10-20T10:00:00+00:00"]]);
  const removed = await tool(72, "remove_from_auto_apply_queue", { id: "67ff4ef965d91ef7" });
  assert.deepEqual(removed.structuredContent, { id: "67ff4ef965d91ef7", queued: false });
  assert.ok(![...store.keys()].some((k) => k.includes("/api/me/")), "nothing personal is in the shared cache");
  routes.unshift({ prefix: "/api/me/apply/queue/", status: 403, body: { error: "Turn on \"Jobs queued by my AI assistant through MCP\" in your auto apply settings at https://oceanofjobs.com/account#aa-settings" }, headers: { "content-type": "application/json" } });
  const refused = await tool(73, "queue_for_auto_apply", { id: "67ff4ef965d91ef7" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Turn on "Jobs queued by my AI assistant through MCP".*#aa-settings/);
  routes.unshift({ prefix: "/api/me/apply/queue/", status: 422, body: { error: "The extension can't apply on this job's site (workday) yet. It fills Greenhouse forms for now." }, headers: { "content-type": "application/json" } });
  const unfillable = await tool(74, "queue_for_auto_apply", { id: "97602f3e8d77ca9a" });
  assert.equal(unfillable.isError, true);
  assert.equal(unfillable.content[0].text, "Ocean of Jobs refused that: The extension can't apply on this job's site (workday) yet. It fills Greenhouse forms for now.");
});

test("alert and preference tools: the token goes to the box, bodies are JSON, preferences merge", async () => {
  const ALERT_ID = "0b6c3f2e-1d2a-4c5b-8e9f-0a1b2c3d4e5f";
  const alert = { alert_id: ALERT_ID, user_id: "u1", email: "dana@example.com", active: true, filter: { search: "devops" }, created_at: "2026-10-22T09:00:00+00:00" };
  route("/api/me/alerts/", 200, { ...alert, active: false }, { "content-type": "application/json" });
  route("/api/me/alerts", 200, { alerts: [alert] }, { "content-type": "application/json" });
  route("/api/me/profile", 200, { profile: { skills: ["Python"], seniority: null, workplace: ["remote"], country: ["IL"], city: [], israel_only: true,
    cadence: "instant", digest_time: "09:00", digest_tz: "Asia/Jerusalem", digest_day: 0 } }, { "content-type": "application/json" });
  const auth = { authorization: "Bearer " + TOKEN };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body), headers: init.headers }); return realFetch(url, init); };
  try {
    const tool = async (name, args) => (await (await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, auth)).json()).result;
    const list = await tool("list_alerts", {});
    assert.deepEqual(list.structuredContent, { alerts: [{ id: ALERT_ID, active: true, filter: { search: "devops" }, created_at: "2026-10-22T09:00:00+00:00" }] });
    assert.ok(!JSON.stringify(list).includes("dana@example.com"), "the address isn't passed on to the model");
    await tool("create_alert", { filter: { search: " devops ", country: "IL" } });
    assert.deepEqual([sent.at(-1).method, sent.at(-1).url.replace(BOX_URL, ""), sent.at(-1).body], ["POST", "/api/me/alerts", { filter: { search: "devops", country: "IL" } }]);
    assert.equal(sent.at(-1).headers["content-type"], "application/json");
    assert.equal(sent.at(-1).headers.authorization, "Bearer " + TOKEN);
    const paused = await tool("update_alert", { id: ALERT_ID, active: false });
    assert.equal(paused.structuredContent.active, false);
    assert.deepEqual([sent.at(-1).method, sent.at(-1).url.replace(BOX_URL, ""), sent.at(-1).body], ["PATCH", `/api/me/alerts/${ALERT_ID}`, { active: false }]);
    const gone = await tool("delete_alert", { id: ALERT_ID });
    assert.deepEqual(gone.structuredContent, { id: ALERT_ID, deleted: true });
    assert.equal(sent.at(-1).method, "DELETE");
    for (const [name, args, why] of [["update_alert", { id: "%23apply_profile" }, /alert id/], ["delete_alert", { id: "#token#abcd1234" }, /alert id/],
      ["update_alert", { id: ALERT_ID }, /active, filter or both/], ["create_alert", { filter: { q: "x" } }, /Unknown filter field: q/],
      ["create_alert", { filter: {} }, /at least one field/]]) {
      const before = sent.length;
      const r = await tool(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, why);
      assert.equal(sent.length, before, "a bad argument never reaches the box");
    }
    const prefs = await tool("update_preferences", { cadence: "daily", skills: ["Python", "Go"] });
    const put = sent.at(-1);
    assert.equal(put.method, "PUT");
    assert.deepEqual(put.body, { skills: ["Python", "Go"], seniority: null, workplace: ["remote"], country: ["IL"], city: [], israel_only: true,
      cadence: "daily", digest_time: "09:00", digest_tz: "Asia/Jerusalem", digest_day: 0 }, "the fields not given go back unchanged");
    assert.equal(prefs.structuredContent.israel_only, true);
    assert.ok(![...store.keys()].some((k) => k.includes("/api/me/")), "nothing personal is in the shared cache");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a revoked token is a readable tool error, and other Authorization headers are ignored", async () => {
  route("/api/me/saved", 401, { error: "unauthorized" });
  const res = await post({ jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: "list_saved_jobs", arguments: {} } }, { authorization: "Bearer " + TOKEN });
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /revoked or expired/);
  const other = await post({ jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "list_saved_jobs", arguments: {} } }, { authorization: "Bearer eyJhbGciOi.some.jwt" });
  assert.match((await other.json()).result.content[0].text, /needs an Ocean of Jobs personal access token/);
  assert.ok(!JSON.stringify(points).includes(TOKEN), "the token is never in analytics");
});

test("transport edges: GET, OPTIONS, bad JSON, batches, versions, paths, methods", async () => {
  const get = await worker.fetch(new Request("https://oceanofjobs.com/mcp"), env, ctx);
  assert.equal(get.status, 405);
  const opt = await worker.fetch(new Request("https://oceanofjobs.com/mcp", { method: "OPTIONS" }), env, ctx);
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
  assert.equal((await post("{nope")).status, 400);
  assert.equal((await (await post("{nope")).json()).error.code, -32700);
  assert.equal((await post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status, 400);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" })).status, 400);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2025-06-18" })).status, 200);
  assert.equal((await (await post({ jsonrpc: "2.0", id: 1, method: "resources/list" })).json()).error.code, -32601);
  assert.equal((await (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drop_db" } })).json()).error.code, -32602);
  const other = await worker.fetch(new Request("https://oceanofjobs.com/mcpx", { method: "POST", body: "{}" }), env, ctx);
  assert.equal(other.status, 404);
  assert.equal((await post("x".repeat(70000))).status, 413);
  assert.equal(calls.length, 0, "none of these reach the box");
});

test("the same search in any order or spelling is one cache entry and one box request", async () => {
  route("/api/jobs?", 200, { jobs: [job()], total: 1 });
  const a = await call("search_jobs", { query: "Backend  Python", country: "il", workplace: "Hybrid", limit: 5 });
  const b = await call("search_jobs", { limit: 5, workplace: "hybrid", country: "IL", query: "backend python " });
  assert.equal(calls.length, 1);
  assert.equal(a.res.headers.get("x-otj-cache"), "hit=0 miss=1");
  assert.equal(b.res.headers.get("x-otj-cache"), "hit=1 miss=0");
  assert.deepEqual(a.out, b.out);
  const u = new URL(calls[0].url);
  assert.deepEqual([...u.searchParams.keys()], [...u.searchParams.keys()].sort(), "parameters are sorted");
  assert.equal(u.searchParams.get("search"), "backend python");
  assert.equal(u.searchParams.get("workplace"), "hybrid");
  assert.equal(u.searchParams.get("sort"), "relevance");
  assert.equal(u.searchParams.get("limit"), "5");
  assert.equal(calls[0].headers["x-otj-origin-key"], "test-key");
});

test("sort follows the board: relevance with a query, newest without", async () => {
  route("/api/jobs?", 200, { jobs: [], total: 0 });
  await call("search_jobs", { query: "python" });
  await call("search_jobs", { country: "IL" });
  assert.equal(new URL(calls[0].url).searchParams.get("sort"), "relevance");
  assert.equal(new URL(calls[1].url).searchParams.get("sort"), "age");
  assert.equal(new URL(calls[1].url).searchParams.get("limit"), "10", "the default page is 10, not the API's 100");
});

test("caps and bad arguments come back as tool errors the model can read", async () => {
  route("/api/jobs?", 200, { jobs: [], total: 0 });
  for (const [args, pattern] of [
    [{ country: "IL", limit: 26 }, /limit must be/],
    [{ country: "IL", offset: 201 }, /REST API/],
    [{ country: "IL", offset: 1.5 }, /offset must be/],
    [{ country: "IL", seniority: "wizard" }, /seniority must be one of/],
    [{ country: "Israel" }, /two-letter/],
    [{ country: "IL", skills: ["Go"] }, /Unknown argument: skills/],
    [{ salary: 5 }, /Unknown argument: salary/],
    // Measured live: no narrowing filter means a count of every open row
    // and the box's 25s guard. Workplace or seniority alone are not enough.
    [{}, /at least one of query, company, city or country/],
    [{ workplace: "remote", seniority: "senior" }, /at least one of/],
  ]) {
    const { result } = await call("search_jobs", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, pattern);
  }
  assert.equal(calls.length, 0);
});

test("a busy box is an error, and it is not cached", async () => {
  route("/api/jobs?", 503, { error: "busy" });
  const first = await call("search_jobs", { query: "devops" });
  assert.equal(first.result.isError, true);
  assert.match(first.result.content[0].text, /busy/);
  await call("search_jobs", { query: "devops" });
  assert.equal(calls.length, 2, "asked again, not served from cache");
  assert.equal(store.size, 0);
});

test("only public 200 JSON answers are stored", async () => {
  const cases = [
    [200, { ...PUBLIC, "cache-control": "private, max-age=60" }],
    [200, { ...PUBLIC, "cache-control": "public, no-store" }],
    [200, { ...PUBLIC, "set-cookie": "a=b" }],
    [200, { "content-type": "text/html", "cache-control": "public, max-age=60" }],
    [200, { "content-type": "application/json" }],
  ];
  for (const [status, headers] of cases) {
    routes = [];
    route("/api/jobs/", status, headers["content-type"] === "text/html" ? "<html>" : job(), headers);
    await call("get_job", { id: "67ff4ef965d91ef7" });
  }
  assert.equal(store.size, 0);
  routes = [];
  route("/api/jobs/", 404, { error: "no job" });
  const missing = await call("get_job", { id: "67ff4ef965d91ef7" });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /No job with id/);
  assert.equal(store.size, 0, "a 404 is not stored either");
});

test("TTL follows s-maxage, is capped at 300s, and expires", async () => {
  route("/api/jobs/aaaa", 200, job({ id: "aaaa" }), { ...PUBLIC, "cache-control": "public, max-age=60, s-maxage=180" });
  route("/api/jobs/bbbb", 200, job({ id: "bbbb" }), { ...PUBLIC, "cache-control": "public, max-age=900" });
  await call("get_job", { id: "aaaa" });
  await call("get_job", { id: "bbbb" });
  const ccs = [...store.values()].map((e) => e.cc);
  assert.deepEqual(ccs, ["public, max-age=180", "public, max-age=300"]);
  clock += 179 * 1000;
  await call("get_job", { id: "aaaa" });
  assert.equal(calls.length, 2, "still fresh at 179s");
  clock += 2 * 1000;
  await call("get_job", { id: "aaaa" });
  assert.equal(calls.length, 3, "fetched again after 180s");
});

test("the origin limiter stops misses but cached answers still serve", async () => {
  route("/api/jobs/", 200, job());
  await call("get_job", { id: "67ff4ef965d91ef7" });
  limiterOpen = false;
  const cached = await call("get_job", { id: "67ff4ef965d91ef7" });
  assert.equal(cached.result.isError, false);
  const fresh = await call("get_job", { id: "ffff000011112222" });
  assert.equal(fresh.result.isError, true);
  assert.match(fresh.result.content[0].text, /too many/);
  assert.equal(calls.length, 1);
  assert.equal(points.at(-1).blobs[2], "limited");
});

test("lifetime is computed, prominent, and the permalink comes before the ATS link", async () => {
  route("/api/jobs?", 200, { jobs: [job(), job({ id: "c1", url: "https://boards.greenhouse.io/acme/jobs/2", closed_at: "2026-10-12T00:00:00+00:00", first_seen: "2026-10-02T00:00:00+00:00" })], total: 2 });
  const { out } = await call("search_jobs", { query: "backend" });
  const [open, closed] = out.jobs;
  assert.deepEqual(Object.keys(open).slice(0, 7), ["id", "title", "company", "company_domain", "lifetime", "url", "apply_url"]);
  assert.equal(open.lifetime.status, "open");
  assert.equal(open.lifetime.days_listed, 10);
  assert.match(open.lifetime.summary, /^Open: first seen 2026-10-09 \(10 days listed\), last seen 2026-10-18\.$/);
  assert.equal(open.lifetime.reappeared_at, null);
  assert.equal(closed.lifetime.status, "closed");
  assert.equal(closed.lifetime.days_listed, 10, "a closed job counts to its closing, not to today");
  assert.equal(open.url, "https://oceanofjobs.com/job/67ff4ef965d91ef7?ref=mcp");
  assert.equal(open.apply_url, "https://boards.greenhouse.io/acme/jobs/1");
  assert.equal(open.salary, "₪30K–40K (estimate)");
  assert.equal(out.more, null);
  const text = (await call("search_jobs", { query: "backend" })).result.content[0].text;
  assert.ok(text.indexOf('"url"') < text.indexOf('"apply_url"'));
});

test("a listing that came back says so, and only from reopened_at", async () => {
  route("/api/jobs?", 200, { jobs: [
    job({ id: "r1", reopened_at: "2026-10-15T00:00:00+00:00", first_seen: "2026-06-01T00:00:00+00:00" }),
    job({ id: "o1", url: "https://x/old", first_seen: "2026-01-01T00:00:00+00:00" }),
  ], total: 2 });
  const [back, old] = (await call("search_jobs", { country: "IL" })).out.jobs;
  assert.equal(back.lifetime.reappeared_at, "2026-10-15T00:00:00+00:00");
  assert.match(back.lifetime.summary, /Seen again on 2026-10-15 after at least two days missing from the board\.$/);
  assert.equal(old.lifetime.reappeared_at, null, "an old first_seen alone is not a return");
  assert.doesNotMatch(old.lifetime.summary, /Seen again/);
});

test("paging hints stop at the offset cap", async () => {
  route("/api/jobs?", 200, { jobs: Array.from({ length: 25 }, (_, i) => job({ id: "j" + i })), total: 900 });
  assert.match((await call("search_jobs", { country: "IL", limit: 25 })).out.more, /offset 25\./);
  assert.match((await call("search_jobs", { country: "IL", limit: 25, offset: 200 })).out.more, /REST API/);
});

test("get_job cuts long descriptions and says so; a missing one is null", async () => {
  route("/api/jobs/long", 200, job({ id: "long", description: "## Role\n" + "x".repeat(7000), department: "R&D", confidence: "verified" }));
  route("/api/jobs/none", 200, job({ id: "none", description: null }));
  const long = (await call("get_job", { id: "long" })).out;
  assert.equal(long.description_truncated, true);
  assert.ok(long.description.length < 6100);
  assert.match(long.description, /full text is at url/);
  assert.equal(long.confidence, "verified");
  const none = (await call("get_job", { id: "none" })).out;
  assert.equal(none.description, null);
  assert.equal(none.description_truncated, false);
  const bad = await call("get_job", { id: "../companies" });
  assert.equal(bad.result.isError, true);
  assert.equal(calls.length, 2);
});

test("get_company finds by name, lists other matches, and skips the lookup for a domain", async () => {
  route("/api/companies/search?", 200, { companies: [{ value: "wix.com", n: 76, name: "Wix" }, { value: "wix2.com", n: 76, name: "Wix" }] });
  route("/api/companies/wix.com", 200, { domain: "wix.com", name: "Wix", ats: "smartrecruiters", open_jobs: 76, new_jobs_7d: 17, tracked_since: "2026-09-01T15:53:12+00:00", history: [] }, { ...PUBLIC, "cache-control": "public, max-age=300, s-maxage=180" });
  route("/api/jobs?", 200, { jobs: [job({ company_domain: "wix.com", company_name: "Wix" })], total: 76 });
  const { out } = await call("get_company", { company: "Wix" });
  assert.equal(out.domain, "wix.com");
  assert.equal(out.url, "https://oceanofjobs.com/company/wix.com?ref=mcp");
  assert.equal(out.open_jobs, 76);
  assert.deepEqual(out.other_matches, [{ domain: "wix2.com", name: "Wix", open_jobs: 76 }]);
  assert.equal(out.newest_jobs.length, 1);
  assert.ok(!("history" in out));
  calls = [];
  store.clear();
  await call("get_company", { company: "wix.com" });
  assert.ok(calls.every((c) => !c.url.includes("/companies/search")));
});

test("search_jobs resolves a company name to its domain", async () => {
  route("/api/companies/search?", 200, { companies: [{ value: "wix.com", n: 76, name: "Wix" }] });
  route("/api/jobs?", 200, { jobs: [], total: 0 });
  await call("search_jobs", { company: "Wix" });
  assert.equal(new URL(calls.at(-1).url).searchParams.get("company"), "wix.com");
  const none = await (async () => { routes = []; route("/api/companies/search?", 200, { companies: [] }); return call("search_jobs", { company: "Nobody Inc" }); })();
  assert.equal(none.result.isError, true);
});

test("structured output carries every required field of its outputSchema", async () => {
  const tools = (await (await post({ jsonrpc: "2.0", id: 9, method: "tools/list" })).json()).result.tools;
  const schema = Object.fromEntries(tools.map((t) => [t.name, t.outputSchema]));
  route("/api/companies/search?", 200, { companies: [{ value: "acme.com", n: 1, name: "Acme" }] });
  route("/api/companies/acme.com", 200, { domain: "acme.com", name: "Acme", ats: "greenhouse", open_jobs: 1, new_jobs_7d: 1, tracked_since: null });
  route("/api/jobs/", 200, job({ description: "text", department: null, confidence: "verified" }));
  route("/api/jobs?", 200, { jobs: [job()], total: 1 });
  for (const [name, args] of [["search_jobs", { query: "x" }], ["get_job", { id: "67ff4ef965d91ef7" }], ["get_company", { company: "Acme" }]]) {
    const { out } = await call(name, args);
    for (const k of schema[name].required) assert.ok(k in out, `${name} is missing ${k}`);
    const items = schema[name].properties.jobs || schema[name].properties.newest_jobs;
    if (items) for (const j of out.jobs || out.newest_jobs) for (const k of items.items.required) assert.ok(k in j, `${name} job is missing ${k}`);
  }
});

test("rows that are one posting fold into one result, and paging still follows the API", async () => {
  const ats = "https://jobs.example.com/acme/1";
  route("/api/jobs?", 200, { jobs: [
    job({ id: "a", url: ats, location: "Israel: Tel Aviv" }),
    job({ id: "b", url: ats, location: "Israel: Jerusalem" }),
    job({ id: "c", url: ats.toUpperCase().replace("HTTPS://", "https://"), location: "Israel: Tel Aviv" }),
    job({ id: "d", url: "https://jobs.example.com/acme/2" }),
  ], total: 40 });
  const { out } = await call("search_jobs", { country: "IL", limit: 4 });
  assert.deepEqual(out.jobs.map((j) => j.id), ["a", "d"]);
  assert.deepEqual(out.jobs[0].other_locations, ["Israel: Jerusalem"]);
  assert.deepEqual(out.jobs[1].other_locations, []);
  assert.equal(out.duplicates_folded, 2);
  assert.match(out.more, /offset 4\./, "the next page starts after the four rows the API sent, not the two kept");
});

test("analytics rows hold the method, tool and outcome, never the arguments", async () => {
  route("/api/jobs?", 200, { jobs: [], total: 0 });
  await call("search_jobs", { query: "secret project" });
  const p = points.at(-1);
  assert.deepEqual(p.blobs.slice(0, 3), ["tools/call", "search_jobs", "ok"]);
  assert.ok(!JSON.stringify(p).includes("secret"));
  assert.equal(p.doubles[2], 1, "one miss");
  assert.deepEqual(p.doubles.slice(4), [0, 0], "a search records its matches and jobs returned");
  await call("get_job", { id: "zzzz" });
  assert.deepEqual(points.at(-1).doubles.slice(4), [-1, -1], "other calls record -1");
});

test.after(() => { Date.now = realNow; });
