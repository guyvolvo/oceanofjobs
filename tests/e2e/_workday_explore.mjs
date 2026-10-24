// Walks a live Workday posting up to its sign-in page, printing the
// data-automation-id controls each step shows. Every write is aborted, so
// no account and no application is ever created.
//   node tests/e2e/_workday_explore.mjs <job url> [out dir]
import { chromium } from "playwright";
const [url, out = "."] = process.argv.slice(2);
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) || /\/wday\/cxs\/.*\/jobs$|\/wday\/cxs\/.*\/job\//.test(r.request().url())
  ? r.continue() : (console.log("blocked", r.request().method(), r.request().url().slice(0, 120)), r.abort())));
const dump = async (tag) => {
  const ids = await page.evaluate(() => [...document.querySelectorAll("[data-automation-id]")].filter((e) => e.checkVisibility())
    .map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute("data-automation-id")}]${e.type ? ":" + e.type : ""} ${(e.innerText || e.value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").slice(0, 60)}`));
  console.log(`\n== ${tag} ${page.url()}\n` + [...new Set(ids)].slice(0, 80).join("\n"));
  await page.screenshot({ path: `${out}/wd-${tag}.png` });
};
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await dump("posting");
const apply = page.locator('[data-automation-id="adventureButton"], a[data-uxi-element-id="Apply_adventureButton"]').first();
await apply.click();
await page.waitForTimeout(3000);
await dump("after-apply");
const manual = page.locator('[data-automation-id="applyManually"]').first();
if (await manual.count()) { await manual.click(); await page.waitForTimeout(4000); await dump("after-manual"); }
const byEmail = page.locator('[data-automation-id="SignInWithEmailButton"]').first();
if (await byEmail.count()) { await byEmail.click(); await page.waitForTimeout(2500); await dump("sign-in-email"); }
const create = page.locator('[data-automation-id="createAccountLink"]').first();
if (await create.count()) { await create.click(); await page.waitForTimeout(2500); await dump("create-account"); }
await b.close();
