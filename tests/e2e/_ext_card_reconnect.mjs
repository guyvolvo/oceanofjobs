// The fill card on a job form, opened while signed out, changes by itself
// once the account connects in another tab: no reload, no toolbar click.
// Nothing is filled or sent.
//   node tests/e2e/_ext_card_reconnect.mjs
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const URL_ = "https://job-boards.greenhouse.io/embed/job_app?for=appsflyer&token=8882905002";
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-reconnect-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
// The test copy only: an open shadow root, so the card's text can be read.
const detect = path.join(ext, "detect.js");
fs.writeFileSync(detect, fs.readFileSync(detect, "utf8").replace("mode: 'closed'", "mode: 'open'"));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-reconnect-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
// Signed in answers for the account calls, so the card can move past Connect.
await ctx.route("https://oceanofjobs.com/api/**", (r) => {
  const u = r.request().url();
  if (u.includes("/me/apply/profile")) return r.fulfill({ json: { profile: { contact: { email: "a@b.c" }, settings: {} }, preferences: {} } });
  if (u.includes("/me/apply/summary")) return r.fulfill({ json: { plan: "free", remaining: 10, applied_today: 0 } });
  if (u.includes("/me/apply/history")) return r.fulfill({ json: { applied: [] } });
  if (u.includes("/me/storage")) return r.fulfill({ json: {} });
  return r.fulfill({ status: 200, json: {} });
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
// The state in the screenshot: a token that has expired.
await sw.evaluate(() => chrome.storage.local.set({ token: "old", authError: true }));

const p = await ctx.newPage();
await p.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForSelector("[data-ooj-fill]", { state: "attached", timeout: 20000 });
await p.waitForTimeout(1500);
const text = () => p.evaluate(() => document.querySelector("[data-ooj-fill]").shadowRoot.querySelector(".c").innerText);
const before = await text();
console.log("before:", before.replace(/\s+/g, " ").slice(0, 200));

// Connecting on oceanofjobs.com: connect.js writes exactly this.
await sw.evaluate(() => chrome.storage.local.set({ token: "new", authError: false }));
await p.waitForTimeout(2500);
const after = await text();
console.log("after:", after.replace(/\s+/g, " ").slice(0, 200));

const ok = /expired/i.test(before) && !/expired|Connect account/i.test(after);
console.log(ok ? "PASS: the card updated after connecting" : "FAIL");
await ctx.close();
process.exit(ok ? 0 : 1);
