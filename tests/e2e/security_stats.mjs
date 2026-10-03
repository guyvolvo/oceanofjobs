// The stats page must not render markup from a shared query's text values,
// even when ?v=bar forces a chart (security review 2026-10-03). Calls the
// page's own renderers with a hostile row, on the code under test, and on
// the previous code when OLD_STATS points at it, to show the check bites.
import { chromium } from "playwright";
import { readFileSync } from "fs";
const base = process.env.BASE || "http://localhost:8010";
const b = await chromium.launch();
const p = await b.newPage();
if (process.env.OLD_STATS) await p.route("**/stats.js*", r => r.fulfill({ body: readFileSync(process.env.OLD_STATS, "utf8"), contentType: "text/javascript" }));
await p.goto(`${base}/stats.html?v=bar`, { waitUntil: "load" });
await p.waitForTimeout(1500);
const r = await p.evaluate(() => {
  const cols = ["a", "b"], rows = [["a", '<img src=x onerror="window.__pwned=1">'], ["b", "plain"]];
  const html = renderBars(cols, rows);
  const host = document.createElement("div"); host.innerHTML = html; document.body.appendChild(host);
  setViz("bogus");
  const vizAfterBogus = typeof viz !== "undefined" ? viz : "?";
  setViz("bar");
  return { barsMarkup: html.includes("<img src=x"), picked: pickViz(cols, rows), vizAfterBogus };
});
await p.waitForTimeout(300);
r.pwned = await p.evaluate(() => !!window.__pwned);
console.log(JSON.stringify(r));
await b.close();
process.exit(r.pwned || r.barsMarkup || r.picked !== "table" ? 1 : 0);
