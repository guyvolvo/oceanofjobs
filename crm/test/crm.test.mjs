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
    // DynamoDB refuses reserved words (scope, status, plan, at...) unaliased; the CRM aliases every name.
    if (body.ProjectionExpression && body.ProjectionExpression.split(",").some((n) => !n.trim().startsWith("#"))) {
      return new Response(JSON.stringify({ __type: "ValidationException", message: "unaliased name in " + body.ProjectionExpression }), { status: 400 });
    }
    if (target.endsWith("ListUsers")) return ok({ Users: state.users });
    if (target.endsWith(".Scan")) return ok({ Items: state.alerts });
    const members = body.TableName === "alerts";
    const sameRow = (k) => (i) => i.user_id.S === k.user_id.S && i.alert_id.S === k.alert_id.S;
    if (members && target.endsWith(".GetItem")) { const it = state.alerts.find(sameRow(body.Key)); return ok(it ? { Item: it } : {}); }
    if (members && target.endsWith(".Query")) {
      const u = body.ExpressionAttributeValues[":u"].S;
      const pre = (body.ExpressionAttributeValues[":l"] || { S: "" }).S;
      return ok({ Items: state.alerts.filter((i) => i.user_id.S === u && i.alert_id.S.startsWith(pre)) });
    }
    if (members && target.endsWith(".PutItem")) {
      state.alerts = state.alerts.filter((i) => !sameRow(body.Item)(i));
      state.alerts.push(body.Item);
      return ok({});
    }
    if (members && target.endsWith(".UpdateItem")) {
      const it = state.alerts.find(sameRow(body.Key));
      const v = body.ExpressionAttributeValues;
      if (!it || it.charged.N !== v[":c"].N || Number(it.held.N) < Number(v[":c"].N)) {
        return new Response(JSON.stringify({ __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException" }), { status: 400 });
      }
      it.held = { N: String(Number(it.held.N) - Number(v[":c"].N)) };
      it.charged = { N: "0" };
      return ok({});
    }
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
    if (target.endsWith(".BatchWriteItem")) {
      if (state.denyBatch) return new Response(JSON.stringify({ __type: "AccessDeniedException", message: "not authorized to perform: dynamodb:BatchWriteItem" }), { status: 400 });
      for (const r of Object.values(body.RequestItems)[0]) state.crm.push(r.PutRequest.Item);
      return ok({});
    }
    if (target.endsWith(".DeleteItem")) {
      state.crm = state.crm.filter((i) => !(i.pk.S === body.Key.pk.S && i.sk.S === body.Key.sk.S));
      return ok({});
    }
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

test("licenses, credit resets and emails to one member or a hand-picked few", async () => {
  _resetKeys();
  dropCache();
  const state = {
    users: [user("u1", "owner@example.com"), user("u2", "a@example.com"), user("u3", "b@example.com")],
    alerts: [row("u2", "#email", { newsletter: { BOOL: true } }), row("u3", "#email", { newsletter: { BOOL: false } }),
      row("u2", "#plan", { plan: { S: "pro" }, status: { S: "canceled" } }),
      row("u2", "#ledger#month#2026-10", { held: { N: "7" }, charged: { N: "5" } })],
    crm: [], sent: [],
  };
  globalThis.fetch = fakeAws(state);
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm", UNSUBSCRIBE_SECRET: "s3cret" };
  const tok = await jwt(good());
  const H = { "X-CRM": "1", "Content-Type": "application/json" };
  const call = (path, init = {}, e = env) => worker.fetch(new Request("https://crm.oceanofjobs.com" + path,
    { ...init, headers: { "Cf-Access-Jwt-Assertion": tok, ...(init.headers || {}) } }), e);

  let d = await (await call("/api/contacts/u2")).json();
  assert.equal(d.billing.plan, "free", "a canceled paid plan isn't in force");
  assert.deepEqual(d.billing.ledgers, [{ key: "#ledger#month#2026-10", held: 7, charged: 5 }]);
  let r = await call("/api/contacts/u2/license", { method: "PUT", headers: H, body: JSON.stringify({ plan: "gold" }) });
  assert.equal(r.status, 400, "only real plans");
  r = await call("/api/contacts/u2/license", { method: "PUT", headers: H, body: JSON.stringify({ plan: "pro", until: "2999-01-01", note: "beta" }) });
  assert.equal((await r.json()).billing.plan, "pro");
  assert.equal((await (await call("/api/contacts")).json()).contacts.find((c) => c.id === "u2").plan, "pro", "the list shows it too");
  r = await call("/api/contacts/u2/license", { method: "PUT", headers: H, body: JSON.stringify({ plan: "free" }) });
  assert.equal((await r.json()).billing.license, null, "removed");

  r = await call("/api/contacts/u2/credits", { method: "POST", headers: H, body: JSON.stringify({ key: "#apply_profile", charged: 5 }) });
  assert.equal(r.status, 400, "only ledger rows");
  r = await call("/api/contacts/u2/credits", { method: "POST", headers: H, body: JSON.stringify({ key: "#ledger#month#2026-10", charged: 4 }) });
  assert.equal(r.status, 409, "stale numbers are refused");
  r = await call("/api/contacts/u2/credits", { method: "POST", headers: H, body: JSON.stringify({ key: "#ledger#month#2026-10", charged: 5 }) });
  assert.deepEqual((await r.json()).billing.ledgers, [{ key: "#ledger#month#2026-10", held: 2, charged: 0 }], "in-progress holds stay");

  const msg = JSON.stringify({ subject: "Your plan", body: "Hi" });
  r = await call("/api/contacts/u3/email", { method: "POST", headers: H, body: JSON.stringify({ subject: "Your plan", body: "Hi", test: true }) });
  assert.equal((await r.json()).sent_to, "owner@example.com");
  r = await call("/api/contacts/u3/email", { method: "POST", headers: H, body: msg });
  assert.equal(r.status, 403, "sending is off");
  r = await call("/api/contacts/u3/email", { method: "POST", headers: H, body: msg }, { ...env, SENDING: "on" });
  assert.equal(r.status, 200, "a one-to-one email doesn't need the newsletter on");
  assert.deepEqual(state.sent.map((m) => m.Destination.ToAddresses[0]), ["owner@example.com", "b@example.com"]);

  r = await call("/api/campaigns", { method: "POST", headers: H, body: JSON.stringify({ subject: "S", body: "B", to: ["u2", "u3"] }) });
  const { campaign } = await r.json();
  r = await call(`/api/campaigns/${campaign.sk}/recipients`);
  assert.deepEqual(await r.json(), { count: 1, sample: ["a@example.com"] }, "a hand-picked bulk email still goes only to subscribers");
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

test("mail to info@: text from multipart, base64 and quoted-printable, encoded headers", async () => {
  const { readMessage, address, decodeWords } = await import("../lib/mime.mjs");
  const qpMsg = "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 is =\r\nfine";
  assert.equal(readMessage(qpMsg).text, "Café is fine");
  const b = "Content-Type: multipart/mixed; boundary=\"xx\"\r\n\r\n--xx\r\nContent-Type: multipart/alternative; boundary=yy\r\n\r\n--yy\r\n"
    + "Content-Type: text/html\r\n\r\n<p>html</p>\r\n--yy\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
    + Buffer.from("Yes, count me in").toString("base64") + "\r\n--yy--\r\n--xx\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment\r\n\r\nJVBE\r\n--xx--";
  assert.deepEqual(readMessage(b), { text: "Yes, count me in", attachments: 1 });
  assert.equal(readMessage("Content-Type: text/html\r\n\r\n<div>Hi<br>there &amp; <script>x</script></div>").text, "Hi\nthere &");
  assert.equal(decodeWords("=?UTF-8?B?16nXnNeV150=?= there"), "שלום there");
  assert.deepEqual(address('"Dana Levi" <Dana@Example.com>'), { name: "Dana Levi", email: "dana@example.com" });
});

test("the inbox: mail is forwarded and saved, replies thread and need sending on", async () => {
  _resetKeys();
  dropCache();
  const state = { users: [user("u1", "owner@example.com"), user("u2", "a@example.com")], alerts: [], crm: [], sent: [] };
  globalThis.fetch = fakeAws(state);
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm",
    UNSUBSCRIBE_SECRET: "s3cret", FORWARD_TO: "owner@example.com", SENDING: "on" };
  const raw = "From: A <a@example.com>\r\nSubject: Re: beta\r\nContent-Type: text/plain\r\n\r\nI'm in";
  const forwarded = [];
  const msg = { from: "a@example.com", to: "info@oceanofjobs.com", forward: async (t) => forwarded.push(t),
    headers: new Headers({ from: "A <a@example.com>", subject: "Re: beta", "message-id": "<m1@mail>" }),
    raw: new Response(raw).body };
  await worker.email(msg, env);
  assert.deepEqual(forwarded, ["owner@example.com"], "a copy goes to the owner first");
  const tok = await jwt(good());
  const H = { "Cf-Access-Jwt-Assertion": tok, "X-CRM": "1", "Content-Type": "application/json" };
  const call = (path, init = {}, e = env) => worker.fetch(new Request("https://crm.oceanofjobs.com" + path, { ...init, headers: { ...H, ...(init.headers || {}) } }), e);
  assert.equal((await worker.fetch(new Request("https://crm.oceanofjobs.com/api/inbox"), env)).status, 403, "the inbox is behind Access too");
  const { messages } = await (await call("/api/inbox")).json();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "I'm in");
  assert.equal(messages[0].contact, "u2", "matched to the member");
  assert.equal(messages[0].read, false);
  let r = await call("/api/inbox/reply", { method: "POST", body: JSON.stringify({ sk: messages[0].sk, body: "Great, done." }) }, { ...env, SENDING: "off" });
  assert.equal(r.status, 403);
  r = await call("/api/inbox/reply", { method: "POST", body: JSON.stringify({ sk: messages[0].sk, body: "Great, done." }) });
  assert.equal(r.status, 200);
  const sent = state.sent.at(-1);
  assert.equal(sent.Destination.ToAddresses[0], "a@example.com");
  assert.equal(sent.Content.Simple.Subject.Data, "Re: beta", "no Re: Re:");
  assert.deepEqual(sent.Content.Simple.Headers.map((h) => h.Name), ["In-Reply-To", "References"]);
  await call("/api/inbox/read", { method: "POST", body: JSON.stringify({ sk: [messages[0].sk] }) });
  const after = (await (await call("/api/inbox")).json()).messages;
  assert.equal(after.length, 2);
  assert.equal(after.find((m) => m.dir === "in").read, true);
  globalThis.fetch = realFetch;
});

test("the waitlist: listed from the members' rows, changed only through the signed server route", async () => {
  _resetKeys();
  dropCache();
  const state = {
    users: [user("u1", "owner@example.com"), user("u2", "a@example.com"), user("u3", "b@example.com")],
    alerts: [row("u2", "#waitlist#pro", { plan: { S: "pro" }, joined_at: { S: "2026-10-25T10:00:00Z" } }),
      row("u3", "#waitlist#basic", { plan: { S: "basic" }, joined_at: { S: "2026-10-24T10:00:00Z" }, status: { S: "approved" } }),
      row("#waitlist", "#count#pro", { n: { N: "1" }, cap: { N: "100" } })],
    crm: [], sent: [],
  };
  const box = [];
  const aws = fakeAws(state);
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://box.oceanofjobs.com/")) {
      box.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, counts: { pro: { cap: 100, taken: 1 } } }));
    }
    return aws(url, init);
  };
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm",
    UNSUBSCRIBE_SECRET: "s3cret", ORIGIN_KEY: "ok-key" };
  const tok = await jwt(good());
  const H = { "Cf-Access-Jwt-Assertion": tok, "X-CRM": "1", "Content-Type": "application/json" };
  const call = (path, init = {}) => worker.fetch(new Request("https://crm.oceanofjobs.com" + path, { ...init, headers: { ...H, ...(init.headers || {}) } }), env);
  const list = await (await call("/api/waitlist")).json();
  assert.deepEqual(list.counts, { pro: { cap: 100, taken: 1 } });
  assert.deepEqual(list.people.map((p) => [p.email, p.waitlist, p.status]), [["b@example.com", "basic", "approved"], ["a@example.com", "pro", "waiting"]], "oldest first");
  let r = await call("/api/waitlist", { method: "POST", body: JSON.stringify({ op: "delete-everything", user_id: "u2" }) });
  assert.equal(r.status, 400, "only the known changes");
  r = await call("/api/waitlist", { method: "POST", body: JSON.stringify({ op: "remove", user_id: "u2", plan: "pro" }) });
  assert.equal(r.status, 200);
  const sent = box.at(-1);
  const { signature } = await import("../lib/admin.mjs");
  assert.equal(sent.headers["x-otj-origin-key"], "ok-key");
  assert.equal(sent.headers["X-OOJ-Sig"], await signature("s3cret", Number(sent.headers["X-OOJ-Time"]), JSON.stringify(sent.body)));
  r = await call("/api/waitlist/approve", { method: "POST", body: JSON.stringify({ people: [{ id: "u2", plan: "pro" }], until: "2026-12-31" }) });
  assert.deepEqual((await r.json()).approved, ["u2"]);
  const grant = state.alerts.find((i) => i.user_id.S === "u2" && i.alert_id.S === "#grant");
  assert.equal(grant.plan.S, "pro");
  assert.equal(grant.until.S, "2026-12-31");
  assert.deepEqual(box.at(-1).body, { op: "mark", user_id: "u2", plan: "pro", status: "approved" });
  globalThis.fetch = realFetch;
});

test("flows: a baseline first, then each new match once; steps, waits, events and approvals", async () => {
  _resetKeys();
  dropCache();
  const A = await import("../lib/auto.mjs");
  const state = {
    users: [user("u1", "owner@example.com"), user("u2", "a@example.com"), user("u3", "b@example.com")],
    alerts: [row("u2", "#waitlist#pro", { plan: { S: "pro" }, joined_at: { S: "2026-10-25T10:00:00Z" } }),
      row("#waitlist", "#count#pro", { n: { N: "1" } })],
    crm: [], sent: [],
  };
  const aws = fakeAws(state);
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://box.oceanofjobs.com/")) return new Response(JSON.stringify({ ok: true }));
    if (u.startsWith("https://hooks.slack.com/")) { posts.push(JSON.parse(init.body)); return new Response("ok"); }
    return aws(url, init);
  };
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm",
    UNSUBSCRIBE_SECRET: "s3cret", SENDING: "on" };
  const tok = await jwt(good());
  const H = { "Cf-Access-Jwt-Assertion": tok, "X-CRM": "1", "Content-Type": "application/json" };
  const call = (path, init = {}) => worker.fetch(new Request("https://crm.oceanofjobs.com" + path, { ...init, headers: { ...H, ...(init.headers || {}) } }), env);
  const save = async (f) => (await call("/api/flows", { method: "POST", body: JSON.stringify(f) })).json();
  let r = await call("/api/flows", { method: "POST", body: JSON.stringify({ trigger: "waitlist_pro", enabled: true, actions: [{ type: "slack", url: "https://evil.example/x", text: "x" }] }) });
  assert.equal(r.status, 400, "a Slack step needs a Slack address");
  await save({ name: "Pro welcome", trigger: "waitlist_pro", enabled: true, actions: [
    { type: "email", subject: "You're in", body: "Hi {{email}}, {{pro_left}} left" },
    { type: "slack", url: "https://hooks.slack.com/services/T/B/X", text: "{{email}} joined Pro" },
    { type: "tag_add", tag: "pro-waitlist" },
    { type: "wait", days: 2 },
    { type: "email", subject: "Two days later", body: "Still there?" }] });
  assert.equal((await A.run(env)).ran, 0, "the first run only marks who already matches");
  assert.equal(state.sent.length + posts.length, 0);
  state.alerts.push(row("u3", "#waitlist#pro", { plan: { S: "pro" }, joined_at: { S: "2026-10-26T10:00:00Z" } }));
  dropCache();
  assert.equal((await A.run(env)).ran, 1);
  assert.equal(state.sent[0].Destination.ToAddresses[0], "b@example.com", "only the new one");
  assert.match(state.sent[0].Content.Simple.Body.Text.Data, /^Hi b@example\.com, 99 left/);
  assert.ok(!state.sent[0].Content.Simple.Headers, "an account email has no newsletter unsubscribe header");
  assert.deepEqual(posts, [{ text: "b@example.com joined Pro" }]);
  assert.ok(state.crm.some((i) => i.pk.S === "tags" && i.sk.S === "u3"), "tagged");
  assert.equal(state.sent.length, 1, "the rest waits");
  dropCache();
  assert.equal((await A.run(env)).ran, 0, "once each, and the wait isn't due");
  await A.run(env, { now: Date.now() + 3 * 864e5 });
  assert.equal(state.sent.at(-1).Content.Simple.Subject.Data, "Two days later", "after the wait");

  await save({ name: "Approved", trigger: "waitlist_approved", enabled: true, actions: [{ type: "email", subject: "Approved", body: "Pro until {{license_until}}" }] });
  r = await call("/api/waitlist/approve", { method: "POST", body: JSON.stringify({ people: [{ id: "u3", plan: "pro" }], until: "2026-12-31" }) });
  assert.equal((await r.json()).flows, 1, "approving runs it at once");
  assert.match(state.sent.at(-1).Content.Simple.Body.Text.Data, /Pro until 31 December 2026/);
  const before = state.sent.length;
  state.alerts.find((i) => i.user_id.S === "u3" && i.alert_id.S === "#waitlist#pro").status = { S: "approved" };
  dropCache();
  await A.run(env);
  assert.equal(state.sent.length, before, "the scheduled run doesn't start it again");

  await save({ name: "Mail alert", trigger: "inbox_received", enabled: true, actions: [{ type: "slack", url: "https://hooks.slack.com/services/T/B/X", text: "Mail from {{from}}: {{subject}}" }] });
  await worker.email({ from: "z@example.com", to: "info@oceanofjobs.com", forward: async () => {},
    headers: new Headers({ from: "Zed <z@example.com>", subject: "Hello" }), raw: new Response("Content-Type: text/plain\n\nHi").body }, env);
  assert.deepEqual(posts.at(-1), { text: "Mail from Zed <z@example.com>: Hello" });
  globalThis.fetch = realFetch;
});

test("flows: a baseline that can't be saved shows on the flow as an error", async () => {
  _resetKeys();
  dropCache();
  const A = await import("../lib/auto.mjs");
  const state = { users: [user("u2", "a@example.com")], alerts: [], crm: [], sent: [], denyBatch: true };
  globalThis.fetch = fakeAws(state);
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm", SENDING: "on" };
  state.crm.push({ pk: { S: "flow" }, sk: { S: "f1" }, name: { S: "Welcome" }, trigger: { S: "signup" }, enabled: { BOOL: true },
    actions: { L: [] }, baseline_at: { S: "" } });
  assert.equal((await A.run(env, { log: () => {} })).ran, 0);
  const f = state.crm.find((i) => i.pk.S === "flow");
  assert.match(f.last_error.S, /BatchWriteItem/);
  assert.equal(f.baseline_at.S, "", "no baseline was taken, so the next run tries again");
  assert.equal(state.sent.length, 0);
});

test("bulk changes: tags, licenses and waitlists for many users at once", async () => {
  _resetKeys();
  dropCache();
  const state = {
    users: [user("u1", "owner@example.com"), user("u2", "a@example.com"), user("u3", "b@example.com")],
    alerts: [row("u3", "#waitlist#pro", { plan: { S: "pro" }, joined_at: { S: "2026-10-25T10:00:00Z" } })], crm: [], sent: [],
  };
  const aws = fakeAws(state);
  const box = [];
  globalThis.fetch = async (url, init) => (String(url).startsWith("https://box.oceanofjobs.com/")
    ? (box.push(JSON.parse(init.body)), new Response(JSON.stringify({ ok: true }))) : aws(url, init));
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm", UNSUBSCRIBE_SECRET: "s3cret" };
  const tok = await jwt(good());
  const call = (b) => worker.fetch(new Request("https://crm.oceanofjobs.com/api/contacts/bulk", { method: "POST", body: JSON.stringify(b),
    headers: { "Cf-Access-Jwt-Assertion": tok, "X-CRM": "1", "Content-Type": "application/json" } }), env).then((r) => r.json());
  assert.equal((await call({ ids: ["u2", "u3"], op: "tag_add", tag: "Beta" })).changed, 2);
  assert.equal((await call({ ids: ["u2", "u3"], op: "tag_add", tag: "beta" })).changed, 0, "already tagged");
  assert.equal((await call({ ids: ["u2"], op: "tag_remove", tag: "beta" })).changed, 1);
  assert.equal((await call({ ids: ["u2", "u3"], op: "license", plan: "pro", until: "2026-12-31" })).changed, 2);
  assert.equal(state.alerts.filter((i) => i.alert_id.S === "#grant" && i.plan.S === "pro").length, 2);
  assert.equal((await call({ ids: ["u2", "u3"], op: "waitlist_remove" })).changed, 1, "only those on a waitlist");
  assert.deepEqual(box.at(-1), { op: "remove", user_id: "u3", plan: "pro" });
  assert.equal((await call({ ids: ["u2"], op: "delete" })).error, "Pick users and a change.");
  globalThis.fetch = realFetch;
});

test("an account notice goes to every member, newsletter or not, as account email", async () => {
  _resetKeys();
  dropCache();
  const state = {
    users: [user("u1", "owner@example.com"), user("u2", "a@example.com"), user("u3", "b@example.com"), { ...user("u4", "off@example.com"), Enabled: false }],
    alerts: [row("u2", "#email", { newsletter: { BOOL: true } }), row("u3", "#email", { newsletter: { BOOL: false } })],
    crm: [], sent: [],
  };
  globalThis.fetch = fakeAws(state);
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm", UNSUBSCRIBE_SECRET: "s3cret" };
  const tok = await jwt(good());
  const H = { "Cf-Access-Jwt-Assertion": tok, "X-CRM": "1", "Content-Type": "application/json" };
  const call = (path, init = {}, e = env) => worker.fetch(new Request("https://crm.oceanofjobs.com" + path, { ...init, headers: { ...H, ...(init.headers || {}) } }), e);
  let r = await call("/api/campaigns", { method: "POST", body: JSON.stringify({ subject: "New terms", body: "We updated the terms.", kind: "notice", to: ["u2"] }) });
  const { campaign } = await r.json();
  assert.equal(campaign.kind, "notice", "the kind is stored");
  r = await call(`/api/campaigns/${campaign.sk}/recipients`);
  assert.deepEqual(await r.json(), { count: 3, sample: ["owner@example.com", "a@example.com", "b@example.com"] }, "enabled members, newsletter on or off");
  await call(`/api/campaigns/${campaign.sk}/test`, { method: "POST" });
  assert.ok(!state.sent[0].Content.Simple.Headers, "the test is account email too");
  r = await call(`/api/campaigns/${campaign.sk}/send`, { method: "POST", body: JSON.stringify({ confirm: 3 }) });
  assert.equal(r.status, 403, "still needs sending on");
  r = await call(`/api/campaigns/${campaign.sk}/send`, { method: "POST", body: JSON.stringify({ confirm: 3 }) }, { ...env, SENDING: "on" });
  assert.equal((await r.json()).sent, 3);
  const notices = state.sent.slice(1);
  assert.deepEqual(notices.map((m) => m.Destination.ToAddresses[0]).sort(), ["a@example.com", "b@example.com", "owner@example.com"]);
  for (const m of notices) {
    assert.ok(!m.Content.Simple.Headers, "no newsletter unsubscribe header");
    assert.match(m.Content.Simple.Body.Html.Data, /because of your Ocean of Jobs account/);
  }
  r = await call("/api/campaigns", { method: "POST", body: JSON.stringify({ subject: "Update", body: "B" }) });
  assert.equal((await r.json()).campaign.kind, "update", "a product update by default");
  const log = await (await call("/api/flows/builtin/notices")).json();
  assert.deepEqual(log.entries.map((e) => [e.to, e.what]), [["3 members", "New terms"]]);
  globalThis.fetch = realFetch;
});

test("flows: one log row per run, failed and resumed runs too, read from the log route", async () => {
  _resetKeys();
  dropCache();
  const A = await import("../lib/auto.mjs");
  const state = { users: [user("u1", "owner@example.com"), user("u2", "a@example.com")], alerts: [], crm: [], sent: [] };
  const aws = fakeAws(state);
  let slackStatus = 200;
  globalThis.fetch = async (url, init) => (String(url).startsWith("https://hooks.slack.com/") ? new Response("x", { status: slackStatus }) : aws(url, init));
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm",
    UNSUBSCRIBE_SECRET: "s3cret", SENDING: "on" };
  const tok = await jwt(good());
  const H = { "Cf-Access-Jwt-Assertion": tok, "X-CRM": "1", "Content-Type": "application/json" };
  const call = (path, init = {}) => worker.fetch(new Request("https://crm.oceanofjobs.com" + path, { ...init, headers: { ...H, ...(init.headers || {}) } }), env);
  const { flow } = await (await call("/api/flows", { method: "POST", body: JSON.stringify({ name: "Tagged", trigger: "tag_added", tag: "vip", enabled: true,
    actions: [{ type: "email", subject: "Hi", body: "Hello" }, { type: "wait", days: 1 }, { type: "slack", url: "https://hooks.slack.com/services/T/B/X", text: "later" }] }) })).json();
  await call("/api/contacts/u2/tags", { method: "PUT", body: JSON.stringify({ tags: ["vip"] }) });
  let { entries } = await (await call(`/api/flows/${flow.id}/log`)).json();
  assert.equal(entries.length, 1, "one row for the run");
  assert.equal(entries[0].email, "a@example.com");
  assert.equal(entries[0].trigger, "tag_added");
  assert.deepEqual(entries[0].steps.map((s) => s[1]).slice(0, 1), ["done"]);
  assert.match(entries[0].steps[1][1], /^until /, "parked at the wait");
  slackStatus = 500;
  await A.run(env, { now: Date.now() + 2 * 864e5, log: () => {} });
  ({ entries } = await (await call(`/api/flows/${flow.id}/log`)).json());
  assert.equal(entries.length, 2, "the resumed run has its own row");
  const resumed = entries.find((e) => e.from > 0);
  assert.deepEqual(resumed.steps, [["slack", "failed"]]);
  assert.match(resumed.error, /hooks\.slack\.com answered 500/, "the failure is on the row");
  slackStatus = 200;
  await call(`/api/flows/${flow.id}/test`, { method: "POST" });
  ({ entries } = await (await call(`/api/flows/${flow.id}/log`)).json());
  assert.equal(entries.filter((e) => e.test).length, 1, "a test run is logged and marked");
  assert.equal((await call("/api/flows/nope/log")).status, 404);
  globalThis.fetch = realFetch;
});

test("default flows: logs from what's already recorded", async () => {
  _resetKeys();
  dropCache();
  const state = {
    users: [user("u1", "owner@example.com"), user("u2", "a@example.com")],
    alerts: [row("u2", "a1b2", { email: { S: "a@example.com" }, active: { BOOL: true }, last_digest_at: { S: "2026-10-27T09:00:00Z" } }),
      row("u2", "c3d4", { email: { S: "a@example.com" }, active: { BOOL: true } })],
    crm: [], sent: [],
  };
  globalThis.fetch = fakeAws(state);
  const env = { ...ENV, AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", USER_POOL_ID: "pool", ALERTS_TABLE: "alerts", CRM_TABLE: "crm",
    UNSUBSCRIBE_SECRET: "s3cret", SENDING: "on" };
  const tok = await jwt(good());
  const H = { "Cf-Access-Jwt-Assertion": tok, "X-CRM": "1", "Content-Type": "application/json" };
  const call = (path, init = {}) => worker.fetch(new Request("https://crm.oceanofjobs.com" + path, { ...init, headers: { ...H, ...(init.headers || {}) } }), env);
  await call("/api/contacts/u2/email", { method: "POST", body: JSON.stringify({ subject: "Your plan", body: "Hi" }) });
  let r = await (await call("/api/flows/builtin/direct")).json();
  assert.deepEqual(r.entries.map((e) => [e.to, e.what]), [["a@example.com", "Your plan"]]);
  r = await (await call("/api/flows/builtin/alerts")).json();
  assert.deepEqual(r.entries, [{ at: "2026-10-27T09:00:00Z", to: "a@example.com", what: "Alert on" }], "only alerts that sent a digest");
  r = await (await call("/api/flows/builtin/replies")).json();
  assert.deepEqual(r.entries, []);
  state.crm.push({ pk: { S: "signin" }, sk: { S: "2026-10-28T09:00:00Z#ab12" }, at: { S: "2026-10-28T09:00:00Z" }, email: { S: "a@example.com" } });
  r = await (await call("/api/flows/builtin/signin")).json();
  assert.deepEqual(r.entries, [{ at: "2026-10-28T09:00:00Z", to: "a@example.com", what: "Code requested" }], "the sign-in Lambda's rows");
  assert.equal((await call("/api/flows/builtin/nope")).status, 404, "no log for what isn't recorded");
  // The inbox's Sent view: the email to one member above, a reply, a sent campaign, a flow's email step.
  state.crm.push({ pk: { S: "inbox" }, sk: { S: "2026-10-28T08:00:00Z#r1" }, dir: { S: "out" }, email: { S: "b@example.com" }, subject: { S: "Re: hi" }, text: { S: "Thanks" } },
    { pk: { S: "campaign" }, sk: { S: "c1" }, status: { S: "sent" }, sent: { N: "3" }, sent_at: { S: "2026-10-28T07:00:00Z" }, subject: { S: "News" }, body: { S: "Body" }, kind: { S: "notice" } },
    { pk: { S: "flow" }, sk: { S: "f1" }, name: { S: "Welcome" }, trigger: { S: "signup" }, enabled: { BOOL: true },
      actions: { L: [{ M: { type: { S: "email" }, subject: { S: "Welcome" }, body: { S: "Hello" } } }] } },
    { pk: { S: "flowlog#f1" }, sk: { S: "2026-10-28T06:00:00Z#l1" }, at: { S: "2026-10-28T06:00:00Z" }, email: { S: "a@example.com" },
      test: { BOOL: false }, from: { N: "0" }, steps: { L: [{ L: [{ S: "email" }, { S: "done" }] }] } });
  r = await (await call("/api/inbox/sent")).json();
  assert.deepEqual(r.sent.map((m) => [m.source, m.to, m.subject]).sort(), [
    ["Account notice", "3 members", "News"], ["Flow: Welcome", "a@example.com", "Welcome"], ["Reply", "b@example.com", "Re: hi"], ["To one member", "a@example.com", "Your plan"]]);
  globalThis.fetch = realFetch;
});
