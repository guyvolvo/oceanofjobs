// The weekly fill check: on real, live postings from every hiring system
// it runs "Fill in this page" (fillTab), then asks the general filler which
// button would send the form, without pressing it. Every write that would
// leave the browser for anywhere but oceanofjobs.com is aborted and logged,
// and nothing ever calls submit(): no application is sent. Based on
// _ext_coverage.mjs, plus page errors, lists left open and demographic
// questions sent to the AI.
//
// Run from the repo root:
//   node tests/e2e/ats_sweep.mjs [out-dir]                      live sweep, then the report
//   node tests/e2e/ats_sweep.mjs [out-dir] url ...              the same on given pages
//   node tests/e2e/ats_sweep.mjs --from results.json [out-dir]  the report only, from an earlier run
//   node tests/e2e/ats_sweep.mjs --self-check                   checks the comparison rules
// Add --write-baseline to save the run's numbers to tests/e2e/ats_baseline.json.
// PER_ATS=2 SYSTEMS=workday,lever pick the sample. MAX_MINUTES stops starting
// new pages after that long. PREVIOUS=path/to/results.json adds the changes
// since an earlier run. Writes results.json and summary.md to out-dir, and
// exits 1 on a regression against the baseline, so a CI run fails.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const match = createRequire(import.meta.url)(path.resolve("extension/lib/match.js"));

const BASELINE = path.resolve(process.env.BASELINE || "tests/e2e/ats_baseline.json");
const N = Number(process.env.PER_ATS || 3);
const SYSTEMS = (process.env.SYSTEMS || [
  "ashby", "greenhouse", "workable", "smartrecruiters", "lever", "recruitee", "personio", "jazzhr", "teamtailor",
  "pinpoint", "bamboohr", "breezy", "comeet", "workday", "amazon", "microsoft", "google", "apple", "oracle",
  "checkpoint", "eightfold", "jobvite", "hibob", "gem", "deel", "niloosoft", "ness", "wpjobs", "redmatch",
  "wprest", "tycowp", "experis", "adamjobs", "nogamy", "matrix",
].join(",")).split(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} took over ${ms / 1000}s`)), ms).unref())]);

// Why a page has no filled form. Closed postings, CAPTCHAs, load failures
// and pages the time budget skipped say nothing about the filler, so they
// stay out of the rates the comparison uses.
const OUTCOME_WORDS = { closed: "posting closed", captcha: "captcha", "sign-in": "sign-in wall", "post-blocked": "form loads over a blocked POST",
  "no-form": "no form found", "load-failed": "page failed to load", "not-run": "out of time" };
const NOISE = new Set(["closed", "captcha", "load-failed", "not-run"]);
function outcome(x) {
  if (!x.error) return "form";
  if (/^test: not run/.test(x.error)) return "not-run";
  if (x.why === "posting closed") return "closed";
  if (x.why === "captcha") return "captcha";
  if (x.why === "sign-in first") return "sign-in";
  if (/^form loads over POST/.test(x.why)) return "post-blocked";
  if (/^test:/.test(x.error)) return "load-failed";
  return "no-form";
}

// A field's identity for the form's shape: its label in plain words and its
// type. Long labels are a posting's own questions, not the system's form.
const fieldId = (f) => {
  const words = String(f.label || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words && words.length <= 40 ? `${words}:${f.type}` : null;
};
const rates = (s) => ({
  formRate: s.usable ? s.form / s.usable : null,
  requiredRate: s.required ? (s.required - s.missing) / s.required : null,
  fillRate: s.fields ? s.filled / s.fields : null,
  fillErrorsPerForm: s.form ? s.fillErrors / s.form : null,
  openListsPerForm: s.form ? s.openLists / s.form : null,
  pageErrorsPerForm: s.form ? s.pageErrors / s.form : null,
});
const round = (v) => (v == null ? null : Math.round(v * 100) / 100);

// What each system is expected to do: the counts and rates, the fields its
// form had (with the share of pages each was on), the
// required fields the fill leaves empty, and the walls it puts up.
function statsOf(rows) {
  const by = {};
  for (const x of rows) {
    const s = (by[x.ats] ||= { tried: 0, usable: 0, form: 0, fields: 0, filled: 0, required: 0, missing: 0,
      fillErrors: 0, openLists: 0, pageErrors: 0, demographicsToAi: 0, claims: 0, outcomes: {}, shape: {}, missingFields: {} });
    const o = outcome(x);
    s.tried++;
    s.outcomes[o] = (s.outcomes[o] || 0) + 1;
    if (!NOISE.has(o)) s.usable++;
    s.demographicsToAi += (x.draftList || []).filter((d) => d.eeo).length;
    s.claims += x.claims || 0;
    if (o !== "form") continue;
    s.form++;
    s.fields += x.fields || 0;
    s.filled += x.filled || 0;
    s.required += x.required || 0;
    s.missing += (x.missing || []).length;
    s.fillErrors += (x.profileErrors || []).length;
    s.openLists += x.after ? x.after.open.length : 0;
    s.pageErrors += x.after ? x.after.errors.length : 0;
    for (const id of new Set(((x.read && x.read.fields) || []).map(fieldId).filter(Boolean))) s.shape[id] = (s.shape[id] || 0) + 1;
    for (const m of x.missing || []) s.missingFields[m] = (s.missingFields[m] || 0) + 1;
  }
  for (const s of Object.values(by)) {
    s.shape = Object.fromEntries(Object.entries(s.shape).map(([k, n]) => [k, round(n / s.form)]));
    s.rates = Object.fromEntries(Object.entries(rates(s)).map(([k, v]) => [k, round(v)]));
  }
  return by;
}

// [measure, words, a better move this big is listed, a worse move this big is a regression, higher is better]
// Rates, not counts, because the live postings differ every week.
const RULES = [
  ["requiredRate", "required fields filled", 0.1, 0.2, true],
  ["fillRate", "fields filled", 0.1, 0.25, true],
  ["fillErrorsPerForm", "fill errors per form", 0.5, 1, false],
  ["openListsPerForm", "lists left open per form", 0.5, 1, false],
  ["pageErrorsPerForm", "page errors after the fill, per form", 1, 3, false],
];
const fmt = (k, v) => (/Rate$/.test(k) ? Math.round(v * 100) + "%" : String(Math.round(v * 10) / 10));
const notFilled = (s) => Object.entries(s.outcomes).filter(([o]) => o !== "form").map(([o, n]) => `${OUTCOME_WORDS[o]} ${n}`).join(", ");
const CLASSES = ["regression", "site changed", "site unavailable", "improved", "no baseline"];

// Demographic wording, kept apart from the extension's own match.isEeo so a
// question the extension misses is still caught here. Either one fails the run.
const DEMOGRAPHIC = /\b(gender|sex|sexual|orientation|lgbtq?|transgender|pronouns?|race|racial|ethnic(ity)?|hispanic|latin[oax]|veterans?|disab\w*|religio\w*|marital|age|how old|date of birth|birth ?date|caste|pregnan\w*|national origin|indigenous|aboriginal|neurodiver\w*)\b|(^|[^\u0590-\u05FF])(מגדר|מין|מוגבלות|דת|גיל)([^\u0590-\u05FF]|$)/i;
// The one exception: the whole question is "Are you 18 or older?" or a close equivalent, legal working
// age answered from the user's facts. Any other wording about age or birth stays demographic.
const OF_AGE = /^\s*(are you|i am|i confirm (that )?i am)\s+(at least |over (the age of )?)?(16|17|18|19|21)\+?( years)?( old| of age)?( or older| or over)?\s*[?.]?\s*$/i;
const isDemographic = (question, options) =>
  match.isEeo({ label: question, name: "", type: "", options: options || [] })
  || (DEMOGRAPHIC.test(String(question || "")) && !OF_AGE.test(String(question || "")));

// Each difference gets one class. Regression: the form has the shape the
// reference saw and the fill did worse on it. Site changed: the form's
// fields differ, so a worse fill there goes to a person, not a failure.
// Site unavailable: closed, no form, walls, timeouts, too few pages. Noise.
function diff(cur, ref) {
  const items = [];
  const add = (ats, cls, text) => items.push({ ats, cls, text });
  for (const ats of new Set([...Object.keys(cur), ...Object.keys(ref)])) {
    const c = cur[ats], r = ref[ats];
    if (!c) { add(ats, "site unavailable", "no live postings from our API this run"); continue; }
    if (c.claims) add(ats, "regression", `${c.claims} credits were claimed. This must be 0.`);
    if (!r) { add(ats, "no baseline", "nothing to compare with yet"); continue; }
    const kinds = (s) => Object.keys(s.outcomes).filter((o) => o !== "form");
    const fresh = kinds(c).filter((o) => !r.outcomes[o]);
    if (fresh.length) add(ats, "site unavailable", `new this run: ${fresh.map((o) => `${OUTCOME_WORDS[o]} ${c.outcomes[o]}`).join(", ")}`);
    if (c.usable < 2 || r.usable < 2) {
      if (r.form) add(ats, "site unavailable", `${c.usable} usable pages this run, too few to compare`);
      continue;
    }
    const cr = rates(c), rr = rates(r);
    // 0.51 so one form missing out of two pages is not listed.
    // Pages that loaded but where no form was found any more: the site or our
    // form finding changed. Never noise, a person looks.
    if (rr.formRate - cr.formRate >= 0.51) add(ats, "site changed", `pages with a form found went from ${fmt("formRate", rr.formRate)} to ${fmt("formRate", cr.formRate)}. The site or our form finding changed`);
    if (cr.formRate - rr.formRate >= 0.25) add(ats, "improved", `pages with a form found went from ${fmt("formRate", rr.formRate)} to ${fmt("formRate", cr.formRate)}`);
    if (!c.form || !r.form) continue;
    const gone = Object.keys(r.shape).filter((id) => r.shape[id] === 1 && r.form >= 2 && !c.shape[id]);
    const added = Object.keys(c.shape).filter((id) => c.shape[id] === 1 && c.form >= 2 && !r.shape[id]);
    const changed = gone.length || added.length;
    if (changed) add(ats, "site changed", [gone.length && `fields gone: ${gone.join(", ")}`, added.length && `new fields: ${added.join(", ")}`].filter(Boolean).join(". "));
    for (const [k, words, betterAt, regressAt, up] of RULES) {
      if (cr[k] == null || rr[k] == null) continue;
      const worse = up ? rr[k] - cr[k] : cr[k] - rr[k];
      let text = `${words} went from ${fmt(k, rr[k])} to ${fmt(k, cr[k])}`;
      if (k === "requiredRate") {
        const empty = Object.keys(c.missingFields).filter((m) => !r.missingFields[m]);
        if (empty.length) text += `. Newly left empty: ${empty.slice(0, 5).join(", ")}`;
      }
      if (worse >= regressAt - 1e-9) add(ats, changed ? "site changed" : "regression", text);
      else if (-worse >= betterAt - 1e-9) add(ats, "improved", text);
    }
  }
  return items.sort((a, b) => CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls));
}

// What happened to each system this run. Only "Tested" means its checks ran.
function testStatus(ats, s, changed) {
  if (!s) return "Not tested: no live postings";
  if (s.form) return changed.has(ats) ? "Site changed, needs a look" : "Tested";
  if (s.outcomes["sign-in"]) return "Not tested: sign-in page";
  if (s.outcomes.captcha) return "Not tested: CAPTCHA";
  if (s.outcomes["no-form"]) return changed.has(ats) ? "Site changed, needs a look" : "Not tested: no form found";
  return "Site unavailable";
}

// firstRun: the first run in a new environment (GitHub's runners) records
// what that environment sees. Differences from the baseline are listed, not
// failed; demographic questions to the AI and credits claimed still fail.
function report(rows, base, prev, firstRun = false) {
  const stats = statsOf(rows);
  const vsBase = base ? diff(stats, base.stats) : [];
  const regressions = vsBase.filter((i) => i.cls === "regression");
  const claims = Object.values(stats).reduce((n, s) => n + s.claims, 0);
  const changed = new Set(vsBase.filter((i) => i.cls === "site changed").map((i) => i.ats));
  const systems = [...new Set([...Object.keys(stats), ...Object.keys(base ? base.stats : {})])];
  const status = Object.fromEntries(systems.map((a) => [a, testStatus(a, stats[a], changed)]));
  const groups = {};
  for (const [a, st] of Object.entries(status)) (groups[st] ||= []).push(a);
  const ORDER = ["Tested", "Site changed, needs a look", "Not tested: sign-in page", "Not tested: CAPTCHA", "Not tested: no form found",
    "Not tested: no live postings", "Site unavailable"];
  const demographics = Object.entries(stats).filter(([, s]) => s.demographicsToAi);
  const line = (i) => `- **${i.cls}**, ${i.ats}: ${i.text}`;
  const total = (k) => Object.values(stats).reduce((n, s) => n + s[k], 0);
  const cell = (a, b) => (b ? `${a}/${b}` : "");
  const md = [
    `# Hiring system fill sweep, ${new Date().toISOString().slice(0, 10)}`,
    "",
    demographics.length
      ? `**FAILED: ${total("demographicsToAi")} demographic questions were sent to the AI** (${demographics.map(([a, s]) => `${a} ${s.demographicsToAi}`).join(", ")}). This fails the run on its own. The questions are in results.json under draftList, marked eeo.`
      : "**Demographic questions sent to the AI: 0.**",
    "",
    `${regressions.length} regressions. ${rows.length} pages on ${Object.keys(stats).length} hiring systems. Credits claimed: ${total("claims")}.`,
    "",
    ...(firstRun ? ["**First run in this environment: a baseline, not a verdict.** Differences from the baseline are listed below and don't fail this run. Demographic questions sent to the AI and credits claimed still do.", ""] : []),
    "## What was tested",
    "",
    ...ORDER.filter((st) => groups[st]).map((st) => `- **${st}** (${groups[st].length}): ${groups[st].sort().join(", ")}`),
    "",
    base ? `## Against the baseline recorded ${base.recorded}` : "## Against the baseline",
    "",
    ...(base ? (vsBase.length ? vsBase.map(line) : ["No differences."]) : ["No baseline file, so nothing to compare with."]),
    "",
    ...(prev ? [`## Since the previous run, ${prev.when}`, "", ...(() => { const d = diff(stats, prev.stats); return d.length ? d.map(line) : ["No differences."]; })(), ""] : []),
    "## Per hiring system",
    "",
    "| System | Status | Pages | Forms found | Fields filled | Required filled | Fill errors | Lists left open | Page errors | Demographics to AI | Not filled |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(stats).map(([ats, s]) => `| ${ats} | ${status[ats]} | ${s.tried} | ${s.form} | ${cell(s.filled, s.fields)} | ${cell(s.required - s.missing, s.required)} | ${s.form ? s.fillErrors : ""} | ${s.form ? s.openLists : ""} | ${s.form ? s.pageErrors : ""} | ${s.demographicsToAi} | ${notFilled(s)} |`),
    "",
  ].join("\n");
  return { stats, status, failed: (!firstRun && regressions.length > 0) || demographics.length > 0 || claims > 0 || !rows.length, md };
}

function selfCheck() {
  const s = (o) => ({ tried: 3, usable: 3, form: 3, fields: 30, filled: 30, required: 20, missing: 0, fillErrors: 0, openLists: 0, pageErrors: 0,
    demographicsToAi: 0, claims: 0, outcomes: { form: 3 }, shape: { "email:email": 1, "first name:text": 1 }, missingFields: {}, ...o });
  const cls = (cur, ref = s()) => diff({ x: cur }, { x: ref }).map((i) => i.cls).join();
  assert.equal(cls(s()), "");
  assert.equal(cls(s({ tried: 2, usable: 2, form: 1, outcomes: { form: 1, "no-form": 1 } })), "site unavailable", "one form missing out of two is noise");
  assert.equal(cls(s({ form: 0, fields: 0, filled: 0, required: 0, outcomes: { "no-form": 3 } })), "site changed,site unavailable", "forms gone on pages that loaded goes to a person");
  assert.equal(cls(s({ usable: 0, form: 0, outcomes: { closed: 3 } })), "site unavailable,site unavailable", "closed postings are noise");
  assert.equal(cls(s({ missing: 10, missingFields: { Phone: 3 } })), "regression", "half the required fields left empty on the same form");
  assert.equal(cls(s({ missing: 10, shape: { "e mail:email": 1, "first name:text": 1 } })), "site changed,site changed", "the same drop on a changed form");
  assert.equal(cls(s({ fillErrors: 3 })), "regression");
  assert.equal(cls(s({ openLists: 3 })), "regression");
  assert.equal(cls(s({ pageErrors: 9 })), "regression");
  assert.equal(cls(s(), s({ filled: 20 })), "improved");
  assert.ok(report([{ ats: "x", draftList: [{ question: "Gender", eeo: true }], claims: 0 }], null, null).failed, "demographics to the AI always fail");
  for (const q of ["Sexual orientation", "What is your date of birth?", "Are you a protected veteran?", "Your pronouns", "Race / Ethnicity", "מגדר"])
    assert.ok(isDemographic(q, []), q);
  for (const q of ["What is your age?", "How old are you?", "Please provide your date of birth", "Date of birth (you must be 18 or older)",
    "Are you 18 or older? Please enter your date of birth", "Are you over 40?", "Are you over the age of 40?", "Age range"])
    assert.ok(isDemographic(q, []), `still demographic: ${q}`);
  for (const q of ["Are you 18 years of age or older?", "Are you at least 18 years old?", "Are you over the age of 18?", "Are you 18 or older?",
    "I confirm I am 18 or older.", "Are you 21+?"])
    assert.ok(!isDemographic(q, []), `legal working age: ${q}`);
  for (const q of ["Why do you want to work here?", "How did you hear about us?", "Years of experience with Kubernetes", "Which agency referred you?", "Page URL"])
    assert.ok(!isDemographic(q, []), q);
  const walled = [{ ats: "w", error: "x", why: "sign-in first" }, { ats: "c", error: "x", why: "captcha" }, { ats: "g", fields: 10, filled: 10, required: 2 }];
  const base3 = { stats: statsOf([...walled.slice(2), { ats: "w", fields: 5, filled: 5 }, { ats: "c", fields: 5, filled: 5 }, { ats: "gone", fields: 5, filled: 5 }]) };
  const r3 = report(walled, base3, null);
  assert.deepEqual(r3.status, { g: "Tested", w: "Not tested: sign-in page", c: "Not tested: CAPTCHA", gone: "Not tested: no live postings" },
    "a system behind a wall, or missing, never reads as tested");
  assert.ok(!r3.failed, "walls alone don't fail the run");
  const worse = [{ ats: "g", fields: 10, filled: 1, required: 2, missing: ["a", "b"] }, { ats: "g", fields: 10, filled: 1, required: 2, missing: ["a", "b"] }];
  const base4 = { stats: statsOf([{ ats: "g", fields: 10, filled: 10, required: 2 }, { ats: "g", fields: 10, filled: 10, required: 2 }]) };
  assert.ok(report(worse, base4, null).failed, "a regression fails a normal run");
  assert.ok(!report(worse, base4, null, true).failed, "and is only listed on a first run");
  assert.ok(report([{ ats: "g", draftList: [{ question: "Gender", eeo: true }] }], base4, null, true).failed, "demographics to the AI fail a first run too");
  assert.ok(report([{ ats: "g", claims: 1, fields: 1, filled: 1 }], null, null, true).failed, "so do credits claimed");
  console.log("self-check passed");
}

const args = process.argv.slice(2);
if (args.includes("--self-check")) { selfCheck(); process.exit(0); }
const writeBaseline = args.includes("--write-baseline");
const fromAt = args.indexOf("--from");
const rest = args.filter((a, i) => a !== "--write-baseline" && (fromAt < 0 || (i !== fromAt && i !== fromAt + 1)));
const out = rest[0] || fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ats-sweep-"));
fs.mkdirSync(out, { recursive: true });
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const rowsOf = (j) => (Array.isArray(j) ? j : j.rows);

const rows = fromAt >= 0 ? rowsOf(readJson(args[fromAt + 1])) : await sweep(rest.slice(1));
const base = fs.existsSync(BASELINE) ? readJson(BASELINE) : null;
const prevFile = process.env.PREVIOUS;
const prev = prevFile && fs.existsSync(prevFile) ? ((j) => ({ when: j.when || "an earlier run", stats: statsOf(rowsOf(j)) }))(readJson(prevFile)) : null;
// On GitHub, no earlier run to download means this environment's first run.
const firstRun = process.env.GITHUB_ACTIONS === "true" && !prev;
const { stats, failed, md } = report(rows, writeBaseline ? null : base, prev, firstRun);
const when = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ when, perAts: N, stats, rows }, null, 1));
fs.writeFileSync(path.join(out, "summary.md"), md);
console.log("\n" + md);
console.log(`results: ${path.join(out, "results.json")}`);
if (writeBaseline) {
  fs.writeFileSync(BASELINE, JSON.stringify({ recorded: when, stats }, null, 1) + "\n");
  console.log(`baseline written: ${BASELINE}`);
} else if (failed) {
  process.exitCode = 1;
}

async function sweep(urls) {
  const { chromium } = await import("playwright");

  // Jobs from our own API, a few per ATS, one request at a time.
  async function liveJobs() {
    const pages = [];
    for (const ats of SYSTEMS) {
      try {
        const res = await fetch(`https://oceanofjobs.com/api/jobs?ats=${ats}&limit=${N * 4}&count=skip`, { signal: AbortSignal.timeout(30000) });
        const { jobs = [] } = await res.json();
        // Different companies where the list allows, so one site's quirks don't count N times.
        const seen = new Set(), hosts = new Set();
        for (const j of jobs) if (seen.size < N && !hosts.has(j.company_domain)) { seen.add(j.url); hosts.add(j.company_domain); pages.push({ ats, url: j.url }); }
        for (const j of jobs) if (seen.size < N && !seen.has(j.url)) { seen.add(j.url); pages.push({ ats, url: j.url }); }
        if (!jobs.length) console.log(`no open ${ats} jobs from the API`);
      } catch (e) {
        console.log(`no ${ats} jobs from the API: ${e.message}`);
      }
      await sleep(1000);
    }
    return pages;
  }
  const pages = urls.length ? urls.map((url) => ({ ats: "arg", url })) : await liveJobs();
  const deadline = process.env.MAX_MINUTES ? Date.now() + Number(process.env.MAX_MINUTES) * 60000 : Infinity;

  // The popup's click grants activeTab, which a test cannot press, so a copy
  // of the extension gets host access to every site instead.
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-sweep-"));
  fs.cpSync(path.resolve("extension"), ext, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions.push("<all_urls>");
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));

  // channel "chromium" is the full browser in new headless mode, which loads extensions.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-sweep-profile-"));
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
    settings: { fill: "half", mode: "queue", sources: ["board"], unknowns: "skip", guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } },
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
        page && page.drafts.push({ question: body.question, options: body.options, eeo: isDemographic(body.question, body.options) });
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
    // Ashby loads its form over GraphQL. Read-only queries go through, as in
    // _ext_ashby_run.mjs; every mutation (saving an answer, the CV, submitting) is aborted below.
    if (req.method() === "POST" && u.origin + u.pathname === "https://jobs.ashbyhq.com/api/non-user-graphql") {
      let body = null;
      try { body = req.postDataJSON(); } catch { /* not JSON, aborted below */ }
      if (body && /^\s*query\b/.test(body.query || "") && !/\bmutation\b/.test(body.query)) return r.continue();
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

  // After the fill: what the page itself flags, dropdowns left open, and
  // each filled control's value as the page holds it.
  async function inspect(tab) {
    const all = { errors: [], open: [], values: [] };
    for (const f of tab.frames()) {
      const got = await f.evaluate(() => {
        const shown = (el) => el.checkVisibility && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && el.getBoundingClientRect().width > 0;
        const t = (el) => String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const errors = [...new Set([...document.querySelectorAll('[role="alert"], [aria-live="assertive"], [class*="error" i], [class*="invalid" i], [data-automation-id="errorMessage"], [id*="error" i]')]
          .filter((el) => shown(el) && !el.querySelector("input, select, textarea") && t(el) && t(el).length < 250).map(t))];
        const invalid = [...document.querySelectorAll('[aria-invalid="true"]')].filter(shown).map((el) => el.getAttribute("data-ooj") + "=" + (el.value || "").slice(0, 40));
        const open = [...document.querySelectorAll('[role="listbox"], [aria-expanded="true"], .select__menu, [class*="menu-list" i], [data-automation-id="activeListContainer"]')]
          .filter((el) => shown(el) && el.getBoundingClientRect().height > 20 && !/^(BUTTON|A)$/.test(el.tagName) && el.querySelectorAll('[role="option"], li, div').length > 1)
          .map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}[${el.getAttribute("role") || el.className.toString().slice(0, 40)}] ${t(el).slice(0, 80)}`);
        const values = [...document.querySelectorAll("[data-ooj]")].map((el) => {
          const v = el.type === "file" ? (el.files && el.files.length ? el.files[0].name : "") : el.type === "radio" || el.type === "checkbox" ? (el.checked ? "[x]" : "") : el.tagName === "SELECT" ? ((el.selectedOptions || [])[0] || {}).text || "" : el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : t(el).slice(0, 60);
          return [el.getAttribute("data-ooj"), el.tagName.toLowerCase() + ":" + (el.type || el.getAttribute("role") || ""), String(v).slice(0, 80)];
        }).filter((x) => x[2]);
        return { errors: errors.slice(0, 20), invalid, open: open.slice(0, 5), values };
      }).catch(() => null);
      if (!got) continue;
      all.errors.push(...got.errors, ...got.invalid.map((x) => "aria-invalid " + x)); all.open.push(...got.open); all.values.push(...got.values);
    }
    return all;
  }

  function whyNot(text) {
    if (/captcha|verify you are (a )?human|are you a robot/i.test(text)) return "captcha";
    if (/(doesn.t|does not|no longer) exist|page not found|\b404\b|no longer (available|accepting|open|active)|(position|job|vacancy) (has been |is )?(filled|closed|expired)|not accepting applications/i.test(text)) return "posting closed";
    if (/sign in|log in|create (an )?account/i.test(text)) return "sign-in first";
    return "";
  }

  const rows = [];
  for (const { ats, url } of pages) {
    if (Date.now() > deadline) {
      rows.push({ ats, url, landed: url, error: "test: not run, the time budget ran out", why: "", draftList: [], claims: 0 });
      continue;
    }
    page = { blocked: [], drafts: [], claims: [], console: [] };
    const tab = await ctx.newPage();
    tab.on("pageerror", (e) => page.console.push("pageerror: " + String(e.message).slice(0, 200)));
    tab.on("console", (m) => { if (m.type() === "error") page.console.push(m.text().slice(0, 200)); });
    let r, held = {}, landed = url, why = "";
    try {
      await tab.goto(url, { waitUntil: "load", timeout: 45000 });
      await sleep(1500);
      r = await within(sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => /^https?:/.test(t.url));
        globalThis.__last = null;
        const res = { ...(await fillTab(tab.id)), read: globalThis.__last };
        const frameId = res.frameId || 0;
        res.submit = await inTab(tab.id, 'generic', 'submitInfo', [], frameId).catch((e) => ({ error: String(e.message || e) }));
        // A wizard's Next button, a password field (a sign-in wall) or a CAPTCHA on show.
        const [w] = await chrome.scripting.executeScript({ target: frameId ? { tabId: tab.id, frameIds: [frameId] } : { tabId: tab.id }, func: () => {
          const shown = (el) => el.checkVisibility && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
          const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
          const buttons = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')].filter(shown);
          return {
            step: buttons.map((b) => words(b.textContent || b.value)).filter((t) => /^(next|continue|weiter|suivant|siguiente|save and continue|save & continue)\b/.test(t)).slice(0, 3),
            password: [...document.querySelectorAll('input[type="password"]')].some(shown),
            signin: /\b(sign in|log in|create (an )?account)\b/i.test(document.body.innerText.slice(0, 4000)),
            captcha: [...document.querySelectorAll('iframe')].some((f) => /captcha|challenges\.cloudflare/.test(f.src) && f.getBoundingClientRect().width > 50),
            botScript: !!document.querySelector('script[src*="recaptcha"], script[src*="hcaptcha"], script[src*="turnstile"], .grecaptcha-badge'),
          };
        } }).catch(() => [{ result: null }]);
        res.walls = w && w.result;
        return res;
      }), 120000, "the fill");
      await sleep(1500);
      landed = tab.url();
      held = await holds(tab);
      page.after = await inspect(tab);
      if (r.error) why = /captcha/.test(new URL(landed).hostname) ? "captcha" : await tab.evaluate(() => document.body.innerText).then(whyNot, () => "");
      const slug = rows.length + "-" + new URL(landed).hostname.replace(/[^a-z0-9]+/gi, "_");
      await tab.screenshot({ path: path.join(out, slug + ".png"), fullPage: true }).catch(() => {});
    } catch (e) {
      r = { error: "test: " + String(e.message || e).split("\n")[0].slice(0, 120) };
    }
    if (r.error && page.blocked.some((b) => /graphql/i.test(b))) why = "form loads over POST, which this test blocks";
    // AI suggestions here are the stub's first option or "Test answer", so
    // their misses say nothing about the filler.
    const asked = (e) => page.drafts.some((q) => e.startsWith(q.question + ":"));
    const errs = r.errors || [];
    const row = { ...r, after: page.after, console: page.console, draftList: page.drafts, ats, adapter: r.ats, url, landed, why, held, blocked: page.blocked, drafts: page.drafts.length, claims: page.claims.length,
      profileErrors: errs.filter((e) => !asked(e)), aiErrors: errs.filter(asked) };
    rows.push(row);
    const host = (() => { try { return new URL(landed).hostname; } catch { return landed; } })();
    console.log(`${ats.padEnd(16)} ${outcome(row).padEnd(12)} ${host.padEnd(36)} ${row.error ? row.error.slice(0, 80) : `fields ${row.fields}, required ${row.required}, filled ${row.filled}, missing ${(row.missing || []).length}`}`);
    await tab.close();
    // Gentle on the sites: one page at a time, with a pause between.
    await sleep(3000);
  }
  console.log(`writes to other hosts, all aborted or answered in the browser: ${rows.reduce((n, x) => n + (x.blocked || []).length, 0)}`);
  await ctx.close();
  return rows;
}
