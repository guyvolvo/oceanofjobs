// Fills a live form from an isolated world, as the extension's content
// scripts run, and reads back what the page's own script (main world) sees.
//   node tests/e2e/_isolated_fill.mjs <url> <css of a text input>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const [url, sel] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../..");
const b = await chromium.launch({ channel: "chromium" });
const page = await (await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" })).newPage();
await page.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) ? r.continue() : r.abort()));
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
const cdp = await page.context().newCDPSession(page);
const { frameTree } = await cdp.send("Page.getFrameTree");
const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "ooj-test" });
const run = (expression) => cdp.send("Runtime.evaluate", { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true });
await run(fs.readFileSync(path.join(root, "extension/lib/match.js"), "utf8"));
await run(fs.readFileSync(path.join(root, "extension/ats/generic.js"), "utf8"));
const r = await run(`(async () => {
  const g = globalThis.oojAts.generic;
  const { fields } = await g.read();
  const f = fields.find((x) => x.label === "Nombre completo");
  const cvField = fields.find((x) => x.type === "file");
  const cv = { name: "cv.pdf", type: "application/pdf", data: btoa("%PDF-1.4 test") };
  const res = await g.fill([...(cvField ? [{ ...cvField, value: "cv" }] : []), { ...f, value: "Test Person" }], cv);
  await new Promise((r) => setTimeout(r, 4000));
  return { errors: res.errors };
})()`);
console.log("isolated fill:", JSON.stringify(r.result.value));
console.log("main world sees:", await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  const ctrl = window.angular && window.angular.element(el).controller("ngModel");
  return { domValue: el.value, model: ctrl ? ctrl.$modelValue : "(no ngModel)", viewValue: ctrl ? ctrl.$viewValue : null };
}, sel));
await b.close();
