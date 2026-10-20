// The fill button's "Submit application" on sites with no dedicated
// filler, on live forms with our API stubbed. NO APPLICATION REACHES AN
// EMPLOYER: every POST, PUT, PATCH and DELETE to a host other than
// oceanofjobs.com is aborted and logged (S3 CV uploads get a stub answer
// instead), and once Submit is pressed every navigation away from the
// page is aborted too, so a form that sends by navigating sends nothing.
//  submit: Lever, Comeet (Cyera's page, form in a comeet.co frame),
//    Teamtailor, Recruitee and Breezy. Fill from the card, check the
//    button submitButton() picked, press Submit: one claim, the site's
//    write blocked, the result reported as failed, no hang.
//    A form behind a bot check (Comeet's reCAPTCHA, Lever's hCaptcha) gets
//    no Submit on the card, says to press the site's own button, and
//    submitHere refuses with no claim. Nothing is pressed there.
//  posting: a Comeet and a Lever job posting before its Apply button is
//    pressed. The button shows with no API call, and one click on the
//    card presses Apply and fills the form it opens.
//  review: Fetcherr's careers page (a Comeet form in a frame with optional
//    Yes/No questions) and an Experis job (Hebrew, a modal behind its
//    "שליחת קו"ח" button). The AI stub says Yes to a yes/no question; the
//    radios end up ticked, the contact fields and CV filled, consent boxes
//    untouched, and the card offers no Submit (both run reCAPTCHA).
// The extension gets access to every site, as "every careers page" in
// Settings grants, since Fetcherr and Experis are outside its host list.
// Run from the repo root: node tests/e2e/_ext_generic_submit.mjs [out-dir]
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "ooj-submit-out-"));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CYERA = "https://www.comeet.com/jobs/cyera/17.008/customer-success-engineer---rest-of-west/3E.46C";

// Open jobs from our API, gently: one call per ATS, a pause after each.
async function liveJobs(ats, n, keep = () => true, suffix = "") {
  const res = await fetch(`https://oceanofjobs.com/api/jobs?ats=${ats}&limit=25&count=skip`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
  const { jobs = [] } = await res.json();
  await sleep(2000);
  const urls = [];
  for (const j of jobs.filter((j) => keep(j.url))) {
    if (urls.length >= n) break;
    const page = await fetch(j.url.replace(/\/$/, "") + suffix, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    // A redirect to a custom domain leaves the host permissions behind.
    if (page && page.ok && new URL(page.url).hostname === new URL(j.url).hostname && !/404|not found/i.test((/<title>([^<]*)/i.exec(await page.text()) || [])[1] || "")) urls.push(j.url.replace(/\/$/, "") + suffix);
    await sleep(1500);
  }
  if (!urls.length) throw new Error(`no open ${ats} job`);
  return urls;
}
// Optional: only these ATSes, e.g. "lever breezy".
const only = process.argv.slice(3);
const want = (ats) => !only.length || only.includes(ats);
const [lever, leverPosting] = want("lever") ? await liveJobs("lever", 2) : [];
// Each ATS gets a few jobs to try, in order, until one has a form with a
// single clear submit button (a multi-step form gets none, by design).
const SUBMIT = [
  want("lever") && { ats: "lever", urls: [lever + "/apply"] },
  want("comeet") && { ats: "comeet", urls: [CYERA] },
  want("teamtailor") && { ats: "teamtailor", urls: await liveJobs("teamtailor", 2, undefined, "/applications/new") },
  want("recruitee") && { ats: "recruitee", urls: await liveJobs("recruitee", 2, (u) => new URL(u).hostname.endsWith(".recruitee.com"), "/c/new") },
  // Brand Momentum asks for a recorded video answer, which nothing fills.
  want("breezy") && { ats: "breezy", urls: await liveJobs("breezy", 4, (u) => !u.includes("//brandmomentum."), "/apply") },
].filter(Boolean);
const POSTING = [
  want("comeet") && { ats: "comeet", url: (await liveJobs("comeet", 1, (u) => u.startsWith("https://www.comeet.com/jobs/")))[0] },
  want("lever") && { ats: "lever", url: leverPosting },
].filter(Boolean);
// System Architect - Azure: "Can you work from the Netanya office?" and
// "hands-on experience ... on Azure?", Yes/No, both optional.
const REVIEW = [
  want("fetcherr") && { ats: "fetcherr", url: "https://www.fetcherr.io/careers/732769d50a", radios: 2 },
  want("experis") && { ats: "experis", url: (await (async () => {
    const res = await fetch("https://oceanofjobs.com/api/jobs?search=experis&limit=10&count=skip", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
    const { jobs = [] } = await res.json();
    await sleep(2000);
    const j = jobs.find((j) => /^https:\/\/experis\.co\.il\/job\/\d+$/.test(j.url));
    if (!j) throw new Error("no open experis job");
    return j.url;
  })()), contact: true },
].filter(Boolean);

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: "test.person@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://www.linkedin.com/in/test-person", github: "", website: "" },
  work: { authorized_countries: ["IL"], needs_sponsorship: true, notice_period: "30 days", salary: "100000" },
  eeo: { gender: "decline", race: "decline", veteran: "decline", disability: "decline" },
  answers: [{ question: "How did you hear about us?", answer: "LinkedIn" }],
  settings: { mode: "queue", sources: ["board"], unknowns: "skip", guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } },
};
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

let log = null;
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-submit-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("https://*/*");
manifest.optional_host_permissions = manifest.optional_host_permissions.filter((h) => h !== "https://*/*");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-submit-profile-"));
const ctx = await chromium.launchPersistentContext(dir, {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 }, userAgent: UA,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
// A service worker's requests would skip the routes below.
await ctx.addInitScript(() => {
  const none = { register: () => Promise.reject(new Error("blocked in this test")), getRegistrations: async () => [], getRegistration: async () => undefined,
    ready: new Promise(() => {}), controller: null, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => none, configurable: true }); } catch { /* already gone */ }
});
await ctx.route("**/*", (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com" && u.pathname.startsWith("/api/")) {
    const p = u.pathname;
    if (p.startsWith("/api/me/apply/")) log && log.api.push(p);
    if (p === "/api/me/apply/profile") return r.fulfill({ json: { profile, preferences: { skills: ["Python"] } } });
    if (p === "/api/me/apply/usage") return r.fulfill({ json: { plan: "pro", period: "day", limit: 50, used: 0, remaining: 50 } });
    if (p === "/api/me/apply/history") return r.fulfill({ json: { applied: [] } });
    if (p === "/api/me/apply/draft") {
      const body = req.postDataJSON();
      log && log.drafts.push(body.question);
      const yes = body.options.find((o) => /^yes$/i.test(o));
      return r.fulfill({ json: { answer: yes || (body.options.length ? body.options[0] : "Test answer") } });
    }
    if (p === "/api/me/apply/claim") { log && log.claims.push(req.postDataJSON()); return r.fulfill({ json: { remaining: 49 } }); }
    if (p === "/api/me/apply/result") { log && log.results.push(req.postDataJSON()); return r.fulfill({ status: 204, body: "" }); }
    return r.fulfill({ status: 204, body: "" });
  }
  if (req.method() === "POST" && /\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(u.hostname)) {
    log && log.blocked.push(`stubbed POST ${u.hostname}${u.pathname}`.slice(0, 140));
    const key = /name="key"\r\n\r\n([^\r]*)/.exec((req.postDataBuffer() || "").toString("latin1"));
    return r.fulfill({ status: 201, contentType: "application/xml",
      body: `<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>${u.origin}/${key && key[1]}</Location><Key>${key && key[1]}</Key><ETag>"0"</ETag></PostResponse>` });
  }
  // Breezy uploads the CV to its own API first and only needs a URL back.
  if (req.method() === "POST" && u.hostname === "app.breezy.hr" && /^\/api\/portal\/[^/]+\/upload$/.test(u.pathname)) {
    log && log.blocked.push(`stubbed POST ${u.hostname}${u.pathname}`);
    return r.fulfill({ json: { url: "https://example.invalid/Test_Person_CV.pdf" } });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method()) && u.hostname !== "oceanofjobs.com") {
    log && log.blocked.push(`${log.armed ? "after submit: " : ""}${req.method()} ${u.hostname}${u.pathname}`.slice(0, 160));
    return r.abort();
  }
  if (log && log.armed && req.isNavigationRequest() && u.hostname !== "oceanofjobs.com") {
    log.blocked.push(`after submit: navigation ${req.method()} ${u.hostname}${u.pathname}`.slice(0, 160));
    return r.abort();
  }
  return r.continue();
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(async (data) => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "Test_Person_CV.pdf", type: "application/pdf", size: data.length, data: btoa(data) } });
  await chrome.alarms.clearAll();
  // Keep what the card's fill and submit returned, and the button picked.
  const fill = assistHere;
  assistHere = async (msg, sender) => {
    const r = await fill(msg, sender);
    globalThis.__sender = { tab: { id: sender.tab.id }, frameId: sender.frameId };
    globalThis.__picked = r && !r.error ? await inTab(sender.tab.id, "generic", "submitInfo", [], r.frameId).catch((e) => ({ error: e.message })) : null;
    return (globalThis.__assist = r);
  };
  const send = submitHere;
  submitHere = async (...a) => (globalThis.__submit = await send(...a));
}, pdf);
for (const p of ctx.pages()) await p.close();

// The fill button's box in page coordinates, from whichever frame shows it.
async function button(tab) {
  for (const f of tab.frames()) {
    const box = await f.evaluate(() => {
      const el = document.querySelector("[data-ooj-fill]");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }).catch(() => null);
    if (!box) continue;
    if (f !== tab.mainFrame()) {
      const at = await (await f.frameElement()).boundingBox();
      box.x += at.x; box.y += at.y;
    }
    return box;
  }
  return null;
}
const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) { const v = await fn(); if (v) return v; } return null; };
const global = (name) => sw.evaluate((n) => globalThis[n] || null, name);
const reset = () => sw.evaluate(() => { globalThis.__assist = globalThis.__submit = globalThis.__picked = null; });
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
// The card's main button sits above its "Hide on this site" line.
const pressCard = async (tab) => { const c = await button(tab); await tab.mouse.click(c.x + c.w / 2, c.y + c.h - 62); };
// What the card says and whether its main button shows. Its shadow root
// is closed, which only the DevTools protocol reads through.
async function cardState(tab) {
  const cdp = await tab.context().newCDPSession(tab);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  await cdp.detach();
  const kids = (n) => [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])];
  const attrs = (n) => { const a = {}; for (let i = 0; i < (n.attributes || []).length; i += 2) a[n.attributes[i]] = n.attributes[i + 1]; return a; };
  const text = (n) => (n.nodeType === 3 ? n.nodeValue : kids(n).map(text).join(""));
  const find = (n, test) => (test(n) ? n : kids(n).reduce((hit, k) => hit || find(k, test), null));
  const host = find(root, (n) => "data-ooj-fill" in attrs(n));
  const msg = host && find(host, (n) => /\bmsg\b/.test(attrs(n).class || ""));
  const go = host && find(host, (n) => n.nodeName === "BUTTON" && /\bgo\b/.test(attrs(n).class || ""));
  return { msg: msg && text(msg), submitShown: !!go && !("hidden" in attrs(go)) && /submit/i.test(text(go)) };
}
const HUMAN = "This site requires you to submit the form yourself. Review your answers and use the site's Submit button.";
// submitHere as the card's button calls it, on the frame the fill used.
const askSubmit = (url) => sw.evaluate((url) => submitHere({ url, frameId: __assist.frameId, title: "test", company: "test" }, __sender), url);

const rows = [];
async function fillFromCard(tab, name) {
  const fab = await until(() => button(tab), 15000);
  if (!fab) {
    await tab.screenshot({ path: path.join(out, `${name}-no-button.png`) });
    return { error: "no fill button" };
  }
  await tab.screenshot({ path: path.join(out, `${name}-button.png`) });
  // The button can show before a form has rendered all its questions
  // (Comeet adds them late); a person reads the page before clicking.
  await sleep(4000);
  const api = log.api.length;
  await tab.mouse.click(fab.x + fab.w / 2, fab.y + fab.h / 2);
  await sleep(1500);
  await pressCard(tab);
  const r = await until(() => global("__assist"), 60000);
  await sleep(1500);
  await tab.screenshot({ path: path.join(out, `${name}-filled.png`) });
  return { r, apiBeforeClick: api };
}

log = null;
const passedOver = [];
async function submitOn(ats, url) {
  log = { api: [], blocked: [], claims: [], results: [], drafts: [], armed: false };
  await reset();
  const tab = await ctx.newPage();
  const name = `submit-${ats}-${slug(new URL(url).hostname)}`;
  const row = { part: "submit", ats, url };
  try {
    await tab.goto(url, { waitUntil: "load", timeout: 45000 });
    await sleep(5000);
    const { r, error } = await fillFromCard(tab, name);
    row.fill = error || (r && (r.error || `${r.filled} filled, ${r.missing.length} missing`));
    row.picked = await global("__picked");
    if (r && r.botCheck) {
      row.botCheck = true;
      row.card = await cardState(tab);
      row.result = await askSubmit(url);
    } else if (r && !r.error && r.submit) {
      // What the user does before sending: tick the consent boxes the fill leaves alone.
      row.ticked = 0;
      for (const f of tab.frames()) {
        row.ticked += await f.evaluate(() => [...document.querySelectorAll('input[type="checkbox"]:not(:checked)')].filter((el) => {
          const box = el.closest("label") || el.parentElement;
          return box && /consent|agree|privacy|terms|accept|acknowledg/i.test(box.textContent) && (el.click(), true);
        }).length).catch(() => 0);
      }
      const writesBefore = log.blocked.length;
      log.armed = true;
      const started = Date.now();
      await pressCard(tab);
      row.result = await until(() => global("__submit"), 45000);
      row.seconds = Math.round((Date.now() - started) / 1000);
      await sleep(1000);
      await tab.screenshot({ path: path.join(out, `${name}-submitted.png`) }).catch(() => {});
      row.siteWrites = log.blocked.slice(writesBefore).filter((w) => w.startsWith("after submit"));
    }
  } catch (e) {
    row.fill = row.fill || "error: " + e.message.split("\n")[0];
  }
  Object.assign(row, { claims: log.claims, results: log.results, blocked: log.blocked });
  console.log(`\n== ${ats} ${url}\n${JSON.stringify({ ...row, blocked: row.blocked.length })}`);
  await tab.close().catch(() => {});
  await sleep(3000);
  return row;
}
for (const { ats, urls } of SUBMIT) {
  for (const [i, url] of urls.entries()) {
    const row = await submitOn(ats, url);
    if (row.picked || i === urls.length - 1) { rows.push(row); break; }
    passedOver.push({ ats, url, fill: row.fill, claims: row.claims.length });
  }
}

for (const { ats, url } of POSTING) {
  log = { api: [], blocked: [], claims: [], results: [], drafts: [], armed: false };
  await reset();
  const tab = await ctx.newPage();
  const name = `posting-${ats}`;
  const row = { part: "posting", ats, url };
  try {
    await tab.goto(url, { waitUntil: "load", timeout: 45000 });
    await sleep(5000);
    row.fieldsBefore = await tab.evaluate(() => document.querySelectorAll("input:not([type=hidden]), textarea, select").length);
    const { r, apiBeforeClick, error } = await fillFromCard(tab, name);
    row.apiBeforeClick = apiBeforeClick;
    row.fill = error || (r && (r.error || `${r.filled} filled, ${r.missing.length} missing`));
    row.filled = r && r.filled;
    row.picked = await global("__picked");
    row.landed = tab.url();
    // A fill that moved to the form page shows its card there, open.
    const card = await until(() => button(tab), 10000);
    row.cardOpen = !!(card && card.h > 100);
    await tab.screenshot({ path: path.join(out, `${name}-after.png`) });
  } catch (e) {
    row.fill = row.fill || "error: " + e.message.split("\n")[0];
  }
  Object.assign(row, { claims: log.claims, results: log.results, blocked: log.blocked });
  rows.push(row);
  console.log(`\n== posting ${ats} ${url}\n${JSON.stringify({ ...row, blocked: row.blocked.length })}`);
  await tab.close().catch(() => {});
  await sleep(3000);
}

// Across the tab's frames: the option picked in each radio question, how
// many checkboxes are ticked, the text values and whether a CV is attached.
async function formState(tab) {
  const st = { picked: [], ticked: 0, values: [], cv: false };
  for (const f of tab.frames()) {
    const s = await f.evaluate(() => {
      const names = [...new Set([...document.querySelectorAll('input[type="radio"]')].map((r) => r.name))].filter((n) => document.getElementsByName(n).length > 1);
      return {
        picked: names.map((n) => {
          const c = [...document.getElementsByName(n)].find((r) => r.checked);
          const l = c && ((c.id && document.querySelector(`label[for="${CSS.escape(c.id)}"]`)) || c.closest("label"));
          return l ? l.textContent.trim() : "";
        }),
        ticked: document.querySelectorAll('input[type="checkbox"]:checked').length,
        values: [...document.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="hidden"]):not([type="submit"])')].map((el) => el.value).filter(Boolean),
        cv: [...document.querySelectorAll('input[type="file"]')].some((el) => el.files && el.files.length),
      };
    }).catch(() => null);
    if (!s) continue;
    st.picked.push(...s.picked);
    st.ticked += s.ticked;
    st.values.push(...s.values);
    st.cv = st.cv || s.cv;
  }
  return st;
}

for (const { ats, url, radios, contact } of REVIEW) {
  log = { api: [], blocked: [], claims: [], results: [], drafts: [], armed: false };
  await reset();
  const tab = await ctx.newPage();
  const name = `review-${ats}`;
  const row = { part: "review", ats, url, radios, contact };
  try {
    await tab.goto(url, { waitUntil: "load", timeout: 45000 });
    await sleep(5000);
    row.tickedBefore = (await formState(tab)).ticked;
    const { r, error } = await fillFromCard(tab, name);
    row.fill = error || (r && (r.error || `${r.filled} filled, ${r.suggested} suggested, ${r.missing.length} missing`));
    row.botCheck = !!(r && r.botCheck);
    row.after = await formState(tab);
    row.card = await cardState(tab);
    row.result = await askSubmit(url);
  } catch (e) {
    row.fill = row.fill || "error: " + e.message.split("\n")[0];
  }
  Object.assign(row, { claims: log.claims, results: log.results, blocked: log.blocked, drafts: log.drafts });
  rows.push(row);
  console.log(`\n== review ${ats} ${url}\n${JSON.stringify({ ...row, blocked: row.blocked.length })}`);
  await tab.close().catch(() => {});
  await sleep(3000);
}
await ctx.close();

fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(rows, null, 1));
const pad = (s, n) => String(s ?? "-").slice(0, n).padEnd(n);
console.log("\n" + [pad("part", 7), pad("ats", 10), pad("fill", 22), pad("button picked", 26), pad("selector", 48), pad("outcome", 34), pad("claims", 6), pad("s", 3), "site writes blocked after submit"].join(" "));
let bad = 0;
const need = (ok, what) => { if (!ok) { bad++; console.log("FAIL", what); } };
for (const x of rows) {
  const res = x.result ? (x.result.failed ? "failed: " + x.result.failed : x.result.unknown ? "unknown (reported failed)" : JSON.stringify(x.result)) : "-";
  console.log([pad(x.part, 7), pad(x.ats, 10), pad(x.fill, 22), pad(x.picked && x.picked.text, 26), pad(x.picked && x.picked.selector, 48), pad(res, 34),
    pad(x.claims.length, 6), pad(x.seconds, 3), (x.siteWrites || []).map((w) => w.replace("after submit: ", "")).join("; ")].join(" ").slice(0, 300));
}
// The card on a bot-checked form: no Submit, the reason, and a refusal.
const botChecked = (x, what) => {
  need(x.botCheck, `${what}: the bot check was seen`);
  need(x.card && x.card.msg && x.card.msg.includes(HUMAN), `${what}: the card says to press the site's own button (${x.card && x.card.msg})`);
  need(x.card && !x.card.submitShown, `${what}: no Submit on the card`);
  need(x.result && x.result.error === HUMAN, `${what}: submitHere refuses (${JSON.stringify(x.result)})`);
  need(x.claims.length === 0, `${what}: no claim (${x.claims.length})`);
};
// Comeet runs reCAPTCHA and Lever hCaptcha on every form.
for (const x of rows.filter((x) => x.part === "submit" && (x.botCheck || ["comeet", "lever"].includes(x.ats)))) botChecked(x, x.ats);
for (const x of rows.filter((x) => x.part === "review")) {
  botChecked(x, `${x.ats} review`);
  const a = x.after || { picked: [], values: [] };
  if (x.radios) {
    need(a.picked.filter((p) => p === "Yes").length >= x.radios, `${x.ats} review: ${x.radios} Yes/No questions ticked Yes (${JSON.stringify(a.picked)})`);
    need(x.drafts.some((q) => /Netanya/.test(q)), `${x.ats} review: the optional office question went to the AI stub`);
  }
  if (x.contact) {
    for (const v of ["Test", "Person", profile.contact.email]) need(a.values.includes(v), `${x.ats} review: ${v} filled (${JSON.stringify(a.values)})`);
    need(a.values.some((v) => v.replace(/\D/g, "").endsWith("500000000")), `${x.ats} review: phone filled`);
  }
  need(a.cv, `${x.ats} review: CV attached`);
  need(a.ticked <= x.tickedBefore, `${x.ats} review: no checkbox ticked by the fill (${x.tickedBefore} before, ${a.ticked} after)`);
}
for (const x of rows.filter((x) => x.part === "submit" && !x.botCheck)) {
  need(x.picked && x.picked.text, `${x.ats}: a submit button was picked`);
  need(x.result && !x.result.submitted && !x.result.error, `${x.ats}: the result is not a confirmation`);
  need(x.claims.length === 1, `${x.ats}: exactly one claim (${x.claims.length})`);
  need(x.results.length === 1 && x.results[0].status === "failed", `${x.ats}: reported failed, credit returned (${JSON.stringify(x.results)})`);
  need(x.seconds != null && x.seconds <= 40, `${x.ats}: no hang (${x.seconds} s)`);
  // A write to the ATS's own host, not analytics or a CAPTCHA service.
  // Lever and Recruitee run an invisible hCaptcha before they send. Its
  // own POSTs are blocked too, so their application write never starts.
  const sent = (x.siteWrites || []).some((w) => !/captcha/i.test(w) && new RegExp(`^after submit: (navigation )?(POST|PUT|PATCH) [^ /]*${x.ats}\\.`).test(w));
  const gated = (x.siteWrites || []).some((w) => /^after submit: POST [^ ]*captcha/i.test(w));
  console.log(`${x.ats}: ${sent ? "the application write was attempted and blocked" : gated ? "stopped at the CAPTCHA's own write, blocked; the application write sits behind it" : "no write"}`);
  need(sent || gated, `${x.ats}: the site's send was attempted and blocked`);
}
for (const x of rows.filter((x) => x.part === "posting")) {
  need(x.fieldsBefore < 3, `${x.ats} posting: no form before Apply (${x.fieldsBefore} fields)`);
  need(x.apiBeforeClick === 0, `${x.ats} posting: no API call before the click`);
  need(x.filled > 0, `${x.ats} posting: one click filled the form (${x.fill})`);
  need(x.claims.length === 0, `${x.ats} posting: no claim from a fill`);
}
for (const x of passedOver) {
  console.log(`passed over, no clear submit button: ${x.ats} ${x.url} (${x.fill}, ${x.claims} claims)`);
  need(x.claims === 0, `${x.ats}: no claim without a submit button`);
}
console.log(`\nwrites to other hosts, all aborted or answered in the browser: ${rows.reduce((n, x) => n + x.blocked.length, 0)}`);
for (const x of rows) for (const w of x.blocked) console.log(`  ${x.part} ${x.ats}: ${w}`);
console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
console.log(`screenshots and results: ${out}`);
process.exitCode = bad ? 1 : 0;
