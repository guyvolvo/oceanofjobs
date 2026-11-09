// A page that redraws its whole document after the card appears (React
// hydrating Greenhouse's page) used to drop the card for good. It must come
// back. A local page, the API answered locally; nothing is filled or sent.
//   node tests/e2e/_ext_card_survives_redraw.mjs
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const URL_ = "https://job-boards.greenhouse.io/redraw-test/jobs/1";
const PAGE = `<!doctype html><html><head><title>Engineer</title></head><body><h1>Engineer</h1>
<form><label>First name <input name="first_name"></label><label>Email <input type="email" name="email"></label>
<label>Phone <input type="tel" name="phone"></label><label>Resume <input type="file" name="resume"></label>
<button type="submit">Submit application</button></form>
<script>
  // What a React root on the document does on a hydration error: the whole
  // tree is rebuilt, and anything a script added to it is gone.
  setTimeout(() => { for (const el of document.querySelectorAll('[data-ooj-fill]')) el.remove(); document.body.innerHTML = document.body.innerHTML; }, 2500);
</script></body></html>`;

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-redraw-"));
fs.cpSync(path.resolve(process.env.EXT || "extension"), ext, { recursive: true });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-redraw-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route("https://job-boards.greenhouse.io/**", (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
await ctx.route("https://oceanofjobs.com/**", (r) => {
  const u = r.request().url();
  if (u.includes("/me/apply/profile")) return r.fulfill({ json: { profile: { contact: { email: "a@b.c" }, settings: {} }, preferences: {} } });
  if (u.includes("/me/apply/summary")) return r.fulfill({ json: { plan: "free", remaining: 10, applied_today: 0 } });
  if (u.includes("/me/apply/history")) return r.fulfill({ json: { applied: [] } });
  return r.fulfill({ status: 200, json: {} });
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(() => chrome.storage.local.set({ token: "t", authError: false }));

const p = await ctx.newPage();
await p.goto(URL_, { waitUntil: "domcontentloaded" });
await p.waitForSelector("[data-ooj-fill]", { state: "attached", timeout: 15000 });
await p.waitForTimeout(2600); // the page has now removed it
await p.waitForTimeout(2000);
const back = await p.evaluate(() => document.querySelectorAll("[data-ooj-fill]").length);
console.log({ cardsAfter: back });
const ok = back === 1;
console.log(ok ? "PASS: the card comes back after the page redraws, once" : "FAIL: the card is gone after the page redrew");
await ctx.close();
process.exit(ok ? 0 : 1);
