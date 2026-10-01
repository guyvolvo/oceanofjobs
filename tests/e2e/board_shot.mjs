// Screenshots of the board (board.html) served by scripts/live_preview.py
// at several widths, with page errors and a few layout facts printed.
import { chromium } from "playwright";
const base = process.env.BASE || "http://localhost:8010";
const b = await chromium.launch();
const errors = [];
for (const [w, h] of [[1440, 900], [1100, 900], [800, 900], [390, 844]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  p.on("pageerror", (e) => errors.push(`${w}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${w} console: ${m.text().slice(0, 140)}`); });
  await p.addInitScript(() => { localStorage.setItem("iljobs_geo_asked", "1"); localStorage.setItem("iljobs_theme", "dark"); });
  await p.goto(base + "/board", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => !document.querySelector("#jobs-body tr.skeleton-row") && document.querySelectorAll("#jobs-body tr[data-id]").length > 0, null, { timeout: 30000 }).catch(() => errors.push(`${w}: no rows`));
  await p.waitForTimeout(1200);
  const facts = await p.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    side: Math.round(document.querySelector("#site-side").getBoundingClientRect().width),
    sideOnScreen: document.querySelector("#site-side").getBoundingClientRect().right > 0,
    pills: [...document.querySelectorAll(".board-pills .rail-acc")].filter((x) => x.offsetParent !== null).length,
    cats: document.querySelectorAll("#side-cats .side-cat").length,
    count: document.querySelector("#result-count")?.textContent.trim(),
    rowH: Math.round(document.querySelector("#jobs-body tr[data-id]")?.getBoundingClientRect().height || 0),
    menuBtn: getComputedStyle(document.querySelector("#side-open")).display,
    corner: getComputedStyle(document.querySelector(".board-corner")).display,
    authIn: document.getElementById("auth-area")?.parentElement.className,
  }));
  console.log(w, JSON.stringify(facts));
  await p.screenshot({ path: `tests/e2e/board-${w}.png` });
  if (w === 390) {
    await p.click("#side-open"); await p.waitForTimeout(400);
    await p.screenshot({ path: "tests/e2e/board-390-drawer.png" });
    await p.click("#side-scrim", { position: { x: 380, y: 400 } }).catch(() => {}); await p.waitForTimeout(300);
    await p.click('.rail-acc[data-acc="work"] .rail-acc-head'); await p.waitForTimeout(500);
    await p.screenshot({ path: "tests/e2e/board-390-pill.png" });
  }
  if (w === 1440) {
    await p.click('.rail-acc[data-acc="place"] .rail-acc-head'); await p.waitForTimeout(500);
    await p.screenshot({ path: "tests/e2e/board-1440-pill.png" });
    await p.keyboard.press("Escape"); await p.waitForTimeout(300);
    await p.click("#jobs-body tr[data-id] .main-cell"); await p.waitForTimeout(1500);
    await p.screenshot({ path: "tests/e2e/board-1440-open.png" });
  }
  await p.close();
}
await b.close();
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
