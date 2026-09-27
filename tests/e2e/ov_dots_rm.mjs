// The loading dots with reduced motion on: still animating.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
await page.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/app.js", contentType: "application/javascript" }));
await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
await page.addInitScript(() => localStorage.setItem("iljobs_geo_asked", "1"));
await page.route((u) => u.pathname === "/api/stats" && u.search.includes("country="), () => new Promise(() => {}));
await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".ov-dots");
const samples = await page.evaluate(async () => {
  const out = [];
  for (let k = 0; k < 8; k++) {
    const e = document.querySelector(".ov-dots > i");
    out.push(e ? [getComputedStyle(e).animationName, getComputedStyle(e).animationDuration, Number(getComputedStyle(e).opacity).toFixed(2)] : null);
    await new Promise((r) => setTimeout(r, 200));
  }
  return out;
});
const ops = new Set(samples.filter(Boolean).map((x) => x[2]));
console.log("reduced motion:", samples.filter(Boolean)[0], "opacities seen:", [...ops].join(" "), "| animating:", ops.size > 2);
await browser.close();
