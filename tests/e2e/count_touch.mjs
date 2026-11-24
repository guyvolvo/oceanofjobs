// frontend/count.js counts a visit, and a listing page's job view, only
// after a real click, tap, key or wheel: a page that is only loaded, or
// clicked by its own script, sends nothing. Self-contained, no server:
//   node tests/e2e/count_touch.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const js = readFileSync(new URL("../../frontend/count.js", import.meta.url), "utf8");
const b = await chromium.launch();
const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

async function sent(path, act) {
  const ctx = await b.newContext({ userAgent: ua });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.__beacons = [];
    Object.defineProperty(Navigator.prototype, "sendBeacon", {
      configurable: true, value: (u) => { window.__beacons.push(new URL(u, location.href).searchParams.get("e")); return true; } });
  });
  await ctx.route("https://oceanofjobs.test/**", (r) => r.fulfill({ contentType: "text/html", body: `<p>listing</p><script>${js}</script>` }));
  const p = await ctx.newPage();
  await p.goto(`https://oceanofjobs.test${path}`);
  if (act) await act(p);
  await p.waitForTimeout(200);
  const out = await p.evaluate(() => window.__beacons);
  await ctx.close();
  return out.join(",");
}

const cases = [
  ["a page only loaded sends nothing", await sent("/job/abc", null), ""],
  ["a click counts the visit and the job view", await sent("/job/abc", (p) => p.mouse.click(10, 10)), "visit,new_visitor,job_view"],
  ["a click by the page's own script sends nothing", await sent("/job/abc", (p) => p.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))), ""],
  ["a wheel scroll on the board counts the visit only", await sent("/board", (p) => p.mouse.wheel(0, 300)), "visit,new_visitor"],
  ["a second touch counts nothing more", await sent("/job/abc", async (p) => { await p.mouse.click(10, 10); await p.keyboard.press("Tab"); }), "visit,new_visitor,job_view"],
];
await b.close();
let failed = 0;
for (const [name, got, want] of cases) {
  const ok = got === want;
  failed += !ok;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : `  -- got "${got}", want "${want}"`}`);
}
process.exit(failed ? 1 : 0);
