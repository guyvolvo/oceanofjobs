// Where the extension's fill card appears (detect.js), with access to every
// site: never on a checkout or sign-up form, still on application forms.
// Nothing is filled or sent; the card is only looked for.
//   node tests/e2e/_ext_card_where.mjs <dodo checkout url>
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const PAGES = [
  // [address, should the card show]
  [process.argv[2], false],
  ["https://jobs.lever.co/matchgroup/a5c7d9c1-c8ef-47d1-aef0-af6bc111ea6e/apply", true],
  ["https://job-boards.greenhouse.io/embed/job_app?for=appsflyer&token=8882905002", true],
].filter(([u]) => u);

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-where-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-where-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route("https://oceanofjobs.com/api/**", (r) => r.fulfill({ status: 401, json: { error: "signed out" } }));
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 2000));

let failed = 0;
for (const [url, want] of PAGES) {
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  // detect.js looks for 10 seconds.
  const got = await p.waitForSelector("[data-ooj-fill]", { state: "attached", timeout: 15000 }).then(() => true, () => false);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${new URL(url).hostname} card ${got ? "shown" : "not shown"} (want ${want ? "shown" : "none"})`);
  await p.close();
}
await ctx.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
