// The account page (apply/dist/account.html, so run `npm run build` in
// apply/ first), served as https://oceanofjobs.com/account from the local
// files with every /api call stubbed in the shapes api/handler.py returns.
//
// Two parts. Checks: the ways in (email code, Google's ?code=, GitHub's
// #id_token=, a sign-in error) and the mutations, with the request each
// one sends. Then screenshots of every section, signed in and out, at
// desktop and phone width, dark and light, failing on a page error or a
// horizontal scroll.
//   node tests/e2e/account_shot.mjs [outdir]
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "../..");
const out = process.argv[2] || join(root, "tests/e2e/shots");
await mkdir(out, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };
const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();
const SPEC = JSON.parse(execFileSync("python", ["-c", "import sys, json; sys.path.insert(0, 'api'); import skills; print(json.dumps(skills.spec()))"], { cwd: root, encoding: "utf8" }));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (extra = {}) => `${b64({ alg: "none" })}.${b64({ email: "dana@example.com", name: "Dana Levi", sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600,
  identities: JSON.stringify([{ providerName: "Google" }]), ...extra })}.sig`;

const SKILLS = ["Python", "AWS", "Kubernetes", "Terraform", "Docker", "Linux", "Go", "PostgreSQL", "Kafka"];
const COMPANIES = [["wix.com", "Wix"], ["monday.com", "monday.com"], ["snyk.io", "Snyk"], ["riskified.com", "Riskified"], ["jfrog.com", "JFrog"], ["taboola.com", "Taboola"]];
const TITLES = ["Senior Backend Engineer", "Platform Engineer, Developer Experience", "Staff Site Reliability Engineer", "DevOps Engineer", "Data Engineer", "Cloud Infrastructure Engineer"];
const job = (i) => ({ id: `a${i.toString(16).padStart(7, "0")}`, title: TITLES[i % 6], company_domain: COMPANIES[i % 6][0], company_name: COMPANIES[i % 6][1],
  location: ["Tel Aviv, Israel", "Remote", "Herzliya, Israel"][i % 3], url: `https://boards.greenhouse.io/x/jobs/${i}`,
  skills: [...SKILLS.slice(0, 3 + (i % 5)), i % 2 ? "Helm" : "GCP", "CI/CD"].join(","), salary_text: `₪${25 + (i % 9) * 4},000–₪${32 + (i % 9) * 4},000 / month` });
const days = Array.from({ length: 90 }, (_, i) => ({ day: new Date(Date.now() - (89 - i) * 864e5).toISOString().slice(0, 10), new: 4 + ((i * 7) % 11), open: 300 + i * 3 }));
const STATE = () => ({
  profile: { skills: [...SKILLS], seniority: "senior", workplace: ["hybrid"], israel_only: true, country: ["IL"], city: [], cadence: "daily", digest_time: "09:00", digest_tz: "Asia/Jerusalem", digest_day: 0 },
  alerts: [
    { alert_id: "al1", active: true, email: "dana@example.com", filter: { search: "devops", department: "Infrastructure", country: "IL" }, created_at: ago(500), last_notified_at: ago(3) },
    { alert_id: "al2", active: false, email: "dana@example.com", filter: { search: "sre", country: "IL" }, created_at: ago(900), last_notified_at: ago(70) },
    { alert_id: "al3", active: true, email: "dana@example.com", filter: { search: "devops", department: "Infrastructure", country: "IL" }, created_at: ago(20), last_notified_at: ago(20) },
  ],
  saved: [0, 1, 2, 3].map((i) => ({ job_id: job(i).id, saved_at: ago(i * 10) })),
  tokens: [{ id: "tk1", name: "Claude Code laptop", hint: "x9Qa", created_at: ago(400), last_used_at: ago(5), expires_at: ago(-1700), scope: "mcp",
    permissions: { saved: "write", queue: "none", alerts: "write", preferences: "read" } },
    { id: "tk2", name: "Ocean of Jobs extension", hint: "77ab", created_at: ago(900), last_used_at: null, expires_at: null, scope: "extension" }],
});
const FACETS = { verified: { locations: [
  { value: "IL", label: "Israel", n: 18234, cities: [{ value: "Tel Aviv", n: 9000 }, { value: "Herzliya", n: 2100 }, { value: "Haifa", n: 1300 }] },
  { value: "US", label: "United States", n: 71734, cities: [{ value: "New York", n: 8000 }, { value: "San Francisco", n: 6000 }] },
  { value: "DE", label: "Germany", n: 12001, cities: [{ value: "Berlin", n: 4000 }] },
] } };
const STATS = { top_departments: [{ department: "Engineering", n: 52000 }, { department: "Infrastructure", n: 9100 }, { department: "Data & Analytics", n: 8420 }, { department: "Security", n: 5160 }] };
const COMPANY_LIST = { companies: Array.from({ length: 300 }, (_, i) => ({ domain: i < 6 ? COMPANIES[i][0] : `company${i}.com`, job_count: 1000 - i })) };

const requests = [];
async function setup(ctx, state, { signedIn = true, mode = "dark" } = {}) {
  await ctx.route(/^https:\/\/(auth\.oceanofjobs\.com|github\.com|cognito-idp\.[^/]+\.amazonaws\.com)\//, async (r) => {
    const url = r.request().url();
    requests.push({ method: r.request().method(), url, body: r.request().postData() });
    if (url.includes("/oauth2/token")) return r.fulfill({ json: { id_token: jwt({ name: "Google Person" }), access_token: "a", refresh_token: "r" } });
    if (url.includes("/oauth2/revoke")) return r.fulfill({ status: 200, body: "" });
    if (url.includes("cognito-idp")) {
      const target = r.request().headers()["x-amz-target"] || "";
      if (target.endsWith("RespondToAuthChallenge")) return r.fulfill({ json: { AuthenticationResult: { IdToken: jwt({ name: undefined, identities: undefined }), AccessToken: "a", RefreshToken: "r" } } });
      return r.fulfill({ json: { Session: "s1" } });
    }
    return r.fulfill({ status: 200, contentType: "text/html", body: "<p>provider</p>" });
  });
  await ctx.route("https://oceanofjobs.com/**", async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    if (p.startsWith("/api/")) requests.push({ method: m, path: p + url.search, body: req.postData() });
    const json = (body, status = 200) => r.fulfill({ status, contentType: "application/json", body: body === null ? "" : JSON.stringify(body) });
    if (p === "/api/me/profile") {
      if (m === "PUT") { state.profile = { ...state.profile, ...JSON.parse(req.postData()) }; delete state.profile.options; return json({ profile: state.profile }); }
      return json({ profile: state.profile, options: {}, skill_spec: SPEC });
    }
    if (p === "/api/me/alerts") {
      if (m === "POST") { const a = { alert_id: `al${Date.now()}`, active: true, filter: JSON.parse(req.postData()).filter, created_at: ago(0), last_notified_at: ago(0) }; state.alerts.push(a); return json(a, 201); }
      return json({ alerts: state.alerts });
    }
    if (p.startsWith("/api/me/alerts/")) {
      const id = p.split("/").pop();
      if (m === "DELETE") { state.alerts = state.alerts.filter((a) => a.alert_id !== id); return json(null, 204); }
      const a = state.alerts.find((x) => x.alert_id === id);
      Object.assign(a, JSON.parse(req.postData()));
      return json(a);
    }
    if (p === "/api/me/saved") return json({ saved: state.saved });
    if (p.startsWith("/api/me/saved/")) {
      const id = decodeURIComponent(p.split("/").pop());
      state.saved = state.saved.filter((s) => s.job_id !== id);
      if (m === "PUT") state.saved.unshift({ job_id: id, saved_at: ago(0) });
      return json(null, 204);
    }
    if (p === "/api/me/dashboard") return json({ key: "k", computed_at: ago(2), history: { days }, counts: Object.fromEntries([...SKILLS, "Helm", "GCP", "CI/CD"].map((s, i) => [s, 4200 - i * 380])),
      matches: Array.from({ length: 60 }, (_, i) => job(i)), suggested: [{ skill: "Helm", share: 0.5 }] });
    if (p === "/api/me/tokens") {
      if (m === "POST") { const t = { id: `tk${Date.now()}`, name: JSON.parse(req.postData()).name || "Token", hint: "AbCd", created_at: ago(0), last_used_at: null, expires_at: ago(-2160), scope: "mcp", token: "ooj_ZmEwMzAyNWQ4ZjQ0YTk3OWIxAbCd" }; state.tokens.unshift(t); return json(t, 201); }
      return json({ tokens: state.tokens });
    }
    if (p.startsWith("/api/me/tokens/")) { state.tokens = state.tokens.filter((t) => t.id !== p.split("/").pop()); return json(null, 204); }
    if (p === "/api/me/apply") return json(null, 204);
    if (p === "/api/jobs") {
      const ids = url.searchParams.get("ids");
      if (ids) return json({ jobs: ids.split(",").map((id) => Array.from({ length: 60 }, (_, i) => job(i)).find((j) => j.id === id)).filter(Boolean).map((j, i) => (i === 2 ? { ...j, closed_at: ago(30) } : j)) });
      return json({ jobs: [job(7), job(8), job(9)] });
    }
    if (p === "/api/companies") return json(COMPANY_LIST);
    if (p === "/api/auth/email/start") return json({ ok: true });
    if (p === "/api/pipeline-status") return json({ upstream: [] });
    if (p.startsWith("/api/")) return json({ error: "not stubbed" }, 404);
    if (p === "/facets.json") return json(FACETS);
    if (p === "/stats.json") return json(STATS);
    if (p.startsWith("/logo/")) return r.fulfill({ status: 404, body: "" });
    const file = p === "/account" ? join(root, "apply/dist/account.html")
      : p.startsWith("/apply/") ? join(root, "apply/dist", p.slice(7)) : join(root, "frontend", p);
    try {
      r.fulfill({ body: await readFile(file), contentType: TYPES[extname(file)] || "application/octet-stream" });
    } catch { r.fulfill({ status: 404, body: "" }); }
  });
  await ctx.addInitScript(([m, token]) => {
    if (location.protocol !== "https:" || sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("iljobs_theme", m);
    localStorage.setItem("ooj_cookie_consent", "no");
    localStorage.removeItem("iljobs_dash_v1");
    if (token) localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: token, access_token: "a", refresh_token: "r" }));
  }, [mode, signedIn ? jwt() : null]);
}

const b = await chromium.launch();
const errors = [];
const overflow = [];
const fails = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : "  -- " + detail}`); if (!ok) fails.push(name); };
const watch = (page, tag) => {
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  page.on("console", (msg) => { if (msg.type() === "error" && !/Failed to load resource|Sign-in failed: access_denied/.test(msg.text())) errors.push(`${tag} console: ${msg.text().slice(0, 200)}`); });
};
const last = (pred) => [...requests].reverse().find(pred);

// The ways in.
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await setup(ctx, STATE(), { signedIn: false });
  const page = await ctx.newPage();
  watch(page, "signin");
  await page.goto("https://oceanofjobs.com/account", { waitUntil: "networkidle" });
  check("signed out shows the sign-in", await page.getByRole("heading", { name: "Log in" }).isVisible());
  await page.getByLabel("Email address").fill("dana@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("Verification code").fill("123456");
  check("email start posts the address", JSON.parse(last((r) => r.path === "/api/auth/email/start")?.body || "{}").email === "dana@example.com");
  await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Verify" }).click()]);
  await page.waitForLoadState("networkidle");
  check("a verified code signs in and the page reloads signed in", await page.getByRole("tablist").first().isVisible() && /Good (morning|afternoon|evening)/.test(await page.locator("h1").first().textContent()));

  await page.evaluate(() => localStorage.removeItem("iljobs_auth_tokens"));
  await page.goto("about:blank");
  await page.goto("https://oceanofjobs.com/account#auth_error=access_denied", { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  check("a sign-in error from the provider is said on screen", await page.getByText("Sign-in was cancelled.").first().isVisible());
  check("the error hash is cleared", !page.url().includes("auth_error"));
  await page.keyboard.press("Escape");

  await page.goto("https://oceanofjobs.com/account", { waitUntil: "networkidle" });
  const google = page.waitForRequest((r) => r.url().startsWith("https://auth.oceanofjobs.com/oauth2/authorize"));
  await page.getByRole("button", { name: "Continue with Google" }).click();
  const gurl = new URL((await google).url());
  check("Google goes to Cognito with PKCE and the / callback", gurl.searchParams.get("identity_provider") === "Google"
    && gurl.searchParams.get("redirect_uri") === "https://oceanofjobs.com/" && !!gurl.searchParams.get("code_challenge"));
  await page.goto("https://oceanofjobs.com/account", { waitUntil: "networkidle" });
  const gh = page.waitForRequest((r) => r.url().startsWith("https://github.com/login/oauth/authorize"));
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  check("GitHub goes to its authorize page with the API callback", new URL((await gh).url()).searchParams.get("redirect_uri") === "https://oceanofjobs.com/api/auth/github/callback");

  await page.goto("https://oceanofjobs.com/account?code=abc123", { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  check("?code= on /account is exchanged and signs in", !!last((r) => r.url?.includes("/oauth2/token")) && await page.getByRole("tablist").first().isVisible());
  check("the code is stripped from the address", !page.url().includes("code="));

  await page.evaluate(() => localStorage.removeItem("iljobs_auth_tokens"));
  await page.goto("about:blank");
  await page.goto(`https://oceanofjobs.com/account#id_token=${jwt({ name: "Git Hubber" })}&access_token=a&refresh_token=r`, { waitUntil: "networkidle" });
  check("#id_token= on /account signs in", await page.getByText("Good", { exact: false }).first().isVisible() && !page.url().includes("id_token"));

  // The header's Log in, on /apply signed out, still lands here.
  await page.evaluate(() => localStorage.removeItem("iljobs_auth_tokens"));
  await page.goto("about:blank");
  await page.goto("https://oceanofjobs.com/account#alerts", { waitUntil: "networkidle" });
  check("signed out on a section hash still shows the sign-in", await page.getByRole("heading", { name: "Log in" }).isVisible());
  await ctx.close();
}

// The mutations, signed in.
{
  const state = STATE();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await setup(ctx, state);
  const page = await ctx.newPage();
  watch(page, "mutations");
  await page.goto("https://oceanofjobs.com/account#alerts", { waitUntil: "networkidle" });
  check("#alerts opens the Alerts tab", await page.getByRole("tab", { name: /Alerts/ }).getAttribute("aria-selected") === "true");
  check("a duplicate alert is marked", await page.getByText("Duplicate of", { exact: false }).isVisible());
  await page.getByLabel("Keywords").fill("platform engineer");
  await page.getByRole("button", { name: "Create alert" }).click();
  await page.waitForTimeout(300);
  const post = last((r) => r.method === "POST" && r.path === "/api/me/alerts");
  const f = JSON.parse(post?.body || "{}").filter || {};
  check("create posts the filter with the profile's places", f.search === "platform engineer" && f.workplace === "hybrid" && f.country === "IL", post?.body);
  check("create says so", await page.getByText("Alert created.").isVisible());
  await page.getByRole("switch").first().click();
  await page.waitForTimeout(200);
  check("the switch pauses an alert", last((r) => r.method === "PATCH")?.body === '{"active":false}');
  const del = page.getByRole("button", { name: /^Delete alert/ }).first();
  await del.click();
  check("delete asks first", !last((r) => r.method === "DELETE" && r.path.startsWith("/api/me/alerts/")) && await page.getByRole("button", { name: /Delete\? Click again/ }).isVisible());
  await page.getByRole("button", { name: /Delete\? Click again/ }).click();
  await page.waitForTimeout(200);
  check("the second click deletes", !!last((r) => r.method === "DELETE" && r.path.startsWith("/api/me/alerts/")));

  await page.getByRole("tab", { name: /Preferences/ }).click();
  await page.getByRole("button", { name: /Alert intervals/ }).click();
  await page.getByRole("radio", { name: "Weekly at" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(300);
  const put = JSON.parse(last((r) => r.method === "PUT" && r.path === "/api/me/profile")?.body || "{}");
  check("a preference save PUTs the whole profile", put.cadence === "weekly" && put.skills?.length === SKILLS.length && put.digest_tz === "Asia/Jerusalem" && "israel_only" in put, JSON.stringify(put));
  check("#preferences is the address", page.url().endsWith("#preferences"));

  await page.getByRole("tab", { name: /Skills/ }).click();
  const tmp = join(tmpdir(), "cv.txt");
  await writeFile(tmp, "Experienced engineer. Skills: React, TypeScript, Node.js, GraphQL.\nBuilt services in Rust.");
  await page.locator('input[type="file"]').setInputFiles(tmp);
  await page.waitForTimeout(300);
  check("a CV is read in the browser", /Found \d+ skills?\./.test(await page.locator("[aria-live=polite]").first().textContent()));
  await page.getByRole("button", { name: "Save to profile" }).click();
  await page.waitForTimeout(300);
  const saved = JSON.parse(last((r) => r.method === "PUT" && r.path === "/api/me/profile")?.body || "{}");
  check("Save to profile sends the merged skills", saved.skills?.includes("TypeScript") && saved.skills?.includes("Python"), JSON.stringify(saved.skills));

  await page.getByRole("tab", { name: /Saved jobs/ }).click();
  await page.waitForTimeout(300);
  check("saved jobs list the live listings", await page.getByText("Closed").isVisible());
  await page.getByRole("button", { name: /^Remove .* from saved/ }).first().click();
  await page.getByRole("button", { name: /Remove\? Click again/ }).click();
  await page.waitForTimeout(300);
  check("remove deletes the saved row", !!last((r) => r.method === "DELETE" && r.path.startsWith("/api/me/saved/")));

  await page.getByRole("tab", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "New token" }).click();
  await page.getByLabel("Token name").fill("Cursor desktop");
  check("a token's permissions are listed", await page.getByText("Read and write: saved jobs, alerts · Read: search preferences").isVisible());
  const dialog = page.getByRole("dialog", { name: "New token" });
  check("New token opens a dialog that starts at read everything",
    await dialog.isVisible() && await dialog.getByRole("checkbox", { name: "Read all" }).isChecked()
      && !(await dialog.getByRole("checkbox", { name: "Write alerts" }).isChecked()));
  await dialog.getByRole("checkbox", { name: "Read all" }).click();
  check("clearing Read all leaves nothing, and Create token waits", await dialog.getByRole("button", { name: "Create token" }).isDisabled());
  await dialog.getByRole("checkbox", { name: "Write alerts" }).click();
  check("ticking Write ticks Read on the same row", await dialog.getByRole("checkbox", { name: "Read alerts" }).isChecked());
  await dialog.getByRole("checkbox", { name: "Write all" }).click();
  await dialog.getByRole("button", { name: "Create token" }).click();
  await page.waitForTimeout(300);
  check("create token posts name, 90 days and the permissions picked",
    last((r) => r.method === "POST" && r.path === "/api/me/tokens")?.body
      === '{"name":"Cursor desktop","expires_in_days":90,"permissions":{"saved":"write","queue":"write","alerts":"write","preferences":"write"}}',
    last((r) => r.method === "POST" && r.path === "/api/me/tokens")?.body);
  const madeText = await page.locator(".oj-made").textContent().catch(() => "");
  check("the new token shows masked", madeText.includes("ooj_ZmEwMzAy…") && !madeText.includes("NWQ4"), madeText.slice(0, 200));
  await page.getByRole("button", { name: "Revoke" }).first().click();
  await page.getByRole("button", { name: /Revoke\? Click again/ }).click();
  await page.waitForTimeout(300);
  check("revoke deletes the token", !!last((r) => r.method === "DELETE" && r.path.startsWith("/api/me/tokens/")));

  const before = requests.length;
  await page.getByRole("button", { name: "Delete account" }).click();
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.waitForTimeout(800);
  const seq = requests.slice(before).filter((r) => r.path?.startsWith("/api/me/")).map((r) => `${r.method} ${r.path.replace(/\/[^/]+$/, (s) => (/(alerts|saved|tokens)\//.test(r.path) ? "/:id" : s))}`);
  check("delete account removes everything, then empties the profile", seq[0] === "GET /api/me/alerts" && seq.includes("DELETE /api/me/apply") && seq.at(-1) === "PUT /api/me/profile", seq.join(", "));
  await page.waitForTimeout(1500);
  check("then signs out", await page.getByRole("heading", { name: "Log in" }).isVisible());

  // #aa-settings, which older extension builds link to.
  await page.evaluate((t) => localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: t, access_token: "a", refresh_token: "r" })), jwt());
  await page.goto("about:blank");
  await page.goto("https://oceanofjobs.com/account#aa-settings", { waitUntil: "networkidle" });
  check("#aa-settings opens auto apply settings on the same page", page.url().endsWith("/apply#settings")
    && await page.getByRole("tab", { name: "Auto apply settings" }).getAttribute("aria-selected") === "true");
  await page.getByRole("tab", { name: "Account settings" }).click();
  check("and the switch goes back to the account side", page.url().endsWith("/account") && await page.getByRole("tab", { name: /^Skills/ }).isVisible());
  await ctx.close();
}

// Screenshots.
for (const mode of ["dark", "light"]) {
  for (const [w, h, tag] of [[1440, 1000, "desktop"], [390, 844, "mobile"]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    await setup(ctx, STATE(), { mode, signedIn: false });
    const page = await ctx.newPage();
    watch(page, `${mode} ${tag}`);
    const shot = async (name) => {
      const sw = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (sw > 0) overflow.push(`${mode} ${tag} ${name}: ${sw}px`);
      await page.screenshot({ path: join(out, `account-${name}-${tag}-${mode}.png`), fullPage: true });
    };
    await page.goto("https://oceanofjobs.com/account", { waitUntil: "networkidle" });
    await shot("signedout");
    await page.evaluate((t) => localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: t, access_token: "a", refresh_token: "r" })), jwt());
    for (const section of ["overview", "skills", "alerts", "saved", "preferences", "settings"]) {
      await page.goto(`https://oceanofjobs.com/account#${section}`, { waitUntil: "networkidle" });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(section === "overview" ? 1200 : 400);
      if (section === "preferences") await page.getByRole("button", { name: /Alert intervals/ }).click();
      if (section === "settings") {
        await page.getByRole("button", { name: "New token" }).click();
        await page.getByRole("dialog", { name: "New token" }).waitFor();
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(out, `account-token-dialog-${tag}-${mode}.png`) });
      }
      if (section === "skills") await page.getByRole("button", { name: "Save to profile" }).waitFor();
      await shot(section);
    }
    await ctx.close();
  }
}
await b.close();
console.log(errors.length ? errors.join("\n") : "no page errors");
console.log(overflow.length ? "horizontal overflow:\n" + overflow.join("\n") : "no horizontal overflow");
console.log(fails.length ? `${fails.length} checks failed` : "all checks passed");
process.exit(errors.length || overflow.length || fails.length ? 1 : 0);
