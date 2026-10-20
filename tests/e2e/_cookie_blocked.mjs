// With site storage blocked, the banner must not appear and GA must not load.
import { chromium } from "playwright";
import path from "node:path";
const b = await chromium.launch();
const p = await b.newPage();
await p.addInitScript(() => {
  const deny = () => { throw new DOMException("blocked", "SecurityError"); };
  Object.defineProperty(window, "localStorage", { get: deny });
});
let ga = false;
p.on("request", (r) => { if (/googletagmanager/.test(r.url())) ga = true; });
await p.goto("http://127.0.0.1:8011/index.html", { waitUntil: "load" });
await p.waitForTimeout(1000);
console.log("blocked storage -> banner:", await p.locator("#cookie-banner").count(), "| GA loaded:", ga);
const q = await b.newPage();
await q.goto("http://127.0.0.1:8011/index.html", { waitUntil: "load" });
await q.waitForTimeout(1000);
console.log("normal storage  -> banner:", await q.locator("#cookie-banner").count());
await b.close();
