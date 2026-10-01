// Screenshots of the companies directory (companies.html) at several
// widths. Until the directory API is deployed, MOCK=1 answers its two
// endpoints from the live facets, so the page can be looked at; the
// numbers under MOCK are placeholders, not the site's.
import { chromium } from "playwright";
const base = process.env.BASE || "http://localhost:8010";
const mock = process.env.MOCK === "1";
const b = await chromium.launch();
const errors = [];
const ctx = await b.newContext();
if (mock) {
  await ctx.route("**/api/companies/directory*", async (route) => {
    const u = new URL(route.request().url());
    const country = u.searchParams.get("country");
    const r = await fetch(`https://oceanofjobs.com/api/facets?confidence=all${country ? `&country=${country}` : ""}`);
    const f = await r.json();
    const systems = ["greenhouse", "workday", "comeet", "lever", "ashby", "smartrecruiters", null];
    const companies = (f.companies || []).map((c, i) => ({ domain: c.value, n: c.n, new_7d: i % 3 === 0 ? Math.round(c.n / 9) : 0, name: c.name, ats: systems[i % systems.length], has_logo: i % 5 !== 4,
      trend: i % 7 === 6 ? [] : Array.from({ length: 12 }, (_, k) => Math.round(c.n * (0.7 + 0.3 * Math.sin((k + i) / 2)))) }));
    await route.fulfill({ json: { companies, capped: companies.length >= 500, limit: 500 } });
  });
  await ctx.route((url) => /\/api\/companies\/(?!directory)[^/]+$/.test(url.pathname), async (route) => {
    const domain = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    const days = 30;
    const history = Array.from({ length: days }, (_, i) => ({ day: new Date(Date.now() - (days - 1 - i) * 864e5).toISOString().slice(0, 10), open_n: 200 + Math.round(40 * Math.sin(i / 4)) + i, new_n: 3 }));
    await route.fulfill({ json: { domain, name: domain, ats: "greenhouse", has_logo: true, tracked_since: "2026-01-01", open_jobs: 1240, new_jobs_7d: 31, history } });
  });
}
for (const [w, h] of [[1440, 900], [1100, 900], [390, 844]]) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w, height: h });
  p.on("pageerror", (e) => errors.push(`${w}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${w} console: ${m.text().slice(0, 140)}`); });
  await p.addInitScript(() => { localStorage.setItem("iljobs_theme", "dark"); localStorage.setItem("iljobs_dir_country", "IL"); });
  await p.goto(base + "/companies", { waitUntil: "domcontentloaded" });
  await p.waitForSelector(".dir-row", { timeout: 40000 }).catch(() => errors.push(`${w}: no rows`));
  await p.waitForTimeout(1500);
  console.log(w, JSON.stringify(await p.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    head: document.querySelector("#dir-count").textContent, sub: document.querySelector("#dir-sub").textContent.slice(0, 60),
    rows: document.querySelectorAll(".dir-row").length, systems: document.querySelectorAll("#dir-systems .side-cat").length,
  }))));
  await p.screenshot({ path: `tests/e2e/companies-${w}.png` });
  if (errors.length) { console.log("ERRORS so far:", errors.join(" | ")); await p.close(); continue; }
  if (w === 1440) {
    await p.click(".dir-row"); await p.waitForSelector("#dir-tiles .ov-tile", { timeout: 30000 }).catch(() => errors.push("no tiles")); await p.waitForTimeout(2500);
    console.log("panel:", await p.$$eval("#dir-tiles .ov-tile", (e) => e.map((x) => x.textContent.trim().replace(/\s+/g, " ")).join(" | ")), "| spark:", !!(await p.$(".dir-spark")), "| jobs:", await p.$$eval("#dir-jobs .dir-job", (e) => e.length), "| hash:", await p.evaluate(() => location.hash));
    await p.screenshot({ path: "tests/e2e/companies-1440-open.png" });
    await p.click("#dir-close"); await p.waitForTimeout(300);
    await p.click("#dir-pill-place"); await p.waitForTimeout(400);
    await p.screenshot({ path: "tests/e2e/companies-1440-pill.png", clip: { x: 240, y: 0, width: 900, height: 500 } });
  }
  if (w === 390) {
    await p.click(".dir-row"); await p.waitForTimeout(2500);
    await p.screenshot({ path: "tests/e2e/companies-390-open.png" });
  }
  await p.close();
}
await b.close();
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
