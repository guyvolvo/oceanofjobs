// ats/workday.js on a live posting: enter() should reach the sign-in page,
// and account() should get as far as pressing Sign In, then Create Account.
// Every write is aborted, so Workday never sees a sign-in, no account is
// made and nothing is applied to.
//   node tests/e2e/_workday_enter.mjs <job url> [out dir]
import { chromium } from "playwright";
import path from "node:path";
const [url, out = "."] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../..");
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const writes = [];
await page.route("**/*", (r) => {
  const req = r.request();
  if (["GET", "HEAD", "OPTIONS"].includes(req.method()) || /\/wday\/cxs\/.*\/(jobs$|job\/)/.test(req.url())) return r.continue();
  writes.push(`${req.method()} ${new URL(req.url()).pathname.slice(0, 80)}`);
  return r.abort();
});
const load = async () => { for (const f of ["extension/lib/match.js", "extension/ats/generic.js", "extension/ats/workday.js"]) await page.addScriptTag({ path: path.join(root, f) }); };
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await load();
// As the run does: a navigation ends the script, so load it again and ask again.
let r = null;
for (let i = 0; i < 4 && !r; i++) {
  r = await page.evaluate(() => globalThis.oojAts.workday.enter()).catch(() => null);
  if (!r) { await page.waitForLoadState("networkidle").catch(() => {}); await load(); }
}
console.log("enter:", JSON.stringify(r), page.url());
await page.screenshot({ path: `${out}/wd-enter.png` });
const acct = await page.evaluate(() => globalThis.oojAts.workday.account("test.person@example.com", "Aa1!aaaaaaaa")).catch((e) => ({ threw: e.message }));
console.log("account:", JSON.stringify(acct));
console.log("after:", JSON.stringify(await page.evaluate(() => {
  const q = (id) => document.querySelector(`[data-automation-id="${id}"]`);
  const box = q("createAccountCheckbox");
  return { checked: box && box.checked, ariaChecked: box && box.getAttribute("aria-checked"),
    errors: [...document.querySelectorAll('[data-automation-id="errorMessage"], [role="alert"], [aria-invalid="true"]')].map((e) => (e.innerText || e.getAttribute("data-automation-id") || e.id).slice(0, 80)),
    submit: q("createAccountSubmitButton") && q("createAccountSubmitButton").outerHTML.slice(0, 200),
    filter: q("createAccountSubmitButton") && q("createAccountSubmitButton").parentElement.outerHTML.slice(0, 400) };
})));
console.log("pinned form area:", await page.evaluate(() => !!document.querySelector("[data-ooj-root]")));
console.log("beecatcher touched:", await page.evaluate(() => [...document.querySelectorAll('[data-automation-id="beecatcher"]')].some((e) => e.value)));
await page.screenshot({ path: `${out}/wd-account.png` });
console.log("writes aborted:", writes.filter((w) => !/collect|analytics|linkedin/.test(w)));
await b.close();
