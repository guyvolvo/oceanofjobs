// Live check of the send watch on real job sites, with nothing sent: the
// extension fills each real form as the popup's Fill application does,
// then the site's own send button is clicked like a person would. Every
// write the page makes (POST, PUT, PATCH, a form post) is answered here
// with a fake 200 and never leaves the browser; only GETs and bot-check
// pings (reCAPTCHA, hCaptcha, Turnstile, DataDome) go out. Ocean of Jobs'
// API is stubbed. Reports per job whether the extension marked the fill
// sent, and how ("request" from the form's POST, "page" from a confirmation).
//   node tests/e2e/_ext_sent_live.mjs [out dir]   env: SYSTEMS, PER_ATS, JOB_URLS
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "ooj-sent-live-"));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL = "test.person@example.com";
const N = Number(process.env.PER_ATS || 2);
const SYSTEMS = (process.env.SYSTEMS || "greenhouse,lever,ashby,workable,teamtailor,recruitee,pinpoint,breezy,bamboohr,jazzhr,personio,comeet").split(",");

const jobs = (process.env.JOB_URLS || "").split(/\s+/).filter(Boolean).map((url) => ({ url, ats: "given" }));
for (const ats of jobs.length ? [] : SYSTEMS) {
  try {
    const res = await fetch(`https://oceanofjobs.com/api/jobs?ats=${ats}&limit=${N * 6}&count=skip`, { signal: AbortSignal.timeout(30000) });
    const { jobs: list = [] } = await res.json();
    const seen = new Set();
    for (const j of list) if (jobs.filter((x) => x.ats === ats).length < N && !seen.has(j.company_domain)) { seen.add(j.company_domain); jobs.push({ url: j.url, ats }); }
  } catch (e) { console.log(`no ${ats} jobs: ${e.message}`); }
  await sleep(800);
}

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-sent-live-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-sent-live-profile-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: EMAIL, phone: "+1 415 555 0134", location: "San Francisco, CA, United States" },
  links: { linkedin: "https://www.linkedin.com/in/test-person", github: "https://github.com/test-person", website: "" },
  work: { authorized_countries: ["US"], needs_sponsorship: false, notice_period: "2 weeks", salary: "100000" },
  eeo: { gender: "decline", race: "decline", veteran: "decline", disability: "decline" },
  answers: [{ question: "How did you hear about us?", answer: "LinkedIn" }],
  settings: { mode: "queue", sources: ["board"], unknowns: "ai", consent: true, guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } },
};

let cur = null;
// Bot checks and their pings carry no application, and Ashby reads its
// form with a POST query (op=ApiJobPosting) that sends nothing.
const PASS = /^https:\/\/(jobs\.ashbyhq\.com\/api\/non-user-graphql\?op=ApiJobPosting$|(www\.)?google\.com\/recaptcha|www\.recaptcha\.net|[^/]*hcaptcha\.com|challenges\.cloudflare\.com|api-js\.datadome\.co\/js\/|[^/]+\/cdn-cgi\/challenge-platform\/)/;
await ctx.route("**/*", (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com") {
    const p = u.pathname;
    if (req.method() === "POST" && cur) cur.api.push(p + " " + (req.postData() || ""));
    if (p === "/api/me/apply/profile") return r.fulfill({ json: { profile, preferences: { skills: ["Python"] } } });
    if (p === "/api/me/apply/history") return r.fulfill({ json: { applied: [] } });
    if (p === "/api/me/apply/summary") return r.fulfill({ json: { plan: "pro", remaining: 100 } });
    if (p === "/api/me/apply/draft") {
      const body = req.postDataJSON() || {};
      return r.fulfill({ json: { answer: body.options && body.options.length ? body.options[0] : "Test answer", source: "ai" } });
    }
    return r.fulfill({ json: { attempt: { state: "filled" } } });
  }
  if (PASS.test(req.url()) || ["GET", "HEAD", "OPTIONS"].includes(req.method())) return r.continue();
  // Every other write stays here: a fake success, never sent.
  if (cur) {
    const body = (req.postDataBuffer() || Buffer.alloc(0)).toString("latin1").toLowerCase();
    cur.writes.push({ at: Date.now(), what: `${req.method()} ${u.hostname}${u.pathname}${u.search}`.slice(0, 140),
      email: body.includes(EMAIL) || body.includes(encodeURIComponent(EMAIL).toLowerCase()) });
  }
  return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
await sw.evaluate(async (data) => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "Test_Person_CV.pdf", type: "application/pdf", size: data.length, data: btoa(data) } });
  await chrome.alarms.clearAll();
}, pdf);

const rows = [];
for (const job of jobs) {
  cur = { api: [], writes: [] };
  const tab = await ctx.newPage();
  const row = { ats: job.ats, url: job.url };
  try {
    await tab.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3000);
    const fill = await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.split("#")[0] === url.split("#")[0]) || tabs.find((x) => x.active);
      return fillTab(t.id);
    }, tab.url()).catch((e) => ({ error: "harness: " + e.message.split("\n")[0] }));
    row.fill = fill.error ? fill.error : `${fill.filled} filled (${fill.ats})`;
    await sleep(2000);
    if (!fill.error) {
      // The form's own send button, as the filler sees it, clicked like a person would.
      let clicked = null;
      const mark = await sw.evaluate(async ({ url, frameId, tick }) => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => x.url && x.url.split("#")[0] === url.split("#")[0]) || tabs.find((x) => x.active);
        const target = frameId ? { tabId: t.id, frameIds: [frameId] } : { tabId: t.id };
        const [r] = await chrome.scripting.executeScript({ target, args: [tick], func: (tick) => {
          // What the fill left unticked, for the log.
          const left = [...document.querySelectorAll('input[type="checkbox"]:not(:checked)')]
            .map((c) => ((c.closest('fieldset, [class*="question" i], [class*="field" i], label') || c.parentElement).textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50));
          // What a person does before sending: tick the required boxes the fill left to them (NO_TICK=1: don't).
          if (tick) for (const c of document.querySelectorAll('input[type="checkbox"]:not(:checked)')) {
            const box = c.closest('fieldset, [class*="question" i], [class*="field" i], label') || c.parentElement;
            if (c.required || c.getAttribute('aria-required') === 'true'
              || /\*|required|privacy|consent|agree|acknowledg|understand/i.test((box && box.textContent) || '')) c.click();
          }
          // The form's send button, or with several, the last one that says so.
          const shown = (el) => el.getClientRects().length > 0;
          const b = globalThis.oojAts.generic.submitButton() || [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
            .filter((x) => shown(x) && /^(submit|send|apply|bewerbung absenden|absenden|senden|envoyer|enviar)/i.test((x.innerText || x.value || '').trim())).pop();
          if (!b) return { left };
          b.setAttribute("data-ooj-test-send", "1");
          return { left, text: (b.innerText || b.value || "").trim().slice(0, 40) };
        } });
        return r && r.result;
      }, { url: tab.url(), frameId: fill.frameId || 0, tick: !process.env.NO_TICK }).then((r) => {
        if (r && r.left.length) console.log("      boxes the fill left unticked:", r.left.join(" | "));
        return r && r.text;
      }).catch(() => null);
      if (mark) {
        for (const f of tab.frames()) {
          const b = f.locator('[data-ooj-test-send="1"]');
          if (await b.count().catch(() => 0)) { row.button = mark; row.clickAt = Date.now(); await b.first().click({ timeout: 10000 }).catch(() => b.first().evaluate((el) => el.click()).then(() => { row.button += " (clicked in the page)"; })).then(() => { clicked = true; }, (e) => { row.button += ` (click failed: ${e.message.split("\n")[0].slice(0, 60)})`; }); break; }
        }
      } else row.button = "no single send button (a wizard, or two of equal weight)";
      if (clicked) await sleep(15000);
    }
  } catch (e) { row.fill = row.fill || "page: " + e.message.split("\n")[0].slice(0, 80); }
  const sent = cur.api.find((a) => /\/sent /.test(a));
  row.sent = sent ? JSON.parse(sent.split(" ").slice(1).join(" ")).how : "";
  const after = cur.writes.filter((w) => row.clickAt && w.at >= row.clickAt);
  row.posts = after.map((w) => `${w.what}${w.email ? " [email]" : ""}`).slice(0, 4);
  rows.push(row);
  await tab.screenshot({ path: path.join(out, `${rows.length}-${job.ats}.png`) }).catch(() => {});
  console.log(`${(row.sent ? "SENT:" + row.sent : row.clickAt ? "not marked" : "no click").padEnd(13)} ${job.ats.padEnd(13)} ${String(row.fill).slice(0, 40).padEnd(40)} btn="${row.button || ""}"  ${job.url.slice(0, 80)}`);
  for (const p of row.posts) console.log("      write after click:", p);
  await tab.close().catch(() => {});
  if (!ctx.pages().length) await ctx.newPage();
  await sleep(2000);
}
fs.writeFileSync(path.join(out, "sent.json"), JSON.stringify(rows, null, 1));
console.log(`\nclicked ${rows.filter((r) => r.clickAt).length}/${rows.length}, marked sent ${rows.filter((r) => r.sent).length} (request ${rows.filter((r) => r.sent === "request").length}, page ${rows.filter((r) => r.sent === "page").length})`);
console.log(`results: ${path.join(out, "sent.json")}`);
await ctx.close();
