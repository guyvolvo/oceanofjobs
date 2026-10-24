// generic.read() on a live page in a normal browser signature, GETs only:
// what it finds, and a screenshot after.
//   node tests/e2e/_read_live.mjs <url> [out.png]
import { chromium } from "playwright";
import path from "node:path";
const [url, shot] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../..");
const b = await chromium.launch({ channel: "chromium" });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" });
const aborted = [];
// A site's bot-detection pings (DataDome, Cloudflare's challenge) carry no
// application data, and a page whose pings fail can refuse to go on.
const PING = /^https:\/\/(api-js\.datadome\.co\/js\/|[^/]+\/cdn-cgi\/challenge-platform\/)/;
await page.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) || PING.test(r.request().url()) ? r.continue()
  : (aborted.push(`${r.request().method()} ${new URL(r.request().url()).host}${new URL(r.request().url()).pathname}`.slice(0, 120)), r.abort())));
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
// STEPS=n: fill each page with test answers (the profile's, else the first
// option or "Test answer"), press Next and read the next page, n times.
for (let i = 0; i < Number(process.env.STEPS || 0); i++) {
  const step = await page.evaluate(async () => {
    const g = globalThis.oojAts.generic, m = globalThis.oojMatch;
    const profile = { contact: { first_name: "Test", last_name: "Person", email: "test.person@example.com", phone: "+1 415 555 0134", location: "London, United Kingdom" },
      links: { linkedin: "https://www.linkedin.com/in/test-person" }, work: {}, eeo: {}, answers: [] };
    const { fields } = await g.read();
    const plan = m.planFill(fields, profile, {});
    for (const f of plan.missing) plan.fills.push({ ...f, value: f.options && f.options.length ? f.options[0] : "Test answer" });
    const filled = await g.fill(plan.fills.filter((f) => f.type !== "file"), null);
    const before = g.next();
    if (!before) return { errors: filled.errors, next: "no Next button" };
    const moved = await g.nextOutcome(before, 8000);
    const again = await g.read();
    return { errors: filled.errors, moved, fields: again.fields && again.fields.map((f) => `${f.required ? "*" : " "} ${f.type.padEnd(9)} ${f.label.slice(0, 70)}`), submit: g.submitInfo() };
  }).catch((e) => ({ threw: e.message.slice(0, 200) }));
  console.log(`step ${i + 1}:`, JSON.stringify(step, null, 1));
}
if (process.env.ANC) console.log("ancestors:", JSON.stringify(await page.evaluate((sel) => {
  const all = []; const visit = (n) => { for (const el of n.children) { if (el.matches(sel)) all.push(el); if (el.shadowRoot) visit(el.shadowRoot); visit(el); } }; visit(document);
  const up = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const text = (node) => { const parts = []; const v = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) parts.push(c.textContent); else if (c.nodeType === 1) { if (c.shadowRoot) v(c.shadowRoot); v(c); } } }; if (node.shadowRoot) v(node.shadowRoot); v(node); return parts.join(" ").replace(/\s+/g, " ").trim(); };
  const out = [];
  for (let n = all[1], d = 0; n && d < 9; n = up(n), d++) out.push(`${d} <${n.tagName.toLowerCase()}> "${text(n).slice(0, 120)}"`);
  return out;
}, process.env.ANC), null, 1));
if (process.env.WALK) console.log("walk:", JSON.stringify(await page.evaluate((sel) => {
  const all = []; const visit = (n) => { for (const el of n.children) { if (el.matches(sel)) all.push(el); if (el.shadowRoot) visit(el.shadowRoot); visit(el); } }; visit(document);
  const up = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const stop = document.querySelector("[data-ooj-form]");
  const el = all[1];
  const out = [`stop=<${stop && stop.tagName.toLowerCase()} ${stop && stop.className}>`];
  for (let node = el, d = 0; node && d < 8; node = up(node), d++) {
    if (node === stop) { out.push(`${d}: reached stop`); break; }
    for (let s = node.previousSibling; s; s = s.previousSibling) {
      if (s.nodeType !== 1) continue;
      const ctl = []; const v = (n) => { for (const c of n.children) { if (c.matches('input, textarea, select, [role="combobox"]:not(input), button[aria-haspopup="listbox"]') && c.checkVisibility({ opacityProperty: true })) ctl.push(c); if (c.shadowRoot) v(c.shadowRoot); v(c); } };
      if (s.shadowRoot) v(s.shadowRoot); v(s);
      const txt = (s.innerText || "").trim();
      if (ctl.length) out.push(`${d}: <${s.tagName.toLowerCase()}> holds ${ctl.map((c) => "<" + c.tagName.toLowerCase() + " " + (c.type || "") + " " + c.getBoundingClientRect().width + "x" + c.getBoundingClientRect().height + ">").join(" ")}`);
      if (txt) { out.push(`${d}: <${s.tagName.toLowerCase()}> "${txt.slice(0, 50)}" visible=${s.checkVisibility()}`); break; }
    }
  }
  return out;
}, process.env.WALK), null, 1));
if (process.env.TRACE) console.log("trace:", JSON.stringify(await page.evaluate((sel) => {
  const all = []; const visit = (n) => { for (const el of n.children) { if (el.matches(sel)) all.push(el); if (el.shadowRoot) visit(el.shadowRoot); visit(el); } }; visit(document);
  const deepHas = (root) => { let hit = null; const v = (n) => { for (const el of n.children) { if (!hit && el.matches('input, textarea, select, [role="combobox"]:not(input), button[aria-haspopup="listbox"]')) hit = el; if (el.shadowRoot) v(el.shadowRoot); v(el); } }; if (root.shadowRoot) v(root.shadowRoot); v(root); return hit; };
  const up = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const out = [];
  for (let node = all[1], d = 0; node && d < 8; node = up(node), d++) {
    for (let s = node.previousSibling, k = 0; s && k < 3; s = s.previousSibling, k++) {
      const hit = s.nodeType === 1 && (s.matches('input, textarea, select') ? s : deepHas(s));
      out.push(`${d}: ${s.nodeType === 1 ? "<" + s.tagName.toLowerCase() + ">" : "#text"} "${(s.textContent || "").trim().slice(0, 40)}" ${hit ? "HAS CONTROL <" + hit.tagName.toLowerCase() + " " + (hit.type || "") + " vis=" + hit.checkVisibility() + ">" : ""}`);
    }
  }
  return out;
}, process.env.TRACE), null, 1));
if (process.env.INSPECT) console.log("inspect:", JSON.stringify(await page.evaluate((sel) => {
  const all = []; const visit = (n) => { for (const el of n.children) { if (el.matches(sel)) all.push(el); if (el.shadowRoot) visit(el.shadowRoot); visit(el); } }; visit(document);
  const up = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  return all.slice(0, 2).map((el) => {
    const chain = [];
    for (let n = el, d = 0; n && d < 7; n = up(n), d++) chain.push(`${d} <${n.tagName.toLowerCase()} ${[...n.attributes].filter((a) => /label|aria|id|for|name|class/.test(a.name)).map((a) => a.name + '="' + a.value.slice(0, 40) + '"').join(" ")}> prev="${(n.previousElementSibling && (n.previousElementSibling.innerText || n.previousElementSibling.textContent) || "").trim().slice(0, 60)}"`);
    return chain;
  });
}, process.env.INSPECT), null, 1));
console.log("writes aborted:", aborted.filter((a) => !/collect|analytics|doubleclick|clarity|hotjar|segment|sentry|datadog|bat\.bing/i.test(a)));
if (shot) await page.screenshot({ path: shot, fullPage: true });
await b.close();
