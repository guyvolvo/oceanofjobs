// MCP click attribution in frontend/count.js: a page reached with
// ?ref=mcp counts one mcp_view per browser, the first apply click on it
// one mcp_apply, refreshes and repeat visits add nothing, and the
// parameter leaves the address bar without taking other parameters.
//
// Run from tests/e2e:  node mcp_attribution.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8844;
const root = mkdtempSync(join(tmpdir(), "otj-mcp-"));
mkdirSync(join(root, "job"));
copyFileSync(new URL("../../frontend/count.js", import.meta.url), join(root, "count.js"));
for (const id of ["abc", "def"]) {
  writeFileSync(join(root, "job", `${id}.html`),
    `<!doctype html><title>${id}</title><a class="pg-apply" href="#apply">Apply</a><script src="/count.js"></script>`);
}
const srv = spawn("python", ["-m", "http.server", String(PORT)], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));

let bad = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}: ${n}${ok ? "" : "  -- " + d}`); if (!ok) bad++; };
const base = `http://localhost:${PORT}`;
const browser = await chromium.launch();

async function context() {
  // Headless Chromium says "HeadlessChrome", which count.js also treats as a robot.
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" });
  const events = [];
  // count.js counts nothing for automated browsers, so look like a person,
  // and use fetch rather than sendBeacon so every count is routed here.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    navigator.sendBeacon = undefined;
  });
  await ctx.route("**/api/event**", (route) => {
    events.push(new URL(route.request().url()).searchParams.get("e"));
    route.fulfill({ status: 204, body: "" });
  });
  return { ctx, events };
}
const mcp = (events) => events.filter((e) => e.startsWith("mcp_"));
const settle = () => new Promise((r) => setTimeout(r, 300));

try {
  const { ctx, events } = await context();
  const page = await ctx.newPage();
  await page.goto(`${base}/job/abc.html?ref=mcp`);
  await settle();
  check("a referred page counts a job view and one mcp_view", events.includes("job_view") && mcp(events).join() === "mcp_view", events.join());
  check("ref leaves the address bar", page.url() === `${base}/job/abc.html`, page.url());

  await page.reload();
  await settle();
  check("a refresh adds no mcp_view", mcp(events).join() === "mcp_view", events.join());

  await page.click("a.pg-apply");
  await page.click("a.pg-apply");
  await settle();
  check("the first apply after a refresh still counts as an MCP apply, once", mcp(events).join() === "mcp_view,mcp_apply", events.join());
  check("every apply click still counts as an apply", events.filter((e) => e === "apply").length === 2, events.join());

  const again = await ctx.newPage();
  await again.goto(`${base}/job/abc.html?ref=mcp`);
  await again.click("a.pg-apply");
  await settle();
  check("a repeat visit from the same browser adds nothing", mcp(events).join() === "mcp_view,mcp_apply", events.join());

  const other = await ctx.newPage();
  await other.goto(`${base}/job/def.html`);
  await other.click("a.pg-apply");
  await settle();
  check("a page reached without ref is not attributed", mcp(events).join() === "mcp_view,mcp_apply", events.join());
  await ctx.close();

  const fresh = await context();
  const p2 = await fresh.ctx.newPage();
  await p2.goto(`${base}/job/def.html?x=1&ref=mcp#top`);
  await settle();
  check("another browser is another referral", mcp(fresh.events).join() === "mcp_view", fresh.events.join());
  check("other parameters and the hash stay", p2.url() === `${base}/job/def.html?x=1#top`, p2.url());
  await fresh.ctx.close();
} finally {
  await browser.close();
  srv.kill();
  await new Promise((r) => srv.on("exit", r));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(bad ? `\n${bad} failed` : "\nall passed");
process.exit(bad ? 1 : 0);
