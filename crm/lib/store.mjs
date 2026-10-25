// The CRM's data. Contacts are read from what already exists: Cognito's
// accounts and the members' own rows in the alerts table (api/consent.py:
// #consent, #email, #waitlist#<plan>; api/paddle.py: #plan). The CRM never
// writes those. Its own records (tags, notes, segments, campaigns, the
// changelog, the audit log) are in the CRM table, keyed pk/sk.
import { all, cognito, ddb, item, plain } from "./aws.mjs";

const MEMBER_ROWS = ["#consent", "#email", "#plan", "#waitlist#basic", "#waitlist#pro"];
let cache = null; // { at, contacts, complete }
const CACHE_FOR = 60 * 1000;

const attr = (u, name) => ((u.Attributes || []).find((a) => a.Name === name) || {}).Value || "";
function provider(u) {
  try {
    const ids = JSON.parse(attr(u, "identities") || "[]");
    if (ids.length) return String(ids[0].providerName || "").toLowerCase();
  } catch {}
  return "email";
}

// Every account with what the CRM shows about it. shortcut: reads the whole
// user pool and scans the alerts table for the member rows, cached a
// minute; fine for a few thousand members, page it past that.
export async function contacts(env, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_FOR) return cache;
  const users = [];
  let token;
  let complete = true;
  for (let i = 0; i < 25; i++) {
    const r = await cognito(env, "ListUsers", { UserPoolId: env.USER_POOL_ID, Limit: 60, ...(token ? { PaginationToken: token } : {}) });
    users.push(...(r.Users || []));
    token = r.PaginationToken;
    if (!token) break;
    if (i === 24) complete = false;
  }
  const rows = await all(env, "Scan", {
    TableName: env.ALERTS_TABLE,
    FilterExpression: "alert_id IN (" + MEMBER_ROWS.map((_, i) => `:r${i}`).join(", ") + ")",
    ExpressionAttributeValues: Object.fromEntries(MEMBER_ROWS.map((r, i) => [`:r${i}`, { S: r }])),
  }, 20);
  const crm = await all(env, "Query", { TableName: env.CRM_TABLE, KeyConditionExpression: "pk = :p",
    ExpressionAttributeValues: { ":p": { S: "tags" } } }, 5);
  const byUser = {};
  for (const r of rows.items) (byUser[r.user_id] ||= {})[r.alert_id] = r;
  const tags = Object.fromEntries(crm.items.map((t) => [t.sk, t.tags || []]));
  const list = users.map((u) => {
    const sub = attr(u, "sub");
    const own = byUser[sub] || {};
    const mail = own["#email"] || {};
    return {
      id: sub,
      email: attr(u, "email").toLowerCase(),
      verified: attr(u, "email_verified") === "true",
      provider: provider(u),
      status: u.UserStatus,
      enabled: u.Enabled !== false,
      created: u.UserCreateDate ? new Date(u.UserCreateDate * 1000).toISOString() : null,
      updated: u.UserLastModifiedDate ? new Date(u.UserLastModifiedDate * 1000).toISOString() : null,
      newsletter: !!mail.newsletter,
      newsletter_source: mail.newsletter_source || null,
      newsletter_at: mail.newsletter_at || null,
      unsubscribed_at: mail.unsubscribed_at || null,
      agreed_version: (own["#consent"] || {}).version || null,
      agreed_at: (own["#consent"] || {}).agreed_at || null,
      plan: (own["#plan"] || {}).plan || "free",
      waitlist: ["basic", "pro"].filter((p) => own["#waitlist#" + p]),
      tags: tags[sub] || [],
    };
  });
  cache = { at: Date.now(), contacts: list, complete: complete && rows.complete };
  return cache;
}
export function dropCache() { cache = null; }

// A segment's rule, applied. Every field is optional; all must hold.
export function matches(c, f = {}) {
  if (f.newsletter === true && !c.newsletter) return false;
  if (f.newsletter === false && c.newsletter) return false;
  if (f.waitlist && f.waitlist !== "any" && !c.waitlist.includes(f.waitlist)) return false;
  if (f.waitlist === "any" && !c.waitlist.length) return false;
  if (f.plan && c.plan !== f.plan) return false;
  if (f.tag && !c.tags.includes(f.tag)) return false;
  if (f.signed_up_after && !(c.created && c.created >= f.signed_up_after)) return false;
  if (f.search) {
    const q = String(f.search).toLowerCase();
    if (!c.email.includes(q) && !c.tags.some((t) => t.includes(q))) return false;
  }
  return true;
}

// What a member did, for their page: counted from their own partition.
export async function activity(env, id) {
  const r = await all(env, "Query", { TableName: env.ALERTS_TABLE, KeyConditionExpression: "user_id = :u",
    ExpressionAttributeValues: { ":u": { S: id } }, ProjectionExpression: "alert_id, created_at, #s, active",
    ExpressionAttributeNames: { "#s": "state" } }, 10);
  const count = { alerts: 0, active_alerts: 0, saved: 0, applications: 0 };
  for (const row of r.items) {
    const k = String(row.alert_id || "");
    if (k.startsWith("#attempt#")) { if (["submitted", "unconfirmed", "sent"].includes(row.state)) count.applications++; }
    else if (k.startsWith("#applied#")) count.applications++;
    else if (k.startsWith("#saved#") || /^[0-9a-f]{16}$/.test(k)) count.saved++;
    else if (!k.startsWith("#")) { count.alerts++; if (row.active) count.active_alerts++; }
  }
  return count;
}

// The CRM table.
// onlyNew: fail (ConditionalCheckFailed) when the key is already there.
const put = (env, o, onlyNew = false) => ddb(env, "PutItem", { TableName: env.CRM_TABLE, Item: item(o),
  ...(onlyNew ? { ConditionExpression: "attribute_not_exists(sk)" } : {}) });
const del = (env, pk, sk) => ddb(env, "DeleteItem", { TableName: env.CRM_TABLE, Key: item({ pk, sk }) });
export async function get(env, pk, sk) {
  const r = await ddb(env, "GetItem", { TableName: env.CRM_TABLE, Key: item({ pk, sk }) });
  return r.Item ? plain(r.Item) : null;
}
export async function list(env, pk, { newest = true, limit = 200 } = {}) {
  const r = await ddb(env, "Query", { TableName: env.CRM_TABLE, KeyConditionExpression: "pk = :p",
    ExpressionAttributeValues: { ":p": { S: pk } }, ScanIndexForward: !newest, Limit: limit });
  return (r.Items || []).map(plain);
}
export const id = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
export const now = () => new Date().toISOString();

export async function setTags(env, contact, tags) {
  const clean = [...new Set((tags || []).map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
  if (clean.length) await put(env, { pk: "tags", sk: contact, tags: clean });
  else await del(env, "tags", contact);
  dropCache();
  return clean;
}
export async function addNote(env, contact, text) {
  const note = { pk: "note#" + contact, sk: now() + "#" + id(), text: String(text || "").trim().slice(0, 4000) };
  if (!note.text) throw Object.assign(new Error("Write a note first."), { status: 400 });
  await put(env, note);
  return note;
}
export const deleteNote = (env, contact, sk) => del(env, "note#" + contact, sk);

const FILTER_KEYS = ["newsletter", "waitlist", "plan", "tag", "signed_up_after", "search"];
export async function saveSegment(env, body) {
  const name = String(body.name || "").trim().slice(0, 80);
  if (!name) throw Object.assign(new Error("Name the segment."), { status: 400 });
  const filter = Object.fromEntries(FILTER_KEYS.filter((k) => body.filter && body.filter[k] !== undefined && body.filter[k] !== "").map((k) => [k, body.filter[k]]));
  const seg = { pk: "segment", sk: body.id || id(), name, filter, updated: now() };
  await put(env, seg);
  return seg;
}
export const deleteSegment = (env, sk) => del(env, "segment", sk);

export async function saveCampaign(env, body) {
  const old = body.id ? await get(env, "campaign", body.id) : null;
  if (old && old.status !== "draft") throw Object.assign(new Error("This email was already sent and can't be changed."), { status: 409 });
  const c = {
    pk: "campaign", sk: old ? old.sk : id(), status: "draft",
    subject: String(body.subject || "").trim().slice(0, 150),
    body: String(body.body || "").slice(0, 50000),
    segment: body.segment ? String(body.segment) : "",
    created: old ? old.created : now(), updated: now(), sent: old ? old.sent : 0, changelog: body.changelog || (old && old.changelog) || "",
  };
  await put(env, c);
  return c;
}
export const putCampaign = put;
export const deleteCampaign = (env, sk) => del(env, "campaign", sk);

export async function audit(env, who, action, detail = {}) {
  await put(env, { pk: "audit", sk: now() + "#" + id(), who, action, detail });
}
export { put, del };
