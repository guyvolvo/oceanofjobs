// generic.read() on a live page in a normal browser signature, GETs only:
// what it finds, and a screenshot after.
//   node tests/e2e/_read_live.mjs <url> [out.png]
import { chromium } from "playwright";
import path from "node:path";
const [url, shot] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../..");
const b = await chromium.launch({ channel: "chromium" });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" });
await page.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) ? r.continue() : r.abort()));
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
for (const f of ["extension/lib/match.js", "extension/ats/generic.js"]) await page.addScriptTag({ path: path.join(root, f) });
const r = await page.evaluate(async () => {
  const g = globalThis.oojAts.generic;
  const res = await g.read();
  return { ...res, fields: res.fields && res.fields.map((f) => `${f.required ? "*" : " "} ${f.type.padEnd(9)} ${f.label.slice(0, 70)}${f.options && f.options.length ? " [" + f.options.slice(0, 4).join(" | ") + "]" : ""}`),
    submit: g.submitInfo(), wall: g.wall(), step: !!(g.next && document.querySelector('[data-ooj-form]') && (() => { try { return !!g.stepButtonText; } catch { return false; } })()),
    buttons: (() => { const out = []; const visit = (n) => { for (const el of n.children) { if (el.matches('button, [role=button]') && el.checkVisibility()) out.push((el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)); if (el.shadowRoot) visit(el.shadowRoot); visit(el); } }; visit(document); return [...new Set(out)].filter(Boolean).slice(0, 30); })() };
}).catch((e) => ({ threw: e.message.slice(0, 200) }));
console.log("at:", page.url());
console.log(JSON.stringify(r, null, 1));
if (shot) await page.screenshot({ path: shot, fullPage: false });
await b.close();
