// Signs in to a company's Workday site with guyvoloshin@gmail.com and
// WORKDAY_TEST_PASSWORD from .env (never printed), and prints what Workday
// says. Only the sign-in itself is let through.
//   node tests/e2e/_workday_signin.mjs <job url> [out.png]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const [url, shot] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../..");
const password = (/^WORKDAY_TEST_PASSWORD=(.*)$/m.exec(fs.readFileSync(path.join(root, ".env"), "utf8")) || [])[1];
const b = await chromium.launch({ channel: "chromium" });
const page = await (await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" })).newPage();
await page.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) || /\/login$|\/wday\/cxs\//.test(new URL(r.request().url()).pathname) ? r.continue() : r.abort()));
page.on("response", async (res) => {
  if (!/\/login$/.test(new URL(res.url()).pathname) || res.request().method() !== "POST") return;
  const body = await res.text().catch(() => "");
  console.log("login answered:", res.status(), body.replace(/"password"\s*:\s*"[^"]*"/g, '"password":"***"').slice(0, 600));
});
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.locator('[data-automation-id="adventureButton"]').first().click();
await page.locator('[data-automation-id="applyManually"]').first().click();
await page.locator('[data-automation-id="SignInWithEmailButton"]').first().click();
await page.locator('[data-automation-id="email"]').fill("guyvoloshin@gmail.com");
await page.locator('[data-automation-id="password"]').fill(password);
await page.locator('[data-automation-id="signInSubmitButton"]').locator("..").locator('[data-automation-id="click_filter"]').click();
await page.waitForTimeout(8000);
console.log("at:", page.url());
console.log("says:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700));
if (shot) await page.screenshot({ path: shot });
await b.close();
