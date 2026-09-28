// The homepage stats tile: numbers fill in, both logo rows move in
// opposite directions, the three links go where they say, and the tile
// holds together on desktop, in dark mode and on a phone.
import { chromium } from "playwright";
const browser = await chromium.launch();
const LOCAL = ["style.css", "img/stats-tile-blur.webp", "fonts/Geist-400-latin.woff2", "fonts/Geist-500-latin.woff2"];
async function open(viewport, dark) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  if (dark) await page.addInitScript(() => localStorage.setItem("iljobs_theme", "dark"));
  await page.route(/^https:\/\/oceanofjobs\.com\/(\?.*)?$/, (r) => r.fulfill({ path: "../../frontend/index.html", contentType: "text/html" }));
  for (const f of LOCAL) await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ path: `../../frontend/${f}` }));
  await page.goto("https://oceanofjobs.com/", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  return page;
}
{
  const page = await open({ width: 1440, height: 900 });
  const tile = page.locator(".stats-tile");
  const box = await tile.boundingBox();
  const pos = () => page.evaluate(() => ["ticker-logos-a", "ticker-logos-b"].map((id) => new DOMMatrix(getComputedStyle(document.getElementById(id)).transform).m41.toFixed(0)));
  const p1 = await pos(); await page.waitForTimeout(1000); const p2 = await pos();
  console.log("tile", Math.round(box.width), "x", Math.round(box.height),
    "| numbers:", await page.evaluate(() => ["st-open", "st-remote", "st-companies"].map((id) => document.getElementById(id).textContent).join(" / ")),
    "| rows moved:", p1.join(","), "->", p2.join(","),
    "| logos:", await page.locator(".hero-logo img").count());
  console.log("links:", await page.evaluate(() => [...document.querySelectorAll(".stats-tile-nums a")].map((a) => `${a.textContent.trim()} -> ${a.getAttribute("href")}`).join(" | ")));
  await tile.screenshot({ path: "stats-tile-desktop.png" });
  await page.close();
}
{
  const page = await open({ width: 1440, height: 900 }, true);
  await page.locator(".stats-tile").screenshot({ path: "stats-tile-dark.png" });
  await page.close();
}
{
  const page = await open({ width: 390, height: 844 });
  await page.locator(".stats-tile").screenshot({ path: "stats-tile-phone.png" });
  console.log("phone overflow:", await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await page.close();
}
await browser.close();
