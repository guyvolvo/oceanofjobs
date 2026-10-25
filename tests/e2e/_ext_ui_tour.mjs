// Every screen of the extension, dark and light: the popup in each state
// (its chrome APIs stubbed), the in-page fill card in each state (the
// content scripts on a local page, the background stubbed), and the
// settings page from the real unpacked build. Nothing leaves the browser.
//   node tests/e2e/_ext_ui_tour.mjs <outdir>
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const ext = path.resolve("extension");
const version = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8")).version;
const bg = fs.readFileSync(path.join(ext, "background.js"), "utf8");
// The background's own wording, so the shots never drift from it.
const T = Object.fromEntries([...bg.matchAll(/^const (NOT_CONNECTED|EXPIRED|NO_CV|ALREADY|UNREACHABLE|ACCOUNT_URL) = (['"])(.*)\2;$/gm)].map((m) => [m[1], m[3]]));
const SOURCES_OFF = /blocked: '(Turn on [^']+)'/.exec(bg)[1];
const icon = "data:image/png;base64," + fs.readFileSync(path.join(ext, "icons/icon-48.png")).toString("base64");
const errors = [];
const shots = [];

const browser = await chromium.launch();

// The popup.
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const base = { connected: true, usage: { plan: "pro", remaining: 46, period: "day" }, appliedToday: 4, needs: [], hasCv: true, paused: false, lastRun: ago(3) };
const NEEDS = [
  { job_id: "j1", title: "Data Engineer", company: "Riskified", link: "#", question: "Why do you want to work at Riskified?", draft: "" },
  { job_id: "j1", title: "Data Engineer", company: "Riskified", link: "#", question: "Are you willing to work from the Tel Aviv office three days a week?", draft: "Yes" },
  { job_id: "j2", title: "Backend Engineer", company: "Lemonade", link: "#", question: "What is your expected monthly salary in ILS?", draft: "" },
];
const QUEUE = { total: 12, items: [
  { id: "a1", title: "Senior Backend Engineer", company: "Wix", supported: true },
  { id: "a2", title: "Platform Engineer", company: "monday.com", supported: true },
  { id: "a3", title: "Staff SRE", company: "Snyk", supported: false },
] };
const FILLED = { filled: 8, missing: [{ label: "Why us?" }], suggested: 2, errors: [], frameId: 0 };
const CV = { name: "Dana_Levi_CV.pdf", type: "application/pdf", size: 188416, savedAt: "2026-10-12T09:00:00Z" };
const LOCAL = { connected: true, mode: "local", ready: true, cv: null, workday: false, ai: null };
const POPUP = [
  ["signed-out", { status: { connected: false } }],
  ["connection-expired", { status: { connected: false, authError: true } }],
  ["free-no-cv-no-form", { status: { ...base, usage: { plan: "free", remaining: 7, period: "month" }, appliedToday: 0, hasCv: false, lastRun: null }, page: "none", queue: { total: 0, items: [] }, openQueue: true }],
  ["checking-this-page", { status: base, page: null, queue: QUEUE }],
  ["form-found-asks-site-access", { status: base, page: "form", ask: true, queue: QUEUE }],
  ["after-fill", { status: base, page: "form", queue: QUEUE, click: "fill", fill: FILLED }],
  ["review-step", { status: base, page: "form", queue: QUEUE, session: { review: true }, click: "fill", review: { left: 3, index: 1, kind: "suggested" } }],
  ["review-required-field", { status: base, page: "form", queue: QUEUE, session: { review: true }, click: "fill", review: { left: 2, index: 2, kind: "required" } }],
  ["nothing-left-to-check", { status: base, page: "form", queue: QUEUE, session: { review: true }, click: "fill", review: { left: 0 } }],
  ["application-filled", { status: base, page: "form", queue: QUEUE, session: { review: false } }],
  ["fill-error", { status: base, page: "form", queue: QUEUE, click: "fill", fill: { error: "No application form on this page." } }],
  ["unsupported-site", { status: base, page: "unsupported", queue: QUEUE }],
  ["needs-your-input", { status: { ...base, needs: NEEDS }, page: "none", queue: QUEUE }],
  ["queue-open", { status: base, page: "none", queue: QUEUE, openQueue: true }],
  ["queue-failed-to-load", { status: base, page: "none", queue: { error: "x" }, openQueue: true }],
  ["paused", { status: { ...base, paused: true }, page: "none", queue: QUEUE }],
  ["move-to-account-offer", { status: base, page: "none", queue: QUEUE, storage: { ...LOCAL, cv: CV } }],
  ["settings-this-computer", { status: base, page: "none", queue: QUEUE, storage: { ...LOCAL, cv: CV, workday: true }, clicks: ["#gear"] }],
  ["settings-account", { status: base, page: "none", queue: QUEUE, storage: { ...LOCAL, mode: "account", cv: CV, workday: true, ai: { provider: "anthropic", model: "claude-haiku-5-5" } }, clicks: ["#gear"] }],
  ["settings-ask-before-account", { status: base, page: "none", queue: QUEUE, storage: { ...LOCAL, cv: CV }, clicks: ["#gear", '.seg [data-mode="account"]'] }],
  ["settings-ask-before-this-computer", { status: base, page: "none", queue: QUEUE, storage: { ...LOCAL, mode: "account", cv: CV }, clicks: ["#gear", '.seg [data-mode="local"]'] }],
  ["settings-no-cv-ai-open", { status: base, page: "none", queue: QUEUE, storage: { ...LOCAL, ready: false }, clicks: ["#gear", "#s-ai summary"] }],
];

for (const scheme of ["dark", "light"]) {
  for (const [name, s] of POPUP) {
    const page = await browser.newPage({ viewport: { width: 320, height: 200 }, deviceScaleFactor: 2, colorScheme: scheme });
    page.on("pageerror", (e) => errors.push(`popup ${name}: ${e.message}`));
    await page.addInitScript(({ s, version }) => {
      const tab = { id: 1, url: "https://careers.example.com/jobs/backend-engineer" };
      const reply = (m) => {
        switch (m.type) {
          case "status": return s.status;
          case "pageState": return s.page ? { state: s.page } : new Promise(() => {});
          case "queue": return s.queue;
          case "fillTab": return s.fill;
          case "reviewFields": return s.review;
          case "storageState": case "storageSync": return s.storage || { connected: true, mode: "local", ready: false, cv: null, workday: false, ai: null };
          default: return null;
        }
      };
      window.chrome = {
        runtime: { getManifest: () => ({ version }), openOptionsPage() {}, sendMessage: async (m) => reply(m), onMessage: { addListener() {} } },
        tabs: { query: async () => [tab], create() {} },
        permissions: { contains: async () => !s.ask, request: async () => true, remove: async () => true },
        storage: {
          local: { get: async () => (s.storage && s.storage.workday ? { workday: { password: "Xk7!mP2#qR9$wT4&" } } : {}), set: async () => {}, remove: async () => {} },
          session: { get: async () => (s.session ? { "filled:1": { url: tab.url, frameId: 0, ...s.session } } : {}), set: async () => {} },
          onChanged: { addListener() {} },
        },
      };
    }, { s, version });
    await page.goto(pathToFileURL(path.join(ext, "popup.html")).href);
    await page.waitForTimeout(400);
    if (s.openQueue) await page.evaluate(() => { document.getElementById("queue-box").open = true; });
    if (s.click) { await page.click("#fill"); await page.waitForTimeout(300); }
    for (const sel of s.clicks || []) { await page.click(sel); await page.waitForTimeout(300); }
    const file = `popup-${String(POPUP.findIndex(([n]) => n === name) + 1).padStart(2, "0")}-${name}-${scheme}.png`;
    await page.screenshot({ path: path.join(out, file), fullPage: true });
    shots.push(file);
    await page.close();
  }
}

// The in-page card, on a careers page and on a Greenhouse page.
const FORM = (title) => `<!doctype html><html><head><title>${title}</title><style>body{font:16px system-ui;margin:40px;max-width:640px;color:#222;background:#fff}label{display:block;margin-top:14px}input{display:block;width:100%;padding:8px}</style></head><body>
<h1>${title}</h1><p>Tel Aviv · Full time</p><form><label>First name<input name="first_name" required></label><label>Last name<input name="last_name" required></label>
<label>Email<input name="email" type="email" required></label><label>Phone<input name="phone" type="tel"></label>
<label>Resume/CV<input name="resume" type="file"></label><button type="submit">Submit application</button></form></body></html>`;
const GENERIC = "https://careers.example.com/jobs/backend-engineer";
const GREENHOUSE = "https://job-boards.greenhouse.io/acme/jobs/4012345";
const CARD = [
  ["fill-offer", { url: GENERIC, offer: { show: true, assist: true } }],
  ["closed-to-button", { url: GENERIC, offer: { show: true, assist: true }, steps: ["close"] }],
  ["filled-submit-here", { url: GENERIC, offer: { show: true, assist: true }, fill: { ...FILLED, submit: true }, steps: ["go"] }],
  ["filled-bot-check", { url: GENERIC, offer: { show: true, assist: true }, fill: { ...FILLED, botCheck: true }, steps: ["go"] }],
  ["filled-submit-on-page", { url: GENERIC, offer: { show: true, assist: true }, fill: { ...FILLED, missing: [], suggested: 0 }, steps: ["go"] }],
  ["submitted", { url: GENERIC, offer: { show: true, assist: true }, fill: { ...FILLED, submit: true }, submit: { submitted: true }, steps: ["go", "go"] }],
  ["not-confirmed", { url: GENERIC, offer: { show: true, assist: true }, fill: { ...FILLED, submit: true }, submit: { unknown: true }, steps: ["go", "go"] }],
  ["not-submitted", { url: GENERIC, offer: { show: true, assist: true }, fill: { ...FILLED, submit: true }, submit: { failed: "submit button not found" }, steps: ["go", "go"] }],
  ["fill-error", { url: GENERIC, offer: { show: true, assist: true }, fill: { error: "no CV saved in the extension" }, steps: ["go"] }],
  ["not-connected", { url: GENERIC, offer: { show: true, blocked: T.NOT_CONNECTED, action: { label: "Connect account", url: T.ACCOUNT_URL } } }],
  ["connection-expired", { url: GENERIC, offer: { show: true, blocked: T.EXPIRED, action: { label: "Connect account", url: T.ACCOUNT_URL } } }],
  ["no-cv", { url: GENERIC, offer: { show: true, assist: true, blocked: T.NO_CV, action: { label: "Add CV", options: true } } }],
  ["greenhouse-offer", { url: GREENHOUSE, offer: { show: true, remaining: 46 } }],
  ["greenhouse-filled", { url: GREENHOUSE, offer: { show: true, remaining: 46 }, fill: FILLED, steps: ["go"] }],
  ["greenhouse-source-off", { url: GREENHOUSE, offer: { show: true, blocked: SOURCES_OFF, action: { label: "Open Auto apply", url: T.ACCOUNT_URL } } }],
  ["greenhouse-already-applied", { url: GREENHOUSE, offer: { show: true, blocked: T.ALREADY } }],
  ["greenhouse-account-unreachable", { url: GREENHOUSE, offer: { show: true, blocked: T.UNREACHABLE } }],
];
const SCRIPTS = ["lib/match.js", "ats/greenhouse.js", "ats/ashby.js", "ats/workable.js", "ats/generic.js", "detect.js"].map((f) => fs.readFileSync(path.join(ext, f), "utf8"));

for (const scheme of ["dark", "light"]) {
  for (const [name, s] of CARD) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 640 }, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`card ${name}: ${e.message}`));
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: FORM(s.url === GREENHOUSE ? "Senior Backend Engineer" : "Backend Engineer") }));
    await page.addInitScript(({ s, icon }) => {
      // Open, so the test can press the card's buttons.
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function () { return attach.call(this, { mode: "open" }); };
      const reply = (m) => {
        switch (m.type) {
          case "hidden": return false;
          case "icon": return icon;
          case "offerHere": return s.offer;
          case "fillHere": return s.fill;
          case "submitHere": return s.submit;
          case "startSubmit": return { ok: true };
          default: return null;
        }
      };
      // A real reply arrives a task later, never in the same click.
      window.chrome = { runtime: { id: "x", sendMessage: (m) => new Promise((r) => setTimeout(() => r(reply(m)), 30)), onMessage: { addListener() {} }, getURL: (p) => p } };
    }, { s, icon });
    await page.goto(s.url);
    for (const js of SCRIPTS) await page.addScriptTag({ content: js });
    const host = page.locator("[data-ooj-fill]");
    await host.waitFor({ timeout: 15000 }).catch(() => errors.push(`card ${name}: no card`));
    await page.waitForTimeout(500);
    for (const step of s.steps || []) {
      await page.locator(`[data-ooj-fill] >> css=${step === "close" ? ".x" : ".go"}`).click().catch((e) => errors.push(`card ${name}: ${e.message.split("\n")[0]}`));
      await page.waitForTimeout(500);
    }
    const file = `card-${String(CARD.findIndex(([n]) => n === name) + 1).padStart(2, "0")}-${name}-${scheme}.png`;
    // The card with some of the page around it, as the user sees it.
    const box = await host.boundingBox();
    if (box) {
      const inner = await page.evaluate(() => { const r = document.querySelector("[data-ooj-fill]").shadowRoot.querySelector(".c:not([hidden]), .fab:not([hidden])").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      await page.screenshot({ path: path.join(out, file), clip: { x: inner.x - 24, y: Math.max(0, inner.y - 16), width: inner.width + 40, height: inner.height + 40 } });
      shots.push(file);
    }
    if (name === "fill-offer") {
      await page.screenshot({ path: path.join(out, `card-00-on-a-careers-page-${scheme}.png`) });
      shots.push(`card-00-on-a-careers-page-${scheme}.png`);
    }
    await ctx.close();
  }
}
await browser.close();

// The settings page, from the real build: empty, then filled in.
const pdf = "%PDF-1.4\n%%EOF";
for (const filled of [false, true]) {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ui-tour-")), {
    channel: "chromium", headless: true, deviceScaleFactor: 2, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  await sw.evaluate(async ({ filled, pdf }) => {
    await chrome.alarms.clearAll();
    if (filled) await chrome.storage.local.set({ token: "ooj_test.0.x", cv: { name: "Dana_Levi_CV.pdf", type: "application/pdf", size: 188416, data: btoa(pdf) },
      ai: { provider: Object.keys(globalThis.oojProviders || { anthropic: 1 })[0], key: "sk-test-0000000000", model: "" }, workday: { password: "Xk7!mP2#qR9$wT4&" } });
  }, { filled, pdf });
  const id = sw.url().split("/")[2];
  for (const scheme of ["dark", "light"]) {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`options: ${e.message}`));
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 760, height: 900 });
    await page.goto(`chrome-extension://${id}/options.html`);
    await page.waitForTimeout(700);
    const file = `settings-${filled ? "2-filled-in" : "1-empty"}-${scheme}.png`;
    await page.screenshot({ path: path.join(out, file), fullPage: true });
    shots.push(file);
    await page.close();
  }
  await ctx.close();
}

console.log(`version ${version}, ${shots.length} shots in ${out}`);
console.log(errors.length ? "errors:\n" + errors.join("\n") : "no page errors");
