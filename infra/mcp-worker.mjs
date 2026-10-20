// The Ocean of Jobs MCP server: https://oceanofjobs.com/mcp
//
// A Model Context Protocol endpoint for AI clients (Claude, ChatGPT,
// Cursor, Claude Code). Three read-only tools, each a thin translation
// to a public GET on the API the board already uses:
//
//     search_jobs   -> /api/jobs
//     get_job       -> /api/jobs/{id}
//     get_company   -> /api/companies/search, /api/companies/{domain}, /api/jobs
//
// Protocol: Streamable HTTP, stateless, revision 2025-11-25, also
// answering clients on 2025-06-18 and 2025-03-26. A client POSTs one
// JSON-RPC message and gets one JSON response back; no session id, no
// SSE stream (GET answers 405, which the spec allows). The server keeps
// nothing between requests, so any isolate in any location can answer.
// Batches are refused: 2025-06-18 removed them and no client we target
// sends them.
//
// Why a Worker that calls GETs rather than an /api/mcp route on the box:
// a tool call arrives as a POST, which nothing caches. Here it becomes a
// GET with its parameters in a fixed order, and that GET is kept in
// Cloudflare's cache for as long as the API's own Cache-Control allows
// (capped at five minutes). The next person asking the same question
// gets the edge's copy and the box never hears about it.
//
// Its own script and route, apart from otj-box-router, so a fault here
// cannot touch the board's API, and switching it off is deleting one
// route. With the route gone, or the account's free daily Workers
// allowance spent (the route fails open), /mcp falls through to
// CloudFront, whose mcp_unavailable function answers a JSON-RPC error
// that says so (infra/cloudfront.tf).
//
// Origin protection does not lean on client addresses. Claude.ai and
// ChatGPT call connectors from their own servers, so one address can be
// thousands of people. Instead: every call is capped (25 results, offset
// 200), answers come from the cache where they can, and the ORIGIN_LIMIT
// binding caps how many cache misses reach the box per minute per
// Cloudflare location, whoever is asking. The box's own expensive-query
// guard sits behind that.
//
// Deployed by scripts/deploy_mcp_worker.py. Tested by
// tests/test_mcp_worker.mjs (node --test).

const BOX = "https://box.oceanofjobs.com";
const SITE = "https://oceanofjobs.com";
// Cache API keys are URLs on our own zone. The version segment lets a
// change in what we store retire every old entry at once.
const CACHE_PREFIX = SITE + "/__mcp_cache/v1";
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER = { name: "oceanofjobs", title: "Ocean of Jobs", version: "1.0.0", websiteUrl: SITE };
const MAX_LIMIT = 25;
const MAX_OFFSET = 200;
const MAX_TTL = 300;
const MAX_DESCRIPTION = 6000;
const MAX_BODY = 65536;
const DAY_MS = 86400000;

const LIFETIME_NOTE =
  "first_seen is when Ocean of Jobs first found the listing on the employer's own applicant " +
  "tracking system. last_seen is the last time a read of that board returned the listing with " +
  "any change; a board that answers 'unchanged' was still checked, so the listing may have been " +
  "confirmed more recently than last_seen says. closed_at is when a successful read of the board " +
  "no longer included it; null means it was still listed at the last successful read. " +
  "reappeared_at is when this same listing (the same ATS id) was last seen again after being " +
  "missing from our reads of the board for at least two days; null means no such absence was seen " +
  "(recorded since 2026-10-19). It says what was observed, not that the employer reposted it: our " +
  "own failed reads can look the same, so do not call a listing reposted on this or on an old " +
  "first_seen. A new posting for the same role is a new listing. posted_at is the employer's own date where " +
  "the ATS gives one, and can be missing.";

const INSTRUCTIONS =
  "Ocean of Jobs lists open jobs read directly from each employer's own applicant tracking " +
  "system (Greenhouse, Comeet, Workday and others), not from job boards. It is built for Israeli " +
  "tech, but most listings are elsewhere, above all the US, so pass country (IL for Israel) " +
  "when the place matters. " +
  "Each job carries a lifetime: how long it has been listed and whether it is still open. Lead " +
  "with it when it matters, for example a role listed for months. " + LIFETIME_NOTE + " " +
  "Search results are candidates, not answers: search_jobs says how to search in few calls, " +
  "and a job is judged on its description from get_job, not its title. Answer with a short " +
  "ranked list, each entry giving title, company, location and the reason it fits, then url (the " +
  "Ocean of Jobs page) and apply_url (the employer's page) on their own lines, never inside a " +
  "table cell. Results are capped at 25 per call and offset 200; for " +
  "bulk data use the public REST API documented at " + SITE + "/api/help. " +
  "save_job, list_saved_jobs, remove_saved_job and the three auto apply queue tools work on the " +
  "user's own Ocean of Jobs account and need a personal access token sent as Authorization: " +
  "Bearer ooj_...; save or queue a job only when the user asks for it.";

const JOB_PROPS = {
  id: { type: "string" },
  title: { type: "string" },
  company: { type: "string", description: "The employer's name, or its domain when the ATS gives no name." },
  company_domain: { type: "string" },
  lifetime: {
    type: "object",
    description: LIFETIME_NOTE,
    properties: {
      summary: { type: "string" },
      status: { type: "string", enum: ["open", "closed"] },
      days_listed: { type: ["integer", "null"] },
      first_seen: { type: ["string", "null"] },
      last_seen: { type: ["string", "null"] },
      closed_at: { type: ["string", "null"] },
      reappeared_at: { type: ["string", "null"] },
      posted_at: { type: ["string", "null"] },
    },
    required: ["summary", "status", "days_listed", "first_seen", "last_seen", "closed_at", "reappeared_at", "posted_at"],
  },
  url: { type: "string", description: "The listing's page on Ocean of Jobs. Show this first." },
  apply_url: { type: ["string", "null"], description: "The employer's own application page." },
  location: { type: ["string", "null"] },
  workplace: { type: ["string", "null"] },
  seniority: { type: ["string", "null"] },
  category: { type: ["string", "null"] },
};
const JOB_REQUIRED = Object.keys(JOB_PROPS);
const LISTED_JOB = {
  type: "object",
  properties: {
    ...JOB_PROPS,
    other_locations: { type: "array", items: { type: "string" }, description: "Other places the same posting is listed for." },
    salary: { type: ["string", "null"], description: "Monthly, in shekels, as listed or estimated." },
  },
  required: [...JOB_REQUIRED, "other_locations", "salary"],
};
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "search_jobs",
    title: "Search jobs",
    description:
      "Search open jobs on Ocean of Jobs. Give at least one of query, company, city or country " +
      "(IL for Israel; most listings are in the US). Returns up to 25 jobs per call, best match " +
      "first when there is a query, newest first otherwise, with the total number of matches. " +
      "Every job includes its lifetime (days listed, first and last seen) and two links: url, the " +
      "Ocean of Jobs page, to show first, and apply_url, the employer's page.\n\n" +
      "How to search well:\n" +
      "- Put one or two core title or skill words in query, such as \"backend\", \"python\" or " +
      "\"devops\", and use the filters for place, seniority and dates. Every word in query must " +
      "match, so a long description of the person returns little or nothing.\n" +
      "- Search once. If that gives relevant candidates, do not search again for synonyms. If it " +
      "gives nothing useful, change or broaden query once, keeping the same filters.\n" +
      "- Across searches, treat the same id or the same apply_url as one job.\n" +
      "- Open only the strongest few candidates with get_job, and read their descriptions for " +
      "seniority, required skills and where the job can be done from before ranking them.\n" +
      "- Give the number of recommendations asked for when enough jobs fit, and say so when " +
      "fewer do.\n" +
      "- Never call a listing reposted because of its age. Use lifetime.reappeared_at, and say " +
      "when the tracked history is too short to tell.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search titles, companies, locations and descriptions, skills included, e.g. \"kubernetes go\". Quotes keep a phrase together." },
        company: { type: "string", description: "A company domain such as wix.com, or a name, which is looked up." },
        city: { type: "string", description: "City name, e.g. Tel Aviv." },
        country: { type: "string", description: "Two-letter country code, e.g. IL or US." },
        seniority: { type: "string", enum: ["intern", "junior", "mid", "senior", "staff", "principal", "lead", "manager", "director", "exec"] },
        workplace: { type: "string", enum: ["remote", "hybrid", "onsite"] },
        max_age_days: { type: "integer", minimum: 0, description: "Only jobs posted within this many days." },
        salary_min: { type: "integer", minimum: 0, description: "Lowest monthly gross salary in shekels." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: 10 },
        offset: { type: "integer", minimum: 0, maximum: MAX_OFFSET, default: 0 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "integer", description: "Every match, not only this page." },
        offset: { type: "integer" },
        jobs: { type: "array", items: LISTED_JOB },
        duplicates_folded: { type: "integer", description: "Rows on this page that were the same posting as another, folded into it." },
        more: { type: ["string", "null"] },
      },
      required: ["total", "offset", "jobs", "duplicates_folded", "more"],
    },
    annotations: { title: "Search jobs", ...READ_ONLY },
  },
  {
    name: "get_job",
    title: "Get a job",
    description:
      "One job on Ocean of Jobs by its id (from search_jobs or get_company): the description as " +
      "plain text, its lifetime, whether its data is verified against the employer's ATS, and " +
      "both links, the Ocean of Jobs page first.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The job's id, e.g. 67ff4ef965d91ef7." } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ...JOB_PROPS,
        department: { type: ["string", "null"] },
        confidence: { type: ["string", "null"], description: "verified: read from the employer's ATS API. best_effort: from the careers page markup." },
        description: { type: ["string", "null"], description: "Plain text; '## ' starts a heading and '- ' a bullet. Null when the ATS gave none." },
        description_truncated: { type: "boolean" },
      },
      required: [...JOB_REQUIRED, "department", "confidence", "description", "description_truncated"],
    },
    annotations: { title: "Get a job", ...READ_ONLY },
  },
  {
    name: "get_company",
    title: "Get a company",
    description:
      "A company on Ocean of Jobs by name or domain: how many jobs it has open, how many are new " +
      "this week, how long it has been tracked, its newest jobs, and its Ocean of Jobs page.",
    inputSchema: {
      type: "object",
      properties: { company: { type: "string", description: "A name such as Wix, or a domain such as wix.com." } },
      required: ["company"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        name: { type: ["string", "null"] },
        url: { type: "string" },
        ats: { type: ["string", "null"] },
        open_jobs: { type: "integer" },
        new_jobs_7d: { type: "integer" },
        tracked_since: { type: ["string", "null"] },
        newest_jobs: { type: "array", items: LISTED_JOB },
        other_matches: { type: "array", items: { type: "object", properties: { domain: { type: "string" }, name: { type: ["string", "null"] }, open_jobs: { type: "integer" } } } },
      },
      required: ["domain", "name", "url", "ats", "open_jobs", "new_jobs_7d", "tracked_since", "newest_jobs", "other_matches"],
    },
    annotations: { title: "Get a company", ...READ_ONLY },
  },
  {
    name: "save_job",
    title: "Save a job",
    description:
      "Save a job to the user's Ocean of Jobs account, where it shows under Saved jobs on every " +
      "device. Needs the user's personal access token. Saving the same job twice is harmless.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The job's id, e.g. 67ff4ef965d91ef7." } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { id: { type: "string" }, saved: { type: "boolean" }, url: { type: "string" } },
      required: ["id", "saved", "url"],
    },
    annotations: { title: "Save a job", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_saved_jobs",
    title: "List saved jobs",
    description:
      "The jobs saved on the user's Ocean of Jobs account, newest saved first, with the same " +
      "fields as search results and when each was saved. Needs the user's personal access token.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "How many, 1 to 25. Default 10." } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "integer", description: "Every saved job, not only this list." },
        jobs: { type: "array", items: { ...LISTED_JOB, properties: { ...LISTED_JOB.properties, saved_at: { type: ["string", "null"] } } } },
        gone: { type: "array", items: { type: "string" }, description: "Saved ids that no longer have a listing." },
      },
      required: ["total", "jobs", "gone"],
    },
    annotations: { title: "List saved jobs", ...READ_ONLY },
  },
  {
    name: "remove_saved_job",
    title: "Remove a saved job",
    description: "Take a job off the user's saved list. Needs the user's personal access token.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The job's id." } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { id: { type: "string" }, saved: { type: "boolean" } },
      required: ["id", "saved"],
    },
    annotations: { title: "Remove a saved job", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "queue_for_auto_apply",
    title: "Queue a job for auto apply",
    description:
      "Queue a job for the Ocean of Jobs Chrome extension to apply to with the user's profile and CV. " +
      "The extension applies to queued jobs on its next check, every 15 minutes, so the user needs " +
      "the extension installed and connected. The user must also turn on \"Jobs queued by my AI " +
      "assistant through MCP\" in their auto apply settings. For now the extension fills Greenhouse " +
      "forms only (an apply_url on boards.greenhouse.io or job-boards.greenhouse.io); a job on any other " +
      "site is refused, so pick Greenhouse jobs. This sends a real application, so " +
      "queue a job only when the user asks for it. Needs the user's personal access token. " +
      "Queueing the same job twice is harmless.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The job's id, e.g. 67ff4ef965d91ef7." } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { id: { type: "string" }, queued: { type: "boolean" }, url: { type: "string" } },
      required: ["id", "queued", "url"],
    },
    annotations: { title: "Queue a job for auto apply", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "list_auto_apply_queue",
    title: "List the auto apply queue",
    description:
      "The jobs waiting in the user's auto apply queue, oldest first, with the same fields as " +
      "search results and when each was queued. A job leaves the queue once the extension has " +
      "tried it. Needs the user's personal access token.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "How many, 1 to 25. Default 10." } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "integer", description: "Every queued job, not only this list." },
        jobs: { type: "array", items: { ...LISTED_JOB, properties: { ...LISTED_JOB.properties, added_at: { type: ["string", "null"] } } } },
        gone: { type: "array", items: { type: "string" }, description: "Queued ids that no longer have a listing." },
      },
      required: ["total", "jobs", "gone"],
    },
    annotations: { title: "List the auto apply queue", ...READ_ONLY },
  },
  {
    name: "remove_from_auto_apply_queue",
    title: "Remove a job from the auto apply queue",
    description: "Take a job out of the user's auto apply queue before the extension applies to it. Needs the user's personal access token.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The job's id." } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { id: { type: "string" }, queued: { type: "boolean" } },
      required: ["id", "queued"],
    },
    annotations: { title: "Remove from the auto apply queue", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

// Thrown inside a tool for anything the model should read and act on:
// bad arguments, nothing found, the box busy. It becomes a result with
// isError, so the model can correct itself, not a protocol error.
class ToolError extends Error {}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id",
};

function json(status, body, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { "content-type": "application/json" }), "cache-control": "no-store", ...CORS, ...extra },
  });
}

function rpcError(id, code, message, status = 200, trace = null) {
  if (trace) trace.outcome = "rpc_error";
  return json(status, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

// The fixed form of one API request, which is both the URL the box is
// asked and the cache key. Parameters are sorted and empty ones dropped,
// so the same question asked in any order or spelling is one entry.
function canonicalPath(path, params) {
  const q = new URLSearchParams();
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== "") q.append(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

// How long a box answer may be kept, or 0 for never. Only a 200 JSON
// answer the API itself marked public and cacheable qualifies; an error,
// a busy reply, anything private or setting a cookie is never stored.
function cacheTtl(res) {
  if (res.status !== 200) return 0;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return 0;
  if (res.headers.has("set-cookie")) return 0;
  const cc = (res.headers.get("cache-control") || "").toLowerCase();
  if (!/\bpublic\b/.test(cc) || /\b(private|no-store|no-cache)\b/.test(cc)) return 0;
  const m = cc.match(/\bs-maxage=(\d+)/) || cc.match(/\bmax-age=(\d+)/);
  return m ? Math.min(Number(m[1]), MAX_TTL) : 0;
}

// One API read: the edge cache first, then the box. trace counts what
// happened for the response header and the analytics row.
async function api(path, params, env, ctx, trace) {
  const canonical = canonicalPath(path, params);
  const key = new Request(CACHE_PREFIX + canonical);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    trace.hits++;
    return { status: 200, body: await hit.json() };
  }
  if (env.ORIGIN_LIMIT) {
    const { success } = await env.ORIGIN_LIMIT.limit({ key: "origin" });
    if (!success) {
      trace.limited = true;
      throw new ToolError("Ocean of Jobs is answering too many new questions right now. Try again in a minute.");
    }
  }
  trace.misses++;
  let res;
  try {
    res = await fetch(BOX + canonical, {
      headers: { "x-otj-origin-key": env.ORIGIN_KEY || "", "user-agent": "oceanofjobs-mcp/" + SERVER.version, accept: "application/json" },
    });
  } catch {
    throw new ToolError("Ocean of Jobs could not be reached. Try again shortly.");
  }
  if (res.status === 503) throw new ToolError("Ocean of Jobs is busy. Try again in a few seconds.");
  if (res.status === 404) return { status: 404, body: null };
  if (res.status !== 200) throw new ToolError(`Ocean of Jobs answered ${res.status}. Try again shortly.`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ToolError("Ocean of Jobs sent an unreadable answer. Try again shortly.");
  }
  const ttl = cacheTtl(res);
  if (ttl > 0) {
    const stored = new Response(text, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } });
    ctx.waitUntil(cache.put(key, stored));
  }
  return { status: 200, body };
}

const NEEDS_TOKEN =
  "This needs an Ocean of Jobs personal access token. The user can create one at " + SITE +
  "/account#settings and add it to this MCP server as the header Authorization: Bearer ooj_...";

// One call on the user's own account, with their personal access token.
// Never cached, never counted as a cache miss: the answer is one
// person's, and the Cloudflare cache above is shared by everyone.
async function me(method, path, token, env) {
  if (!token) throw new ToolError(NEEDS_TOKEN);
  let res;
  try {
    res = await fetch(BOX + path, {
      method,
      headers: { "x-otj-origin-key": env.ORIGIN_KEY || "", authorization: "Bearer " + token, "user-agent": "oceanofjobs-mcp/" + SERVER.version, accept: "application/json" },
    });
  } catch {
    throw new ToolError("Ocean of Jobs could not be reached. Try again shortly.");
  }
  if (res.status === 401) throw new ToolError("The personal access token was not accepted: it may be revoked or expired. " + NEEDS_TOKEN);
  // These carry the reason too: auto apply not turned on for MCP (403), a
  // job on a site the extension can't fill yet (422), an unknown job (404).
  if ([400, 403, 404, 422].includes(res.status)) {
    const err = await res.json().catch(() => ({}));
    throw new ToolError(`Ocean of Jobs refused that: ${String(err.error || "bad request").replace(/\.$/, "")}.`);
  }
  if (res.status === 503 || res.status === 429) throw new ToolError("Ocean of Jobs is busy. Try again in a few seconds.");
  if (!res.ok) throw new ToolError(`Ocean of Jobs answered ${res.status}. Try again shortly.`);
  return res.status === 204 ? null : res.json();
}
function jobId(args) {
  const id = str(args, "id", 64);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new ToolError("id must be a job id such as 67ff4ef965d91ef7.");
  return id;
}

function link(path) {
  return `${SITE}${path}?ref=mcp`;
}

function day(ts) {
  return ts ? String(ts).slice(0, 10) : "an unknown date";
}

function lifetime(job, now = Date.now()) {
  const first = job.first_seen ? Date.parse(job.first_seen) : NaN;
  const end = job.closed_at ? Date.parse(job.closed_at) : now;
  const days = Number.isNaN(first) ? null : Math.max(0, Math.floor((end - first) / DAY_MS));
  const span = days === null ? "" : ` (${days} day${days === 1 ? "" : "s"} listed)`;
  const back = job.reopened_at ? ` Seen again on ${day(job.reopened_at)} after at least two days missing from the board.` : "";
  const summary = (job.closed_at
    ? `Closed on ${day(job.closed_at)}, first seen ${day(job.first_seen)}${span}.`
    : `Open: first seen ${day(job.first_seen)}${span}, last seen ${day(job.last_seen)}.`) + back;
  return {
    summary,
    status: job.closed_at ? "closed" : "open",
    days_listed: days,
    first_seen: job.first_seen ?? null,
    last_seen: job.last_seen ?? null,
    closed_at: job.closed_at ?? null,
    reappeared_at: job.reopened_at ?? null,
    posted_at: job.posted_at ?? null,
  };
}

function shapeJob(j, now) {
  return {
    id: j.id,
    title: j.title,
    company: j.company_name || j.company_domain,
    company_domain: j.company_domain,
    lifetime: lifetime(j, now),
    url: link(`/job/${encodeURIComponent(j.id)}`),
    apply_url: j.url || null,
    location: j.location ?? null,
    workplace: j.workplace_type ?? null,
    seniority: j.seniority ?? null,
    category: j.category ?? null,
  };
}

function listedJob(j, now) {
  const salary = j.salary_text ? `${j.salary_text}${j.salary_is_estimate ? " (estimate)" : ""}` : null;
  return { ...shapeJob(j, now), other_locations: [], salary };
}

// One posting can come back as several rows: a role open in two cities
// is a row per city (Fullpath), and a board stored under two domains is
// a row per domain until the loader demotes the twin (Wix, whose token
// differed only in case). The employer's own URL is the same posting by
// definition, so rows sharing it fold into the first, keeping the other
// places. Within one page only; total and paging stay the API's.
function listedJobs(rows, now) {
  const out = [];
  const byUrl = new Map();
  for (const j of rows) {
    const key = (j.url || "").toLowerCase();
    const kept = key && byUrl.get(key);
    if (kept) {
      if (j.location && j.location !== kept.location && !kept.other_locations.includes(j.location)) kept.other_locations.push(j.location);
      continue;
    }
    const shaped = listedJob(j, now);
    if (key) byUrl.set(key, shaped);
    out.push(shaped);
  }
  return out;
}

function str(args, name, max = 200) {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`${name} must be a string.`);
  const s = v.trim().replace(/\s+/g, " ");
  if (s.length > max) throw new ToolError(`${name} is longer than ${max} characters.`);
  return s || undefined;
}

function int(args, name, lo, hi, dflt) {
  const v = args[name];
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new ToolError(`${name} must be a whole number from ${lo} to ${hi}` +
      (name === "offset" ? ". For deeper pages use the REST API at " + SITE + "/api/help." : "."));
  }
  return v;
}

function oneOf(args, name, allowed) {
  const s = str(args, name);
  if (s === undefined) return undefined;
  const v = s.toLowerCase();
  if (!allowed.includes(v)) throw new ToolError(`${name} must be one of: ${allowed.join(", ")}.`);
  return v;
}

function looksLikeDomain(s) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);
}

async function findCompanies(name, env, ctx, trace) {
  const { body } = await api("/api/companies/search", { name: name.toLowerCase() }, env, ctx, trace);
  return (body && body.companies) || [];
}

const SCHEMAS = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema]));

function unknownArgs(name, args) {
  const extra = Object.keys(args).filter((k) => !(k in SCHEMAS[name].properties));
  if (extra.length) throw new ToolError(`Unknown argument${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}.`);
}

async function searchJobs(args, env, ctx, trace, now) {
  const seniorities = TOOLS[0].inputSchema.properties.seniority.enum;
  const query = str(args, "query");
  let company = str(args, "company");
  if (company && !looksLikeDomain(company)) {
    const found = await findCompanies(company, env, ctx, trace);
    if (!found.length) throw new ToolError(`No company called "${company}" on Ocean of Jobs. Try its domain, e.g. example.com.`);
    company = found[0].value;
  }
  const country = str(args, "country", 20);
  if (country && !/^[a-z]{2}$/i.test(country)) throw new ToolError("country must be a two-letter code such as IL.");
  const city = str(args, "city");
  // Measured 2026-10-19: with none of these the box counts every open
  // row and gives up at its 25s guard, and a skills filter (left out of
  // v1 for the same reason) did the same even within one country.
  if (!query && !company && !city && !country) {
    throw new ToolError("Give at least one of query, company, city or country (IL for Israel).");
  }
  const limit = int(args, "limit", 1, MAX_LIMIT, 10);
  const offset = int(args, "offset", 0, MAX_OFFSET, 0);
  const params = {
    search: query && query.toLowerCase(),
    company: company && company.toLowerCase(),
    city,
    country: country && country.toUpperCase(),
    seniority: oneOf(args, "seniority", seniorities),
    workplace: oneOf(args, "workplace", ["remote", "hybrid", "onsite"]),
    max_age_days: int(args, "max_age_days", 0, 3650, undefined),
    salary_min: int(args, "salary_min", 0, 10000000, undefined),
    sort: query ? "relevance" : "age",
    limit,
    offset,
  };
  const { body } = await api("/api/jobs", params, env, ctx, trace);
  const rows = body.jobs || [];
  const jobs = listedJobs(rows, now);
  trace.total = body.total;
  trace.returned = jobs.length;
  const next = offset + rows.length;
  let more = null;
  if (body.total > next) {
    more = next <= MAX_OFFSET
      ? `${body.total - next} more; call again with offset ${next}.`
      : `${body.total - next} more than this tool pages through; narrow the search or use the REST API at ${SITE}/api/help.`;
  }
  return { total: body.total, offset, jobs, duplicates_folded: rows.length - jobs.length, more };
}

async function getJob(args, env, ctx, trace, now) {
  const id = str(args, "id", 64);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new ToolError("id must be a job id such as 67ff4ef965d91ef7.");
  const { status, body } = await api(`/api/jobs/${id}`, {}, env, ctx, trace);
  if (status === 404) throw new ToolError(`No job with id ${id}. It may have been removed; search again.`);
  const text = body.description || null;
  const truncated = !!text && text.length > MAX_DESCRIPTION;
  return {
    ...shapeJob(body, now),
    department: body.department ?? null,
    confidence: body.confidence ?? null,
    description: truncated ? text.slice(0, MAX_DESCRIPTION) + "\n\n[Cut here. The full text is at url.]" : text,
    description_truncated: truncated,
  };
}

async function getCompany(args, env, ctx, trace, now) {
  const wanted = str(args, "company");
  if (!wanted) throw new ToolError("company is required: a name such as Wix or a domain such as wix.com.");
  let domain = wanted.toLowerCase();
  let others = [];
  if (!looksLikeDomain(domain)) {
    const found = await findCompanies(wanted, env, ctx, trace);
    if (!found.length) throw new ToolError(`No company called "${wanted}" on Ocean of Jobs.`);
    domain = found[0].value;
    others = found.slice(1, 6).map((c) => ({ domain: c.value, name: c.name ?? null, open_jobs: c.n ?? 0 }));
  }
  const { status, body } = await api(`/api/companies/${encodeURIComponent(domain)}`, {}, env, ctx, trace);
  if (status === 404) throw new ToolError(`No company with domain ${domain} on Ocean of Jobs.`);
  const recent = await api("/api/jobs", { company: domain, limit: 5, offset: 0, sort: "age" }, env, ctx, trace);
  return {
    domain: body.domain,
    name: body.name ?? null,
    url: link(`/company/${encodeURIComponent(body.domain)}`),
    ats: body.ats ?? null,
    open_jobs: body.open_jobs ?? 0,
    new_jobs_7d: body.new_jobs_7d ?? 0,
    tracked_since: body.tracked_since ?? null,
    newest_jobs: listedJobs(recent.body.jobs || [], now),
    other_matches: others,
  };
}

async function saveJob(args, env, ctx, trace, now, token) {
  const id = jobId(args);
  await me("PUT", `/api/me/saved/${id}`, token, env);
  return { id, saved: true, url: link(`/job/${encodeURIComponent(id)}`) };
}

async function removeSavedJob(args, env, ctx, trace, now, token) {
  const id = jobId(args);
  await me("DELETE", `/api/me/saved/${id}`, token, env);
  return { id, saved: false };
}

// The jobs behind a list of {job_id, <stamp>} rows from the user's account.
// The listings themselves are public, so these go through the shared
// cache like any get_job.
async function withListings(items, limit, stamp, env, ctx, trace, now) {
  const rows = await Promise.all(items.slice(0, limit).map(async (s) => {
    const { status, body } = await api(`/api/jobs/${encodeURIComponent(s.job_id)}`, {}, env, ctx, trace);
    return { s, job: status === 404 ? null : body };
  }));
  return {
    total: items.length,
    jobs: rows.filter((r) => r.job).map((r) => ({ ...listedJob(r.job, now), [stamp]: r.s[stamp] ?? null })),
    gone: rows.filter((r) => !r.job).map((r) => r.s.job_id),
  };
}

async function listSavedJobs(args, env, ctx, trace, now, token) {
  const limit = int(args, "limit", 1, MAX_LIMIT, 10);
  const saved = ((await me("GET", "/api/me/saved", token, env)) || {}).saved || [];
  return withListings(saved, limit, "saved_at", env, ctx, trace, now);
}

async function queueForAutoApply(args, env, ctx, trace, now, token) {
  const id = jobId(args);
  await me("PUT", `/api/me/apply/queue/${id}`, token, env);
  return { id, queued: true, url: link(`/job/${encodeURIComponent(id)}`) };
}

async function removeFromAutoApplyQueue(args, env, ctx, trace, now, token) {
  const id = jobId(args);
  await me("DELETE", `/api/me/apply/queue/${id}`, token, env);
  return { id, queued: false };
}

async function listAutoApplyQueue(args, env, ctx, trace, now, token) {
  const limit = int(args, "limit", 1, MAX_LIMIT, 10);
  const queue = ((await me("GET", "/api/me/apply/queue", token, env)) || {}).queue || [];
  return withListings(queue, limit, "added_at", env, ctx, trace, now);
}

const HANDLERS = {
  search_jobs: searchJobs, get_job: getJob, get_company: getCompany,
  save_job: saveJob, list_saved_jobs: listSavedJobs, remove_saved_job: removeSavedJob,
  queue_for_auto_apply: queueForAutoApply, list_auto_apply_queue: listAutoApplyQueue,
  remove_from_auto_apply_queue: removeFromAutoApplyQueue,
};

// The personal access token, if the client sent one. Anything else in
// Authorization is ignored rather than refused: the public tools need none.
function bearerToken(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(ooj_[A-Za-z0-9_.-]{20,300})$/);
  return m ? m[1] : null;
}

async function callTool(params, env, ctx, trace, token = null) {
  const name = params && params.name;
  const handler = HANDLERS[name];
  trace.tool = typeof name === "string" ? name.slice(0, 40) : "";
  if (!handler) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const args = params.arguments ?? {};
  try {
    if (typeof args !== "object" || Array.isArray(args)) throw new ToolError("arguments must be an object.");
    unknownArgs(name, args);
    const out = await handler(args, env, ctx, trace, Date.now(), token);
    return { result: { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false } };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    trace.outcome = trace.limited ? "limited" : "tool_error";
    return { result: { content: [{ type: "text", text: e.message }], isError: true } };
  }
}

async function handle(request, env, ctx, trace) {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return json(404, { error: "not found; the MCP endpoint is /mcp" });
  if (request.method === "OPTIONS") return json(204, null);
  if (request.method !== "POST") {
    return json(405, { error: "POST JSON-RPC messages to this endpoint. This server opens no SSE stream." }, { allow: "POST, OPTIONS" });
  }
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion && !VERSIONS.includes(headerVersion)) {
    return rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${headerVersion}; supported: ${VERSIONS.join(", ")}`, 400);
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) return rpcError(null, -32600, "Request too large", 413);
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, "Batches are not supported; send one message per request", 400);
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid request", 400);
  trace.method = typeof msg.method === "string" ? msg.method.slice(0, 40) : "";
  // A notification or a client's reply to us: nothing to answer.
  if (msg.id === undefined || msg.method === undefined) return json(202, null);
  const { id, method, params } = msg;
  if (method === "initialize") {
    const asked = params && params.protocolVersion;
    trace.client = String((params && params.clientInfo && params.clientInfo.name) || "").slice(0, 60);
    return json(200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      },
    });
  }
  if (method === "ping") return json(200, { jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return json(200, { jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const out = await callTool(params, env, ctx, trace, bearerToken(request));
    if (out.error) return rpcError(id, out.error.code, out.error.message, 200, trace);
    return json(200, { jsonrpc: "2.0", id, result: out.result });
  }
  return rpcError(id, -32601, `Method not found: ${method}`, 200, trace);
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const trace = { method: "", tool: "", client: "", outcome: "ok", hits: 0, misses: 0, limited: false, total: -1, returned: -1 };
    let response;
    try {
      response = await handle(request, env, ctx, trace);
    } catch (e) {
      console.error("mcp failed", e && e.stack ? e.stack : e);
      trace.outcome = "server_error";
      response = rpcError(null, -32603, "Internal error", 500);
    }
    response.headers.set("x-otj-cache", `hit=${trace.hits} miss=${trace.misses}`);
    // One row per request for the adoption report. Nothing about the
    // person asking is kept: no address, no arguments. total and returned
    // are a search's matches and the jobs it sent back, -1 for anything
    // else, so zero-result and too-broad searches can be counted.
    if (env.MCP_EVENTS && trace.method) {
      env.MCP_EVENTS.writeDataPoint({
        indexes: [trace.tool || trace.method],
        blobs: [trace.method, trace.tool, trace.outcome, trace.client],
        doubles: [Date.now() - started, trace.hits, trace.misses, response.status, trace.total, trace.returned],
      });
    }
    return response;
  },
};
