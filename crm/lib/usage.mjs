// The Usage page: MCP sessions and tool calls, calls to the public API by
// apps (not the site), and requests the firewall blocked. All of it from
// Cloudflare with a read-only analytics token (CF_ANALYTICS_TOKEN, Account
// Analytics Read + Zone Analytics Read): the MCP Worker's Analytics Engine
// rows (otj_mcp, infra/mcp-worker.mjs) and the zone's request analytics.
// Extension and MCP connections come from the token rows the contacts scan
// already reads (store.mjs).

const ACCOUNT = "2f08a903f97b2824af964b0d4a85a1ed";
const ZONE = "820df5408d0b7e9498a9eacc7584b8ce"; // oceanofjobs.com
// The free plan keeps request analytics for about four weeks.
export const MAX_DAYS = 28;

// MCP clients that open a session only to see the server is up: directories,
// uptime monitors, registries. Measured 2026-11-24 they were about 10,000 of
// 14,308 sessions in 30 days (mcpbeat alone 2,741).
const CHECKER = /probe|prober|monitor|beat|liveness|uptime|health|catalog|registry|collector|crawler|scanner|index|bot|agentrank|glama|histor|check|verif|directory|reliability|validator|inspector|watch|scan|observ/i;
export const isChecker = (client) => !client || CHECKER.test(client);

// API callers that are the site itself, our own tools, or blocked scrapers.
const OURS = /^ooj-|^otj-|oceanofjobs|grafana|synthetic-monitoring/i;
const BLOCKED_UA = /lightpanda|headlesschrome/i;

async function aeSql(env, sql) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, {
    method: "POST", headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` }, body: sql });
  if (!res.ok) throw Object.assign(new Error(`Cloudflare analytics answered ${res.status}.`), { status: 502 });
  return (await res.json()).data || [];
}

async function gql(env, query, variables) {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw Object.assign(new Error("Cloudflare analytics refused the request."), { status: 502 });
  return body.data.viewer.zones[0].httpRequestsAdaptiveGroups;
}

const day = (s) => String(s).slice(0, 10);

// [{date, ...series}] for every day in the range, zeros filled in.
function byDay(days, now, rows) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push({ date: new Date(now - i * 864e5).toISOString().slice(0, 10) });
  const at = Object.fromEntries(out.map((r) => [r.date, r]));
  for (const [date, key, n] of rows) if (at[date]) at[date][key] = (at[date][key] || 0) + n;
  for (const r of out) for (const [, key] of rows) r[key] ||= 0;
  return out;
}

export async function mcp(env, days, now = Date.now()) {
  const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
  const [sessions, calls] = await Promise.all([
    aeSql(env, `SELECT toStartOfDay(timestamp) AS d, blob4 AS client, SUM(_sample_interval) AS n FROM otj_mcp WHERE blob1 = 'initialize' AND ${since} GROUP BY d, client`),
    aeSql(env, `SELECT toStartOfDay(timestamp) AS d, blob2 AS tool, SUM(_sample_interval) AS n FROM otj_mcp WHERE blob1 = 'tools/call' AND ${since} GROUP BY d, tool`),
  ]);
  const clients = {};
  const daily = [];
  let real = 0, checks = 0;
  for (const r of sessions) {
    const n = Number(r.n), checker = isChecker(r.client);
    if (checker) checks += n; else real += n;
    if (!checker) clients[r.client] = (clients[r.client] || 0) + n;
    daily.push([day(r.d), checker ? "checks" : "sessions", n]);
  }
  const tools = {};
  let toolCalls = 0;
  for (const r of calls) {
    const n = Number(r.n);
    // A directory's probe for a tool that doesn't exist is a check too
    // ("__verifymcp_auth_probe_...", "ddd__no_such_tool", "__mcp_index_nonexistent__").
    if (!r.tool || /^_|__|probe|no_such|nonexistent|does-not-exist/i.test(r.tool)) { checks += n; continue; }
    toolCalls += n;
    tools[r.tool] = (tools[r.tool] || 0) + n;
    daily.push([day(r.d), "calls", n]);
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  return { sessions: real, checks, calls: toolCalls, clients: top(clients).slice(0, 15), tools: top(tools), daily: byDay(days, now, daily) };
}

export async function api(env, days, now = Date.now()) {
  const s = new Date(now - days * 864e5).toISOString().slice(0, 19) + "Z";
  const e = new Date(now).toISOString().slice(0, 19) + "Z";
  const base = `datetime_geq: $s, datetime_lt: $e, clientRequestHTTPHost: "oceanofjobs.com", clientRequestPath_like: "/api/%"`;
  const q = (filter, dims, limit) => `query($z: String!, $s: Time!, $e: Time!) { viewer { zones(filter: {zoneTag: $z}) {
    httpRequestsAdaptiveGroups(limit: ${limit}, orderBy: [count_DESC], filter: {${base}, ${filter}}) { count dimensions { ${dims} } } } } }`;
  const v = { z: ZONE, s, e };
  const [agents, blockedDays] = await Promise.all([
    gql(env, q(`userAgent_notlike: "Mozilla%"`, "userAgent date", 2000), v),
    gql(env, q("edgeResponseStatus: 403", "date", 100), v),
  ]);
  const apps = {};
  const daily = [];
  for (const g of agents) {
    const ua = g.dimensions.userAgent || "(none)";
    if (OURS.test(ua) || BLOCKED_UA.test(ua)) continue;
    apps[ua] = (apps[ua] || 0) + g.count;
    daily.push([g.dimensions.date, "calls", g.count]);
  }
  let blocked = 0;
  for (const g of blockedDays) { blocked += g.count; daily.push([g.dimensions.date, "blocked", g.count]); }
  const list = Object.entries(apps).sort((a, b) => b[1] - a[1]);
  return { calls: list.reduce((t, [, n]) => t + n, 0), apps: list.slice(0, 20), app_count: list.length, blocked, daily: byDay(days, now, daily) };
}

// Extension installs and MCP tokens, from the contacts scan's token rows.
export function connections(contacts, now = Date.now()) {
  const week = now - 7 * 864e5;
  const out = { extension: { connected: 0, active: 0 }, mcp: { connected: 0, active: 0 } };
  for (const c of contacts) {
    for (const t of c.tokens || []) {
      const k = t.scope === "extension" ? "extension" : "mcp";
      out[k].connected++;
      if (t.last_used_at && Date.parse(t.last_used_at) >= week) out[k].active++;
    }
  }
  return out;
}
