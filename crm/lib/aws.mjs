// AWS from the CRM Worker: Signature Version 4 with WebCrypto, and the few
// calls the CRM makes (DynamoDB, Cognito, SES). The key is the ooj-crm IAM
// user's (scripts/setup_crm_aws.py): it can read accounts and the alerts
// table, write only the CRM's own table, and send only from info@.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

// Signs and sends one request. `target` is the x-amz-target header for the
// JSON APIs; `path` and `query` for REST ones (SES v2).
export async function signedFetch(env, { service, host, method = "POST", path = "/", body = "", headers = {}, now = new Date() }) {
  const region = env.AWS_REGION || "il-central-1";
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256(body);
  const all = { host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  const names = Object.keys(all).sort();
  const canonical = [method, path, "", names.map((n) => `${n}:${String(all[n]).trim()}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key = await hmac("AWS4" + env.AWS_SECRET_ACCESS_KEY, day);
  for (const part of [region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  const auth = `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  const res = await fetch(`https://${host}${path}`, { method, headers: { ...all, Authorization: auth }, body: method === "GET" ? undefined : body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(data.message || data.Message || data.__type || `AWS ${res.status}`), { status: res.status, type: data.__type });
  return data;
}

const region = (env) => env.AWS_REGION || "il-central-1";

function jsonApi(env, service, host, target, payload) {
  return signedFetch(env, { service, host, body: JSON.stringify(payload),
    headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": target } });
}

// DynamoDB, in its own attribute-value format; plain values in and out.
export const ddb = (env, op, payload) => jsonApi(env, "dynamodb", `dynamodb.${region(env)}.amazonaws.com`, `DynamoDB_20120810.${op}`, payload);

export function toAttr(v) {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(toAttr) };
  return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toAttr(x)])) };
}
export function fromAttr(a) {
  if ("S" in a) return a.S;
  if ("N" in a) return Number(a.N);
  if ("BOOL" in a) return a.BOOL;
  if ("NULL" in a) return null;
  if ("L" in a) return a.L.map(fromAttr);
  if ("M" in a) return Object.fromEntries(Object.entries(a.M).map(([k, x]) => [k, fromAttr(x)]));
  if ("SS" in a) return a.SS;
  return null;
}
export const item = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toAttr(v)]));
export const plain = (it) => Object.fromEntries(Object.entries(it || {}).map(([k, v]) => [k, fromAttr(v)]));

// Every page of a Query or Scan, up to `max` pages (each is a subrequest,
// and a free Worker gets 50 per request).
export async function all(env, op, payload, max = 20) {
  const out = [];
  let start;
  for (let i = 0; i < max; i++) {
    const r = await ddb(env, op, { ...payload, ...(start ? { ExclusiveStartKey: start } : {}) });
    out.push(...(r.Items || []).map(plain));
    start = r.LastEvaluatedKey;
    if (!start) return { items: out, complete: true };
  }
  return { items: out, complete: false };
}

// Cognito: the user pool's accounts.
export const cognito = (env, op, payload) =>
  signedFetch(env, { service: "cognito-idp", host: `cognito-idp.${region(env)}.amazonaws.com`, body: JSON.stringify(payload),
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityProviderService.${op}` } });

// SES v2: one email.
export const sesSend = (env, payload) =>
  signedFetch(env, { service: "ses", host: `email.${region(env)}.amazonaws.com`, path: "/v2/email/outbound-emails",
    body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
