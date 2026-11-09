// How long the fill card takes: page registration (DOMContentLoaded to the
// card ready to fill), Fill application to the first field filled, the
// whole fill, and each field's own time. Runs the unpacked extension on
// local forms built here, and on a live Greenhouse form read with GETs
// only. Our API is stubbed with set latencies, the AI is stubbed, every
// POST to a job site is aborted, and Submit is never pressed.
// Run from the repo root: node tests/e2e/_ext_speed.mjs
// RUNS=20 per fixture and mode. FIXTURES=form,late,greenhouse.
// MODES=warm-fg,cold-fg,warm-bg,cold-bg (bg: timers throttled as in a hidden tab until Fill is pressed).
// API_MS=200 AI_MS=1500 (each varies by half either way; 1 API call in 10 takes 1200 ms).
// LATE_MS=11000 is when the late form shows up. OUT=file.json keeps the raw runs.
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const RUNS = Number(process.env.RUNS || 20);
const FIXTURES = (process.env.FIXTURES || "form,late,greenhouse").split(",");
const MODES = (process.env.MODES || "warm-fg,cold-fg,warm-bg,cold-bg").split(",");
const API_MS = Number(process.env.API_MS || 200);
const AI_MS = Number(process.env.AI_MS || 1500);
const LATE_MS = Number(process.env.LATE_MS || 11000);
const GREENHOUSE = process.env.GH_URL || "https://job-boards.greenhouse.io/anthropic/jobs/5456619008";

// A seeded random source, so a before and an after run see the same latencies.
let seed = 1;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const jitter = (ms) => ms * (0.5 + rand());
const apiDelay = () => (rand() < 0.1 ? 1200 : jitter(API_MS));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The card lives in a closed shadow root; the copy here opens it so the
// harness can watch it. Nothing else changes.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-speed-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const detectPath = path.join(ext, "detect.js");
fs.writeFileSync(detectPath, fs.readFileSync(detectPath, "utf8").replace("attachShadow({ mode: 'closed' })", "attachShadow({ mode: 'open' })"));

// A background tab, emulated: Playwright's pages always report visible and
// are never throttled, so the content scripts' timers are held to Chrome's
// hidden-tab rule (wake-ups aligned to whole seconds) while the page carries
// data-ooj-hidden. The first content script (lib/match.js) installs it for
// its whole isolated world; the service worker has no document and skips it.
const SHIM = `if (typeof document === 'object' && !globalThis.__oojShim) {
  globalThis.__oojShim = true;
  const st = setTimeout, ci = clearInterval;
  const hidden = () => document.documentElement && document.documentElement.hasAttribute('data-ooj-hidden');
  const wait = (ms) => { const at = performance.now() + Math.max(0, ms || 0); return hidden() ? Math.ceil(at / 1000) * 1000 - performance.now() : at - performance.now(); };
  globalThis.setTimeout = (f, ms, ...a) => st(f, wait(ms), ...a);
  const ids = new Map(); let n = 0;
  globalThis.setInterval = (f, ms, ...a) => { const id = ++n; const tick = () => { ids.set(id, st(() => { if (!ids.has(id)) return; tick(); f(...a); }, wait(ms))); }; tick(); return id; };
  globalThis.clearInterval = (id) => { if (ids.has(id)) { clearTimeout(ids.get(id)); ids.delete(id); } else ci(id); };
}
`;
const matchPath = path.join(ext, "lib", "match.js");
fs.writeFileSync(matchPath, SHIM + fs.readFileSync(matchPath, "utf8"));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-speed-profile-")), {
  channel: "chromium", headless: true, viewport: { width: 1200, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

// A careers form like the ones the general filler meets: contact fields,
// a CV, a place looked up as you type (300 ms, like a places API), a list
// button, a typeahead with no list until typed, open questions and a yes/no.
const FIELDS = `
<label for="first_name">First name</label><input id="first_name" name="first_name" required>
<label for="last_name">Last name</label><input id="last_name" name="last_name" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="phone">Phone</label><input id="phone" name="phone" type="tel">
<label for="resume">Resume</label><input id="resume" name="resume" type="file" required>
<label for="linkedin">LinkedIn profile</label><input id="linkedin" name="linkedin">
<label for="location">Location</label><input id="location" role="combobox" aria-controls="location-list" aria-expanded="false" autocomplete="off"><ul id="location-list" role="listbox"></ul>
<label id="source-label">How did you hear about us?</label><button type="button" id="source" aria-haspopup="listbox" aria-labelledby="source-label" aria-controls="source-list">Select one</button><ul id="source-list" role="listbox" hidden></ul>
<label for="school">School</label><input id="school" role="combobox" aria-controls="school-list" autocomplete="off"><ul id="school-list" role="listbox"></ul>
<label for="sponsor">Will you now or in the future require visa sponsorship?</label><select id="sponsor" name="sponsor" required><option value="">Select</option><option>Yes</option><option>No</option></select>
<label for="why">Why do you want to work at Acme?</label><textarea id="why" name="why" required></textarea>
<label for="project">Tell us about a project you are proud of</label><textarea id="project" name="project"></textarea>
<label for="notice">What is your notice period?</label><input id="notice" name="notice">
<fieldset><legend>Are you willing to relocate?</legend><label><input type="radio" name="relocate" value="yes">Yes</label><label><input type="radio" name="relocate" value="no">No</label></fieldset>
<button type="submit">Submit application</button>`;
const WIDGETS = `<script>
const opt = (list, texts, pick) => { list.innerHTML = ''; for (const t of texts) { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = t;
  li.addEventListener('click', () => pick(t)); list.appendChild(li); } };
function wire() {
  const loc = document.getElementById('location'), locList = document.getElementById('location-list');
  let timer;
  loc.addEventListener('input', () => { clearTimeout(timer); const q = loc.value.toLowerCase(); timer = setTimeout(() => opt(locList, ['Tel Aviv, Israel', 'Tel Aviv-Yafo, Israel', 'Toronto, Canada'].filter((t) => q && t.toLowerCase().startsWith(q.slice(0, 3))),
    (t) => { loc.value = t; locList.innerHTML = ''; loc.dispatchEvent(new Event('change', { bubbles: true })); }), 300); });
  const src = document.getElementById('source'), srcList = document.getElementById('source-list');
  src.addEventListener('click', () => { srcList.hidden = false; opt(srcList, ['LinkedIn', 'A friend', 'Job board', 'Company website', 'Other'], (t) => { src.textContent = t; srcList.hidden = true; src.dispatchEvent(new Event('change', { bubbles: true })); }); });
  src.addEventListener('keydown', (e) => { if (e.key === 'Escape') srcList.hidden = true; });
  const sch = document.getElementById('school'), schList = document.getElementById('school-list');
  sch.addEventListener('input', () => setTimeout(() => opt(schList, sch.value ? [sch.value + ' University', 'Technion'] : [], (t) => { sch.value = t; schList.innerHTML = ''; sch.dispatchEvent(new Event('change', { bubbles: true })); }), 200));
}
</script>`;
const page = (late) => `<!doctype html><html><head><title>Backend Engineer at Acme</title></head><body>
<h1>Backend Engineer</h1><p>Tel Aviv. Apply for this job below.</p><div id="mount">${late ? "" : `<form id="application" action="/submit" method="post">${FIELDS}</form>`}</div>${WIDGETS}
<script>${late ? `setTimeout(() => { document.getElementById('mount').innerHTML = '<form id="application" action="/submit" method="post">' + ${JSON.stringify(FIELDS)} + '</form>'; wire(); }, ${LATE_MS});` : "wire();"}</script></body></html>`;

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: "test.person@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://linkedin.com/in/test-person", github: "", website: "" },
  work: { authorized_countries: ["IL"], needs_sponsorship: false, notice_period: "", salary: "" }, eeo: { gender: "decline" }, answers: [],
  settings: { mode: "queue", sources: ["board", "ats_pages"], unknowns: "ai", guardrails: {} },
};

const apiLog = [];
let blockedPosts = 0;
await ctx.route("**/*", async (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "careers.acme.test") {
    if (req.method() !== "GET") { blockedPosts++; return r.abort(); }
    return r.fulfill({ contentType: "text/html", body: page(u.pathname.includes("/late/")) });
  }
  if (u.hostname === "oceanofjobs.com") {
    const start = Date.now();
    const p = u.pathname;
    let res;
    if (p === "/api/me/apply/draft") {
      await sleep(jitter(AI_MS));
      const b = req.postDataJSON() || {};
      res = /notice period|salary/i.test(b.question) ? { status: 422, json: { error: "your profile doesn't answer this question" } }
        : { json: { answer: (b.options || []).length ? b.options[0] : "I like how Acme builds things.", source: "ai" } };
    } else {
      await sleep(apiDelay());
      if (p === "/api/me/apply/profile") res = { json: { profile, preferences: { skills: ["Python"] } } };
      else if (p === "/api/me/apply/summary") res = { json: { plan: "pro", period: "day", limit: 50, used: 0, remaining: 50, applied_today: 0 } };
      else if (p === "/api/me/apply/history") res = { json: { applied: [] } };
      else res = { status: 204, body: "" };
    }
    apiLog.push({ path: p, start, end: Date.now() });
    return r.fulfill(res).catch(() => {});
  }
  // Live pages: reads only. Nothing is sent to an employer.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) { blockedPosts++; return r.abort(); }
  return r.continue();
});

// The page's own clock, from before any of its scripts: DOMContentLoaded,
// when the card is ready and when the fill ends (both watched through the
// card's shadow root, which timers in a background tab would not catch in
// time), and the last event on each field.
await ctx.addInitScript(() => {
  const o = window.__ooj = { labels: {} };
  const now = () => performance.timeOrigin + performance.now();
  document.addEventListener("DOMContentLoaded", () => { o.dcl = now(); });
  // A background tab (see SHIM) from before any content script runs.
  if (/[?&]bg=1/.test(location.search)) document.addEventListener("readystatechange", () => document.documentElement.setAttribute("data-ooj-hidden", ""), { once: true });
  const card = () => { const h = document.querySelector("[data-ooj-fill]"); return h && h.shadowRoot; };
  const check = () => {
    const r = card();
    if (!r) return;
    const go = r.querySelector(".go"), msg = r.querySelector(".msg");
    if (!o.reg && go && !go.hidden && !go.disabled && go.textContent === "Fill application" && msg && msg.textContent.trim()) o.reg = now();
    if (o.click && !o.done && msg && /\b(ok|warn)\b/.test(msg.className)) { o.done = now(); o.result = msg.textContent; o.resultOk = /\bok\b/.test(msg.className); }
  };
  let watched = null;
  new MutationObserver(() => {
    const r = card();
    if (r && r !== watched) { watched = r; new MutationObserver(check).observe(r, { subtree: true, childList: true, characterData: true, attributes: true }); check(); }
  }).observe(document, { childList: true, subtree: true });
  const label = (el) => {
    const l = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const by = el.getAttribute && el.getAttribute("aria-labelledby");
    const t = (l && l.textContent) || (by && (document.getElementById(by.split(" ")[0]) || {}).textContent)
      || ((el.closest && el.closest("fieldset")) || { querySelector: () => null }).querySelector("legend")?.textContent || el.name || el.id || el.tagName;
    return String(t).replace(/\s+/g, " ").replace(/\*\s*$/, "").trim().slice(0, 50);
  };
  // Every event on a field after the click; the harness works out the
  // fill's order and each field's time from them.
  o.events = [];
  for (const type of ["pointerdown", "focusin", "input", "change"]) {
    window.addEventListener(type, (e) => {
      if (!o.click || o.done) return;
      const el = e.composedPath()[0];
      if (!el || !el.tagName || el.closest?.("[data-ooj-fill]") || !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) return;
      const key = el.type === "radio" || el.type === "checkbox" ? "box:" + (el.name || el.closest("fieldset")?.id || el.id) : el.id || el.name || el.tagName;
      if (!o.labels[key]) o.labels[key] = label(el);
      o.events.push([key, type, now()]);
    }, true);
  }
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(async () => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "cv.pdf", type: "application/pdf", size: 9, data: btoa("%PDF-1.4\n%") } });
  await chrome.alarms.clearAll();
});
// The CDP session that stops the service worker for a cold start.
const control = await ctx.newPage();
await control.goto("about:blank");
const cdp = await ctx.newCDPSession(control);
await cdp.send("ServiceWorker.enable");


const URLS = { form: "https://careers.acme.test/jobs/42/apply", late: "https://careers.acme.test/late/42/apply", greenhouse: GREENHOUSE };
async function once(fx, mode) {
  const cold = mode.startsWith("cold"), bg = mode.endsWith("-bg");
  if (cold) { await cdp.send("ServiceWorker.stopAllWorkers"); await sleep(300); }
  else await sw.evaluate(() => 1).catch(() => null); // awake
  const logFrom = apiLog.length;
  const p = await ctx.newPage();
  await p.goto(URLS[fx] + (URLS[fx].includes("?") ? "&" : "?") + "r=" + Math.random().toString(36).slice(2) + (bg ? "&bg=1" : ""), { waitUntil: "commit" });
  const out = { fx, mode };
  try {
    const regLimit = fx === "late" ? LATE_MS + 10000 : 25000;
    const ok = await p.waitForFunction(() => window.__ooj && window.__ooj.reg, null, { timeout: regLimit, polling: 100 }).then(() => true, () => false);
    if (!ok) { out.error = `card not ready ${regLimit / 1000} s after load`; return out; }
    // The late form is there for registration only; its fill is the same form's.
    if (fx === "late") { out.reg = await p.evaluate(() => window.__ooj.reg - window.__ooj.dcl); return out; }
    // The user switches to the tab to press Fill application.
    if (bg) await p.evaluate(() => document.documentElement.removeAttribute("data-ooj-hidden"));
    await p.evaluate(() => { const go = document.querySelector("[data-ooj-fill]").shadowRoot.querySelector(".go"); window.__ooj.click = performance.timeOrigin + performance.now(); go.click(); });
    const done = await p.waitForFunction(() => window.__ooj.done, null, { timeout: 120000, polling: 100 }).then(() => true, () => false);
    const o = await p.evaluate(() => window.__ooj);
    out.reg = o.reg - o.dcl;
    if (!done) { out.error = "fill never ended"; return out; }
    out.result = o.result;
    out.ok = o.resultOk;
    // The fill starts with the first value set; dropdowns opened before
    // that were the form being read. Each field runs from its first event
    // in the fill to the next field's.
    const setAt = o.events.filter(([, type]) => type === "input" || type === "change").map(([, , t]) => t);
    const fillAt = setAt.length ? Math.min(...setAt) : null;
    out.first = fillAt && fillAt - o.click;
    const firsts = new Map();
    for (const [key, , t] of o.events) if (fillAt && t >= fillAt - 1 && !firsts.has(key)) firsts.set(key, t);
    const fields = [...firsts].map(([key, first]) => ({ label: o.labels[key], first }));
    out.total = o.done - o.click;
    const calls = apiLog.slice(logFrom).filter((c) => c.start >= o.click - 5);
    const drafts = calls.filter((c) => c.path.endsWith("/draft"));
    const acct = calls.filter((c) => /profile|summary|history/.test(c.path));
    out.account = acct.length ? Math.max(...acct.map((c) => c.end)) - Math.min(...acct.map((c) => c.start)) : 0;
    out.ai = drafts.length ? Math.max(...drafts.map((c) => c.end)) - Math.min(...drafts.map((c) => c.start)) : 0;
    out.drafts = drafts.length;
    out.beforeAi = drafts.length ? Math.min(...drafts.map((c) => c.start)) - o.click : null;
    out.perField = fields.map((f, i) => ({ label: f.label, ms: (i + 1 < fields.length ? fields[i + 1].first : o.done) - f.first }));
    if (out.perField.length) out.perField[out.perField.length - 1].label += " (and after)";
    if (fx !== "greenhouse") {
      out.values = await p.evaluate(() => ({
        first_name: document.getElementById("first_name").value, email: document.getElementById("email").value,
        location: document.getElementById("location").value, source: document.getElementById("source").textContent,
        sponsor: document.getElementById("sponsor").value, school: document.getElementById("school").value, why: !!document.getElementById("why").value,
        relocate: !!document.querySelector("input[name=relocate]:checked"), cv: document.getElementById("resume").files.length,
      }));
    } else {
      out.values = await p.evaluate(() => ({ first_name: (document.getElementById("first_name") || {}).value, email: (document.getElementById("email") || {}).value,
        filled: [...document.querySelectorAll("#application-form input:not([type=hidden]):not([type=file]), #application-form textarea")].filter((e) => e.value).length }));
    }
    return out;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 200);
    return out;
  } finally {
    await p.close().catch(() => {});
  }
}

const pct = (xs, q) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]) : "-"; };
const stat = (xs) => `${pct(xs, 0.5)} / ${pct(xs, 0.9)} / ${pct(xs, 1)}`;

const all = [];
for (const fx of FIXTURES) {
  for (const mode of MODES) {
    seed = 1; // the same latencies for every fixture and mode
    const rows = [];
    for (let i = 0; i < RUNS; i++) rows.push(await once(fx, mode));
    all.push(...rows);
    const good = rows.filter((r) => !r.error && r.total != null);
    console.log(`\n${fx} ${mode}: ${fx === "late" ? `card ready in ${rows.filter((r) => r.reg != null).length}/${rows.length} (registration only)` : `${good.length}/${rows.length} filled`}${rows.some((r) => r.error) ? " (" + [...new Set(rows.filter((r) => r.error).map((r) => r.error))].join("; ") + ")" : ""}`);
    console.log(`  p50 / p90 / max ms   registration ${stat(rows.map((r) => r.reg))}   first field ${stat(good.map((r) => r.first))}   total ${stat(good.map((r) => r.total))}`);
    console.log(`  account calls ${stat(good.map((r) => r.account))}   AI (${pct(good.map((r) => r.drafts), 0.5)} drafts) ${stat(good.map((r) => r.ai))}   click to first AI call ${stat(good.map((r) => r.beforeAi))}`);
    if (good[0]) console.log(`  result: ${good[0].result}  values: ${JSON.stringify(good[0].values)}`);
    const by = new Map();
    for (const r of good) for (const f of r.perField) by.set(f.label, [...(by.get(f.label) || []), f.ms]);
    const slow = [...by].sort((a, b) => pct(b[1], 0.5) - pct(a[1], 0.5)).slice(0, 6);
    console.log("  slowest fields (p50 / p90 / max): " + slow.map(([l, xs]) => `${l} ${stat(xs)}`).join(" | "));
  }
}
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(all, null, 1));
console.log(`\nPOSTs to job sites aborted: ${blockedPosts}`);
await ctx.close();
