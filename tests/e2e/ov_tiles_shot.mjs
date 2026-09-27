// The overview tiles with trends, working copy frontend over the live
// API, whole board and Israel, light and dark. node tests/e2e/ov_tiles_shot.mjs
import { chromium } from "playwright";
const browser = await chromium.launch();
for (const [name, path, theme] of [["all-light", "/board", "light"], ["il-dark", "/board?country=IL", "dark"], ["il-light", "/board?country=IL", "light"]]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((t) => { localStorage.setItem("iljobs_theme", t); localStorage.setItem("iljobs_geo_asked", "1"); }, theme);
  await page.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/app.js", contentType: "application/javascript" }));
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  await page.goto("https://oceanofjobs.com" + path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ov-delta", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const t = await page.$$eval(".ov-tile", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
  console.log(name, t);
  await (await page.$(".ov-tiles")).screenshot({ path: `ov-tiles-${name}.png` });
  await page.close();
}
await browser.close();
