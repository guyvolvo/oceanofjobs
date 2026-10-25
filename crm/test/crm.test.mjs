// The CRM's security and its sending rules, without AWS or Cloudflare:
//   node --test crm/test/crm.test.mjs
// AWS calls go to an in-memory stand-in (fake fetch); Access tokens are
// signed here with a key the fake certs endpoint publishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signedFetch } from "../lib/aws.mjs";
import { owner, _resetKeys } from "../lib/access.mjs";
import { markdown, unsubscribeToken, message } from "../lib/mail.mjs";
import { dropCache } from "../lib/store.mjs";
import worker from "../worker.mjs";

const realFetch = globalThis.fetch;

test("SigV4 matches botocore's signature for the same request", async () => {
  let sent;
  globalThis.fetch = async (url, init) => { sent = init; return new Response("{}", { status: 200 }); };
  await signedFetch({ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", AWS_REGION: "il-central-1" }, {
    service: "dynamodb", host: "dynamodb.il-central-1.amazonaws.com", body: '{"TableName":"t"}',
    headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.Scan" }, now: new Date("2026-10-25T15:58:23Z"),
  });
  globalThis.fetch = realFetch;
  assert.equal(sent.headers.Authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261025/il-central-1/dynamodb/aws4_request, "
    + "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target, Signature=3d1f7e45bec93b2fb1ca23a0bd09add4de2733a1125b43157d056371d111314a");
});

// Access tokens.
const keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const otherPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1", alg: "RS256" };
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
async function jwt(claims, { key = keyPair.privateKey, kid = "k1", alg = "RS256" } = {}) {
  const head = b64({ alg, kid, typ: "JWT" });
  const body = b64(claims);
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`))).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const ENV = { ACCESS_TEAM: "oceanofjobs", ACCESS_AUD: "aud-tag", OWNER_EMAIL: "owner@example.com" };
const good = () => ({ aud: ["aud-tag"], iss: "https://oceanofjobs.cloudflareaccess.com", email: "owner@example.com", exp: Math.floor(Date.now() / 1000) + 600 });
const certs = async (url) => {
  assert.equal(url, "https://oceanofjobs.cloudflareaccess.com/cdn-cgi/access/certs");
  return new Response(JSON.stringify({ keys: [jwk] }));
};
const req = (token, init = {}) => new Request("https://crm.oceanofjobs.com/api/me", { ...init, headers: { ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}), ...(init.headers || {}) } });

test("Access: only a valid token for the owner gets in", async () => {
  _resetKeys();
  const ok = (t, env = ENV) => owner(req(t), env, { fetchImpl: certs });
  assert.equal(await ok(await jwt(good())), "owner@example.com");
  assert.equal(await ok(null), null, "no token");
  assert.equal(await ok("x.y.z"), null, "garbage");
  assert.equal(await ok(await jwt({ ...good(), aud: ["other-app"] })), null, "another Access app's token");
  assert.equal(await ok(await jwt({ ...good(), iss: "https://evil.cloudflareaccess.com" })), null, "another team");
  assert.equal(await ok(await jwt({ ...good(), exp: Math.floor(Date.now() / 1000) - 5 })), null, "expired");
  assert.equal(await ok(await jwt({ ...good(), email: "someone@example.com" })), null, "someone else");
  assert.equal(await ok(await jwt(good(), { key: otherPair.privateKey })), null, "signed with another key");
  assert.equal(await ok(await jwt(good(), { kid: "unknown" })), null, "unknown key id");
  const t = await jwt(good());
  const [h, , s] = t.split(".");
  assert.equal(await ok(`${h}.${b64({ ...good(), email: "OWNER@example.com", aud: ["aud-tag"] })}.${s}`), null, "claims changed after signing");
  assert.equal(await ok(`${b64({ alg: "none", kid: "k1" })}.${b64(good())}.`), null, "alg none");
  assert.equal(await ok(await jwt(good()), { ...ENV, OWNER_EMAIL: "" }), null, "not configured: nobody");
});

// The Worker against an in-memory AWS.
function fakeAws(state) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.includes("cloudflareaccess.com")) return new Response(JSON.stringify({ keys: [jwk] }));
    const target = (init.headers || {})["x-amz-target"] || "";
    const body = init.body ? JSON.parse(init.body) : {};
    const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (target.endsWith("ListUsers")) return ok({ Users: state.users });
    if (target.endsWith(".Scan")) return ok({ Items: state.alerts });
    if (target.endsWith(".Query")) {
      const pk = body.ExpressionAttributeValues[":p"] ? body.ExpressionAttributeValues[":p"].S : null;
      return ok({ Items: pk ? state.crm.filter((i) => i.pk.S === pk) : [] });
    }
    if (target.endsWith(".GetItem")) {
      const it = state.crm.find((i) => i.pk.S === body.Key.pk.S && i.sk.S === body.Key.sk.S);
      return ok(it ? { Item: it } : {});
    }
    if (target.endsWith(".PutItem")) {
      const exists = state.crm.findIndex((i) => i.pk.S === body.Item.pk.S && i.sk.S === body.Item.sk.S);
      if (body.ConditionExpression && exists >= 0) return new Response(JSON.stringify({ __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException" }), { status: 400 });
      if (exists >= 0) state.crm.splice(exists, 1);
      state.crm.push(body.Item);
      return ok({});
    }
    if (target.endsWith(".DeleteItem")) return ok({});
    if (u.includes("/v2/email/outbound-emails")) { state.sent.push(body); return ok({ MessageId: "m" + state.sent.length }); }
    return new Response("{}", { status: 404 });
  };
}
const user = (sub, email) => ({ Username: sub, Attributes: [{ Name: "sub", Value: sub }, { Name: "email", Value: email }], UserCreateDate: 1761300000, Enabled: true });
const row = (sub, id, extra) => ({ user_id: { S: sub }, alert_id: { S: id }, ...extra });

test("the Worker: locked without Access, writes need the header, sending is off until turned on", async () => {
  _resetKeys();
  dropCache();
  const state = {
    users: [user("u1", "owner@example.com"), user("u2", "a@example.com"), user("u3", "b@example.com")],
    alerts: [row("u2", "#email", { newsletter: { BOOL: true } }), row("u3", "#email", { newsletter: { BOOL: false } })],
    crm: [], sent: [],
  };
  globalThis.fetch = fakeAws(state);
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm", UNSUBSCRIBE_SECRET: "s3cret" };
  const tok = await jwt(good());
  const call = (path, init = {}, e = env) => worker.fetch(new Request("https://crm.oceanofjobs.com" + path,
    { ...init, headers: { "Cf-Access-Jwt-Assertion": tok, ...(init.headers || {}) } }), e);

  let r = await worker.fetch(new Request("https://crm.oceanofjobs.com/api/contacts"), env);
  assert.equal(r.status, 403, "no Access token: nothing");
  assert.equal(await r.text(), "Forbidden");
  r = await worker.fetch(new Request("https://crm.oceanofjobs.com/"), env);
  assert.equal(r.status, 403, "not even the page");
  r = await call("/api/contacts");
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("Content-Security-Policy").includes("frame-ancestors 'none'"));
  assert.equal((await r.json()).contacts.length, 3);
  r = await call("/api/campaigns", { method: "POST", body: JSON.stringify({ subject: "Hi", body: "Hello" }) });
  assert.equal(r.status, 403, "a write without X-CRM");
  const H = { "X-CRM": "1", "Content-Type": "application/json" };
  r = await call("/api/campaigns", { method: "POST", headers: H, body: JSON.stringify({ subject: "What's new", body: "**New** things" }) });
  const { campaign } = await r.json();
  r = await call(`/api/campaigns/${campaign.sk}/recipients`);
  assert.deepEqual(await r.json(), { count: 1, sample: ["a@example.com"] }, "only members with the newsletter on");
  r = await call(`/api/campaigns/${campaign.sk}/test`, { method: "POST", headers: H });
  assert.equal(r.status, 200);
  assert.deepEqual(state.sent.map((m) => m.Destination.ToAddresses[0]), ["owner@example.com"], "a test goes to the owner only");
  r = await call(`/api/campaigns/${campaign.sk}/send`, { method: "POST", headers: H, body: JSON.stringify({ confirm: 1 }) });
  assert.equal(r.status, 403, "sending is off by default");
  const on = { ...env, SENDING: "on" };
  r = await call(`/api/campaigns/${campaign.sk}/send`, { method: "POST", headers: H, body: JSON.stringify({ confirm: 3 }) }, on);
  assert.equal(r.status, 409, "the typed count must match");
  r = await call(`/api/campaigns/${campaign.sk}/send`, { method: "POST", headers: H, body: JSON.stringify({ confirm: 1 }) }, on);
  const out = await r.json();
  assert.equal(out.sent, 1);
  assert.equal(out.done, true);
  assert.deepEqual(state.sent.map((m) => m.Destination.ToAddresses[0]), ["owner@example.com", "a@example.com"]);
  const headers = Object.fromEntries(state.sent[1].Content.Simple.Headers.map((h) => [h.Name, h.Value]));
  assert.match(headers["List-Unsubscribe"], /^<https:\/\/oceanofjobs\.com\/api\/alerts\/unsubscribe\?u=u2&a=%23email&t=[0-9a-f]{32}>$/);
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  r = await call(`/api/campaigns/${campaign.sk}/send`, { method: "POST", headers: H, body: JSON.stringify({ confirm: 1 }) }, on);
  assert.equal((await r.json()).sent, 0, "a member gets one copy, whatever is retried");
  r = await call(`/api/campaigns/${campaign.sk}`, { method: "DELETE", headers: H });
  assert.equal(r.status, 409, "a sent email stays in the record");

  r = await call("/api/contacts.csv");
  const csv = await r.text();
  assert.match(csv.split("\n")[0], /^email,created/);
  const audit = state.crm.filter((i) => i.pk.S === "audit").map((i) => i.action.S);
  assert.ok(audit.includes("export") && audit.includes("test email") && audit.includes("send batch"), audit.join(","));
  globalThis.fetch = realFetch;
});

test("email: Markdown is escaped, links only to http(s) and mailto", () => {
  const html = markdown("# Hi <script>alert(1)</script>\n\n- **bold** [ok](https://oceanofjobs.com)\n- [bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>");
  assert.ok(!html.includes("<script>") && !html.includes("<img"));
  assert.ok(html.includes('<a href="https://oceanofjobs.com"'));
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("<strong>bold</strong>"));
});

test("the unsubscribe signature is the one api/unsubscribe_token.py makes", async () => {
  // python: unsubscribe_token("cy", "#email", secret="s3cret") in tests/test_consent.py's setup
  const py = (await import("node:child_process")).execFileSync("python", ["-c",
    "import sys; sys.path.insert(0, 'api'); import unsubscribe_token as u; print(u.unsubscribe_token('cy', '#email', secret='s3cret'))"], { encoding: "utf8" }).trim();
  assert.equal(await unsubscribeToken("s3cret", "cy"), py);
});

test("a message has a text part and the sender", async () => {
  const m = await message({ UNSUBSCRIBE_SECRET: "s" }, { to: "a@example.com", userId: "u", subject: "S", md: "Hello [site](https://oceanofjobs.com)" });
  assert.equal(m.FromEmailAddress, "Ocean of Jobs <info@oceanofjobs.com>");
  assert.ok(m.Content.Simple.Body.Text.Data.includes("Hello site (https://oceanofjobs.com)"));
  assert.ok(m.Content.Simple.Body.Text.Data.includes("Unsubscribe: https://oceanofjobs.com/api/alerts/unsubscribe?u=u&a=%23email&t="));
});
