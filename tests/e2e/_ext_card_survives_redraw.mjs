// The card's life on pages that redraw themselves. Greenhouse's page is a
// React root on the whole document: when it hydrates after the card is in,
// React rebuilds the tree and the card went with it for good. Local pages,
// the API answered locally; nothing is filled or sent.
//   node tests/e2e/_ext_card_survives_redraw.mjs
//   EXT=<folder> node tests/e2e/_ext_card_survives_redraw.mjs   (another copy, e.g. a baseline)
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const FORM = `<h1>Engineer</h1><form><label>First name <input name="first_name"></label>
<label>Email <input type="email" name="email"></label><label>Phone <input type="tel" name="phone"></label>
<label>Resume <input type="file" name="resume"></label><button type="submit">Submit application</button></form>`;
// What each page does to the document once it has loaded. A "hydration" is
// the card's host removed and the body rebuilt, as React does on error #418.
const SCRIPTS = {
  // Before hydration: the card goes in at ~500 ms, the page hydrates at 2.5 s.
  hydrate: `setTimeout(() => { document.querySelectorAll('[data-ooj-fill]').forEach((e) => e.remove()); document.body.innerHTML = document.body.innerHTML; }, 2500);`,
  // After hydration: the page has settled before the card's first look.
  settled: `document.body.innerHTML = document.body.innerHTML;`,
  // Removed again and again: three hydrations, 2.5 s apart.
  repeat: `let n = 0; const t = setInterval(() => { document.querySelectorAll('[data-ooj-fill]').forEach((e) => e.remove()); if (++n === 3) clearInterval(t); }, 2500);`,
  // A busy page: nodes added and removed for 4 s, the card never touched.
  busy: `const t = setInterval(() => { const d = document.createElement('div'); document.body.appendChild(d); setTimeout(() => d.remove(), 30); }, 20); setTimeout(() => clearInterval(t), 4000);`,
  none: ``,
};
const page = (kind) => `<!doctype html><html><head><title>Engineer</title></head><body>${FORM}<script>${SCRIPTS[kind]}</script></body></html>`;

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-redraw-"));
fs.cpSync(path.resolve(process.env.EXT || "extension"), ext, { recursive: true });
// As a user who allowed all sites: the card also comes to company careers pages.
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("https://*/*");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-redraw-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route("https://job-boards.greenhouse.io/**", (r) => {
  const u = new URL(r.request().url());
  if (u.pathname === "/about") return r.fulfill({ contentType: "text/html", body: "<!doctype html><title>About</title><p>No form here.</p>" });
  return r.fulfill({ contentType: "text/html", body: page(u.searchParams.get("kind") || "none") });
});
// A company careers page with Greenhouse's form in a frame (wiz.io, esri.com, live 2026-11-09).
const CAREERS = `<!doctype html><html><head><title>Senior Engineer - Careers</title></head><body>
<h1>Senior Engineer</h1><p>Join our team. Apply below.</p><a href="#apply">Apply now</a>
<iframe id="grnhse_iframe" src="https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123" style="width:100%;height:1200px;border:0"></iframe></body></html>`;
await ctx.route("https://careers.acme-test.com/**", (r) => r.fulfill({ contentType: "text/html", body: CAREERS }));
await ctx.route("https://oceanofjobs.com/**", (r) => {
  const u = r.request().url();
  if (u.includes("/me/apply/profile")) return r.fulfill({ json: { profile: { contact: { email: "a@b.c" }, settings: {} }, preferences: {} } });
  if (u.includes("/me/apply/summary")) return r.fulfill({ json: { plan: "free", remaining: 10, applied_today: 0 } });
  if (u.includes("/me/apply/history")) return r.fulfill({ json: { applied: [] } });
  return r.fulfill({ status: 200, json: {} });
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(() => chrome.storage.local.set({ token: "t", authError: false }));

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : "  -- " + JSON.stringify(detail)}`); if (!ok) failed++; };
const cards = (p) => p.evaluate(() => document.querySelectorAll("[data-ooj-fill]").length);
const open = async (kind) => {
  const p = await ctx.newPage();
  await p.goto(`https://job-boards.greenhouse.io/test/jobs/1?kind=${kind}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("[data-ooj-fill]", { state: "attached", timeout: 15000 }).catch(() => null);
  return p;
};

{ // Card in before the page hydrates, removed by the hydration.
  const p = await open("hydrate");
  const first = await cards(p);
  await p.waitForTimeout(4500);
  check("a card added before hydration comes back after it", first === 1 && (await cards(p)) === 1, { first, after: await cards(p) });
  await p.close();
}
{ // Card in after the page has settled.
  const p = await open("settled");
  await p.waitForTimeout(2500);
  check("a card added after hydration stays, once", (await cards(p)) === 1, await cards(p));
  await p.close();
}
{ // Removed three times.
  const p = await open("repeat");
  const seen = [];
  for (let i = 0; i < 4; i++) { await p.waitForTimeout(2500); seen.push(await cards(p)); }
  check("a card removed again and again comes back each time, never twice", seen.every((n) => n === 1), seen);
  await p.close();
}
{ // A page that keeps mutating.
  const p = await open("busy");
  const seen = [];
  for (let i = 0; i < 5; i++) { await p.waitForTimeout(1000); seen.push(await cards(p)); }
  check("a busy page never gets a second card", seen.every((n) => n === 1), seen);
  await p.close();
}
{ // Navigated away to a page with no form.
  const p = await open("none");
  await p.goto("https://job-boards.greenhouse.io/about", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  check("after navigating to a page with no form, no card", (await cards(p)) === 0, await cards(p));
  await p.close();
}
{ // A careers page around Greenhouse's frame: one card for the one form.
  const p = await ctx.newPage();
  await p.goto("https://careers.acme-test.com/careers/job/1", { waitUntil: "domcontentloaded" });
  const all = async () => (await Promise.all(p.frames().map((f) => f.evaluate(() => document.querySelectorAll("[data-ooj-fill]").length).catch(() => 0)))).reduce((a, b) => a + b, 0);
  const seen = [];
  for (let i = 0; i < 6; i++) { await p.waitForTimeout(2000); seen.push(await all()); }
  if (process.env.DEBUG) console.log(p.frames().map((f) => f.url()));
  check("a careers page with Greenhouse's form in a frame shows one card, not two", seen.at(-1) === 1 && seen.every((n) => n <= 1), seen);
  await p.close();
}

{ // The extension reloaded (an update, or turned off and on): this page's
  // script is cut off from the extension, so its card would do nothing.
  const p = await open("none");
  const before = await cards(p);
  await sw.evaluate(() => chrome.runtime.reload()).catch(() => null);
  await p.waitForTimeout(3000);
  check("after the extension reloads, the dead card is taken off the page", before === 1 && (await cards(p)) === 0, { before, after: await cards(p) });
  await p.close();
}

await ctx.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
