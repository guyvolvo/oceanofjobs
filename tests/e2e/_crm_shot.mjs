// The CRM's pages from crm/dist with its API stubbed (sample members, no
// AWS, no Access), every tab, dark and light.
//   node tests/e2e/_crm_shot.mjs <outdir>
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../crm/dist");
const out = process.argv[2];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
const people = ["dana@example.com", "omer.k@example.com", "noa@example.org", "yael.b@example.com", "amit@example.net", "lior@example.com", "maya.s@example.com"];
const contacts = people.map((email, i) => ({
  id: "u" + i, email, verified: true, provider: ["google", "email", "github"][i % 3], status: "CONFIRMED", enabled: true, created: ago(i * 4 + 1), updated: ago(i),
  newsletter: i % 2 === 0, newsletter_source: ["signup", "waitlist", "settings"][i % 3], newsletter_at: ago(i * 3), unsubscribed_at: null,
  agreed_version: i < 5 ? "2026-10-25" : null, agreed_at: i < 5 ? ago(i) : null, plan: i === 0 ? "pro" : "free",
  waitlist: i % 3 === 1 ? ["pro"] : i % 3 === 2 ? ["basic"] : [], tags: i === 0 ? ["owner"] : i === 2 ? ["beta", "israel"] : [],
}));
const API = {
  "/api/me": { email: "guyvoloshin@gmail.com", sending: false },
  "/api/dashboard": { complete: true, members: 7, new_7: 2, new_30: 7, newsletter: 4, agreed: 5, waitlist: { basic: 2, pro: 2 }, plans: { free: 6, pro: 1 },
    by_day: Array.from({ length: 30 }, (_, i) => [ago(29 - i).slice(0, 10), (i * 7) % 5]) },
  "/api/contacts": { complete: true, contacts },
  "/api/segments": { segments: [{ sk: "s1", name: "Pro waitlist", filter: { waitlist: "pro", newsletter: true }, updated: ago(1) }] },
  "/api/campaigns": { campaigns: [
    { sk: "c1", subject: "Cloud storage for your resume", body: "## What's new\n\nYou can now save your **resume** to your account.\n\n- Works on any computer\n- [Read more](https://oceanofjobs.com/docs/changelog)",
      segment: "", status: "draft", created: ago(1), updated: ago(0), sent: 0 },
    { sk: "c2", subject: "Auto apply on 14 sites", body: "Hello", segment: "s1", status: "sent", created: ago(9), updated: ago(9), sent: 3, sent_at: ago(9) }] },
  "/api/changelog": { entries: [{ sk: "e1", date: "2026-10-25", title: "Extension 1.9.11", body: "Send detection.", created: ago(0), published_at: ago(0) }] },
  "/api/inbox": { messages: [
    { sk: ago(0.02) + "#3", dir: "in", email: "noa@example.org", name: "Noa", subject: "Re: Try Ocean of Jobs Pro free", text: "Yes please, count me in.\n\nNoa", read: false, contact: "u2" },
    { sk: ago(0.5) + "#2", dir: "out", email: "omer.k@example.com", name: "Omer", subject: "Question about Workday", text: "Hi Omer, yes, Workday works. Add your Workday password in the extension's settings.", read: true, contact: "u1" },
    { sk: ago(0.6) + "#1", dir: "in", email: "omer.k@example.com", name: "Omer", subject: "Question about Workday", text: "Does the extension work on Workday sites?", read: true, contact: "u1", attachments: 1 }] },
  "/api/waitlist": { counts: { pro: { cap: 100, taken: 3 } }, people: [
    { id: "u1", email: "omer.k@example.com", waitlist: "pro", joined_at: ago(6), status: "approved", newsletter: true, plan: "pro", license: { plan: "pro", until: "2026-12-31" } },
    { id: "u4", email: "amit@example.net", waitlist: "pro", joined_at: ago(2), status: "waiting", newsletter: true, plan: "free", license: null },
    { id: "u2", email: "noa@example.org", waitlist: "basic", joined_at: ago(1), status: "waiting", newsletter: true, plan: "free", license: null },
    { id: "u5", email: "lior@example.com", waitlist: "pro", joined_at: ago(0.3), status: "waiting", newsletter: false, plan: "free", license: null }] },
  "/api/audit": { entries: [{ sk: ago(0) + "#a", who: "guyvoloshin@gmail.com", action: "export", detail: { count: 7 } },
    { sk: ago(0.1) + "#b", who: "guyvoloshin@gmail.com", action: "test email", detail: { campaign: "c1" } }] },
  "/api/contacts/u2": { contact: contacts[2], activity: { alerts: 3, active_alerts: 2, saved: 12, applications: 5 },
    notes: [{ sk: ago(2) + "#n", text: "Asked about the Pro plan on the contact form." }], billing_url: "https://sandbox-vendors.paddle.com",
    billing: { plan: "pro", paid: { plan: "basic", status: "active", period_end: ago(-20), subscription_id: "sub_01jabc", customer_id: "ctm_01jxyz", event_at: ago(10) },
      license: { plan: "pro", until: "2026-12-31", note: "Beta tester", by: "guyvoloshin@gmail.com", at: ago(1) },
      ledgers: [{ key: "#ledger#month#2026-10", held: 6, charged: 5 }, { key: "#ledger#day#2026-10-25", held: 1, charged: 1 }] },
    emails: [{ sk: ago(3) + "#e", subject: "About your refund", body: "Hi", to: "noa@example.org" }] },
};
const { TRIGGERS, ACTIONS } = await import("../../crm/lib/auto.mjs");
API["/api/flows"] = { sending: true, actions: ACTIONS,
  triggers: TRIGGERS.map((t) => ({ id: t.id, group: t.group, name: t.name, help: t.help || "", days: t.days ?? null, event: !!t.event })),
  flows: [{ id: "f1", name: "Pro waitlist confirmation", trigger: "waitlist_pro", enabled: true, conditions: {}, runs: 12, last_run_at: ago(0.1),
    actions: [{ type: "email", subject: "You're on the Pro waitlist", body: "Hi {{email}}" }, { type: "tag_add", tag: "pro-waitlist" }, { type: "slack", url: "https://hooks.slack.com/x", text: "{{email}} joined" }] },
    { id: "f2", name: "Connect the extension", trigger: "no_extension", days: 3, enabled: false, conditions: { newsletter: true }, runs: 0,
      actions: [{ type: "wait", days: 1 }, { type: "email", subscribers: true }] }] };
let cropped = null;
const b = await chromium.launch();
const errors = [];
for (const mode of ["dark", "light"]) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1.25 });
  await ctx.route("http://crm.local/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p === "/api/images" && r.request().method() === "GET") return r.fulfill({ json: { images: [
      { sk: "2", url: "https://oceanofjobs.com/mail/sample-a.jpg" }, { sk: "1", url: "https://oceanofjobs.com/mail/sample-b.jpg" }] } });
    if (p === "/api/images" && r.request().method() === "POST") { cropped = Buffer.from(JSON.parse(r.request().postData()).data, "base64"); return r.fulfill({ json: { url: "https://oceanofjobs.com/mail/picked.jpg" } }); }
    if (p.startsWith("/api/")) return r.fulfill({ json: API[p] ?? {} });
    const file = join(root, p === "/" ? "crm.html" : p);
    try { r.fulfill({ body: await readFile(file), contentType: TYPES[extname(file)] || "application/octet-stream" }); }
    catch { r.fulfill({ status: 404, body: "" }); }
  });
  // The email header isn't served from the site until it deploys; use the repo's copy.
  await ctx.route("https://oceanofjobs.com/img/email-header.jpg", async (r) =>
    r.fulfill({ body: await readFile(resolve(import.meta.dirname, "../../frontend/img/email-header.jpg")), contentType: "image/jpeg" }));
  for (const [name, file] of [["sample-a", "image-dithered.png"], ["sample-b", "serenox-Image 51-dithered.png"]]) {
    await ctx.route(`https://oceanofjobs.com/mail/${name}.jpg`, async (r) => r.fulfill({ body: await readFile(resolve(import.meta.dirname, "../../frontend/img", file)), contentType: "image/png" }));
  }
  await ctx.route("https://oceanofjobs.com/mail/picked.jpg", (r) => r.fulfill({ body: cropped || Buffer.alloc(0), contentType: "image/jpeg" }));
  await ctx.addInitScript((m) => localStorage.setItem("crm_theme", m), mode);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  for (const tab of ["overview", "inbox", "contacts", "waitlist", "flows", "segments", "emails", "changelog", "activity"]) {
    await page.goto(`http://crm.local/#${tab}`);
    await page.reload();
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(out, `crm-${tab}-${mode}.png`), fullPage: true });
  }
  await page.goto("http://crm.local/#flows"); await page.reload(); await page.waitForTimeout(600);
  await page.getByText("Welcome approved beta users").click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `crm-flow-editor-${mode}.png`), fullPage: true });
  await page.goto("http://crm.local/#inbox"); await page.reload(); await page.waitForTimeout(600);
  await page.locator(".crm-thread").nth(1).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `crm-inbox-open-${mode}.png`), fullPage: true });
  await page.goto("http://crm.local/#contacts"); await page.reload(); await page.waitForTimeout(600);
  await page.getByText("noa@example.org").first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, `crm-member-${mode}.png`) });
  await page.locator(".crm-dialog").evaluate((el) => { el.style.maxHeight = "none"; });
  await page.locator(".crm-dialog").screenshot({ path: join(out, `crm-member-full-${mode}.png`) });
  await page.keyboard.press("Escape");
  await page.locator("[role=checkbox]").nth(2).click();
  await page.locator("[role=checkbox]").nth(3).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `crm-picked-${mode}.png`), clip: { x: 0, y: 0, width: 1360, height: 520 } });
  await page.goto("http://crm.local/#emails"); await page.reload(); await page.waitForTimeout(600);
  await page.getByText("Cloud storage for your resume").click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, `crm-editor-${mode}.png`), fullPage: true });
  if (mode === "dark") {
    await page.screenshot({ path: join(out, "crm-gallery.png"), fullPage: true });
    await page.locator('input[type=file][accept="image/*"]').setInputFiles(resolve(import.meta.dirname, "../../frontend/img/image-dithered.png"));
    await page.waitForTimeout(800);
    await page.mouse.move(700, 400);
    await page.screenshot({ path: join(out, "crm-crop.png") });
    await page.getByText("Use this crop").click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(out, "crm-editor-picked.png"), fullPage: true });
  }
  await ctx.close();
}
await b.close();
console.log(errors.length ? errors.join("\n") : "no page errors");
