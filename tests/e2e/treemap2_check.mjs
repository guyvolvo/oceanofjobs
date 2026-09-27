import { chromium } from "playwright";
const browser = await chromium.launch();
for (const [name, path, theme, vw] of [["all-light", "/board", "light", 1440], ["il-light", "/board?country=IL", "light", 1440], ["il-dark", "/board?country=IL", "dark", 1440], ["il-narrow", "/board?country=IL", "light", 1180]]) {
  const page = await browser.newPage({ viewport: { width: vw, height: 900 } });
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((t) => { localStorage.setItem("iljobs_theme", t); localStorage.setItem("iljobs_geo_asked", "1"); }, theme);
  await page.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/app.js", contentType: "application/javascript" }));
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  await page.goto("https://oceanofjobs.com" + path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tree-cell", { timeout: 30000 }); await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".tree-cell")].map((c) => { const b = c.getBoundingClientRect(); return { n: c.querySelector(".tree-name").innerText, w: Math.round(b.width), h: Math.round(b.height), bg: getComputedStyle(c).backgroundColor, logo: !!c.querySelector(".tree-logo"), clip: c.querySelector(".tree-name").scrollWidth > c.querySelector(".tree-name").clientWidth + 1 && !c.querySelector(".tree-ellipsis") }; });
    return { cells, nav: getComputedStyle(document.querySelector(".topbar-nav a")).fontSize, login: (document.querySelector("#auth-trigger") ? getComputedStyle(document.querySelector("#auth-trigger")).fontSize : "-") };
  });
  const small = r.cells.filter((c) => c.w < 70 || c.h < 54);
  console.log(`${name}: ${r.cells.length} tiles, under 72x56: ${small.length}, nav ${r.nav} login ${r.login}, errors ${errs.length}`);
  console.log("   ", r.cells.map((c) => `${c.n.slice(0, 14)} ${c.w}x${c.h}${c.logo ? " L" : ""}`).join(" | "));
  console.log("    overflowing names:", r.cells.filter((c) => c.clip).map((c) => c.n).join(", ") || "none"); console.log("    colours:", [...new Set(r.cells.map((c) => c.bg))].slice(0, 4).join(" "));
  await page.locator(".ov-tree").screenshot({ path: `treemap2-${name}.png` });
  if (name === "il-light") { await page.click("[data-tree-company]"); await page.waitForTimeout(2000); console.log("    click ->", new URL(page.url()).searchParams.get("company")); }
  await page.close();
}
await browser.close();
