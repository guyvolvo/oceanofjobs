// Screenshots of /apply (apply/dist, so run `npm run build` in apply/
// first) at desktop and phone width, dark and light, every section.
// The page is served as https://oceanofjobs.com from the local files,
// /api/me/apply/* is stubbed with the shapes the API returns, and the
// extension is faked through chrome.runtime.sendMessage.
//   node tests/e2e/apply_shot.mjs [outdir]
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const out = process.argv[2] || join(root, "tests/e2e/shots");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();

const API = {
  summary: { plan: "basic", period: "month", limit: 100, daily_max: 10, used: 37, in_progress: 2, remaining: 61, applied_today: 4, filled_today: 6, unconfirmed: 2, needs_input: 1, queued: 3, disputes_left: 3, ai: { used: 12, limit: 200 }, tz: "Asia/Jerusalem" },
  queue: { queue: [
    { job_id: "a1b2c3d4", added_at: ago(30), position: 1, title: "Senior Backend Engineer", company: "Wix", link: "/job/a1b2c3d4", ats: "greenhouse" },
    { job_id: "b2c3d4e5", added_at: ago(20), position: 2, title: "Platform Engineer, Developer Experience", company: "monday.com", link: "/job/b2c3d4e5", ats: "ashby" },
    { job_id: "c3d4e5f6", added_at: ago(2), position: 3, title: "Staff Site Reliability Engineer", company: "Snyk", link: "https://apply.workable.com/snyk/j/123", ats: "workable" },
  ] },
  needs: { needs: [{ attempt_id: "t9", job_id: "d4e5f6a7", title: "Data Engineer", company: "Riskified", link: "/job/d4e5f6a7",
    questions: ["Why do you want to work at Riskified?", "Are you willing to work from the Tel Aviv office three days a week?"],
    drafts: { "Are you willing to work from the Tel Aviv office three days a week?": "Yes" } }] },
  agent: { agent: { version: 3, editable: true, review: "pause",
    style: { tone: "plain", length: "medium", language: "question", notes: "No exclamation marks." },
    facts: [{ id: "0", text: "I led a team of five data engineers at Acme from 2021 to 2024." },
            { id: "1", text: "I built Acme's Kafka and Spark streaming pipeline, which processed 2 billion events a day." }],
    topics: { referral_source: { action: "answer", value: "LinkedIn" }, start_date: { action: "ai", value: "" }, relocation: { action: "ask", value: "" },
              onsite_days: { action: "ai", value: "" }, why_company: { action: "ask", value: "" }, why_role: { action: "ai", value: "" } },
    never_claim: ["security clearance", "a degree"] } },
  history: { applied: [
    ["submitted", "Backend Engineer", "Lemonade", "", false],
    ["unconfirmed", "Full Stack Developer", "Fiverr", "The confirmation page didn't load", true],
    ["filled", "DevOps Engineer", "JFrog", "Filled, waiting for you to submit", false],
    ["in_progress", "Software Engineer", "Taboola", "", false],
    ["needs_input", "Data Engineer", "Riskified", "2 questions need an answer", false],
    ["failed", "ML Engineer", "Lightricks", "The form has a required file field", false],
    ["skipped", "Security Researcher", "Check Point", "Below your minimum skills match", false],
    ["abandoned", "QA Automation Engineer", "Playtika", "The tab was closed", false],
    ["not_sent_disputed", "Frontend Engineer", "Payoneer", "", false],
    ["unconfirmed", "Engineering Manager", "Gong", "", true],
  ].map(([status, title, company, reason, disputable], i) => ({ job_id: `h${i}`, attempt_id: `t${i}`, company, title, url: "", link: `/job/h${i}`, status, reason, at: ago(i * 19), disputable })) },
  profile: { profile: {
    contact: { first_name: "Dana", last_name: "Levi", email: "dana@example.com", phone: "+972 50 123 4567", location: "Tel Aviv, Israel" },
    links: { linkedin: "https://linkedin.com/in/danalevi", github: "", website: "" },
    work: { authorized_countries: ["IL"], needs_sponsorship: false, notice_period: "30 days", salary: "" },
    eeo: { gender: "Woman", race: null, veteran: "decline", disability: null },
    answers: [{ question: "Why do you want to work here?", answer: "I like the product and the team's focus on reliability." }],
    settings: { mode: "queue", sources: ["board", "matches"], unknowns: "skip", guardrails: { min_match: 60, daily_limit: 10, blocked_companies: ["mycurrentemployer.com"], one_per_company_days: null } },
  }, preferences: {} },
};

// The Settings tab's resume card in each state (cloud storage on and a
// resume saved, local storage, no cloud storage on the server), cropped.
//   node tests/e2e/_apply_storage_shot.mjs <outdir>
const STATES = {
  cloud: { mode: "account", ready: true, cv: { name: "Dana_Levi_Resume.pdf", type: "application/pdf", size: 188416, uploaded_at: "2026-10-12T09:00:00Z" },
           workday: true, ai: { provider: "anthropic", model: "claude-haiku-5-5" } },
  local: { mode: "local", ready: true, cv: null, workday: false, ai: null },
  "not-ready": null,
};
const b = await chromium.launch();
for (const mode of ["dark", "light"]) {
  for (const [name, storage] of Object.entries(STATES)) {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1.5 });
    await ctx.route("https://oceanofjobs.com/**", async (r) => {
      const p = new URL(r.request().url()).pathname;
      if (p === "/api/me/storage") return storage ? r.fulfill({ json: storage }) : r.fulfill({ status: 404, json: { error: "no route" } });
      if (p.startsWith("/api/me/apply/")) return r.fulfill({ json: API[p.slice("/api/me/apply/".length).split("/")[0]] ?? {} });
      if (p.startsWith("/api/")) return r.fulfill({ json: {} });
      const file = p === "/apply" || (p.startsWith("/apply/") && !extname(p)) ? join(root, "apply/dist/index.html")
        : p.startsWith("/apply/") ? join(root, "apply/dist", p.slice(7)) : join(root, "frontend", p);
      try { r.fulfill({ body: await readFile(file), contentType: TYPES[extname(file)] || "application/octet-stream" }); }
      catch { r.fulfill(p.endsWith(".json") ? { json: {} } : { status: 404, body: "" }); }
    });
    await ctx.addInitScript((m) => {
      localStorage.setItem("iljobs_theme", m);
      const payload = btoa(JSON.stringify({ email: "dana@example.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: "x" })).replace(/=+$/, "");
      localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: "eyJhbGciOiJub25lIn0." + payload + ".sig", access_token: "a", refresh_token: "r" }));
      document.addEventListener("readystatechange", () => { document.documentElement.dataset.oojExtension = "1"; }, { once: true });
      window.chrome = { runtime: { sendMessage: (id, msg, cb) => setTimeout(() => cb({ ok: true, version: "1.9.11", connected: true }), 30) } };
    }, mode);
    const page = await ctx.newPage();
    await page.goto("https://oceanofjobs.com/apply#settings", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const top = page.locator(".oj-card-title").first();
    const box = await page.locator("form.oj-stack").boundingBox();
    await page.screenshot({ path: join(out, `storage-${name}-${mode}.png`), clip: { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: 420 } });
    await ctx.close();
  }
}
await b.close();
console.log("done");
