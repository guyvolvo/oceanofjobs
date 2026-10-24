// Prints a live page's links and buttons that look like a way to apply,
// its form fields, and where its Apply control leads. GETs only.
//   node tests/e2e/_page_explore.mjs <url> [out.png]
import { chromium } from "playwright";
const [url, shot] = process.argv.slice(2);
const b = await chromium.launch({ channel: "chromium" });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" });
await page.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) ? r.continue() : r.abort()));
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => console.log("goto:", e.message.slice(0, 80)));
await page.waitForTimeout(2000);
console.log("at:", page.url(), "| title:", await page.title());
console.log(JSON.stringify(await page.evaluate(() => ({
  apply: [...document.querySelectorAll("a, button, [role=button]")].filter((e) => /apply|interested|candidat|bewerb|postul/i.test(e.innerText || e.getAttribute("aria-label") || "") && e.checkVisibility())
    .map((e) => `${e.tagName} "${(e.innerText || e.getAttribute("aria-label") || "").trim().slice(0, 40)}" ${e.href || ""}`).slice(0, 8),
  inputs: [...document.querySelectorAll("input, textarea, select")].filter((e) => e.type !== "hidden").length,
  frames: [...document.querySelectorAll("iframe")].map((f) => f.src.slice(0, 100)),
})), null, 1));
if (shot) await page.screenshot({ path: shot });
await b.close();
