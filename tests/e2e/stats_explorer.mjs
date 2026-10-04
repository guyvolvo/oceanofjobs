// The Statistics page's builder, end to end against the live database,
// with this checkout's page files swapped in: change the grouping, add a
// filter from its popover, switch to the table, view the SQL, remove the
// filter. Exits non-zero when any step does not do what it says.
//   node tests/e2e/stats_explorer.mjs
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
const ROOT = fileURLToPath(new URL("../../frontend/", import.meta.url));
const LOCAL = { "/stats": ["stats.html", "text/html"], "/stats.js": ["stats.js", "text/javascript"], "/qb.js": ["qb.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.route("https://oceanofjobs.com/**", (r) => {
  const path = new URL(r.request().url()).pathname; const hit = LOCAL[path];
  if (hit) return r.fulfill({ body: readFileSync(ROOT + hit[0]), contentType: hit[1] });
  if (path === "/api/event") return r.fulfill({ status: 204 });
  return r.continue();
});
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
const done = async (label) => {
  await p.waitForFunction(() => /rows? in/.test(document.getElementById("explore-metric").textContent) && !document.body.classList.contains("explore-busy"), null, { timeout: 150000 }).catch(() => errs.push("timeout: " + label));
};
const clearSub = () => p.evaluate(() => { document.getElementById("explore-metric").textContent = ""; });
await p.goto("https://oceanofjobs.com/stats", { waitUntil: "load" });
await done("first");
const out = {};
// Group by category instead of day.
await clearSub(); await p.selectOption("#qb-group", "category"); await done("group");
out.groupTitle = await p.textContent("#st-rtitle");
out.sentence = (await p.textContent("#qb")).replace(/\s+/g, " ").trim();
// Add a filter: Workplace is Remote.
await p.waitForTimeout(1500);  // picker values load after the first answer
await p.click("#qb-add");
await p.click('.st-pop [data-field="workplace"]');
await p.waitForSelector('.st-pop input[type=checkbox]');
await clearSub();
await p.check('.st-pop input[value="remote"]');
await p.click(".st-pop .st-pop-done");
await done("filter");
out.tag = await p.textContent(".st-tag-edit");
out.filteredSub = await p.textContent("#explore-metric");
out.filteredTitle = await p.textContent("#st-rtitle");
// Table view, then SQL.
await p.click('.st-viewseg [data-viz="table"]');
out.tableShown = await p.evaluate(() => !!document.querySelector("#st-main-table table") && !document.querySelector(".st-hbars"));
out.url = await p.evaluate(() => location.search.includes("v=table"));
await p.click("#st-viewsql");
out.sql = (await p.inputValue("#explore-sql")).includes("j.workplace IN ('remote')");
// Remove the filter from the builder.
await p.click('.seg [data-mode="builder"]');
await clearSub(); await p.click(".st-tag-x"); await done("remove");
out.tagsLeft = await p.locator(".st-tag").count();
console.log(JSON.stringify({ ...out, errs }, null, 1));
await b.close();
const ok = out.groupTitle === "Open jobs by category" && out.tag === "Workplace is Remote" && /Remote · \d+ rows in/.test(out.filteredSub)
  && out.tableShown && out.url && out.sql && out.tagsLeft === 0 && errs.length === 0;
console.log(ok ? "all passed" : "FAILED");
process.exit(ok ? 0 : 1);
