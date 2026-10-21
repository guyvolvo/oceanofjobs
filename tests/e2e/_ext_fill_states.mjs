// 1.8.91's fill button: what it says before a click (pageState), a fill,
// then "Review filled fields" stepping through what needs attention
// (reviewFields), and the popup's labels for each. Local pages only, our
// API stubbed, nothing leaves the browser and nothing is submitted.
// Run from the repo root: node tests/e2e/_ext_fill_states.mjs
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : "  -- " + detail}`); if (!ok) failures.push(name); };

// A test cannot press the toolbar button that grants activeTab, so a copy
// of the extension gets host access to every site instead.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-states-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-states-profile-")), {
  channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

const FORM = `<!doctype html><html><head><title>Backend Engineer at Example</title></head><body>
<h1>Backend Engineer</h1><form id="application">
<label for="first_name">First name</label><input id="first_name" name="first_name" required>
<label for="last_name">Last name</label><input id="last_name" name="last_name" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="why">Why do you want to work here?</label><textarea id="why" name="why" required></textarea>
<label for="clearance">Security clearance number</label><input id="clearance" name="clearance" required>
<button type="submit">Submit application</button></form></body></html>`;
const PLAIN = `<!doctype html><html><head><title>About us</title></head><body><h1>About Example</h1><p>We make things.</p></body></html>`;

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: "test.person@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: {}, work: { authorized_countries: ["IL"], needs_sponsorship: false }, eeo: {}, answers: [],
  settings: { mode: "queue", sources: ["board"], unknowns: "ai", guardrails: {} },
};
await ctx.route("**/*", (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "careers.example.test") return r.fulfill({ contentType: "text/html", body: u.pathname === "/apply" ? FORM : PLAIN });
  if (u.hostname === "oceanofjobs.com") {
    if (u.pathname === "/api/me/apply/profile") return r.fulfill({ json: { profile, preferences: { skills: [] } } });
    if (u.pathname === "/api/me/apply/usage" || u.pathname === "/api/me/apply/summary") return r.fulfill({ json: { plan: "pro", period: "day", limit: 50, used: 0, remaining: 50 } });
    if (u.pathname === "/api/me/apply/history") return r.fulfill({ json: { applied: [] } });
    // The AI drafts the "why" question and declines the clearance number,
    // so one field is suggested and one stays required and empty.
    if (u.pathname === "/api/me/apply/draft") {
      const q = req.postDataJSON().question || "";
      // As the server does when the profile can't answer: 422.
      return /clearance/i.test(q) ? r.fulfill({ status: 422, json: { error: "your profile doesn't answer this question" } })
        : r.fulfill({ json: { answer: "I like the team's work on open source." } });
    }
    return r.fulfill({ status: 204, body: "" });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) return r.abort();
  return r.continue();
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(async () => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "cv.pdf", type: "application/pdf", size: 4, data: btoa("%PDF") } });
  await chrome.alarms.clearAll();
});

const formPage = await ctx.newPage();
await formPage.goto("https://careers.example.test/apply");
const plainPage = await ctx.newPage();
await plainPage.goto("https://careers.example.test/about");
const blankPage = await ctx.newPage();
await blankPage.goto("about:blank");

const tabOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
const formTab = await tabOf("https://careers.example.test/apply");
const state = (tabId) => sw.evaluate((id) => pageState(id), tabId);

check("a page with a form offers a fill", (await state(formTab)) === "form");
check("a page without one says none", (await state(await tabOf("https://careers.example.test/about"))) === "none");
// The extension is never told a browser page's address; it was opened last.
const blankTab = await sw.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((t) => t.id)));
check("a browser page is not supported", (await state(blankTab)) === "unsupported");

const fill = await sw.evaluate((id) => fillTab(id), formTab);
check("the fill reports one suggested and one missing", fill && fill.suggested === 1 && fill.missing.length === 1, JSON.stringify(fill));
check("the fill names its frame", fill && fill.frameId === 0);
check("nothing was submitted", await formPage.evaluate(() => location.pathname === "/apply"));

const step1 = await sw.evaluate((id) => reviewFields(id, 0), formTab);
const focus1 = await formPage.evaluate(() => document.activeElement && document.activeElement.id);
check("review goes to the required empty field first", step1.kind === "required" && step1.index === 1 && step1.left === 2 && focus1 === "clearance",
  JSON.stringify(step1) + " focus " + focus1);
const step2 = await sw.evaluate((id) => reviewFields(id, 0), formTab);
const focus2 = await formPage.evaluate(() => document.activeElement && document.activeElement.id);
check("then to the AI's answer", step2.kind === "ai" && step2.index === 2 && focus2 === "why", JSON.stringify(step2) + " focus " + focus2);
await formPage.fill("#clearance", "12345");
const step3 = await sw.evaluate((id) => reviewFields(id, 0), formTab);
check("a required field filled by the user drops out", step3.left === 1 && step3.kind === "ai", JSON.stringify(step3));

// The popup: its tab query points at the form tab, as the real popup's would.
const id = new URL(sw.url()).host;
const popup = await ctx.newPage();
await popup.addInitScript((tab) => {
  const real = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (q) => (q && q.active ? [await chrome.tabs.get(tab)] : real(q));
}, formTab);
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.waitForFunction(() => document.getElementById("fill").textContent !== "Checking this page…", null, { timeout: 15000 });
check("the popup offers Fill application on the form", (await popup.textContent("#fill")) === "Fill application", await popup.textContent("#fill"));
check("the status line has no 15-minute sentence", !/15 minutes/.test(await popup.textContent("#state")), await popup.textContent("#state"));
await popup.click("#fill");
await popup.waitForFunction(() => !["Filling application…", "Fill application"].includes(document.getElementById("fill").textContent), null, { timeout: 30000 });
check("after the fill it offers Review filled fields", (await popup.textContent("#fill")) === "Review filled fields", await popup.textContent("#fill"));
await popup.click("#fill");
await popup.waitForTimeout(500);
check("review says what the field is", /to check\./.test(await popup.textContent("#fill-result")), await popup.textContent("#fill-result"));
await popup.reload();
await popup.waitForFunction(() => document.getElementById("fill").textContent !== "Checking this page…", null, { timeout: 15000 });
check("reopening the popup remembers the fill", (await popup.textContent("#fill")) === "Review filled fields", await popup.textContent("#fill"));

await ctx.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
