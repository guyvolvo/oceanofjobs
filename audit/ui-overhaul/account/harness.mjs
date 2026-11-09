// Phase 6 checks for /account and /apply: screenshots (live against the
// local preview, light and dark, 1440 and 390), the loading, empty, error
// and signed-out states, the sign-out (audit blocker 9), the keyboard, and
// the deep links (audit blocker 3).
//
// Signed in means a made-up token in localStorage. Every /api/me call, on
// the live page and the new one alike, is answered here from fixtures in
// the shapes the code reads (src/api.ts, src/account/data.ts, api/*.py);
// nothing reaches the real /api/me, and Cognito is blocked outright.
//
// usage: node audit/ui-overhaul/account/harness.mjs <out dir> [shots|states|signout|focus|links|all] [--local http://127.0.0.1:4178]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "../../../tests/e2e/node_modules/playwright/index.mjs";

const args = process.argv.slice(2);
const out = args[0];
const what = args[1] || "all";
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const LOCAL = opt("--local", "http://127.0.0.1:4178");
const LIVE = "https://oceanofjobs.com";
mkdirSync(out, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const ID_TOKEN = `${b64({ alg: "none" })}.${b64({ sub: "u1", email: "dana@example.com", name: "Dana Levi", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const day = (n) => new Date(Date.now() - n * 864e5).toISOString();
const iso = (n) => day(n).slice(0, 10);

// The fixtures.
const SKILLS = ["python", "react", "typescript", "aws", "docker", "kubernetes", "sql", "go"];
const JOBS = Array.from({ length: 12 }, (_, i) => ({
  id: (0x1a2b3c4d5e6f7000 + i).toString(16), title: ["Senior Backend Engineer", "Full Stack Developer", "Platform Engineer", "Data Engineer"][i % 4] + (i > 3 ? ` ${i}` : ""),
  company_name: ["Wix", "Monday.com", "Snyk", "Riskified"][i % 4], company_domain: ["wix.com", "monday.com", "snyk.io", "riskified.com"][i % 4],
  location: ["Tel Aviv, Israel", "Remote", "Haifa, Israel"][i % 3], url: "https://example.com/careers/" + i, closed_at: i === 2 ? day(3) : null,
  skills: ["python,aws,docker,terraform", "react,typescript,node", "go,kubernetes,terraform", "python,sql,spark,terraform"][i % 4],
  salary_text: `₪${30 + (i % 6) * 5},000 to ₪${40 + (i % 6) * 5},000 a month`, logo_url: "",
}));
const PROFILE = { skills: SKILLS, seniority: "senior", workplace: ["hybrid", "remote"], israel_only: false, country: ["IL"], city: ["Tel Aviv"],
  cadence: "daily", digest_time: "09:00", digest_tz: "Asia/Jerusalem", digest_day: 0 };
const DASH = { computed_at: day(0), history: { days: Array.from({ length: 90 }, (_, i) => ({ day: iso(89 - i), new: 4 + ((i * 7) % 11), open: 300 + i * 3 })) },
  matches: JOBS, counts: { python: 4210, react: 3120, typescript: 2890, aws: 3650, docker: 2400, kubernetes: 1980, sql: 3300, go: 990, terraform: 1500 } };
const ALERTS = [
  { alert_id: "a1", active: true, filter: { search: "backend", country: "IL", workplace: "hybrid" }, created_at: day(20), last_notified_at: day(0.2) },
  { alert_id: "a2", active: false, filter: { department: "Data", seniority: "senior" }, created_at: day(40) },
  { alert_id: "a3", active: true, filter: { search: "backend", country: "IL", workplace: "hybrid" }, created_at: day(2) },
];
const TOKENS = [
  { id: "aaaaaaaa", name: "Chrome extension", hint: "QOIM", created_at: day(12), last_used_at: day(0), scope: "extension" },
  { id: "bbbbbbbb", name: "Claude Code laptop", hint: "Vz9n", created_at: day(20), expires_at: day(-70), scope: "mcp",
    permissions: { saved: "write", queue: "write", alerts: "read", preferences: "none" } },
];
const SUMMARY = { plan: "basic", period: "month", limit: 100, daily_max: 20, used: 37, in_progress: 2, remaining: 61, applied_today: 3, filled_today: 5,
  unconfirmed: 2, needs_input: 1, queued: 4, disputes_left: 5, ai: { used: 41, limit: 300 }, tz: "Asia/Jerusalem" };
const QUEUE = JOBS.slice(0, 4).map((j, i) => ({ job_id: j.id, added_at: day(i + 1), position: i, title: j.title, company: j.company_name, link: `/job/${j.id}`,
  ats: ["greenhouse", "workday", "ashby", "lever"][i] }));
const NEEDS = [{ attempt_id: "t1", job_id: JOBS[5].id, title: JOBS[5].title, company: JOBS[5].company_name, link: `/job/${JOBS[5].id}`,
  questions: ["Why do you want to work here?", "What is your notice period?"], drafts: { "Why do you want to work here?": "I have built payment systems for six years and want to work on fraud at scale." } },
  { attempt_id: "t2", job_id: JOBS[6].id, title: JOBS[6].title, company: JOBS[6].company_name, link: "https://example.com/apply/6", questions: [], ready: true }];
const STATUSES = ["submitted", "unconfirmed", "filled", "in_progress", "needs_input", "failed", "skipped", "abandoned", "not_sent_disputed", "submitted", "unconfirmed", "submitted"];
const HISTORY = STATUSES.map((s, i) => ({ job_id: JOBS[i].id, attempt_id: `at${i}`, company: JOBS[i].company_name, title: JOBS[i].title, url: JOBS[i].url,
  link: `/job/${JOBS[i].id}`, status: s, reason: s === "failed" ? "The form had a required field the extension couldn't fill" : "", at: day(i), disputable: s === "unconfirmed" }));
const APPLY_PROFILE = {
  contact: { first_name: "Dana", last_name: "Levi", email: "dana@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://linkedin.com/in/dana", github: "", website: "" },
  work: { authorized_countries: ["IL"], needs_sponsorship: false, notice_period: "30 days", salary: "35,000 ILS a month" },
  eeo: { gender: null, race: "decline", veteran: null, disability: null },
  answers: [{ question: "How did you hear about us?", answer: "LinkedIn" }],
  settings: { mode: "queue", fill: "half", sources: ["board", "mcp"], unknowns: "ai", guardrails: { min_match: 60, daily_limit: 10, blocked_companies: ["acme.com"], one_per_company_days: 30 } },
};
const AGENT = { version: 3, style: { tone: "plain", length: "short", language: "question", notes: "" }, facts: [{ id: "f1", text: "I led a team of five engineers at Acme from 2021 to 2024." }],
  topics: { referral_source: { action: "answer", value: "LinkedIn" }, start_date: { action: "ai", value: "" }, relocation: { action: "ask", value: "" },
    onsite_days: { action: "ai", value: "" }, why_company: { action: "ai", value: "" }, why_role: { action: "ask", value: "" } },
  never_claim: ["security clearance"], editable: true, resume: { name: "dana-levi-cv.pdf", chars: 6120, truncated: false, uploaded_at: day(9) } };
const STORAGE = { mode: "account", ready: true, cv: { name: "dana-levi-cv.pdf", type: "application/pdf", size: 182000, uploaded_at: day(9) }, workday: true, ai: null };

function fixture(path, search, method, state) {
  if (state === "error") return { status: 500, json: { error: "boom" } };
  const empty = state === "empty";
  if (method !== "GET") {
    if (path === "/api/me/profile") return { json: { profile: PROFILE } };
    if (path === "/api/me/apply/profile") return { json: { profile: APPLY_PROFILE } };
    if (path === "/api/me/email") return { json: { newsletter: false } };
    return { status: 204 };
  }
  switch (path) {
    case "/api/me/profile": return { json: { profile: empty ? { skills: [] } : PROFILE, skill_spec: null } };
    case "/api/me/dashboard": return { json: empty ? {} : DASH };
    case "/api/me/alerts": return { json: { alerts: empty ? [] : ALERTS } };
    case "/api/me/saved": return { json: { saved: empty ? [] : JOBS.slice(0, 5).map((j) => ({ job_id: j.id, saved_at: day(1) })) } };
    case "/api/me/tokens": return { json: { tokens: empty ? [] : TOKENS } };
    case "/api/me/billing": return { json: empty ? { paid: null, license: null, customer: false } : { paid: { plan: "basic", status: "active", period_end: day(-20) }, license: null, customer: true } };
    case "/api/me/consent": return { json: { newsletter: true } };
    case "/api/me/storage": return { json: STORAGE };
    case "/api/me/apply/summary": return { json: empty ? { ...SUMMARY, used: 0, in_progress: 0, remaining: 100, unconfirmed: 0, needs_input: 0, queued: 0, filled_today: 0, ai: { used: 0, limit: 300 } } : SUMMARY };
    case "/api/me/apply/queue": return { json: { queue: empty ? [] : QUEUE } };
    case "/api/me/apply/needs": return { json: { needs: empty ? [] : NEEDS } };
    case "/api/me/apply/history": return { json: { applied: empty ? [] : HISTORY } };
    case "/api/me/apply/profile": return { json: { profile: APPLY_PROFILE, onboarded: true } };
    case "/api/me/apply/agent": return { json: { agent: AGENT } };
    case "/api/jobs": {
      const ids = new URLSearchParams(search).get("ids")?.split(",") || [];
      return { json: { jobs: JOBS.filter((j) => ids.includes(j.id)) } };
    }
    case "/api/companies": return { json: { companies: ["wix.com", "monday.com", "snyk.io", "riskified.com"].map((domain, i) => ({ domain, job_count: 400 - i * 50 })) } };
    default: return path.startsWith("/api/me/") ? { json: {} } : null;
  }
}

const hits = [];
// Signed in (or not), with the API in the given state. Requests to /api/me
// and the two lists above never leave the browser.
async function context(browser, { theme = "light", view = "desktop", signedIn = true, state = "loaded" } = {}) {
  const vp = view === "phone" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } };
  const ctx = await browser.newContext(vp);
  await ctx.addInitScript(([t, tok]) => {
    localStorage.setItem("ooj_cookie_consent", "no");
    localStorage.setItem("iljobs_theme", t);
    localStorage.setItem("ooj_terms_agreed", "1");
    if (tok && !sessionStorage.getItem("signed-out-here")) localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: tok, access_token: tok, refresh_token: "r" }));
    localStorage.setItem("iljobs_starred", JSON.stringify(["1a2b3c4d5e6f7000"]));
  }, [theme, signedIn ? ID_TOKEN : null]);
  await ctx.route(/amazoncognito\.com|cognito-idp\./, (r) => r.abort());
  await ctx.route(/\/api\/(me\/|jobs\?|jobs$|companies\?)/, (r) => {
    const u = new URL(r.request().url());
    hits.push(`${r.request().method()} ${u.host}${u.pathname}`);
    const f = fixture(u.pathname, u.search, r.request().method(), state);
    if (!f) return r.abort();
    if (state === "loading" && u.pathname.startsWith("/api/me/")) return; // never answered
    return r.fulfill({ status: f.status || 200, contentType: "application/json", body: f.status === 204 ? "" : JSON.stringify(f.json) });
  });
  return ctx;
}

const ACCOUNT = ["", "alerts", "saved", "skills", "preferences", "billing", "settings"];
const APPLY = ["", "queue", "needs", "history", "agent", "settings"];
const PAGES = [...ACCOUNT.map((s) => ({ name: `account${s ? "-" + s : ""}`, path: `/account${s ? "/" + s : ""}`, live: `/account${s ? "#" + s : ""}` })),
  ...APPLY.map((s) => ({ name: `apply${s ? "-" + s : ""}`, path: `/apply${s ? "/" + s : ""}`, live: `/apply${s ? "#" + s : ""}` }))];

async function open(ctx, url, errors, pending = false) {
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  // A request left hanging (the loading state) never lets the network go idle.
  await p.goto(url, { waitUntil: pending ? "load" : "networkidle", timeout: 45000 }).catch(() => {});
  if (pending) await p.waitForTimeout(1500);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(700);
  return p;
}
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

const report = { shots: [], states: [], signout: {}, focus: {}, links: {} };
const browser = await chromium.launch();

if (what === "shots" || what === "all") {
  for (const view of ["desktop", "phone"]) for (const theme of ["light", "dark"]) for (const site of opt("--sites", "new,live").split(",")) {
    const ctx = await context(browser, { theme, view });
    for (const pg of PAGES) {
      // Live keeps the old two-page layout; its tabs are the hashes.
      const errors = [];
      const p = await open(ctx, site === "new" ? LOCAL + pg.path : LIVE + pg.live, errors);
      const file = `${pg.name}-${view}-${theme}-${site}.jpg`;
      const ox = await overflow(p);
      await p.screenshot({ path: join(out, file), type: "jpeg", quality: 70, fullPage: true });
      report.shots.push({ file, overflowX: ox, errors });
      console.log(file, ox ? "OVERFLOW" : "", errors.length ? `errors: ${errors.join(" | ")}` : "");
      await p.close();
    }
    await ctx.close();
  }
}

if (what === "states" || what === "all") {
  for (const state of ["signed-out", "loading", "empty", "error"]) {
    for (const view of ["desktop", "phone"]) {
      const ctx = await context(browser, { view, signedIn: state !== "signed-out", state });
      for (const pg of PAGES) {
        const errors = [];
        const p = await open(ctx, LOCAL + pg.path, errors, state === "loading");
        const file = `state-${state}-${pg.name}-${view}.jpg`;
        const text = (await p.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
        const ox = await overflow(p);
        await p.screenshot({ path: join(out, file), type: "jpeg", quality: 70, fullPage: view === "desktop" });
        // The error fixture is a 500, which the browser logs as a failed load; that one is expected.
        const real = errors.filter((e) => !(state === "error" && /status of 500/.test(e)));
        report.states.push({ file, state, page: pg.name, view, overflowX: ox, text, errors: real });
        console.log(file, ox ? "OVERFLOW" : "", "|", text.slice(0, 90), real.length ? `errors: ${real.join(" | ")}` : "");
        await p.close();
      }
      await ctx.close();
    }
  }
}

if (what === "signout" || what === "all") {
  // The account menu's Log out on each page: the page must drop to the
  // sign-in with nothing of the reader left on screen or in this browser.
  for (const path of ["/account", "/account/saved", "/apply/queue", "/apply/history"]) {
    const ctx = await context(browser, {});
    const errors = [];
    const p = await open(ctx, LOCAL + path, errors);
    const before = (await p.locator("main").innerText()).replace(/\s+/g, " ");
    await p.getByRole("button", { name: "My account" }).click();
    await p.addInitScript(() => sessionStorage.setItem("signed-out-here", "1"));
    await p.getByRole("menuitem", { name: "Log out" }).click();
    await p.waitForTimeout(600);
    const after = (await p.locator("main").innerText()).replace(/\s+/g, " ");
    const store = await p.evaluate(() => ({ tokens: localStorage.getItem("iljobs_auth_tokens"), stars: localStorage.getItem("iljobs_starred"), dash: localStorage.getItem("iljobs_dash_v1") }));
    const leaked = ["Senior Backend Engineer", "Wix", "dana@example.com", "Dana", "backend"].filter((w) => after.includes(w));
    await p.screenshot({ path: join(out, `signout${path.replace(/\//g, "-")}.jpg`), type: "jpeg", quality: 70 });
    report.signout[path] = { before: before.slice(0, 120), after: after.slice(0, 160), leaked, store, signInShown: /Log in to Ocean of Jobs/.test(after), errors };
    console.log("signout", path, report.signout[path].signInShown ? "sign-in shown" : "NO SIGN-IN", leaked.length ? `LEAKED ${leaked}` : "nothing left", JSON.stringify(store));
    await ctx.close();
  }
  // Signed out in another tab: the storage event reaches this one.
  const ctx = await context(browser, {});
  const errors = [];
  const p = await open(ctx, LOCAL + "/apply/queue", errors);
  const q = await ctx.newPage();
  await q.goto(LOCAL + "/privacy");
  await q.evaluate(() => { sessionStorage.setItem("signed-out-here", "1"); signOut(); });
  await p.waitForTimeout(800);
  const after = (await p.locator("main").innerText()).replace(/\s+/g, " ");
  report.signout["other tab"] = { signInShown: /Log in to Ocean of Jobs/.test(after), leaked: ["Senior Backend Engineer", "Wix"].filter((w) => after.includes(w)) };
  console.log("signout other tab", JSON.stringify(report.signout["other tab"]));
  await ctx.close();
}

if (what === "focus" || what === "all") {
  const focused = (p) => p.evaluate(() => {
    const el = document.activeElement;
    const s = getComputedStyle(el);
    const visible = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow !== "none" && s.boxShadow !== "");
    return { el: `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}"`, visible };
  });
  for (const theme of ["light", "dark"]) for (const path of ["/apply", "/account/settings", "/account/alerts"]) {
    const ctx = await context(browser, { theme });
    const errors = [];
    const p = await open(ctx, LOCAL + path, errors);
    const stops = [];
    for (let i = 0; i < 30; i++) { await p.keyboard.press("Tab"); stops.push(await focused(p)); }
    const bad = stops.filter((s) => !s.visible).map((s) => s.el);
    report.focus[`${path} ${theme}`] = { first: stops[0].el, stops: stops.map((s) => `${s.visible ? "" : "!"}${s.el}`), invisible: bad };
    console.log("focus", path, theme, `${stops.length - bad.length}/${stops.length} show focus`, bad.join(", "));
    if (path === "/apply" && theme === "light") {
      // The sidebar link with focus, beside the current page's highlight (audit blocker 8).
      await p.goto(LOCAL + path, { waitUntil: "networkidle" });
      for (let i = 0; i < 5; i++) await p.keyboard.press("Tab");
      await p.screenshot({ path: join(out, "focus-sidebar-light.jpg"), type: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 400, height: 520 } });
    }
    await ctx.close();
  }
  // The Settings form's selects and the token dialog from the keyboard.
  const ctx = await context(browser, {});
  const p = await open(ctx, LOCAL + "/account/settings", []);
  await p.getByRole("button", { name: "New token" }).focus();
  await p.keyboard.press("Enter");
  await p.waitForTimeout(300);
  const dialogOpen = await p.getByRole("dialog").isVisible();
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  const back = await p.evaluate(() => document.activeElement?.textContent?.trim());
  report.focus.dialog = { opened: dialogOpen, focusBackOn: back };
  console.log("token dialog from keyboard:", dialogOpen, "focus back on:", back);
  await ctx.close();
}

if (what === "links" || what === "all") {
  // Deep links (audit blocker 3) and the old hashes, as the preview routes them.
  const ctx = await context(browser, {});
  for (const [url, want] of [["/account/alerts", "Alerts"], ["/account/saved", "Saved jobs"], ["/account/skills", "Resume skills"], ["/account/preferences", "Preferences"],
    ["/account/billing", "Billing"], ["/account/settings", "Settings"], ["/account#alerts", "Alerts"], ["/account#aa-settings", "Auto apply settings"],
    ["/apply#queue", "Queue"], ["/apply/needs", "Needs attention"], ["/account/nope", "Account"]]) {
    const errors = [];
    const p = await open(ctx, LOCAL + url, errors);
    const h1 = (await p.locator("h1").first().innerText().catch(() => "")).trim();
    report.links[url] = { h1, at: new URL(p.url()).pathname, ok: h1 === want };
    console.log("link", url, "->", report.links[url].at, JSON.stringify(h1), h1 === want ? "ok" : `WANT ${want}`);
    await p.close();
  }
  await ctx.close();
}

await browser.close();
report.apiHosts = [...new Set(hits.map((h) => h.split(" ")[1].split("/")[0]))];
report.apiCalls = [...new Set(hits)].sort();
writeFileSync(join(out, `report-${what}.json`), JSON.stringify(report, null, 1));
console.log("answered here:", report.apiCalls.length, "distinct calls on", report.apiHosts.join(", "));
