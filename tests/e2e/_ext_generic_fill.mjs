// "Fill in this page" (fillTab in extension/background.js) on real, live
// application forms across many ATSes, with our API stubbed. Every write
// that would leave the browser for anywhere but oceanofjobs.com is aborted
// and logged, and nothing ever calls submit(): no application is sent.
// Run from the repo root: node tests/e2e/_ext_generic_fill.mjs [out-dir] [url ...]
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "ooj-generic-out-"));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jobs from our own API, a few per ATS, one request at a time.
// Comeet's list carries company career pages that embed its form.
const PER_ATS = { ashby: 2, lever: 2, workable: 2, smartrecruiters: 1, recruitee: 2, teamtailor: 2, breezy: 2, personio: 2, comeet: 5, greenhouse: 1 };
async function liveJobs() {
  const pages = [];
  for (const [ats, n] of Object.entries(PER_ATS)) {
    try {
      const res = await fetch(`https://oceanofjobs.com/api/jobs?ats=${ats}&limit=8&count=skip`, { signal: AbortSignal.timeout(30000) });
      const { jobs = [] } = await res.json();
      const seen = new Set();
      for (const j of jobs) {
        if (seen.has(j.url) || seen.size >= n) continue;
        seen.add(j.url);
        pages.push({ ats, url: j.url });
      }
    } catch (e) {
      console.log(`no ${ats} jobs from the API: ${e.message}`);
    }
    await sleep(1000);
  }
  // Our API times out on BambooHR and Jobvite today, so one open job each
  // straight from a board.
  try {
    const { result = [] } = await (await fetch("https://glassesusa.bamboohr.com/careers/list", { signal: AbortSignal.timeout(20000) })).json();
    if (result[0]) pages.push({ ats: "bamboohr", url: `https://glassesusa.bamboohr.com/careers/${result[0].id}` });
  } catch (e) { console.log("no BambooHR job:", e.message); }
  try {
    const html = await (await fetch("https://jobs.jobvite.com/varonis/jobs", { signal: AbortSignal.timeout(20000) })).text();
    const id = /href="\/varonis\/job\/([A-Za-z0-9]+)/.exec(html);
    if (id) pages.push({ ats: "jobvite", url: `https://jobs.jobvite.com/varonis/job/${id[1]}` });
  } catch (e) { console.log("no Jobvite job:", e.message); }
  return pages;
}
const pages = process.argv.length > 3 ? process.argv.slice(3).map((url) => ({ ats: "arg", url })) : await liveJobs();

// The popup's click grants activeTab, which a test cannot press, so a copy
// of the extension gets host access to every site instead.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-generic-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-generic-profile-"));
const ctx = await chromium.launchPersistentContext(dir, {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: "test.person@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://www.linkedin.com/in/test-person", github: "https://github.com/test-person", website: "https://test-person.example.com" },
  work: { authorized_countries: ["IL"], needs_sponsorship: true, notice_period: "30 days", salary: "100000" },
  eeo: { gender: "decline", race: "decline", veteran: "decline", disability: "decline" },
  answers: [
    { question: "How did you hear about us?", answer: "LinkedIn" },
    { question: "Current company", answer: "Acme" },
    { question: "Current job title", answer: "Software Engineer" },
    { question: "Years of experience", answer: "5" },
    { question: "Are you willing to relocate?", answer: "No" },
  ],
  settings: { mode: "queue", sources: ["board"], unknowns: "skip", guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } },
};

// A site's own service worker could make requests the route below never
// sees. Playwright's serviceWorkers: "block" also stops the route seeing
// the extension's calls, so the pages just never get to register one.
await ctx.addInitScript(() => {
  const none = { register: () => Promise.reject(new Error("blocked in this test")), getRegistrations: async () => [], getRegistration: async () => undefined,
    ready: new Promise(() => {}), controller: null, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => none, configurable: true }); } catch { /* already gone */ }
});

let page = null;
await ctx.route("**/*", (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com") {
    const p = u.pathname;
    if (p === "/api/me/apply/profile") return r.fulfill({ json: { profile, preferences: { skills: ["Python"] } } });
    if (p === "/api/me/apply/usage" || p === "/api/me/apply/summary") return r.fulfill({ json: { plan: "pro", period: "day", limit: 50, used: 0, remaining: 50 } });
    if (p === "/api/me/apply/history") return r.fulfill({ json: { applied: [] } });
    // The AI suggestion for a question with no saved answer: the first
    // option, so selects and radios get exercised too.
    if (p === "/api/me/apply/draft") {
      const body = req.postDataJSON();
      page && page.drafts.push(body.question);
      return r.fulfill({ json: { answer: body.options.length ? body.options[0] : "Test answer" } });
    }
    if (p === "/api/me/apply/claim") { page && page.claims.push(p); return r.fulfill({ json: { remaining: 49 } }); }
    return r.fulfill({ status: 204, body: "" });
  }
  // The CV upload some forms make the moment a file is attached (Workable,
  // Greenhouse). Answered here like S3 would, so the page carries on; the
  // file never leaves the browser.
  if (req.method() === "POST" && /\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(u.hostname)) {
    if (page) page.blocked.push(`stubbed ${req.method()} ${u.hostname}${u.pathname}`.slice(0, 140));
    const key = /name="key"\r\n\r\n([^\r]*)/.exec((req.postDataBuffer() || "").toString("latin1"));
    return r.fulfill({ status: 201, contentType: "application/xml",
      body: `<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>${u.origin}/${key && key[1]}</Location><Key>${key && key[1]}</Key><ETag>"0"</ETag></PostResponse>` });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
    if (page) page.blocked.push(`${req.method()} ${u.hostname}${u.pathname}`.slice(0, 140));
    return r.abort();
  }
  return r.continue();
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
// A small real PDF, so upload widgets that sniff the file accept it.
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
await sw.evaluate(async (data) => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "Test_Person_CV.pdf", type: "application/pdf", size: data.length, data: btoa(data) } });
  await chrome.alarms.clearAll();
  // Keep what was read and planned, for the results file.
  const inner = planWithSuggestions;
  planWithSuggestions = async (page, job, ctx) => {
    const res = await inner(page, job, ctx);
    globalThis.__last = { fields: page.fields, fills: res.plan.fills.map((f) => [f.label, f.key, f.value]) };
    return res;
  };
}, pdf);

// What the form holds afterwards, checked in the page: the standard fields
// by value, the CV by any file input that has a file.
async function holds(tab) {
  const want = { email: profile.contact.email, phone: "000 0000", linkedin: "linkedin.com/in/test-person", name: "Test" };
  const res = {};
  for (const f of tab.frames()) {
    const got = await f.evaluate((w) => {
      const vals = [...document.querySelectorAll("input, textarea")].map((el) => (el.type === "file" ? "" : el.value || ""));
      const has = (s) => vals.some((v) => v.replace(/[\s-]/g, "").includes(s.replace(/[\s-]/g, "")));
      return { email: has(w.email), phone: has(w.phone), linkedin: has(w.linkedin), name: has(w.name),
        // Some uploaders swap the input for a chip with the file's name.
        cv: [...document.querySelectorAll('input[type="file"]')].some((el) => el.files && el.files.length) || document.body.innerText.includes("Test_Person_CV") };
    }, want).catch(() => ({}));
    for (const [k, v] of Object.entries(got)) res[k] = res[k] || v;
  }
  return res;
}

const rows = [];
for (const { ats, url } of pages) {
  page = { blocked: [], drafts: [], claims: [] };
  const tab = await ctx.newPage();
  let r, held = {}, landed = url, why = "";
  try {
    await tab.goto(url, { waitUntil: "load", timeout: 45000 });
    await sleep(1500);
    r = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => /^https?:/.test(t.url));
      globalThis.__last = null;
      return { ...(await fillTab(tab.id)), read: globalThis.__last };
    });
    await sleep(1500);
    landed = tab.url();
    held = await holds(tab);
    if (r.error) why = /captcha/.test(new URL(landed).hostname) ? "captcha" : await tab.evaluate(() => document.body.innerText).then(whyNot, () => "");
    const slug = rows.length + "-" + new URL(landed).hostname.replace(/[^a-z0-9]+/gi, "_");
    await tab.screenshot({ path: path.join(out, slug + ".png"), fullPage: true }).catch(() => {});
  } catch (e) {
    r = { error: "test: " + String(e.message || e).split("\n")[0].slice(0, 120) };
  }
  if (r.error && page.blocked.some((b) => /graphql/i.test(b))) why = "form loads over POST, which this test blocks";
  // AI suggestions here are the stub's first option or "Test answer", so
  // their misses say nothing about the filler.
  const asked = (e) => page.drafts.some((q) => e.startsWith(q + ":"));
  const errs = r.errors || [];
  const row = { ...r, ats, adapter: r.ats, url, landed, why, held, blocked: page.blocked, drafts: page.drafts.length, claims: page.claims.length,
    profileErrors: errs.filter((e) => !asked(e)), aiErrors: errs.filter(asked) };
  rows.push(row);
  console.log(`\n== ${ats} ${url}${landed !== url ? `\n   -> ${landed}` : ""}`);
  console.log(JSON.stringify({ ...row, url: undefined, landed: undefined, read: undefined, blocked: row.blocked.length }));
  await tab.close();
  // Gentle on the sites: one page at a time, with a pause between.
  await sleep(3000);
}
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(rows, null, 1));

function whyNot(text) {
  if (/captcha|verify you are (a )?human|are you a robot/i.test(text)) return "captcha";
  if (/(doesn.t|does not|no longer) exist|page not found|\b404\b|no longer (available|accepting|open|active)|(position|job|vacancy) (has been |is )?(filled|closed|expired)|not accepting applications/i.test(text)) return "posting closed";
  if (/sign in|log in|create (an )?account/i.test(text)) return "sign-in first";
  return "";
}

const pad = (s, n) => String(s).slice(0, n).padEnd(n);
console.log("\n" + [pad("ats", 15), pad("adapter", 10), pad("host", 28), pad("fields", 6), pad("req", 4), pad("filled", 6), pad("ai", 3), pad("err", 4), pad("aierr", 5), pad("miss", 5), pad("std e/n/p/l/cv", 15), "notes"].join(" "));
for (const x of rows) {
  const h = x.held || {};
  const std = ["email", "name", "phone", "linkedin", "cv"].map((k) => (h[k] ? "y" : "-")).join("/");
  // A page that uploads the CV the moment it is attached drops it again
  // when this test blocks that upload.
  const upload = !x.error && !h.cv && x.blocked.some((b) => /^(POST|PUT) .*(file|upload|document|attach)/i.test(b)) ? ["CV upload POST blocked by the test"] : [];
  const notes = x.error ? `${x.why ? x.why + ": " : ""}${x.error}` : [...upload, ...x.profileErrors, ...(x.missing || []).map((m) => "missing: " + m)].join("; ");
  console.log([pad(x.ats, 15), pad(x.adapter || "-", 10), pad(new URL(x.landed).hostname, 28), pad(x.fields ?? "-", 6), pad(x.required ?? "-", 4), pad(x.filled ?? "-", 6),
    pad(x.suggested ?? "-", 3), pad(x.error ? "-" : x.profileErrors.length, 4), pad(x.error ? "-" : x.aiErrors.length, 5), pad(x.missing ? x.missing.length : "-", 5), pad(std, 15), notes.slice(0, 150)].join(" "));
}
const filledPages = rows.filter((x) => !x.error);
console.log(`\npages with a form filled: ${filledPages.length} of ${rows.length}; profile fill errors: ${filledPages.reduce((n, x) => n + x.profileErrors.length, 0)}`);
console.log(`required fields: ${filledPages.reduce((n, x) => n + x.required, 0)}, left for the user: ${filledPages.reduce((n, x) => n + x.missing.length, 0)}`);
console.log(`\nclaims made: ${rows.reduce((n, x) => n + x.claims, 0)} (must be 0)`);
console.log(`writes to other hosts, all aborted or answered in the browser: ${rows.reduce((n, x) => n + x.blocked.length, 0)}`);
console.log(`results: ${path.join(out, "results.json")}`);
await ctx.close();
