// The overview treemap, working copy over the live site: light and dark,
// whole board and Israel, plus a click filtering to a company.
import { chromium } from "playwright";
const browser = await chromium.launch();
for (const [name, path, theme] of [["all-light", "/board", "light"], ["il-dark", "/board?country=IL", "dark"], ["il-light", "/board?country=IL", "light"]]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((t) => { localStorage.setItem("iljobs_theme", t); localStorage.setItem("iljobs_geo_asked", "1"); }, theme);
  await page.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/app.js", contentType: "application/javascript" }));
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  await page.goto("https://oceanofjobs.com" + path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tree-cell", { timeout: 30000 });
  await page.waitForTimeout(2500);
  const cells = await page.$$eval(".tree-cell", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return `${e.dataset.company} ${Math.round(r.width)}x${Math.round(r.height)}`; }));
  console.log(name, cells.length, "cells:", cells.slice(0, 4).join(", "), "... errors:", errs.length);
  await page.locator(".ov-tree").screenshot({ path: `treemap-${name}.png` });
  if (name === "il-light") {
    const first = await page.$eval(".tree-cell", (e) => e.dataset.company);
    await page.click(".tree-cell");
    await page.waitForTimeout(2500);
    console.log("click filters to", first, "->", new URL(page.url()).searchParams.get("company"));
  }
  await page.close();
}
await browser.close();
