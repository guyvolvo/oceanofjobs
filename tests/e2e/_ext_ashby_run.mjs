// The periodic auto apply run (run() in extension/background.js) against
// real, live Ashby forms, one job at a time, with our API stubbed. Nothing
// reaches the employer: every write leaving the browser for anywhere but
// the stub is aborted, Ashby's GraphQL included, where only read-only
// queries (the form, place lookups) go through and every mutation (saving
// an answer, uploading the CV, submitting) is stopped and logged.
// Run from the repo root: node tests/e2e/_ext_ashby_run.mjs [jobs, default 8]
import { chromium } from "playwright";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const WANT = Number(process.argv[2]) || 8;
const ext = path.resolve("extension");
const ashby = require(path.join(ext, "ats/ashby.js"));
const match = require(path.join(ext, "lib/match.js"));
const GRAPHQL = "https://jobs.ashbyhq.com/api/non-user-graphql";

// The same read-only query the extension's pageData() sends.
async function formOf(url) {
  const [, board, id] = new URL(url).pathname.split("/");
  const query = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
    jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
      id applicationForm { sections { isHidden fieldEntries { field isRequired isHidden } } } } }`;
  const res = await fetch(`${GRAPHQL}?op=ApiJobPosting`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationName: "ApiJobPosting", query, variables: { organizationHostedJobsPageName: board, jobPostingId: id } }) });
  return res.ok ? ashby.fromGraphql(await res.text()) : null;
}

// Live jobs from our own API, one per company, whose posting is still up.
const { jobs: listed } = await (await fetch("https://oceanofjobs.com/api/jobs?ats=ashby&limit=150&count=skip")).json();
const picked = [];
const companies = new Set();
for (const j of listed) {
  if (picked.length >= WANT) break;
  if (companies.has(j.company_domain) || !ashby.matches(j.url)) continue;
  const form = await formOf(j.url);
  if (!form || !form.fields.length) continue;
  companies.add(j.company_domain);
  const full = await (await fetch(`https://oceanofjobs.com/api/jobs/${j.id}`)).json();
  picked.push({ job: { ...j, ...full, closed_at: null, match_score: 90 }, form });
}
if (picked.length < WANT) throw new Error(`only ${picked.length} live Ashby jobs found`);
// OpenAI's form asks for a start date, the one date field in a survey of 30 Ashby boards.
const { jobs: dated } = await (await fetch("https://oceanofjobs.com/api/jobs?ats=ashby&company=openai.com&limit=5&count=skip")).json();
for (const j of dated.filter((j) => !companies.has(j.company_domain)).slice(0, 1)) {
  const form = await formOf(j.url);
  const full = await (await fetch(`https://oceanofjobs.com/api/jobs/${j.id}`)).json();
  if (form && form.fields.some((f) => f.type === "date")) picked.push({ job: { ...j, ...full, closed_at: null, match_score: 90 }, form });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-ashby-"));
const ctx = await chromium.launchPersistentContext(dir, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });

const savedAnswers = [
  { question: "How did you hear about us?", answer: "LinkedIn" },
  { question: "Current Company", answer: "Example Ltd" },
  { question: "Where have you most recently worked?", answer: "Example Ltd" },
  { question: "Pronouns", answer: "they/them" },
  { question: "What is your notice period?", answer: "1 month" },
  { question: "Salary Expectations", answer: "90000" },
];
const baseProfile = () => ({
  contact: { first_name: "Test", last_name: "Person", email: "test@example.com", phone: "+44 7700 900000", location: "London, United Kingdom" },
  links: { linkedin: "https://www.linkedin.com/in/test", github: "https://github.com/test", website: "https://example.com" },
  work: { authorized_countries: ["GB"], needs_sponsorship: false, notice_period: "1 month", salary: "90000" },
  eeo: { gender: "decline", race: null, veteran: null, disability: null }, answers: [...savedAnswers],
  settings: { mode: "queue", sources: ["board"], unknowns: "skip", guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } },
});

// A made-up answer of the right shape for a question the profile leaves open.
function answerFor(f) {
  if (f.options.length) return f.type === "boolean" ? "Yes" : f.options[0];
  if (f.type === "number") return "3";
  if (f.type === "date") return "2026-12-01";
  if (f.type === "location") return "London";
  return "Test answer";
}

let state;
const blocked = [];
await ctx.route("**/*", async (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com") {
    const p = u.pathname, m = req.method();
    state.calls.push(`${m} ${p}`);
    if (p === "/api/me/apply/profile") return r.fulfill({ json: { profile: state.profile, preferences: { skills: [] } } });
    if (p === "/api/me/apply/usage") return r.fulfill({ json: { plan: "basic", period: "month", limit: 100, used: 0, remaining: 100 } });
    if (p === "/api/me/apply/history") return r.fulfill({ json: { applied: [] } });
    if (p === "/api/me/apply/queue" && m === "GET") return r.fulfill({ json: { queue: state.queue } });
    if (p.startsWith("/api/me/apply/queue/") && m === "DELETE") { state.queue = []; return r.fulfill({ status: 204, body: "" }); }
    if (p === `/api/jobs/${state.job.id}`) return r.fulfill({ json: state.job });
    if (p === "/api/me/apply/claim") { state.claims.push(req.postDataJSON()); return r.fulfill({ json: { remaining: 99 } }); }
    if (p === "/api/me/apply/result") { state.results.push(req.postDataJSON()); return r.fulfill({ status: 204, body: "" }); }
    return r.fulfill({ status: 204, body: "" });
  }
  if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return r.continue();
  if (u.origin + u.pathname === GRAPHQL) {
    let body = null;
    try { body = req.postDataJSON(); } catch {}
    if (body && /^\s*query\b/.test(body.query || "")) return r.continue();
    // Ashby saves each answer as it is given; what it would have saved, by field path.
    if (body && body.operationName === "ApiSetFormValue") state.saved[body.variables.path] = body.variables.value;
    blocked.push(`graphql ${body ? body.operationName : "(not JSON: " + (req.headers()["content-type"] || "?").split(";")[0] + ")"}`);
    return r.abort();
  }
  blocked.push(`${req.method()} ${u.hostname}${u.pathname}`);
  return r.abort();
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(async () => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "cv.pdf", type: "application/pdf", size: 13, data: btoa("%PDF-1.4 test") } });
  // The token change schedules a run in 30 s; this test starts its own.
  await chrome.alarms.clearAll();
  globalThis.__steps = [];
  const inner = inTab;
  inTab = async (tabId, ats, method, args = [], frameId) => {
    if (method === "submit") {
      // What the form holds the moment before the submit click.
      const [snap] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        const v = (p) => { const e = document.querySelector(`[data-field-path="${p}"] input`); return e && e.value; };
        return { name: v("_systemfield_name"), email: v("_systemfield_email"), location: v("_systemfield_location"),
          cv: (document.querySelector('[data-field-path="_systemfield_resume"]') || {}).textContent || "" };
      } });
      globalThis.__steps.push({ method: "values before submit", result: snap.result });
    }
    const res = await inner(tabId, ats, method, args, frameId);
    globalThis.__steps.push({ method, args: method === "fill" ? args[0] : undefined, result: res });
    return res;
  };
});

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };
const rows = [];

async function runJob({ job, form }, { supplyAnswers }) {
  const profile = baseProfile();
  // Required questions the profile and its saved answers leave open; the
  // ones a real user would be asked for.
  const open = match.planFill(form.fields, profile, job).missing;
  if (supplyAnswers) profile.answers.push(...open.filter((f) => f.type !== "file").map((f) => ({ question: f.label, answer: answerFor(f) })));
  state = { job, profile, queue: [{ job_id: job.id, added_at: new Date().toISOString() }], calls: [], claims: [], results: [], saved: {} };
  blocked.length = 0;
  await sw.evaluate(() => { globalThis.__steps = []; return chrome.storage.local.remove(["lastError", "needs"]); });

  const t0 = Date.now();
  await sw.evaluate(() => run());
  const secs = (Date.now() - t0) / 1000;
  const { steps, st } = await sw.evaluate(async () => ({ steps: globalThis.__steps, st: await chrome.storage.local.get(["lastError"]) }));
  const read = (steps.find((s) => s.method === "read") || {}).result || {};
  const fillStep = steps.find((s) => s.method === "fill");
  const snap = (steps.find((s) => s.method === "values before submit") || {}).result;
  const submitted = steps.some((s) => s.method === "submit" && s.result === true);
  const result = state.results[0] || {};
  const row = {
    company: job.company_name || job.company_domain, url: job.url, secs: secs.toFixed(1),
    fields: (read.fields || []).length, required: (read.fields || []).filter((f) => f.required).length,
    filled: fillStep ? fillStep.args.length - fillStep.result.errors.length : 0,
    errors: fillStep ? fillStep.result.errors : [], missing: open.map((f) => f.label),
    status: result.status, reason: result.reason, blocked: [...new Set(blocked)],
    types: [...new Set((read.fields || []).map((f) => f.type))].join(","),
  };
  rows.push({ ...row, supplyAnswers });
  console.log(`\n== ${row.company}  ${job.url}  (${supplyAnswers ? "open questions answered" : "profile only"})`);
  console.log(`run() ${row.secs}s; lastError: ${st.lastError || "none"}; ${row.fields} fields (${row.types}), ${row.required} required`);
  console.log("open with the profile alone:", JSON.stringify(row.missing));
  if (fillStep) for (const f of fillStep.args) console.log(`   fill ${f.type.padEnd(11)} ${f.label.slice(0, 60).padEnd(60)} <- ${JSON.stringify(f.value).slice(0, 50)}`);
  console.log("fill errors:", JSON.stringify(row.errors));
  console.log("before submit:", JSON.stringify(snap));
  console.log("result:", JSON.stringify(state.results));
  console.log("blocked:", JSON.stringify(row.blocked));

  const tag = `${row.company}`;
  check(`${tag}: no error from run()`, !st.lastError, st.lastError || "");
  check(`${tag}: finished in time`, secs < 150, `${row.secs}s`);
  check(`${tag}: read the form`, row.fields > 0, read.error || "");
  check(`${tag}: reported one result, not submitted`, state.results.length === 1 && result.status !== "submitted", JSON.stringify(state.results));
  check(`${tag}: the job tab was closed`, (await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://jobs.ashbyhq.com/*" })).length)) === 0);
  if (!supplyAnswers) {
    if (row.missing.length) check(`${tag}: skipped, asking for the open questions`, result.status === "skipped" && /^needs answer: /.test(result.reason || ""), result.reason);
    return;
  }
  if (open.some((f) => f.type === "file")) {
    check(`${tag}: skipped for a required file other than the CV`, result.status === "skipped", result.reason);
    return;
  }
  check(`${tag}: filled with no errors`, !!fillStep && row.errors.length === 0, JSON.stringify(row.errors));
  const unsaved = fillStep.args.filter((f) => f.type !== "file" && !(f.name in state.saved)).map((f) => f.label);
  check(`${tag}: Ashby took every answer (one save per field)`, unsaved.length === 0, JSON.stringify(unsaved));
  check(`${tag}: name and email in the form`, !!snap && snap.name === "Test Person" && snap.email === "test@example.com", JSON.stringify(snap));
  check(`${tag}: CV attached`, !!snap && snap.cv.includes("cv.pdf"));
  if (form.fields.some((f) => f.name === "_systemfield_location")) check(`${tag}: location picked`, !!snap && /london/i.test(snap.location || ""), snap && snap.location);
  check(`${tag}: claimed one credit`, state.claims.length === 1 && state.claims[0].job_id === job.id);
  check(`${tag}: pressed submit`, submitted);
  // ApiSubmitSingleApplicationFormAction, or ApiSubmitMultipleFormsAction when the job has a survey form too.
  check(`${tag}: the submit mutation was sent and blocked`, blocked.some((b) => /^graphql ApiSubmit\w*Action$/.test(b)), JSON.stringify(row.blocked));
  check(`${tag}: reported failed`, result.status === "failed", result.reason);
}

for (const p of picked) await runJob(p, { supplyAnswers: true });
// The same run with the profile alone, on a form that asks something it
// cannot answer: the job is skipped and nothing is filled or claimed.
const asks = picked.find((p) => match.planFill(p.form.fields, baseProfile(), p.job).missing.length);
if (asks) await runJob(asks, { supplyAnswers: false });

await ctx.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log("\n| company | fields | required | filled | errors | open questions | status | blocked writes |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.company}${r.supplyAnswers ? "" : " (profile only)"} | ${r.fields} | ${r.required} | ${r.filled} | ${r.errors.length ? r.errors.join("; ") : 0} | ${r.missing.length ? r.missing.map((s) => s.slice(0, 40)).join("; ") : "none"} | ${r.status}: ${(r.reason || "").slice(0, 70)} | ${r.blocked.join(", ")} |`);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
