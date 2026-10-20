// The background run (run() in extension/background.js) against real,
// live Workable forms, one job at a time, with our API stubbed. Every
// write that would leave the browser for anywhere but the stub is aborted,
// so the submit click goes nowhere and nothing reaches the employer.
// Run from the repo root: node tests/e2e/_ext_workable_run.mjs [count]
import { chromium } from "playwright";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const COUNT = Number(process.argv[2] || 8);
const ext = path.resolve("extension");
const wk = require(path.join(ext, "ats/workable.js"));
const match = require(path.join(ext, "lib/match.js"));

// Live Workable jobs from our own API, one per company.
const listed = (await (await fetch("https://oceanofjobs.com/api/jobs?ats=workable&limit=100&count=skip")).json()).jobs;
const companies = new Set();
const jobs = listed.filter((j) => wk.matches(j.url) && !companies.has(j.company_domain) && companies.add(j.company_domain));
if (jobs.length < COUNT) throw new Error(`only ${jobs.length} Workable jobs from distinct companies`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-wk-"));
const ctx = await chromium.launchPersistentContext(dir, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });

const baseProfile = () => ({
  contact: { first_name: "Test", last_name: "Person", email: "test@example.com", phone: "+44 7400 123456", location: "London, United Kingdom" },
  links: { linkedin: "https://linkedin.com/in/test", github: "https://github.com/test", website: "https://test.example.com" },
  work: { authorized_countries: ["GB"], needs_sponsorship: false, notice_period: "30 days", salary: "50000" },
  eeo: { gender: "decline", race: null, veteran: null, disability: null }, answers: [],
  settings: { mode: "queue", sources: ["board"], unknowns: "skip", guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } },
});

let state;
let current;
const calls = [];
const blocked = [];
await ctx.route("**/*", async (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com") {
    const p = u.pathname, m = req.method();
    calls.push(`${m} ${p}`);
    if (p === "/api/me/apply/profile") return r.fulfill({ json: { profile: state.profile, preferences: { skills: [] } } });
    if (p === "/api/me/apply/usage") return r.fulfill({ json: { plan: "basic", period: "day", limit: 50, used: 0, remaining: 50 } });
    if (p === "/api/me/apply/history") return r.fulfill({ json: { applied: [] } });
    if (p === "/api/me/apply/queue" && m === "GET") return r.fulfill({ json: { queue: state.queue } });
    if (p.startsWith("/api/me/apply/queue/") && m === "DELETE") {
      state.queue = state.queue.filter((q) => q.job_id !== decodeURIComponent(p.split("/").pop()));
      return r.fulfill({ status: 204, body: "" });
    }
    if (p === `/api/jobs/${current.id}`) return r.fulfill({ json: current });
    if (p === "/api/me/apply/claim") { state.claims.push(req.postDataJSON()); return r.fulfill({ json: { remaining: 49 } }); }
    if (p === "/api/me/apply/result") { state.results.push(req.postDataJSON()); return r.fulfill({ status: 204, body: "" }); }
    return r.fulfill({ status: 204, body: "" });
  }
  if (req.method() === "POST" && u.hostname === "workable-application-form.s3.us-east-1.amazonaws.com") {
    // The CV upload Workable makes on attach. Answered here like S3 would,
    // so the form goes on to its real submit and nothing is stored.
    const key = /name="key"\r\n\r\n([^\r]*)/.exec((req.postDataBuffer() || "").toString("latin1"));
    state.uploads.push(key ? key[1] : "?");
    return r.fulfill({ status: 201, contentType: "application/xml",
      body: `<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>${u.origin}/${key && key[1]}</Location><Key>${key && key[1]}</Key><ETag>"0"</ETag></PostResponse>` });
  }
  // Anything else that writes (the application POST, Cloudflare's
  // challenge beacons, analytics) is stopped here and only its address kept.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
    blocked.push(`${req.method()} ${u.hostname}${u.pathname.replace(/\/cdn-cgi\/challenge-platform\/.*/, "/cdn-cgi/challenge-platform/...")}`);
    // What the employer would have received, kept to check against the plan.
    if (u.hostname === "apply.workable.com" && /\/apply$/.test(u.pathname)) state.sent = req.postData();
    return r.abort();
  }
  return r.continue();
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(async () => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "cv.pdf", type: "application/pdf", size: 13, data: btoa("%PDF-1.4 test\n%%EOF\n") } });
  // The token change schedules a run in 30 s; this test starts its own.
  await chrome.alarms.clearAll();
  // Log every step run() takes inside the tab, and what the form holds
  // the moment before the submit click.
  globalThis.__steps = [];
  const inner = inTab;
  inTab = async (tabId, ats, method, args = [], frameId) => {
    if (method === "submit") {
      const [snap] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        const v = (n) => (document.querySelector(`form [name="${n}"]`) || {}).value;
        const file = document.querySelector('input[type="file"][data-ui="resume"]');
        return { firstname: v("firstname"), lastname: v("lastname"), email: v("email"), phone: v("phone"), address: v("address"),
          phoneCountry: (document.querySelector('[data-ui="phone"] button[aria-haspopup]') || { getAttribute: () => null }).getAttribute("aria-label"),
          resume: file ? (file.files.length ? file.files[0].name : "") + " | " + file.closest('[data-role="dropzone"]').textContent.slice(0, 80) : null };
      } });
      globalThis.__steps.push({ method: "values before submit", result: snap.result });
    }
    const res = await inner(tabId, ats, method, args, frameId);
    globalThis.__steps.push({ method, result: method === "read" ? res && { fields: res.fields, error: res.error } : res });
    return res;
  };
});

// A saved answer for each required question a bare profile cannot answer,
// shaped the way the question wants it.
const answerFor = (f) => ({
  question: f.label,
  answer: f.options.length ? f.options[0] : f.kind === "date" ? "2026-11-02" : f.kind === "number" ? "1000" : "Test answer",
});

const rows = [];
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };

for (const job of jobs.slice(0, COUNT)) {
  current = { ...job, closed_at: null };
  console.log(`\n== ${job.company_domain}  ${job.title}  ${job.url}`);

  // Which required questions this form asks, read the way the extension does.
  const probe = await ctx.newPage();
  await probe.goto(wk.formUrl(job.url), { waitUntil: "load" });
  const form = wk.fromSpec(await probe.evaluate(wk.pageData) || "");
  await probe.close();
  if (!form) { check(`${job.company_domain}: form loaded`, false); rows.push({ company: job.company_domain, status: "no form" }); continue; }
  const unknown = match.planFill(form.fields, baseProfile(), current).missing.filter((f) => f.type !== "file" && f.type !== "group");

  const profile = baseProfile();
  profile.answers = unknown.map(answerFor);
  state = { profile, queue: [{ job_id: job.id, added_at: new Date().toISOString() }], claims: [], results: [], uploads: [] };
  calls.length = 0; blocked.length = 0;
  await sw.evaluate(() => { globalThis.__steps = []; return chrome.storage.local.remove(["lastError", "needs"]); });

  const t0 = Date.now();
  await sw.evaluate(() => run());
  const secs = (Date.now() - t0) / 1000;
  const { steps, st } = await sw.evaluate(async () => ({ steps: globalThis.__steps, st: await chrome.storage.local.get(["lastError", "needs"]) }));

  const read = (steps.find((s) => s.method === "read") || {}).result || {};
  const fill = (steps.find((s) => s.method === "fill") || {}).result;
  const snap = (steps.find((s) => s.method === "values before submit") || {}).result || {};
  const fields = read.fields || [];
  const plan = match.planFill(fields, profile, current);
  const result = state.results[0] || {};
  // Every planned answer as Workable's own form state holds it, from the
  // blocked POST: proof React took the typing, not just the DOM.
  const sent = state.sent ? JSON.parse(state.sent).candidate : [];
  const given = new Set(sent.filter((x) => x.value !== "" && x.value != null && !(Array.isArray(x.value) && !x.value.length)).map((x) => x.name));
  const lost = plan.fills.map((f) => f.name).filter((n) => !given.has(n));
  console.log(`run() ${secs.toFixed(1)}s; lastError: ${st.lastError || "none"}`);
  console.log(`fields ${fields.length}, required ${fields.filter((f) => f.required).length}, saved answers ${unknown.length}, planned ${plan.fills.length}, missing ${plan.missing.length}`,
    plan.missing.map((f) => f.label));
  console.log("fill errors:", JSON.stringify(fill ? fill.errors : null));
  console.log("before submit:", JSON.stringify(snap));
  console.log("submit:", JSON.stringify((steps.find((s) => s.method === "submit") || {}).result));
  console.log("result:", JSON.stringify(state.results));
  console.log("blocked writes:", JSON.stringify([...new Set(blocked)]));
  console.log("sent:", JSON.stringify(sent.map((x) => `${x.name}=${typeof x.value === "object" ? JSON.stringify(x.value).slice(0, 40) : x.value}`)).slice(0, 1500));
  rows.push({
    company: job.company_domain, fields: fields.length, required: fields.filter((f) => f.required).length, answers: unknown.length,
    filled: plan.fills.length, sent: given.size, errors: fill ? fill.errors.length : "-", missing: plan.missing.length,
    status: `${result.status || "none"}${result.reason ? ": " + result.reason.slice(0, 70) : ""}`, blocked: blocked.length, secs: Math.round(secs),
  });

  const name = job.company_domain;
  check(`${name}: no error from run()`, !st.lastError, st.lastError || "");
  check(`${name}: read the form`, fields.length > 0, read.error || "");
  check(`${name}: filled it with no errors`, !!fill && fill.errors.length === 0, fill ? JSON.stringify(fill.errors) : "never filled");
  check(`${name}: contact fields in the form`, snap.firstname === "Test" && snap.lastname === "Person" && snap.email === "test@example.com", JSON.stringify(snap));
  check(`${name}: phone with its country`, !fields.some((f) => f.kind === "phone") || (snap.phone && /United Kingdom \(\+44\)$/.test(snap.phoneCountry || "")), `${snap.phone} ${snap.phoneCountry}`);
  check(`${name}: address`, !fields.some((f) => f.name === "address") || snap.address === "London, United Kingdom", snap.address);
  check(`${name}: CV attached`, /^cv\.pdf/.test(snap.resume || ""), snap.resume);
  check(`${name}: the CV was uploaded once, to the stub`, state.uploads.length === 1, JSON.stringify(state.uploads));
  check(`${name}: pressed submit`, steps.some((s) => s.method === "submit" && s.result === true));
  check(`${name}: the application POST was sent and blocked`, blocked.some((b) => /^POST apply\.workable\.com\/api\/v1\/jobs\/[0-9A-Z]+\/apply$/i.test(b)));
  check(`${name}: every planned answer was in the application sent`, sent.length > 0 && lost.length === 0, JSON.stringify(lost));
  check(`${name}: reported one result, not submitted`, state.results.length === 1 && result.job_id === job.id && result.status !== "submitted", JSON.stringify(state.results));
  check(`${name}: dequeued the job`, calls.includes(`DELETE /api/me/apply/queue/${job.id}`));
  check(`${name}: no hang`, secs < 120, `${secs}s`);
  check(`${name}: the job tab was closed`, (await sw.evaluate(async () => (await chrome.tabs.query({})).filter((t) => t.url.includes("workable.com")).length)) === 0);
}
await ctx.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log("\n| company | fields | required | saved answers | filled | sent | fill errors | missing | blocked writes | secs | reported |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.company} | ${r.fields} | ${r.required} | ${r.answers} | ${r.filled} | ${r.sent} | ${r.errors} | ${r.missing} | ${r.blocked} | ${r.secs} | ${r.status} |`);
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
