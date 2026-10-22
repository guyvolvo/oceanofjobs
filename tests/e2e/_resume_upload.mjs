// The AI agent's resume on /apply: read in the browser (PDF, DOCX, MD), sent
// as text only, and only after the privacy box is ticked.
// Run from the repo root after `npm run build` in apply/: node tests/e2e/_resume_upload.mjs
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "ooj-resume-"));
const PHRASE = "Built a Kafka pipeline for two billion events a day";
const failures = [];
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : "  -- " + detail}`); if (!ok) failures.push(name); };

// Sample files in each format, made here.
writeFileSync(join(dir, "resume.md"), `# Dana Example\n\nData engineer.\n\n- ${PHRASE}.\n- Led a team of five at Acme from 2021 to 2024.\n`);
execFileSync("python", ["-c", `
import zipfile, sys
d = sys.argv[1]
doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ''.join(f'<w:p><w:r><w:t>{t}</w:t></w:r></w:p>' for t in ["Dana Example", "Data engineer.", "${PHRASE}.", "Led a team of five at Acme from 2021 to 2024."]) + '</w:body></w:document>'
with zipfile.ZipFile(d + '/resume.docx', 'w') as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml', doc)
`, dir]);
writeFileSync(join(dir, "old.doc"), "not really a doc");

const browser = await chromium.launch();
const printer = await browser.newPage();
await printer.setContent(`<h1>Dana Example</h1><p>Data engineer.</p><ul><li>${PHRASE}.</li><li>Led a team of five at Acme from 2021 to 2024.</li></ul>`);
await printer.pdf({ path: join(dir, "resume.pdf") });
await printer.close();

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const jwt = "x." + Buffer.from(JSON.stringify({ email: "dana@example.com", exp: 4e9 })).toString("base64url") + ".x";
const agent = { version: 1, editable: true, review: "pause", resume: null, never_claim: [], facts: [],
  style: { tone: "plain", length: "medium", language: "question", notes: "" },
  topics: Object.fromEntries(["referral_source", "start_date", "relocation", "onsite_days", "why_company", "why_role"].map((t) => [t, { action: "ai", value: "" }])) };
const sent = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((tok) => localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: tok, access_token: "a", refresh_token: "r", expires_at: 4e12 })), jwt);
await ctx.route("https://oceanofjobs.com/**", async (r) => {
  const req = r.request();
  const p = new URL(req.url()).pathname;
  if (p === "/api/me/apply/agent/resume") {
    const body = req.postDataJSON();
    sent.push(body);
    return r.fulfill({ json: { resume: { name: body.name, chars: body.text.length, truncated: false, uploaded_at: new Date().toISOString() } } });
  }
  if (p === "/api/me/apply/agent") return r.fulfill({ json: { agent } });
  if (p.startsWith("/api/me/apply/summary")) return r.fulfill({ json: { plan: "basic", period: "month", limit: 100, used: 0, in_progress: 0, remaining: 100,
    applied_today: 0, filled_today: 0, unconfirmed: 0, needs_input: 0, queued: 0, disputes_left: 5, ai: { used: 0, limit: 300 }, tz: "UTC" } });
  if (p.startsWith("/api/")) return r.fulfill({ json: {} });
  const file = p === "/apply" || (p.startsWith("/apply/") && !extname(p)) ? join(root, "apply/dist/index.html")
    : p.startsWith("/apply/") ? join(root, "apply/dist", p.slice(7)) : join(root, "frontend", p);
  if (!existsSync(file)) return r.fulfill({ status: 404, body: "" });
  return r.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] || "application/octet-stream" });
});
await ctx.route(/^(?!https:\/\/oceanofjobs\.com)/, (r) => r.abort());
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("https://oceanofjobs.com/apply#agent");
await page.waitForTimeout(1500);

const button = page.getByRole("button", { name: "Add resume" });
check("Add resume is disabled until the privacy box is ticked", await button.isDisabled());
await page.getByText("I agree to the").click();
check("and enabled once it is", await button.isEnabled());

for (const name of ["resume.pdf", "resume.docx", "resume.md"]) {
  const before = sent.length;
  await page.locator('input[type="file"][accept=".pdf,.docx,.md"]').setInputFiles(join(dir, name));
  await page.waitForTimeout(2500);
  const body = sent[before] || {};
  check(`${name}: read in the browser and sent as text, with consent`, body.name === name && body.consent === true
    && typeof body.text === "string" && body.text.includes(PHRASE) && !("file" in body), JSON.stringify(body).slice(0, 300));
  // Back to the empty state for the next format.
  if (await page.getByRole("button", { name: "Remove" }).count()) {
    await ctx.unroute("https://oceanofjobs.com/api/me/apply/agent/resume");
    await ctx.route("https://oceanofjobs.com/api/me/apply/agent/resume", async (r) => {
      if (r.request().method() === "DELETE") return r.fulfill({ status: 204, body: "" });
      const b = r.request().postDataJSON();
      sent.push(b);
      return r.fulfill({ json: { resume: { name: b.name, chars: b.text.length, truncated: false, uploaded_at: new Date().toISOString() } } });
    });
    await page.getByRole("button", { name: "Remove" }).click();
    await page.waitForTimeout(500);
    await page.getByText("I agree to the").click();
  }
}
const before = sent.length;
await page.locator('input[type="file"][accept=".pdf,.docx,.md"]').setInputFiles(join(dir, "old.doc"));
await page.waitForTimeout(1000);
check("a .doc file isn't sent, and says to save it as .docx", sent.length === before && (await page.getByText("Save it as a .docx file first").count()) > 0);
check("no page errors", errors.length === 0, errors.join("; "));
await browser.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
