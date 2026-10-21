// Live acceptance for extension 1.9: the attempts lifecycle on real
// application forms. Greenhouse, Ashby and Workable through the background
// run (applyTo), Lever through the career-page card (fillTab + submitHere).
// The attempts API is a stateful stand-in; the employer's submission
// request is aborted and counted, so nothing is ever sent.
// Run from the repo root: node tests/e2e/_ext_attempts_live.mjs
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const failures = [];
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : "  -- " + detail}`); if (!ok) failures.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function liveJob(ats) {
  const { jobs = [] } = await (await fetch(`https://oceanofjobs.com/api/jobs?ats=${ats}&limit=5&count=skip`, { signal: AbortSignal.timeout(30000) })).json();
  return jobs[0];
}
const jobs = [];
for (const ats of ["greenhouse", "ashby", "workable", "lever"]) {
  const j = await liveJob(ats).catch(() => null);
  if (j) jobs.push(j);
  await sleep(700);
}

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-attempts-live-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-attempts-live-profile-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.addInitScript(() => {
  const none = { register: () => Promise.reject(new Error("blocked")), getRegistrations: async () => [], getRegistration: async () => undefined,
    ready: new Promise(() => {}), controller: null, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => none, configurable: true }); } catch { /* gone */ }
});

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: "test.person@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://www.linkedin.com/in/test-person" }, work: { authorized_countries: ["IL"], needs_sponsorship: true },
  eeo: { gender: "decline", race: "decline", veteran: "decline", disability: "decline" }, answers: [],
  settings: { mode: "queue", sources: ["board", "ats_pages"], unknowns: "ai", guardrails: {} },
};
const state = { attempts: {}, events: [], submits: [], host: "", gates: [], approved: new Set(), review: false };
// A submission: a write to the job's own site that isn't the CV parser.
// Other hosts (analytics, LinkedIn's widget) are the page's own traffic.
await ctx.route("**/*", async (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com" && u.pathname.startsWith("/api/me/apply/")) {
    const p = u.pathname.replace("/api/me/apply/", "");
    let body = null;
    try { body = req.postDataJSON(); } catch { /* none */ }
    if (p === "profile") return r.fulfill({ json: { profile, preferences: {} } });
    if (p.startsWith("summary")) return r.fulfill({ json: { plan: "pro", period: "day", limit: 50, used: 0, in_progress: 0, remaining: 50, applied_today: 0 } });
    if (p.startsWith("history")) return r.fulfill({ json: { applied: [] } });
    if (p === "needs") return r.fulfill({ json: { needs: [] } });
    if (p === "draft") return r.fulfill({ json: { answer: body.options && body.options.length ? body.options[0] : "Test answer" } });
    if (p === "filled") return r.fulfill({ json: { attempt: { state: "filled" } } });
    if (p === "attempts") {
      // The job lock: an attempt that reached the gate keeps the job.
      if (!state.attempts[body.attempt_id] && Object.values(state.attempts).some((x) => x.job_id === body.job_id
          && ["submission_started", "unconfirmed", "submitted"].includes(x.state))) {
        return r.fulfill({ status: 409, json: { code: "job_taken", error: "already applied", retryable: false } });
      }
      state.attempts[body.attempt_id] = state.attempts[body.attempt_id] || { job_id: body.job_id, state: "reserved" };
      state.events.push([Date.now(), "reserve"]);
      return r.fulfill({ json: { attempt: state.attempts[body.attempt_id] } });
    }
    const [, id, action] = p.split("/");
    const a = state.attempts[id];
    if (!a) return r.fulfill({ status: 404, json: { code: "not_found", retryable: false } });
    if (action === "submission-started") {
      state.gates.push(body);
      const held = state.review && body.mode === "auto" ? (body.answers || []).filter((x) => x.source === "ai" && !state.approved.has(x.question)) : [];
      if (held.length) {
        return r.fulfill({ status: 409, json: { code: "needs_review", error: "check AI answers", retryable: false, questions: held.map((x) => x.question) } });
      }
      a.state = "submission_started";
      state.events.push([Date.now(), "gate"]);
      return r.fulfill({ json: { attempt: a, submit: true } });
    }
    if (action === "settle") {
      if (a.state !== body.outcome) { a.state = body.outcome; a.reason = body.reason; a.questions = body.questions; a.settles = (a.settles || 0) + 1; }
      return r.fulfill({ json: { attempt: a } });
    }
    return r.fulfill({ status: 404, json: {} });
  }
  if (u.hostname === "oceanofjobs.com") return r.continue();
  if (req.method() === "POST" && /\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(u.hostname)) {
    const key = /name="key"\r\n\r\n([^\r]*)/.exec((req.postDataBuffer() || "").toString("latin1"));
    return r.fulfill({ status: 201, contentType: "application/xml", body: `<PostResponse><Key>${key && key[1]}</Key></PostResponse>` });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
    const post = (req.postData() || "").slice(0, 400);
    const read = (u.pathname === "/api/non-user-graphql" && !/Submit|Mutation/i.test(post))
      || u.pathname.startsWith("/cdn-cgi/challenge-platform") || /hcaptcha\.com$/.test(u.hostname);
    if (read) return r.continue();
    // Ashby's GraphQL also carries fill-time writes (the CV upload); only its
    // submit mutation sends the application.
    const ashbyWrite = u.pathname === "/api/non-user-graphql" && !/ApiSubmit/i.test(post);
    if (u.hostname === state.host && !/parseResume/i.test(u.pathname) && !ashbyWrite) state.submits.push([Date.now(), `${u.hostname}${u.pathname}`]);
    return r.abort();
  }
  return r.continue();
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
await sw.evaluate(async (data) => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "Test_Person_CV.pdf", type: "application/pdf", size: data.length, data: btoa(data) } });
  await chrome.alarms.clearAll();
}, pdf);

for (const job of jobs) {
  console.log(`\n${job.ats}: ${job.url}`);
  state.attempts = {}; state.events = []; state.submits = []; state.host = new URL(job.url).hostname;
  let result;
  try {
    if (job.ats === "lever") {
      const page = await ctx.newPage();
      await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(3000);
      const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).filter((t) => (t.url || "").startsWith("http")).sort((a, b) => b.id - a.id)[0].id);
      await sw.evaluate((id) => fillTab(id), tabId);
      await sleep(1500);
      const t = await sw.evaluate(async (id) => chrome.tabs.get(id), tabId);
      result = await sw.evaluate(([id, url, title]) => submitHere({ url, title, company: "lever", frameId: 0 }, { tab: { id }, frameId: 0 }),
        [tabId, t.url, t.title]);
      await page.close();
    } else {
      result = await sw.evaluate(async (j) => {
        const { profile } = await api("/me/apply/profile");
        const st = await chrome.storage.local.get(["cv"]);
        return applyTo(j, { profile, preferences: {}, settings: profile.settings, cv: st.cv, ai: null, serverAi: true });
      }, job);
    }
  } catch (e) {
    check("ran without error", false, e.message.split("\n")[0]);
    continue;
  }
  await sleep(500);
  const attempts = Object.values(state.attempts);
  const a = attempts[0] || {};
  const gateAt = (state.events.find((e) => e[1] === "gate") || [])[0];
  console.log(`  result: ${JSON.stringify(result)}; attempt: ${a.state} ${a.reason ? "(" + a.reason.slice(0, 80) + ")" : ""}; submit requests: ${state.submits.length}`);
  if (result && result.error && /submit the form yourself/.test(result.error)) {
    check("a bot-checked form: nothing reserved, no gate, no click", !attempts.length && !gateAt && !state.submits.length,
      JSON.stringify({ attempts, submits: state.submits }));
    continue;
  }
  check("one attempt, reserved before anything else", attempts.length === 1 && state.events[0] && state.events[0][1] === "reserve", JSON.stringify(state.events));
  if (a.state === "needs_input") {
    check("a question the profile can't answer: paused as needs input, no gate, no click", !gateAt && !state.submits.length);
  } else {
    check("no submission request before the gate's acknowledgement", state.submits.every(([t]) => gateAt && t >= gateAt), JSON.stringify({ gateAt, submits: state.submits }));
    check("at most one submission request, never repeated", state.submits.length <= 1, JSON.stringify(state.submits));
    check("with the employer's request blocked it is never recorded as submitted", a.state !== "submitted", a.state);
    check("settled once", a.settles === 1 && ["unconfirmed", "failed"].includes(a.state), JSON.stringify(a));
  }
}

// Review (custom agent step 3): an AI answer the user hasn't approved stops
// an automatic run at the gate. The job pauses with its questions, nothing
// is sent; once the user approves, the next run passes and clicks once, and
// a retry of the same job is refused rather than sent twice.
state.review = true;
for (const job of jobs.filter((j) => ["greenhouse", "ashby"].includes(j.ats))) {
  console.log(`\nreview, ${job.ats}: ${job.url}`);
  state.attempts = {}; state.events = []; state.submits = []; state.gates = []; state.approved = new Set(); state.host = new URL(job.url).hostname;
  profile.answers = [];
  const run = () => sw.evaluate(async (j) => {
    const { profile } = await api("/me/apply/profile");
    const st = await chrome.storage.local.get(["cv"]);
    return applyTo(j, { profile, preferences: {}, settings: profile.settings, cv: st.cv, ai: null, serverAi: true });
  }, job);
  let result;
  try { result = await run(); } catch (e) { check("ran without error", false, e.message.split("\n")[0]); continue; }
  const first = Object.values(state.attempts)[0] || {};
  const sentAi = (state.gates[0] && state.gates[0].answers || []).filter((x) => x.source === "ai");
  console.log(`  run 1: ${JSON.stringify(result)}; ${first.state}; AI answers at the gate: ${sentAi.length}; submit requests: ${state.submits.length}`);
  if (!sentAi.length) {
    check("this form needed no AI answer, so review didn't apply", result !== "failed" || first.state !== "needs_input", JSON.stringify(first));
    continue;
  }
  check("the gate got every filled answer, the AI's marked", state.gates[0].mode === "auto" && state.gates[0].answers.length > sentAi.length);
  check("an unapproved AI answer stops the run: paused for review, nothing sent", first.state === "needs_input" && state.submits.length === 0
    && JSON.stringify(first.questions) === JSON.stringify(sentAi.map((x) => x.question)), JSON.stringify(first));
  // The user approves (here: saves each drafted answer as their own).
  profile.answers = sentAi.map((x) => ({ question: x.question, answer: x.answer, source: "user", approval: "approved" }));
  state.approved = new Set(sentAi.map((x) => x.question));
  state.submits = [];
  result = await run();
  const second = Object.values(state.attempts).find((x) => x !== first) || {};
  console.log(`  run 2: ${JSON.stringify(result)}; ${second.state}; submit requests: ${state.submits.length}`);
  check("once approved, the next run passes the gate and sends once", state.gates.length === 2 && second.state !== "needs_input"
    && state.submits.length <= 1 && second.state !== "submitted", JSON.stringify({ second, submits: state.submits }));
  const before = state.submits.length;
  result = await run();
  if (second.state === "failed") {
    // The site refused it before anything was sent: the job is free to try again.
    check("after a failure that sent nothing, a retry may run, and still never sends twice", state.submits.length <= 1,
      JSON.stringify({ result, submits: state.submits }));
  } else {
    check("after a click, a retry of the same job is refused, not sent again", result === "skipped" && state.submits.length === before,
      JSON.stringify({ result, submits: state.submits }));
  }
}

await ctx.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
