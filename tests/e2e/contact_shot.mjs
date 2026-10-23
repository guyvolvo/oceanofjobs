// The contact page (apply/dist/contact.html, so run `npm run build` in
// apply/ first), served as https://oceanofjobs.com/contact from the local
// files with /api/contact stubbed. Checks what the form sends and shows,
// then screenshots desktop and phone, dark and light, failing on a page
// error or a horizontal scroll.
//   node tests/e2e/contact_shot.mjs [outdir]
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const out = process.argv[2] || join(root, "tests/e2e/shots");
await mkdir(out, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = `${b64({ alg: "none" })}.${b64({ email: "dana@example.com", name: "Dana Levi", sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}: ${name}`); if (!ok) failed++; };
const errs = [];
const browser = await chromium.launch();

async function open({ w = 1280, h = 900, mode = "dark", signedIn = false, api = 200 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const sent = [];
  await ctx.route("https://oceanofjobs.com/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p === "/api/contact") {
      sent.push(JSON.parse(r.request().postData()));
      return r.fulfill({ status: api, contentType: "application/json", body: api === 200 ? '{"ok":true}' : '{"error":"x"}' });
    }
    if (p.startsWith("/api/")) return r.fulfill({ status: 404, body: "" });
    const file = p === "/contact" ? join(root, "apply/dist/contact.html")
      : p.startsWith("/apply/") ? join(root, "apply/dist", p.slice(7)) : join(root, "frontend", p);
    try { r.fulfill({ body: await readFile(file), contentType: TYPES[extname(file)] || "application/octet-stream" }); }
    catch { r.fulfill({ status: 404, body: "" }); }
  });
  await ctx.addInitScript(([m, token]) => {
    localStorage.setItem("iljobs_theme", m);
    localStorage.setItem("ooj_cookie_consent", "no");
    if (token) localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: token, access_token: "a", refresh_token: "r" }));
  }, [mode, signedIn ? jwt : null]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("https://oceanofjobs.com/contact", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Get in touch" }).waitFor();
  return { ctx, page, sent };
}

// Checks.
{
  const { ctx, page, sent } = await open();
  check("signed out, name and email start empty", await page.getByRole("textbox", { name: "Name", exact: true }).inputValue() === "" && await page.getByRole("textbox", { name: "Email", exact: true }).inputValue() === "");
  check("four topics, Question picked", (await page.getByRole("tab").allTextContents()).join("|") === "Question|Feedback|Feature request|Bug report"
    && await page.getByRole("tab", { name: "Question" }).getAttribute("aria-selected") === "true");
  check("no bug banner for a question", !(await page.getByText("Bugs get fixed faster as a GitHub issue.").isVisible()));
  await page.getByRole("tab", { name: "Bug report" }).click();
  check("a bug report shows the GitHub banner", await page.getByText("Bugs get fixed faster as a GitHub issue.").isVisible()
    && await page.getByRole("link", { name: "Open an issue", exact: true }).getAttribute("href") === "https://github.com/guyvolvo/oceanofjobs/issues/new");
  check("and its own placeholder", (await page.getByRole("textbox", { name: "Message", exact: true }).getAttribute("placeholder")).startsWith("What happened"));
  await page.getByRole("button", { name: "Send message" }).click();
  check("an empty form sends nothing and names both problems", sent.length === 0
    && await page.getByText("An email address is needed for the reply.").isVisible() && await page.getByText("Add a little more: at least 10 characters.").isVisible());
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("dana@example.com");
  check("typing in a field clears its error", !(await page.getByText("An email address is needed for the reply.").isVisible()));
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Dana");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Saving a job did nothing on the board.");
  check("the counter follows the message", await page.getByText("38 / 2000").isVisible());
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Message sent").waitFor();
  const s = sent[0] || {};
  check("one POST with the topic as the first line and an empty trap", sent.length === 1 && s.name === "Dana" && s.email === "dana@example.com"
    && s.topic === "Bug report" && s.message === "Topic: Bug report\n\nSaving a job did nothing on the board." && s.website === "");
  check("the sent card names the address", await page.getByText("Thanks. The reply will go to dana@example.com.").isVisible());
  await page.getByRole("button", { name: "Send another message" }).click();
  check("Send another message brings back an empty message", await page.getByRole("textbox", { name: "Message", exact: true }).inputValue() === "");
  await ctx.close();
}
{
  const { ctx, page } = await open({ signedIn: true });
  check("signed in, name and email are filled from the account", await page.getByRole("textbox", { name: "Name", exact: true }).inputValue() === "Dana Levi"
    && await page.getByRole("textbox", { name: "Email", exact: true }).inputValue() === "dana@example.com" && await page.getByText("Filled from your account. For the reply.").isVisible());
  await ctx.close();
}
{
  const { ctx, page } = await open({ api: 500 });
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("dana@example.com");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("A question about the API, please.");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Not sent. Try again, or email guyvoloshin@oceanofjobs.com.").waitFor();
  check("a failed send keeps the message and says so", await page.getByRole("textbox", { name: "Message", exact: true }).inputValue() === "A question about the API, please.");
  await ctx.close();
}

// Screenshots.
for (const mode of ["dark", "light"]) {
  for (const [name, w, h] of [["desktop", 1280, 900], ["phone", 390, 900]]) {
    const { ctx, page } = await open({ w, h, mode });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (wide) check(`${name} ${mode}: no horizontal scroll`, false);
    await page.screenshot({ path: join(out, `contact-${name}-${mode}.png`), fullPage: true });
    await ctx.close();
  }
}

await browser.close();
check(errs.length ? `page errors: ${errs.join(" | ")}` : "no page errors", !errs.length);
console.log(failed ? `${failed} failed` : "all checks passed");
process.exit(failed ? 1 : 0);
