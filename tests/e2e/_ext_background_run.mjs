// The periodic auto apply run (run() in extension/background.js) against a
// real Greenhouse form, with our API stubbed. Every POST that would leave
// the browser for anywhere but the stub is aborted, so the submit click
// goes nowhere and nothing reaches the employer. Runs queue mode, then
// automatic mode with no candidates so only the queued job is applied.
// Run from the repo root: node tests/e2e/_ext_background_run.mjs
import { chromium } from "playwright";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const JOB_URL = "https://job-boards.greenhouse.io/embed/job_app?for=appsflyer&token=8882905002";
const JOB_ID = "0123456789abcdef";
const ext = path.resolve("extension");
const { fromRemix } = require(path.join(ext, "ats/greenhouse.js"));
const match = require(path.join(ext, "lib/match.js"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-run-"));
const ctx = await chromium.launchPersistentContext(dir, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });

const job = { id: JOB_ID, url: JOB_URL, ats: "greenhouse", title: "Test role", company_name: "AppsFlyer", company_domain: "appsflyer.com",
  location: "Herzliya, Israel", country: "IL", closed_at: null, match_score: 90 };
const baseProfile = () => ({
  contact: { first_name: "Test", last_name: "Person", email: "test@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://linkedin.com/in/test", github: "", website: "" },
  work: { authorized_countries: ["IL"], needs_sponsorship: false, notice_period: "30 days", salary: "" },
  eeo: { gender: "decline", race: null, veteran: null, disability: null }, answers: [],
  settings: { mode: "queue", sources: ["board"], unknowns: "skip", guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } },
});

let state;
const calls = [];
const blocked = [];
await ctx.route("**/*", async (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com") {
    const p = u.pathname, m = req.method();
    calls.push(`${m} ${p}${p === "/api/jobs" ? u.search : ""}`);
    if (p === "/api/me/apply/profile") return r.fulfill({ json: { profile: state.profile, preferences: { skills: ["Python"] } } });
    if (p === "/api/me/apply/usage") return r.fulfill({ json: { plan: state.plan, period: "day", limit: 50, used: 0, remaining: 50 } });
    if (p === "/api/me/apply/history") return r.fulfill({ json: { applied: state.history } });
    if (p === "/api/me/apply/queue" && m === "GET") return r.fulfill({ json: { queue: state.queue } });
    if (p.startsWith("/api/me/apply/queue/") && m === "DELETE") {
      state.queue = state.queue.filter((q) => q.job_id !== decodeURIComponent(p.split("/").pop()));
      return r.fulfill({ status: 204, body: "" });
    }
    if (p === `/api/jobs/${JOB_ID}`) return r.fulfill({ json: job });
    if (p === "/api/jobs") return r.fulfill({ json: { jobs: [] } });
    if (p === "/api/me/apply/draft") {
      const body = req.postDataJSON();
      state.drafts.push(body.question);
      return r.fulfill({ json: { answer: body.options.length ? body.options[0] : "Test answer" } });
    }
    if (p === "/api/me/apply/claim") { state.claims.push(req.postDataJSON()); return r.fulfill({ json: { remaining: 49 } }); }
    if (p === "/api/me/apply/result") {
      const body = req.postDataJSON();
      state.results.push(body);
      state.history.push({ ...body, at: new Date().toISOString() });
      return r.fulfill({ status: 204, body: "" });
    }
    return r.fulfill({ status: 204, body: "" });
  }
  if (req.method() === "POST" && u.hostname.endsWith(".s3.amazonaws.com")) {
    // The CV upload Greenhouse makes on attach. Answered here like S3 would,
    // so the form goes on to its real submit and nothing is stored.
    const key = /name="key"\r\n\r\n([^\r]*)/.exec((req.postDataBuffer() || "").toString("latin1"));
    state.uploads.push(key ? key[1] : "?");
    return r.fulfill({ status: 201, contentType: "application/xml",
      body: `<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>${u.origin}/${key && key[1]}</Location><Key>${key && key[1]}</Key><ETag>"0"</ETag></PostResponse>` });
  }
  // Anything else that writes (the application POST, reCAPTCHA, analytics
  // beacons) is stopped here and only its address kept.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
    blocked.push(`${req.method()} ${u.hostname}${u.pathname}`);
    return r.abort();
  }
  return r.continue();
});

// Which required questions this form asks that a bare profile cannot
// answer, read the same way the extension reads them.
const probe = await ctx.newPage();
await probe.goto(JOB_URL, { waitUntil: "load" });
const remix = await probe.evaluate(() => (window.__remixContext ? JSON.stringify(window.__remixContext) : null));
await probe.close();
const form = remix && fromRemix(remix);
if (!form) throw new Error("the Greenhouse form did not load or its shape changed");
const unknown = match.planFill(form.fields, baseProfile(), job).missing
  .filter((f) => f.type !== "file" && !match.isEeo(f));
console.log(`form: ${form.fields.length} fields, ${unknown.length} required with no profile answer:`, unknown.map((f) => f.label));
const answerFor = (f) => ({ question: f.label, answer: f.options.length ? f.options[0] : "Test answer" });

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(async () => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "cv.pdf", type: "application/pdf", size: 13, data: btoa("%PDF-1.4 test") } });
  // The token change schedules a run in 30 s; this test starts its own.
  await chrome.alarms.clearAll();
  // Log every step run() takes inside the tab, and what the form holds
  // the moment before the submit click.
  globalThis.__steps = [];
  const inner = inTab;
  inTab = async (tabId, ats, method, args = [], frameId) => {
    if (method === "submit") {
      const [snap] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        const v = (id) => (document.getElementById(id) || {}).value;
        return { first_name: v("first_name"), last_name: v("last_name"), email: v("email"), phone: v("phone"),
          country: (document.querySelector('#country')?.closest('.select__control') || {}).textContent };
      } });
      globalThis.__steps.push({ method: "values before submit", result: snap.result });
    }
    const res = await inner(tabId, ats, method, args, frameId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    globalThis.__steps.push({ method, url: tab && tab.url, result: method === "read" ? res && { fields: res.fields && res.fields.length, error: res.error } : res });
    return res;
  };
});

const tabs = [];
ctx.on("page", (p) => tabs.push(p.url() || "(blank)"));

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };

async function runMode(mode) {
  const profile = baseProfile();
  profile.settings.mode = mode;
  // Queue mode: every unknown has a saved answer. Automatic mode: the first
  // one is left to the server AI (Pro plan) to exercise /me/apply/draft.
  const viaAi = mode === "auto" ? unknown.slice(0, 1) : [];
  profile.answers = unknown.filter((f) => !viaAi.includes(f)).map(answerFor);
  if (mode === "auto") profile.settings.unknowns = "ai";
  state = { profile, plan: mode === "auto" ? "pro" : "basic", history: [], queue: [{ job_id: JOB_ID, added_at: new Date().toISOString() }],
    drafts: [], claims: [], results: [], uploads: [] };
  calls.length = 0; blocked.length = 0; tabs.length = 0;
  await sw.evaluate(() => { globalThis.__steps = []; return chrome.storage.local.remove(["lastError", "needs"]); });

  console.log(`\n== mode: ${mode}`);
  const t0 = Date.now();
  await sw.evaluate(() => run());
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const { steps, st } = await sw.evaluate(async () => ({ steps: globalThis.__steps, st: await chrome.storage.local.get(["lastError", "lastRun", "needs"]) }));

  console.log(`run() finished in ${secs}s; lastError: ${st.lastError || "none"}`);
  console.log("tabs opened:", JSON.stringify(tabs));
  console.log("steps in the tab:");
  for (const s of steps) console.log("  ", s.method, s.url ? `@ ${s.url.slice(0, 80)}` : "", JSON.stringify(s.result));
  console.log("api calls:");
  for (const c of calls) console.log("  ", c);
  console.log("drafted by the AI stub:", JSON.stringify(state.drafts));
  console.log("results reported:", JSON.stringify(state.results));
  console.log("blocked writes:", JSON.stringify(blocked));
  console.log("CV uploads answered in the browser:", JSON.stringify(state.uploads));

  const snap = (steps.find((s) => s.method === "values before submit") || {}).result || {};
  const fill = (steps.find((s) => s.method === "fill") || {}).result;
  check(`${mode}: no error from run()`, !st.lastError, st.lastError || "");
  check(`${mode}: opened the job in a tab`, tabs.some((u) => u.startsWith(JOB_URL)) || steps.some((s) => s.url && s.url.startsWith(JOB_URL)));
  check(`${mode}: read the form`, steps.some((s) => s.method === "read" && s.result && s.result.fields > 0));
  check(`${mode}: filled it with no errors`, !!fill && fill.errors.length === 0, fill ? JSON.stringify(fill.errors) : "never filled");
  check(`${mode}: contact fields in the form`, snap.first_name === "Test" && snap.email === "test@example.com", JSON.stringify(snap));
  check(`${mode}: the CV was uploaded once`, state.uploads.length === 1, JSON.stringify(state.uploads));
  check(`${mode}: claimed one credit`, state.claims.length === 1 && state.claims[0].job_id === JOB_ID);
  check(`${mode}: pressed submit`, steps.some((s) => s.method === "submit" && s.result === true));
  check(`${mode}: the application POST was sent and blocked`, blocked.some((b) => /^POST [a-z-]+\.greenhouse\.io\/embed\/[^/]+\/jobs\/\d+$/.test(b)));
  check(`${mode}: reported one result, not submitted`, state.results.length === 1 && state.results[0].job_id === JOB_ID && state.results[0].status !== "submitted",
    JSON.stringify(state.results));
  check(`${mode}: dequeued the job`, calls.includes(`DELETE /api/me/apply/queue/${JOB_ID}`) && state.queue.length === 0);
  check(`${mode}: claim came before the result`, calls.indexOf("POST /api/me/apply/claim") < calls.indexOf("POST /api/me/apply/result"));
  if (mode === "auto") {
    check("auto: asked for candidates", calls.some((c) => c.startsWith("GET /api/jobs?")));
    if (viaAi.length) check("auto: the AI drafted the unknown", state.drafts.length === viaAi.length, JSON.stringify(state.drafts));
    else console.log("(no required question without an answer on this form, so /me/apply/draft is not exercised)");
  }
  check(`${mode}: the job tab was closed`, (await sw.evaluate(async (u) => (await chrome.tabs.query({})).filter((t) => (t.url || "").startsWith(u)).length, JOB_URL)) === 0);
}

await runMode("queue");
await runMode("auto");
await ctx.close();
fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
