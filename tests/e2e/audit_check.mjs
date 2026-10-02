// The interface-audit fixes of 2026-10-02, checked in a browser against
// the local preview (BASE, default http://localhost:8010): skip link,
// landmarks, labels, the title link, Space on a row, the theme-color
// meta, the contact radios, the copy announcement, the motion toggle.
import { chromium } from "playwright";
const base = process.env.BASE || "http://localhost:8010";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [];
const out = {};
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => { localStorage.setItem("iljobs_geo_asked", "1"); localStorage.setItem("iljobs_theme", "dark"); });

// Board.
await page.goto(base + "/board", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("#jobs-body tr[data-id]").length > 0, null, { timeout: 60000 });
out.board = await page.evaluate(() => ({
  skipLink: !!document.querySelector("a.skip-link[href='#main']"), main: !!document.querySelector("#main[role=main], main#main"),
  h1: document.querySelector("h1")?.textContent, themeColor: document.querySelector('meta[name="theme-color"]').content,
  dateLabel: document.querySelector("#f-date-posted").getAttribute("aria-label"), sortLabel: document.querySelector("#f-sort").getAttribute("aria-label"),
  errorLive: document.querySelector("#jobs-error").getAttribute("aria-live"), countLive: document.querySelector(".list-head-text").getAttribute("aria-live"),
  searchName: document.querySelector("#f-search").name, placeholder: document.querySelector("#f-search").placeholder.slice(-1),
  navLabel: document.querySelector("nav.side-nav").getAttribute("aria-label"), brandNoTranslate: document.querySelector(".side-brand span").getAttribute("translate"),
  titleLink: document.querySelector("#jobs-body .job-title-link")?.getAttribute("href"), logoDims: (() => { const i = document.querySelector("#jobs-body img.company-logo"); return i ? `${i.getAttribute("width")}x${i.getAttribute("height")}` : "none"; })(),
}));
// A plain click on the title opens the pane and stays on the board.
await page.click("#jobs-body .job-title-link");
await page.waitForTimeout(800);
out.board.plainClickStays = page.url().includes("/board") && !page.url().includes("/job/");
out.board.paneOpened = await page.evaluate(() => !!document.querySelector("#job-detail .job-detail-title, #job-detail h2, #job-detail .pane-head"));
// Space on a focused row opens it.
await page.keyboard.press("Escape"); await page.waitForTimeout(300);
await page.focus("#jobs-body tr[data-id]:nth-child(2)"); await page.keyboard.press(" "); await page.waitForTimeout(600);
out.board.spaceOpens = await page.evaluate(() => new URLSearchParams(location.search).has("job") || document.querySelector("tr.selected") !== null);
// Copy announces.
out.board.liveRegionAfterCopy = await page.evaluate(async () => { const btn = document.querySelector(".copy-link-btn"); btn && btn.click(); await new Promise((r) => setTimeout(r, 200)); return document.getElementById("live-announce")?.textContent; });
// Theme toggle updates the meta.
await page.evaluate(() => document.querySelector("#theme-toggle, .theme-toggle")?.click()); await page.waitForTimeout(200);
out.board.themeColorAfterToggle = await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content);

// Companies.
await page.goto(base + "/companies?company=amazon.com", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("#dir-rows .dir-row .dir-name").length > 0, null, { timeout: 120000 }); await page.waitForTimeout(800);
out.companies = await page.evaluate(() => ({
  listRole: document.querySelector("#dir-rows").getAttribute("role"), rowRole: document.querySelector("#dir-rows .dir-row").getAttribute("role"),
  nameIsButton: document.querySelector("#dir-rows .dir-name").tagName, h1: document.querySelector("h1")?.textContent,
  logoDims: (() => { const i = document.querySelector("#dir-rows .dir-logo img"); return i ? `${i.getAttribute("width")}x${i.getAttribute("height")}` : "none"; })(),
  openedFromQuery: document.querySelector("#dir-pane-head")?.textContent.trim().slice(0, 40),
}));
await page.focus("#dir-rows .dir-row:nth-child(2) .dir-name"); await page.keyboard.press("Enter"); await page.waitForTimeout(500);
out.companies.enterOpensAndUrl = page.url().includes("company=");

// Contact: native radios with arrow keys.
await page.goto(base + "/contact", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(300);
await page.focus('input[name="topic"]:checked'); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(100);
out.contact = await page.evaluate(() => ({
  checked: document.querySelector('input[name="topic"]:checked').value, onLabel: document.querySelector(".contact-topic.on").dataset.topic,
  placeholderEnds: document.querySelector("#contact-message").placeholder.slice(-1), emailSpellcheck: document.querySelector("#contact-email").getAttribute("spellcheck"),
}));
await page.fill("#contact-email", "nope"); await page.click("#contact-send"); await page.waitForTimeout(200);
out.contact.inlineError = await page.$eval("#contact-email-error", (e) => e.textContent);
out.contact.focusedField = await page.evaluate(() => document.activeElement.id);

// Index: copy announces, motion toggle pauses.
await page.goto(base + "/", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(500);
out.index = await page.evaluate(async () => {
  document.getElementById("api-copy").click(); await new Promise((r) => setTimeout(r, 300));
  const live = document.getElementById("api-copy-live")?.textContent;
  document.getElementById("motion-toggle").click();
  const paused = getComputedStyle(document.querySelector(".hero-ticker-track")).animationPlayState;
  return { copyLive: live, pausedState: paused, toggleText: document.getElementById("motion-toggle").textContent, nbsp: document.body.innerHTML.includes("20&nbsp;requests") || /20 requests/.test(document.body.textContent) };
});

// Account (signed out): labels present.
await page.goto(base + "/account", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(500);
out.account = await page.evaluate(() => ({
  emailLabel: !!document.querySelector('label[for="acct-email-input"]'), otpLabel: !!document.querySelector('label[for="acct-otp-input"]'),
  alertLabel: !!document.querySelector('label[for="alert-f-search"]'), alertHeading: document.querySelector("#alert-form-title")?.tagName + ":" + document.querySelector("#alert-form-title")?.textContent,
  duplicateSignout: document.querySelectorAll("#account-signout").length, heroSignout: !!document.getElementById("acct-hero-signout"),
}));

// Static pages: h1 and main.
for (const path of ["/stats", "/privacy", "/404"]) {
  await page.goto(base + path, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(200);
  out[path] = await page.evaluate(() => ({ h1: document.querySelector("h1.section-title")?.textContent, main: !!document.querySelector("#main"), skip: !!document.querySelector(".skip-link") }));
}
await b.close();
console.log(JSON.stringify(out, null, 1));
console.log(errors.length ? "PAGE ERRORS:\n" + errors.join("\n") : "no page errors");
