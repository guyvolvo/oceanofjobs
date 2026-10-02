// The phone redesign, in a 390px browser against the local preview
// (BASE, default http://localhost:8010). The reader's own endpoints are
// stubbed; the public ones are live.
import { chromium } from "playwright";
const base = process.env.BASE || "http://localhost:8010";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await ctx.route("**/api/me/profile", (r) => r.fulfill({ json: { profile: { skills: ["Python", "AWS", "Docker"], country: ["IL"] }, skill_spec: null } }));
await ctx.route("**/api/me/alerts", (r) => r.fulfill({ json: { alerts: [
  { alert_id: "a1", active: true, filter: { search: "DevOps", department: "Infrastructure", country: "IL" }, created_at: "2026-09-20T09:00:00Z" },
  { alert_id: "a2", active: true, filter: { search: "SRE", country: "IL" } },
  { alert_id: "a3", active: true, filter: { country: "IL" } },
  { alert_id: "a4", active: false, filter: { search: "devops", department: "Infrastructure", country: "IL" } },
] } }));
await ctx.route("**/api/me/saved", (r) => r.fulfill({ json: { saved: [] } }));
await ctx.route("**/api/me/dashboard*", (r) => r.fulfill({ json: { key: "k", computed_at: new Date().toISOString(), history: { days: [] }, counts: {}, matches: [], suggested: [] } }));
const errors = [];
const p = await ctx.newPage();
p.on("pageerror", (e) => errors.push(e.message));
await p.addInitScript(() => {
  localStorage.setItem("iljobs_geo_asked", "1"); localStorage.setItem("iljobs_theme", "dark");
  const payload = btoa(JSON.stringify({ email: "g@example.com", name: "Guy", exp: Math.floor(Date.now() / 1000) + 3600, sub: "x" })).replace(/=+$/, "");
  localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: "eyJhbGciOiJub25lIn0." + payload + ".sig", access_token: "a", refresh_token: "r" }));
});
const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return getComputedStyle(e).display === "none" || !r.width ? "hidden" : [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
const out = {};

await p.goto(base + "/board", { waitUntil: "domcontentloaded" });
await p.waitForFunction(() => document.querySelectorAll("#jobs-body tr[data-id]").length > 0, null, { timeout: 60000 }); await p.waitForTimeout(1200);
out.board = await p.evaluate((boxSrc) => { const box = eval(boxSrc); return {
  tabbar: box(".tabbar"), tabs: [...document.querySelectorAll(".tabbar-item")].map((a) => a.textContent.trim() + (a.classList.contains("on") ? "*" : "")).join(","),
  sidebar: box("#site-side"), hamburger: box("#side-open"), search: box("#topbar-search"), searchFont: getComputedStyle(document.querySelector("#f-search")).fontSize,
  mbar: box("#m-bar"), count: document.querySelector("#m-count").textContent, row: box("#jobs-body tr[data-id]"), titleClamp: getComputedStyle(document.querySelector(".job-title-text")).webkitLineClamp,
  star: box("#jobs-body tr[data-id] .star-btn"), ageTail: document.querySelector(".job-age-tail")?.textContent, fab: box("#m-alert"), overflow: document.documentElement.scrollWidth - innerWidth,
}; }, box.toString());
await p.screenshot({ path: "tests/e2e/m-jobs.png" });

await p.click("#m-filters"); await p.waitForTimeout(500);
out.sheet = await p.evaluate(() => ({
  open: !document.getElementById("m-sheet").hidden, sections: [...document.querySelectorAll("#m-sheet .m-sec-title, #m-sheet .rail-acc-name")].map((e) => e.textContent.trim()),
  cats: document.querySelectorAll("#m-cats .m-opt").length, options: document.querySelectorAll("#m-sheet .rail-option").length, show: document.getElementById("m-show").textContent,
  railInSheet: !!document.querySelector("#m-rail-host #filter-rail"), bodiesVisible: [...document.querySelectorAll("#m-sheet .rail-acc-body")].every((x) => getComputedStyle(x).display !== "none"),
}));
await p.screenshot({ path: "tests/e2e/m-filters.png" });
const picked = await p.evaluate(() => { const o = [...document.querySelectorAll('#m-sheet .rail-option input[data-kind="country"]')].find((i) => i.value === "US"); if (!o) return "no IL option"; o.click(); return { checked: o.checked, country: state.country.slice() }; });
await p.waitForTimeout(1500);
out.pick = picked;
await p.click("#m-show"); await p.waitForTimeout(500);
out.afterPick = await p.evaluate(() => ({ chips: [...document.querySelectorAll("#m-chips .m-chip")].map((c) => c.textContent.trim()), badge: document.getElementById("m-badge").textContent, sheetClosed: document.getElementById("m-sheet").hidden, count: document.getElementById("m-count").textContent }));
await p.screenshot({ path: "tests/e2e/m-jobs-filtered.png" });

await p.click("#jobs-body tr[data-id] .job-title-link"); await p.waitForTimeout(900);
out.job = await p.evaluate((boxSrc) => { const box = eval(boxSrc); return {
  pane: box("#job-detail"), back: document.querySelector(".pane-close")?.innerText.trim(), pos: document.querySelector(".pane-pos")?.textContent, share: box(".pane-share"),
  title: box(".job-detail-title"), titleFont: getComputedStyle(document.querySelector(".job-detail-title")).fontFamily.split(",")[0], facts: box(".job-detail-facts"),
  factCols: getComputedStyle(document.querySelector(".job-detail-facts")).gridTemplateColumns, sticky: box("#pane-sticky"), apply: document.querySelector(".pane-apply")?.textContent.trim(),
  tabbarHidden: getComputedStyle(document.querySelector(".tabbar")).display === "none",
}; }, box.toString());
await p.screenshot({ path: "tests/e2e/m-job.png" });
await p.click(".pane-close"); await p.waitForTimeout(400);

await p.goto(base + "/account", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(2500);
out.account = await p.evaluate(() => ({
  tiles: [...document.querySelectorAll(".acct-stat")].filter((t) => getComputedStyle(t).display !== "none").map((t) => t.querySelector(".acct-stat-label").textContent + "=" + t.querySelector(".acct-stat-value").textContent.trim()),
  card: !document.getElementById("acct-getmatched").hidden && getComputedStyle(document.getElementById("acct-getmatched")).display !== "none",
  panelsHidden: [...document.querySelectorAll("#overview .acct-dash-row")].every((r) => getComputedStyle(r).display === "none"),
  heroActionsHidden: getComputedStyle(document.querySelector(".acct-hero-actions")).display === "none", tabbar: !!document.querySelector(".tabbar"),
  hamburger: document.querySelector(".hero-nav-toggle") ? getComputedStyle(document.querySelector(".hero-nav-toggle")).display : "none",
}));
await p.screenshot({ path: "tests/e2e/m-account.png" });
await p.evaluate(() => { location.hash = "#alerts"; }); await p.waitForTimeout(800);
out.alerts = await p.evaluate(() => ({ rows: document.querySelectorAll(".alert-row").length, dup: document.querySelector(".alert-dup")?.textContent, toggleSize: (() => { const t = document.querySelector(".alert-toggle"); const r = t.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })(), activeTab: document.querySelector(".tabbar-item.on")?.textContent.trim() }));
await p.screenshot({ path: "tests/e2e/m-alerts.png" });

await p.goto(base + "/contact", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(600);
out.contact = await p.evaluate(() => { const tops = ["h1", ".contact-topic-row", "#contact-send", ".contact-direct"].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)); return { order: tops, inputH: Math.round(document.querySelector("#contact-email").getBoundingClientRect().height), inputFont: getComputedStyle(document.querySelector("#contact-email")).fontSize, topicCols: getComputedStyle(document.querySelector(".contact-topic-row")).gridTemplateColumns.split(" ").length }; });
await p.screenshot({ path: "tests/e2e/m-contact.png", fullPage: true });
await b.close();
console.log(JSON.stringify(out, null, 1));
console.log(errors.length ? "PAGE ERRORS:\n" + errors.join("\n") : "no page errors");
