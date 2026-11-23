// /account: a profile that fails to load is never saved over, and a 401
// from /api/me/* shows the sign-in without signing out.
// 1. With GET /api/me/profile answering 500, Preferences, Resume skills
//    and the overview are visited and every save or "Add skill" there is
//    tried. No PUT /api/me/profile may be sent: each PUT is the whole
//    profile, so one built on the empty fallback would wipe it.
// 2. With every /api/me/* answering 401, /account shows the sign-in and
//    iljobs_auth_tokens is still in localStorage.
// Every /api/me call is answered here; nothing is written to the live API.
//   (cd apply && npx vite --port 5181 --strictPort --host 127.0.0.1) & node tests/e2e/_account_profile_guard.mjs [base url]
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:5181";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `${b64({ alg: "none" })}.${b64({ sub: "u1", email: "a@b.c", name: "Test Reader", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const FAILED = "Couldn't load your profile";
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };
const shows = (p, text) => p.getByText(text).first().waitFor({ timeout: 15000 }).then(() => true, () => false);

const b = await chromium.launch();

async function page(answer) {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.addInitScript((t) => {
    // Only the first load seeds the tokens, so a sign-out would stick.
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: t, access_token: t, refresh_token: "r" }));
      sessionStorage.setItem("seeded", "1");
    }
  }, idToken);
  // A sign-out would revoke the made-up refresh token at Cognito.
  await p.route(/amazonaws\.com/, (r) => r.abort());
  await p.route(/\/api\/me(\/|\?|$)/, answer);
  return p;
}

// 1. The profile load fails.
const puts = [];
const day = (i) => ({ day: new Date(Date.now() - (89 - i) * 864e5).toISOString().slice(0, 10), new: 3, open: 40 });
const p1 = await page((r) => {
  const u = new URL(r.request().url());
  const m = r.request().method();
  if (u.pathname === "/api/me/profile") {
    if (m === "PUT") { puts.push(r.request().postData()); return r.fulfill({ json: { profile: JSON.parse(r.request().postData()) } }); }
    return r.fulfill({ status: 500, json: { error: "boom" } });
  }
  const json = u.pathname === "/api/me/alerts" ? { alerts: [] } : u.pathname === "/api/me/saved" ? { saved: [] }
    : u.pathname === "/api/me/dashboard" ? { computed_at: new Date().toISOString(), history: { days: Array.from({ length: 90 }, (_, i) => day(i)) },
      matches: Array.from({ length: 10 }, (_, i) => ({ id: `j${i}`, title: `Job ${i}`, skills: "Kubernetes,Go" })), counts: { Kubernetes: 900, Go: 700 } }
    : {};
  return r.fulfill({ json });
});

await p1.goto(`${BASE}/account/preferences`, { waitUntil: "load" });
const prefsSay = await shows(p1, FAILED);
await p1.waitForTimeout(1000);
for (const row of ["Workplace", "Locations", "Alert intervals"]) {
  const open = p1.getByRole("button", { name: new RegExp(`^${row}`) });
  if (!(await open.count())) continue;
  await open.first().click();
  await p1.getByRole("button", { name: "Save", exact: true }).first().click();
  await p1.waitForTimeout(300);
}
check(prefsSay, "preferences shows the load failure");

await p1.goto(`${BASE}/account/skills`, { waitUntil: "load" });
const skillsSay = await shows(p1, FAILED);
const saveSkills = p1.getByRole("button", { name: "Save to profile" });
if (await saveSkills.count()) { await saveSkills.click(); await p1.waitForTimeout(300); }
check(skillsSay, "resume skills shows the load failure");

await p1.goto(`${BASE}/account`, { waitUntil: "load" });
const overviewSays = await shows(p1, FAILED);
await p1.waitForTimeout(1000);
for (const add of await p1.getByRole("button", { name: /^Add .* to your skills$/ }).all()) { await add.click(); await p1.waitForTimeout(300); }
check(overviewSays, "the overview shows the load failure");
check(puts.length === 0, `no PUT /api/me/profile after a failed load (sent ${puts.length}${puts.length ? `: ${puts[0].slice(0, 120)}` : ""})`);
await p1.close();

// 2. Every /api/me/* call is refused.
const p2 = await page((r) => r.fulfill({ status: 401, json: { error: "Unauthorized" } }));
await p2.goto(`${BASE}/account`, { waitUntil: "load" });
check(await shows(p2, "Log in to Ocean of Jobs"), "a 401 shows the sign-in");
await p2.waitForTimeout(1000);
const kept = await p2.evaluate(() => localStorage.getItem("iljobs_auth_tokens"));
check(!!kept && JSON.parse(kept).refresh_token === "r", "a 401 keeps iljobs_auth_tokens");
// A reload still has the tokens, so the account loads again once the API answers.
await p2.reload({ waitUntil: "load" });
await p2.waitForTimeout(1500);
check(!!(await p2.evaluate(() => localStorage.getItem("iljobs_auth_tokens"))), "the tokens survive a reload");
await b.close();

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
