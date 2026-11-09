// Keyboard check of the migrated pages on the local preview: the first Tab
// stops and whether each shows a focus style, the skip link, a header menu
// opened and shut from the keyboard, the phone menu, and the sign-in window.
// usage: node scripts/focus.mjs <out dir> [--local http://127.0.0.1:4173]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "../../tests/e2e/node_modules/playwright/index.mjs";

const args = process.argv.slice(2);
const out = args[0];
const base = args.includes("--local") ? args[args.indexOf("--local") + 1] : "http://127.0.0.1:4173";
const PAGES = ["/", "/privacy", "/terms", "/refunds", "/contact", "/no-such-page"];
mkdirSync(out, { recursive: true });

const focused = (p) => p.evaluate(() => {
  const el = document.activeElement;
  const s = getComputedStyle(el);
  const visible = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none";
  return { el: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${(el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 30)}"`, visible };
});

const browser = await chromium.launch();
const report = {};
for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => { localStorage.setItem("ooj_cookie_consent", "no"); localStorage.setItem("iljobs_theme", t); }, theme);
  for (const path of PAGES) {
    const p = await ctx.newPage();
    await p.goto(base + path, { waitUntil: "networkidle" });
    const stops = [];
    for (let i = 0; i < 25; i++) { await p.keyboard.press("Tab"); stops.push(await focused(p)); }
    report[`${path} ${theme}`] = { stops, invisible: stops.filter((s) => !s.visible).map((s) => s.el) };
    console.log(path, theme, `${stops.filter((s) => s.visible).length}/25 stops show focus`, report[`${path} ${theme}`].invisible.join(", "));
    assert.match(stops[0].el, /Skip to content/, "first Tab is the skip link");
    await p.close();
  }

  // A header menu from the keyboard: Enter opens it, Tab walks its links, Escape shuts it and returns focus.
  const p = await ctx.newPage();
  await p.goto(base + "/privacy", { waitUntil: "networkidle" });
  const jobs = p.getByRole("button", { name: "Jobs" });
  await jobs.focus();
  await p.keyboard.press("Enter");
  assert.equal(await jobs.getAttribute("aria-expanded"), "true");
  await p.keyboard.press("Tab");
  assert.match((await focused(p)).el, /All jobs/);
  await p.waitForTimeout(300); // the panel's fade-in
  await p.screenshot({ path: join(out, `focus-menu-${theme}.jpg`), type: "jpeg", quality: 75, clip: { x: 400, y: 0, width: 640, height: 320 } });
  await p.keyboard.press("Escape");
  assert.equal(await jobs.getAttribute("aria-expanded"), "false");
  assert.match((await focused(p)).el, /Jobs/);
  // Log in opens the sign-in window; Escape closes it.
  await p.getByRole("link", { name: "Log in" }).focus();
  await p.keyboard.press("Enter");
  await p.getByRole("dialog").waitFor();
  await p.waitForTimeout(400); // the window's fade-in
  await p.screenshot({ path: join(out, `signin-${theme}.jpg`), type: "jpeg", quality: 75 });
  await p.keyboard.press("Escape");
  await p.getByRole("dialog").waitFor({ state: "detached" });
  await p.close();
  console.log(theme, "menu, skip link and sign-in window: keyboard checks pass");
  await ctx.close();
}

// The phone menu: the button opens the sheet, focus stays inside, Escape closes it.
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => localStorage.setItem("ooj_cookie_consent", "no"));
const p = await ctx.newPage();
await p.goto(base + "/terms", { waitUntil: "networkidle" });
await p.getByRole("button", { name: "Menu" }).focus();
await p.keyboard.press("Enter");
await p.getByRole("dialog").waitFor();
for (let i = 0; i < 40; i++) await p.keyboard.press("Tab");
assert.ok(await p.evaluate(() => !!document.activeElement.closest("[role=dialog]")), "focus stays in the phone menu");
await p.waitForTimeout(500); // the sheet's slide-in
await p.screenshot({ path: join(out, "phone-menu.jpg"), type: "jpeg", quality: 75 });
await p.keyboard.press("Escape");
await p.getByRole("dialog").waitFor({ state: "detached" });
console.log("phone menu: keyboard checks pass");
await browser.close();
writeFileSync(join(out, "focus.json"), JSON.stringify(report, null, 1));
