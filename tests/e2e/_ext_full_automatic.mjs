// Fill application in Half and Full automatic, on a local test form: the
// page and the account are Playwright routes, so nothing reaches a real
// employer or oceanofjobs.com (the test copy's API address is .invalid). The form's Submit only counts the press.
//   node tests/e2e/_ext_full_automatic.mjs
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// A host the card runs on with no dedicated filler (manifest content_scripts).
const PAGE = "https://careers.checkpoint.com/jobs/1234/apply";
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-full-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
// The test copy only: an open shadow root, so the card's text can be read.
const detect = path.join(ext, "detect.js");
fs.writeFileSync(detect, fs.readFileSync(detect, "utf8").replace("mode: 'closed'", "mode: 'open'"));
// And an API address that resolves nowhere: if a route ever missed, the
// call fails instead of reaching oceanofjobs.com.
const API = "https://ooj-test.invalid/api";
const bg = path.join(ext, "background.js");
fs.writeFileSync(bg, fs.readFileSync(bg, "utf8").replace("const API = 'https://oceanofjobs.com/api';", `const API = '${API}';`));

const form = (captcha) => `<!doctype html><html><head><title>Software Engineer - Apply</title>
${captcha ? '<script src="https://www.google.com/recaptcha/api.js?render=x"></script>' : ""}</head>
<body><h1>Software Engineer</h1>
<form id="f">
  <label for="first">First name</label><input id="first" name="first_name" required>
  <label for="last">Last name</label><input id="last" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="cv">Resume</label><input id="cv" name="resume" type="file">
  <button type="submit">Submit application</button>
</form>
<script>
  window.submits = 0;
  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();
    window.submits++;
    document.body.insertAdjacentHTML("beforeend", "<h2>Thank you for applying</h2>");
  });
</script></body></html>`;

const state = { fill: "half", plan: "pro", captcha: false, calls: [] };
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-full-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const stray = [];
await ctx.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith(PAGE)) return r.fulfill({ contentType: "text/html", body: form(state.captcha) });
  if (u.startsWith(API + "/")) {
    const at = u.slice(API.length);
    const body = r.request().postDataJSON?.() ?? null;
    state.calls.push({ at, body });
    if (at.startsWith("/me/apply/profile")) {
      return r.fulfill({ json: { profile: { contact: { first_name: "Dana", last_name: "Levi", email: "dana@example.com", phone: "", location: "" },
        links: {}, work: {}, eeo: {}, answers: [],
        settings: { mode: "queue", fill: state.fill, sources: ["ats_pages"], unknowns: "skip", guardrails: { blocked_companies: [] } } }, preferences: {} } });
    }
    if (at.startsWith("/me/apply/summary")) return r.fulfill({ json: { plan: state.plan, period: "day", remaining: 5, applied_today: 0 } });
    if (at.startsWith("/me/apply/history")) return r.fulfill({ json: { applied: [] } });
    if (/\/submission-started$/.test(at)) return r.fulfill({ json: { submit: true, attempt: {} } });
    if (at === "/me/apply/attempts") return r.fulfill({ json: { attempt: { attempt_id: body.attempt_id, state: "reserved" } } });
    return r.fulfill({ json: {} });
  }
  // Anything else (the reCAPTCHA script, fonts) never leaves the machine.
  stray.push(u);
  return r.fulfill({ status: 204, body: "" });
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(() => chrome.storage.local.set({ token: "test", authError: false, paused: true,
  cv: { name: "cv.pdf", type: "application/pdf", data: "JVBERi0xLjQK" } }));

async function scenario(name, set, want, press = false) {
  Object.assign(state, set, { calls: [] });
  const p = await ctx.newPage();
  await p.goto(PAGE, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("[data-ooj-fill]", { state: "attached", timeout: 20000 });
  const go = () => document.querySelector("[data-ooj-fill]").shadowRoot.querySelector(".go");
  const text = () => p.evaluate(() => document.querySelector("[data-ooj-fill]").shadowRoot.querySelector(".msg").innerText);
  await p.waitForFunction(() => document.querySelector("[data-ooj-fill]")?.shadowRoot?.querySelector(".go")?.textContent === "Fill application", null, { timeout: 15000 });
  await p.evaluate(`(${go})().click()`);
  // Filled, then (Full automatic) submitted: the button settles or goes.
  const settled = `(() => { const b = (${go})(); return b.hidden || !/Filling|Submitting/.test(b.textContent); })()`;
  await p.waitForFunction(settled, null, { timeout: 40000 });
  if (press) {
    // The user's own press on the card's Submit.
    await p.evaluate(`(${go})().click()`);
    await p.waitForFunction(`(${go})().hidden`, null, { timeout: 40000 });
  }
  await p.waitForTimeout(500);
  const msg = await text();
  const submits = await p.evaluate(() => window.submits);
  const gates = state.calls.filter((c) => /submission-started$/.test(c.at));
  const button = await p.evaluate(`(() => { const b = (${go})(); return b.hidden ? "(hidden)" : b.textContent; })()`);
  const ok = want(submits, gates, msg);
  const calls = state.calls.map((c) => c.at.replace(/[0-9a-f]{32}/, "<id>").replace(/\?.*/, "")).join(" ");
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}\n  card: ${msg}\n  button: ${button}; form submits: ${submits}; gate: ${gates.map((g) => g.body.mode).join(",") || "none"}\n  calls: ${calls}`);
  await p.screenshot({ path: path.join(os.tmpdir(), `ooj-full-${name.replace(/\W+/g, "-")}.png`) });
  await p.close();
  return ok;
}

const results = [
  await scenario("Half automatic fills and waits", { fill: "half", plan: "pro", captcha: false },
    (n, g, m) => n === 0 && g.length === 0 && /Review your answers, then submit the application here/.test(m)),
  await scenario("Half automatic, then the user presses Submit", { fill: "half", plan: "pro", captcha: false },
    (n, g, m) => n === 1 && g.length === 1 && g[0].body.mode === "card" && /Application submitted/.test(m), true),
  await scenario("Full automatic on Pro fills and submits once", { fill: "full", plan: "pro", captcha: false },
    (n, g, m) => n === 1 && g.length === 1 && g[0].body.mode === "auto" && /Application submitted/.test(m)),
  await scenario("Full automatic on Free fills and waits", { fill: "full", plan: "free", captcha: false },
    (n, g, m) => n === 0 && g.length === 0 && /Full automatic needs the Basic or Pro plan/.test(m)),
  await scenario("Full automatic with a reCAPTCHA script fills and waits", { fill: "full", plan: "pro", captcha: true },
    (n, g, m) => n === 0 && g.length === 0 && /requires you to submit the form yourself/.test(m)),
];
const strayHosts = [...new Set(stray.map((u) => new URL(u).host))];
console.log("requests answered locally instead of the network:", strayHosts.join(", ") || "none");
await ctx.close();
process.exit(results.every(Boolean) ? 0 : 1);
