// QA sweep of the redesign previews (board-next.html, companies-next.html)
// served by scripts/live_preview.py. Prints PASS/FAIL/NOTE lines and
// writes screenshots to tests/e2e/qa-*.png.
import { chromium } from "playwright";
const base = process.env.BASE || "http://localhost:8010";
const out = [];
const log = (kind, name, detail = "") => { out.push(`${kind} ${name}${detail ? "  -- " + detail : ""}`); console.log(out[out.length - 1]); };
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
const note = (name, detail = "") => log("NOTE", name, detail);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const failed = [];
function report() {
  console.log("");
  console.log("== page errors:");
  console.log(errors.length ? errors.join("\n") : "none");
  console.log("== failed requests (logos excluded):");
  console.log(failed.length ? [...new Set(failed)].slice(0, 20).join("\n") : "none");
  const fails = out.filter((l) => l.startsWith("FAIL")).length;
  console.log("");
  console.log(`${out.filter((l) => l.startsWith("PASS")).length} passed, ${fails} failed, ${out.filter((l) => l.startsWith("NOTE")).length} notes`);
}
process.on("uncaughtException", (e) => { console.log("CRASH " + String(e.message).split(/\r?\n/)[0]); report(); process.exit(1); });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { localStorage.setItem("iljobs_geo_asked", "1"); localStorage.setItem("iljobs_theme", "dark"); localStorage.setItem("iljobs_side_folded", "0"); });
const hook = (p, tag) => {
  p.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${tag} console: ${m.text().slice(0, 160)}`); });
  p.on("response", (r) => { const u = r.url(); if (r.status() >= 400 && !/\/api\/logo\//.test(u) && !/googletagmanager|buymeacoffee/.test(u)) failed.push(`${tag}: ${r.status()} ${u.replace(base, "")}`); });
};
const rows = (p) => p.$$eval("#jobs-body tr[data-id]", (e) => e.length);
const count = (p) => p.$eval("#result-count", (e) => e.textContent.trim());
const settle = async (p) => { await p.waitForFunction(() => !document.querySelector("#jobs-body tr.skeleton-row") && document.querySelectorAll("#jobs-body tr[data-id]").length > 0, null, { timeout: 30000 }).catch(() => {}); await wait(600); };

// ---- The board ----
const p = await ctx.newPage(); hook(p, "board");
const t0 = Date.now();
await p.goto(base + "/board", { waitUntil: "domcontentloaded" });
await settle(p);
note("board: time to first rows", `${Date.now() - t0}ms`);
check("board: rows render", (await rows(p)) >= 20, `${await rows(p)} rows`);
check("board: count line in list head", /\d/.test(await count(p)), await count(p));
check("board: no horizontal page overflow", await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
const rowH = await p.$$eval("#jobs-body tr[data-id]", (e) => e.slice(0, 10).map((r) => Math.round(r.getBoundingClientRect().height)));
check("board: rows are 84-100px", rowH.every((h) => h >= 80 && h <= 100), rowH.join(" "));
check("board: titles do not overflow their cell", await p.$$eval(".job-title-text", (e) => e.slice(0, 20).every((t) => t.getBoundingClientRect().right <= t.closest("td").getBoundingClientRect().right + 1)));

// Pills
const pills = await p.$$eval(".board-pills .rail-acc", (e) => e.filter((x) => x.offsetParent !== null).map((x) => x.dataset.acc));
check("board: five visible pills, category hidden", pills.join(",") === "place,pay,employer,level,work" && (await p.$eval('.rail-acc[data-acc="category"]', (e) => e.offsetParent === null)), pills.join(","));
for (const key of pills) {
  await p.click(`.rail-acc[data-acc="${key}"] .rail-acc-head`);
  await wait(400);
  const open = await p.$$eval(".board-pills .rail-acc.open", (e) => e.map((x) => x.dataset.acc));
  const visible = await p.$eval(`.rail-acc[data-acc="${key}"] .rail-acc-body`, (el) => { const r = el.getBoundingClientRect(); return !el.hidden && r.height > 20 && r.right <= window.innerWidth; });
  const options = await p.$$eval(`.rail-acc[data-acc="${key}"] .rail-acc-body .rail-option, .rail-acc[data-acc="${key}"] .rail-acc-body .rail-range, .rail-acc[data-acc="${key}"] .rail-acc-body .rail-search`, (e) => e.length);
  check(`board: pill ${key} opens alone with content`, open.length === 1 && open[0] === key && visible && options > 0, `open=${open} visible=${visible} options=${options}`);
}
await p.keyboard.press("Escape"); await wait(300);
check("board: Escape closes pills", (await p.$$eval(".board-pills .rail-acc.open", (e) => e.length)) === 0);
await p.click('.rail-acc[data-acc="work"] .rail-acc-head'); await wait(300);
await p.click(".board-head"); await wait(300);
check("board: click outside closes pills", (await p.$$eval(".board-pills .rail-acc.open", (e) => e.length)) === 0);

// Filtering through a pill
const before = await count(p);
await p.click('.rail-acc[data-acc="work"] .rail-acc-head'); await wait(300);
await p.click('.rail-acc[data-acc="work"] .rail-option:has(input[value="remote"])');
await settle(p);
const sum = await p.$eval('.rail-acc[data-acc="work"] .rail-acc-sum', (e) => e.textContent).catch(() => "");
check("board: ticking Remote filters and shows on the pill", (await count(p)) !== before && /Remote/.test(sum), `${before} -> ${await count(p)}; pill says "${sum}"`);
check("board: Reset appears when filtered", await p.$eval(".rail-reset", (e) => !e.hidden));
check("board: no chips row duplicates the value", await p.$eval("#active-chips", (e) => e.getBoundingClientRect().height === 0));
await p.click(".rail-reset"); await settle(p);
check("board: Reset clears the filter", (await count(p)) === before && (await p.$eval(".rail-reset", (e) => e.hidden)), `${await count(p)} vs ${before}`);

// Sidebar
const cats = await p.$$eval("#side-cats .side-cat", (e) => e.map((x) => x.textContent.trim().replace(/\s+/g, " ")));
check("board: categories start fully open", cats.length >= 9 && /Show fewer/.test(cats[cats.length - 1]), cats.join(" | "));
await p.click("#side-cats .side-cat"); await settle(p);
const catOn = await p.$eval("#side-cats .side-cat", (e) => e.classList.contains("on"));
check("board: category click filters and marks the row", catOn && (await count(p)) !== before, `${await count(p)}`);
const onStyle = await p.$eval("#side-cats .side-cat.on", (e) => { const s = getComputedStyle(e); return `${s.fontWeight} ${s.backgroundColor}`; });
check("board: active row is bold on a wash, no green", /^(600|700) /.test(onStyle) && !/47, 174, 96|96, 153, 102/.test(onStyle), onStyle);
await p.click("#side-cats .side-cat"); await settle(p);
check("board: category click again clears it", (await count(p)) === before, `${await count(p)} vs ${before}`);
await p.click('#view-switch [data-view="all"]'); await settle(p);
check("board: All roles view switches", (await count(p)) !== before && (await p.$eval('#view-switch [data-view="all"]', (e) => e.classList.contains("active"))), await count(p));
await p.click('#view-switch [data-view="tech"]'); await settle(p);
await p.click('#view-switch [data-view="saved"]'); await wait(1200);
note("board: Saved view (nothing saved)", await p.$eval("#jobs-empty", (e) => (e.hidden ? "no empty state shown" : e.textContent.trim().slice(0, 80))).catch(() => "no empty state node"));
await p.click('#view-switch [data-view="tech"]'); await settle(p);

// Search, date, sort
await p.fill("#f-search", "python"); await p.keyboard.press("Enter"); await settle(p);
check("board: search narrows the count", (await count(p)) !== before, await count(p));
check("board: search clear cross shows", await p.$eval(".topbar-search", (e) => e.classList.contains("has-text")));
await p.fill("#f-search", ""); await p.keyboard.press("Enter"); await settle(p);
await p.selectOption("#f-date-posted", "1"); await settle(p);
check("board: Any date -> past 24h narrows", (await count(p)) !== before, await count(p));
await p.selectOption("#f-date-posted", "any"); await settle(p); await wait(1500);
await p.selectOption("#f-sort", "age:desc"); await settle(p); await wait(1000);
const firstAge = await p.$eval("#jobs-body tr[data-id] .age-cell", (e) => e.textContent.trim());
check("board: sort Oldest puts an old listing first", !/m ago|h ago/.test(firstAge), firstAge);
await p.selectOption("#f-sort", "age:asc"); await settle(p);
check("board: date and sort sit in the list head", await p.$eval(".list-head .topbar-sorts", (e) => !!e));

// Listing open / pane
const gridBefore = await p.$eval(".job-detail", (e) => e.getBoundingClientRect().width);
await p.click("#jobs-body tr[data-id] .main-cell"); await wait(900);
const gridAfter = await p.$eval(".job-detail", (e) => e.getBoundingClientRect().width);
check("board: pane widens when a listing opens", gridAfter > gridBefore + 100, `${Math.round(gridBefore)} -> ${Math.round(gridAfter)}`);
check("board: Copy link label", (await p.$$eval("#job-detail button", (e) => e.map((x) => x.textContent.trim()))).includes("Copy link"));
check("board: close cross inside the pane", await p.$eval("#pane-head .pane-close", (e) => { const r = e.getBoundingClientRect(); const pr = e.closest(".job-detail").getBoundingClientRect(); return r.right <= pr.right && r.top >= pr.top; }));
await p.click("#pane-head .pane-close"); await wait(700);
check("board: closing restores the pane width", Math.abs((await p.$eval(".job-detail", (e) => e.getBoundingClientRect().width)) - gridBefore) < 2);
await p.click("#jobs-body tr[data-id] .main-cell"); await wait(600);
const url1 = p.url();
await p.keyboard.press("Escape"); await wait(400);
note("board: Escape with a listing open", p.url() === url1 ? "pane stays open (Escape not wired on the live board either)" : "closes it");
await p.click("#pane-head .pane-close").catch(() => {}); await wait(300);

// Sidebar collapse, theme, scrolling
await p.click("#side-fold"); await wait(400);
check("board: sidebar collapses to 56px", Math.round(await p.$eval("#site-side", (e) => e.getBoundingClientRect().width)) === 56);
await p.click("#side-fold"); await wait(400);
await p.click("#theme-toggle"); await wait(300);
check("board: theme toggle flips to light", (await p.evaluate(() => document.documentElement.getAttribute("data-theme"))) !== "dark");
await p.screenshot({ path: "tests/e2e/qa-live-board-light.png" });
await p.click("#theme-toggle"); await wait(300);
const n1 = await rows(p);
await p.$eval(".board-list", (e) => { e.scrollTop = e.scrollHeight; });
await wait(2500);
const n2 = await rows(p);
check("board: scrolling the list loads more rows", n2 > n1, `${n1} -> ${n2}`);
check("board: window itself does not scroll", await p.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1));
await p.$eval(".board-list", (e) => { e.scrollTop = 0; });

// Keyboard and ARIA
const ariaPills = await p.$$eval(".board-pills .rail-acc-head", (e) => e.every((x) => x.hasAttribute("aria-expanded") && x.textContent.trim().length > 0));
check("board: pills carry aria-expanded and a name", ariaPills);
check("board: collapse button has a name", await p.$eval("#side-fold", (e) => !!e.getAttribute("aria-label")));
await p.focus("#f-search"); await p.keyboard.press("Tab"); await wait(100);
note("board: Tab after search lands on", await p.evaluate(() => { const a = document.activeElement; return `${a.tagName.toLowerCase()} ${a.className.split(" ")[0]} "${(a.textContent || a.getAttribute("aria-label") || "").trim().slice(0, 30)}"`; }));
check("board: sidebar rows are buttons or links", await p.$$eval("#site-side .side-cat, #site-side .seg-btn, #site-side .topbar-nav a", (e) => e.every((x) => ["BUTTON", "A"].includes(x.tagName))));

// URL state
await p.goto(base + "/board?department=Security&workplace=remote", { waitUntil: "domcontentloaded" }); await settle(p);
await p.waitForSelector("#side-cats .side-cat.on", { timeout: 20000 }).catch(() => {}); await wait(500);
check("board: URL filters apply (department + workplace)", (await p.$eval("#side-cats .side-cat.on", (e) => e.textContent).catch(() => "")).includes("Security") && /Remote/.test(await p.$eval('.rail-acc[data-acc="work"] .rail-acc-sum', (e) => e.textContent).catch(() => "")), await count(p));
await p.screenshot({ path: "tests/e2e/qa-live-board-url.png" });

// Viewports
for (const w of [1920, 1280, 1100, 1024, 768, 390]) {
  await p.setViewportSize({ width: w, height: w < 800 ? 844 : 900 });
  await p.goto(base + "/board", { waitUntil: "domcontentloaded" }); await settle(p);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const pillsRight = await p.$$eval(".board-pills .rail-acc-head", (e) => Math.max(...e.filter((x) => x.offsetParent !== null).map((x) => x.getBoundingClientRect().right)));
  const pillRows = await p.$$eval(".board-pills .rail-acc-head", (e) => new Set(e.filter((x) => x.offsetParent !== null).map((x) => Math.round(x.getBoundingClientRect().top))).size);
  const listW = await p.$eval(".board-list", (e) => Math.round(e.getBoundingClientRect().width));
  const paneW = await p.$eval(".job-detail", (e) => Math.round(e.getBoundingClientRect().width));
  const sideW = await p.$eval("#site-side", (e) => Math.round(e.getBoundingClientRect().width));
  const visibleRows = await p.$$eval("#jobs-body tr[data-id]", (e) => e.filter((r) => r.getBoundingClientRect().bottom <= window.innerHeight).length);
  note(`board @${w}`, `overflow=${overflow}px side=${sideW} list=${listW} pane=${paneW} pills on ${pillRows} row(s), rightmost ${Math.round(pillsRight)}px, ${visibleRows} rows visible`);
  await p.screenshot({ path: `tests/e2e/qa-live-board-${w}.png` });
}
await p.close();

await b.close();
report();
