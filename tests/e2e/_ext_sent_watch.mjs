// After a fill, the user sends the form with the site's own button: the
// extension marks the Filled entry sent from the form's accepted POST, or
// from a confirmation on the page, and not from a Next button, a refused
// POST or one without the applicant's email. Fixture pages only, on a
// host the extension may read; the API is stubbed.
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL = "test.person@example.com";
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-sent-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-sent-profile-")), {
  channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

const page = (button, { email = true, status = 200, thanks = false } = {}) => `<!doctype html><meta charset="utf-8"><title>Apply</title>
<form id="f" onsubmit="return false">
  <label>First name <input name="first"></label><label>Last name <input name="last"></label>
  <label>Email <input name="email" value="${EMAIL}"></label><label>Phone <input name="phone"></label>
  <button type="button" id="go">${button}</button>
</form>
<script>
document.getElementById("go").addEventListener("click", async () => {
  const body = JSON.stringify({ first: "Test", ${email ? `email: document.querySelector("[name=email]").value,` : ""} n: 1 });
  await fetch("/oojtest/post?status=${status}", { method: "POST", body, headers: { "content-type": "application/json" } });
  ${thanks ? `document.body.insertAdjacentHTML("beforeend", "<h2>Thank you for applying</h2>"); document.getElementById("f").remove();` : ""}
});
</script>`;

const CASES = [
  ["the form's POST with the email, accepted", page("Submit application"), "request"],
  ["no email in the POST, then a confirmation", page("Submit application", { email: false, thanks: true }), "page"],
  ["a Next button, even with the email", page("Next"), null],
  ["a POST the site refuses", page("Submit application", { status: 422 }), null],
  ["a plain form post that loads a thank-you page", `<!doctype html><title>Apply</title><form method="post" action="/oojtest/thanks">
    <label>First name <input name="first"></label><label>Last name <input name="last"></label>
    <label>Email <input name="email" value="${EMAIL}"></label><label>Phone <input name="phone"></label>
    <button type="submit" id="go">Submit application</button></form>`, "request"],
];

const api = [];
let html = "";
await ctx.route("**/*", (r) => {
  const u = new URL(r.request().url());
  if (u.hostname === "oceanofjobs.com") {
    if (r.request().method() === "POST") api.push(u.pathname + " " + (r.request().postData() || ""));
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ attempt: { state: "filled" } }) });
  }
  if (u.hostname === "boards.greenhouse.io" && u.pathname === "/oojtest/post") {
    return r.fulfill({ status: Number(u.searchParams.get("status")), contentType: "application/json", body: "{}" });
  }
  if (u.hostname === "boards.greenhouse.io" && u.pathname === "/oojtest/thanks") {
    return r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>Thank you for applying</h1>" });
  }
  if (u.hostname === "boards.greenhouse.io") return r.fulfill({ status: 200, contentType: "text/html", body: html });
  return r.abort();
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
await sw.evaluate(() => chrome.storage.local.set({ token: "ooj_test" }));

let failed = 0;
for (const [name, body, want] of CASES) {
  html = body;
  api.length = 0;
  const tab = await ctx.newPage();
  const url = `https://boards.greenhouse.io/oojtest/jobs/${Math.floor(Math.random() * 1e9)}`;
  await tab.goto(url);
  await sw.evaluate(async ([url, email]) => {
    const [t] = await chrome.tabs.query({ url });
    await recordFilled({ id: "00000000000000a1", url, title: "Test job", company_domain: "example.com" }, t.id, 0, email);
  }, [url, EMAIL]);
  await tab.click("#go");
  await sleep(4000);
  const sent = api.find((a) => a.includes("/sent "));
  const got = sent ? JSON.parse(sent.split(" ").slice(1).join(" ")).how : null;
  const ok = got === want && api.some((a) => a.startsWith("/api/me/apply/filled"));
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${got || "not marked sent"}`);
  await tab.close();
}
await ctx.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
