// An automatic run (applyTo in extension/background.js) on real, live jobs,
// stopped at the Submit gate: our API is stubbed, and its gate
// (submission-started) always says no, so the extension never presses a
// site's final button. Writes to every other site are aborted as well.
// A job "reaches the gate" when the run found its form, filled every page,
// answered every required question and found the button that sends it.
// Run from the repo root:
//   SYSTEMS=teamtailor,breezy PER_ATS=4 node tests/e2e/_ext_auto_dryrun.mjs [out-dir]
// WRITES="regex" lets writes to matching addresses through (a Workday
// sign-in and its Save and Continue, a CV upload), except any that match
// NEVER (default /submit/i), which stays aborted whatever WRITES says.
// EMAIL sets the profile's email; the Workday password is WORKDAY_TEST_PASSWORD
// in .env.
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "ooj-dryrun-"));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WRITES = process.env.WRITES ? new RegExp(process.env.WRITES, "i") : null;
const NEVER = new RegExp(process.env.NEVER || "submit", "i");
const envFile = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const WORKDAY_PASSWORD = (/^WORKDAY_TEST_PASSWORD=(.*)$/m.exec(envFile) || [])[1] || "Dry-run-0nly!";
const N = Number(process.env.PER_ATS || 4);
const SYSTEMS = (process.env.SYSTEMS || "smartrecruiters,bamboohr,jazzhr,recruitee,lever,teamtailor,pinpoint,breezy,personio,comeet").split(",");

// Jobs from our own API, different companies where the list allows, or
// the pages named: ATS=smartrecruiters JOB_URLS="url url" for those alone.
const jobs = (process.env.JOB_URLS || "").split(/\s+/).filter(Boolean)
  .map((url, i) => ({ id: (i + 1).toString(16).padStart(16, "0"), url, ats: process.env.ATS, title: "Test job", company_domain: new URL(url).hostname }));
for (const ats of jobs.length ? [] : SYSTEMS) {
  try {
    const res = await fetch(`https://oceanofjobs.com/api/jobs?ats=${ats}&limit=${N * 5}&count=skip`, { signal: AbortSignal.timeout(30000) });
    const { jobs: list = [] } = await res.json();
    const picked = [], seen = new Set();
    for (const j of list) if (picked.length < N && !seen.has(j.company_domain)) { seen.add(j.company_domain); picked.push(j); }
    for (const j of list) if (picked.length < N && !picked.includes(j)) picked.push(j);
    jobs.push(...picked);
  } catch (e) { console.log(`no ${ats} jobs: ${e.message}`); }
  await sleep(1000);
}

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-dry-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-dry-profile-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  // A real user's Chrome says what it is; "HeadlessChrome" gets bot pages
  // (DataDome on SmartRecruiters) that a real user never sees.
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: process.env.EMAIL || "test.person@example.com", phone: "+1 415 555 0134", location: "San Francisco, CA, United States" },
  links: { linkedin: "https://www.linkedin.com/in/test-person", github: "https://github.com/test-person", website: "" },
  work: { authorized_countries: ["US"], needs_sponsorship: false, notice_period: "2 weeks", salary: "100000" },
  eeo: { gender: "decline", race: "decline", veteran: "decline", disability: "decline" },
  answers: [{ question: "How did you hear about us?", answer: "LinkedIn" }],
  settings: { mode: "queue", sources: ["board"], unknowns: "ai", consent: true, guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } },
};

let cur = null;
await ctx.addInitScript(() => {
  const none = { register: () => Promise.reject(new Error("blocked in this test")), getRegistrations: async () => [], getRegistration: async () => undefined,
    ready: new Promise(() => {}), controller: null, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => none, configurable: true }); } catch { /* gone */ }
});
await ctx.route("**/*", (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com") {
    const p = u.pathname;
    const body = (() => { try { return req.postDataJSON(); } catch { return null; } })();
    if (p === "/api/me/apply/draft") {
      cur && cur.drafts.push(body.question);
      return r.fulfill({ json: { answer: body.options && body.options.length ? body.options[0] : "Test answer", source: "ai" } });
    }
    if (p === "/api/me/apply/attempts") return r.fulfill({ json: { attempt: { state: "reserved" } } });
    // The gate: always no, so nothing is ever sent.
    if (/\/submission-started$/.test(p)) {
      if (cur) { cur.gate = true; cur.answers = (body && body.answers) || []; }
      return r.fulfill({ status: 409, json: { code: "dry_run", error: "dry run: not submitted" } });
    }
    if (/\/settle$/.test(p)) { if (cur) cur.settled.push(body); return r.fulfill({ json: { attempt: {} } }); }
    if (p === "/api/me/apply/answers" || p === "/api/me/apply/result" || p === "/api/me/apply/filled") return r.fulfill({ status: 204, body: "" });
    return r.fulfill({ json: {} });
  }
  // The CV upload some forms make the moment a file is attached: answered here, the file never leaves.
  if (req.method() === "POST" && /\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(u.hostname)) {
    const key = /name="key"\r\n\r\n([^\r]*)/.exec((req.postDataBuffer() || "").toString("latin1"));
    return r.fulfill({ status: 201, contentType: "application/xml", body: `<PostResponse><Key>${key && key[1]}</Key></PostResponse>` });
  }
  // A site's bot-detection pings (DataDome, Cloudflare's challenge) carry
  // no application data, and a page whose pings fail refuses to go on.
  if (/^https:\/\/(api-js\.datadome\.co\/js\/|[^/]+\/cdn-cgi\/challenge-platform\/)/.test(req.url())) return r.continue();
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
    if (WRITES && WRITES.test(req.url()) && !NEVER.test(u.pathname)) {
      if (cur) cur.allowed.push(`${req.method()} ${u.hostname}${u.pathname}`.slice(0, 120));
      return r.continue();
    }
    if (cur) cur.blocked.push(`${req.method()} ${u.hostname}${u.pathname}`.slice(0, 120));
    return r.abort();
  }
  return r.continue();
});

// What a site answered to a write let through (WRITES), for the log.
ctx.on("response", async (res) => {
  if (!cur || res.request().method() === "GET" || !WRITES || !WRITES.test(res.url())) return;
  const body = (await res.text().catch(() => "")).replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"***"');
  cur.answers_from_site = cur.answers_from_site || [];
  cur.answers_from_site.push(`${res.status()} ${new URL(res.url()).pathname.slice(-40)} ${body.replace(/\s+/g, " ").slice(0, 300)}`);
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
// A real one-page PDF with a little text, so a site that reads the CV
// when it is attached (Breezy) takes it. It says it is a test.
function testCv() {
  const text = "BT /F1 20 Tf 72 720 Td (Test Person) Tj 0 -30 Td /F1 11 Tf (Test CV for checking a form, not a real applicant.) Tj "
    + "0 -18 Td (Software Engineer, 5 years. Python, JavaScript, SQL.) Tj ET";
  const objs = ["<</Type/Catalog/Pages 2 0 R>>", "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${text.length}>>\nstream\n${text}\nendstream`, "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"];
  let out = "%PDF-1.4\n";
  const at = objs.map((o, i) => { const pos = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return pos; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map((p) => `${String(p).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
const pdf = testCv();
await sw.evaluate(async ({ data, password }) => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "Test_Person_CV.pdf", type: "application/pdf", size: data.length, data: btoa(data) },
    workday: { password } });
  await chrome.alarms.clearAll();
  // Runs close their tab at the end; here it stays for a screenshot.
  chrome.tabs.remove = async () => {};
}, { data: pdf, password: WORKDAY_PASSWORD });

const rows = [];
for (const job of jobs) {
  cur = { drafts: [], settled: [], blocked: [], allowed: [], gate: false, answers: [] };
  const t0 = Date.now();
  const outcome = await sw.evaluate(async ({ job, profile }) => {
    const ctx = { profile: structuredClone(profile), preferences: { skills: ["Python"] }, settings: profile.settings, cv: (await chrome.storage.local.get("cv")).cv, serverAi: true };
    try { return await applyTo(job, ctx); } catch (e) { return "threw: " + e.message; }
  }, { job, profile }).catch((e) => "harness: " + e.message.split("\n")[0]);
  const last = cur.settled[cur.settled.length - 1] || {};
  const row = { ats: job.ats, url: job.url, outcome, gate: cur.gate, answered: cur.answers.length, drafts: cur.drafts.length,
    settled: last.outcome || "", reason: (last.reason || "").slice(0, 160), questions: last.questions || [], secs: Math.round((Date.now() - t0) / 1000), blocked: cur.blocked.length };
  rows.push(row);
  if (cur.allowed.length) console.log("   writes let through:", cur.allowed.join(" | ").slice(0, 600));
  for (const a of cur.answers_from_site || []) console.log("   site answered:", a);
  if (process.env.SHOW_BLOCKED) for (const x of cur.blocked) console.log("   blocked:", x);
  // The run's tab, kept for its screenshot, then closed; a blank one stays
  // so the browser keeps a window to open the next run's tab in.
  for (const tab of ctx.pages()) {
    if (!/^https?:/.test(tab.url())) continue;
    // PROBE="js expression": what the page itself sees, for a stopped run.
    if (!row.gate && process.env.PROBE) console.log("   probe:", JSON.stringify(await tab.evaluate(process.env.PROBE).catch((e) => e.message.slice(0, 120))));
    if (!row.gate) await tab.screenshot({ path: path.join(out, `${rows.length}-${job.ats}.png`) }).catch(() => {});
    await tab.close().catch(() => {});
  }
  if (!ctx.pages().length) await ctx.newPage();
  console.log(`${row.gate ? "GATE " : "stop "} ${job.ats.padEnd(15)} ${String(row.secs).padStart(3)}s ${row.gate ? `${row.answered} answers, ${row.drafts} by AI` : row.settled ? `${row.settled}: ${row.reason}` : `(${outcome})`}  ${job.url.slice(0, 90)}`);
  await sleep(3000);
}
fs.writeFileSync(path.join(out, "dryrun.json"), JSON.stringify(rows, null, 1));
const by = {};
for (const r of rows) (by[r.ats] ||= []).push(r);
console.log("\nreached the Submit gate (would be sent, or handed to the user where the site checks for a person):");
for (const [ats, rs] of Object.entries(by)) {
  const ready = rs.filter((r) => /^ready to submit|Ready to submit/i.test(r.reason)).length;
  console.log(`  ${ats.padEnd(15)} gate ${rs.filter((r) => r.gate).length}/${rs.length}, ready to submit ${ready}/${rs.length}`);
}
console.log(`results: ${path.join(out, "dryrun.json")}`);
await ctx.close();
