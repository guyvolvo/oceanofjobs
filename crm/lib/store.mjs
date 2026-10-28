// The CRM's data. Contacts are read from what already exists: Cognito's
// accounts and the members' own rows in the alerts table (api/consent.py:
// #consent, #email, #waitlist#<plan>; api/dodo.py: #plan). Of those
// rows the CRM writes only two kinds: #grant, a plan given by hand
// (api/apply.py's plan_of honours it), and a credit reset on a
// #ledger# row (api/attempts.py). Its own records (tags, notes, segments, campaigns, the
// changelog, the audit log) are in the CRM table, keyed pk/sk.
import { all, cognito, ddb, item, plain } from "./aws.mjs";

const MEMBER_ROWS = ["#consent", "#email", "#plan", "#grant", "#waitlist#basic", "#waitlist#pro"];
const PLANS = ["free", "basic", "pro"];

// The plan in force, the same rule as api/apply.py's plan_of.
export function planOf(paid = {}, grant = {}, today = new Date().toISOString().slice(0, 10)) {
  const p = PLANS.includes(paid.plan) && ["active", "trialing", "past_due"].includes(paid.status) ? paid.plan : "free";
  const g = PLANS.includes(grant.plan) && (!grant.until || grant.until >= today) ? grant.plan : "free";
  return PLANS.indexOf(g) > PLANS.indexOf(p) ? g : p;
}
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

const projection = (names) => ({ ProjectionExpression: names.map((_, i) => `#n${i}`).join(", "),
  ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#n${i}`, n])) });

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
  // Also what the automatic emails look at: tokens (extension, MCP),
  // the monthly credit ledgers and the resume.
  const rows = await all(env, "Scan", {
    TableName: env.ALERTS_TABLE,
    FilterExpression: "alert_id IN (" + MEMBER_ROWS.map((_, i) => `:r${i}`).join(", ") + ") OR begins_with(alert_id, :tok) "
      + "OR begins_with(alert_id, :led) OR begins_with(alert_id, :res)",
    ExpressionAttributeValues: { ...Object.fromEntries(MEMBER_ROWS.map((r, i) => [`:r${i}`, { S: r }])),
      ":tok": { S: "#token#" }, ":led": { S: "#ledger#month#" }, ":res": { S: "#agent_resume#" } },
    // Every name aliased: DynamoDB reserves many plain words (scope, status, plan, at...).
    ...projection(["user_id", "alert_id", "newsletter", "newsletter_at", "newsletter_source", "unsubscribed_at", "version", "agreed_at", "plan",
      "status", "joined_at", "until", "note", "at", "scope", "created_at", "charged", "subscription_id", "event_at"]),
  }, 20);
  const crm = await all(env, "Query", { TableName: env.CRM_TABLE, KeyConditionExpression: "pk = :p",
    ExpressionAttributeValues: { ":p": { S: "tags" } } }, 5);
  const byUser = {};
  const extra = {};
  for (const r of rows.items) {
    const k = String(r.alert_id);
    const x = (extra[r.user_id] ||= { tokens: [], ledgers: {}, resume: false });
    if (k.startsWith("#token#")) x.tokens.push({ scope: r.scope || "", created_at: r.created_at || "" });
    else if (k.startsWith("#ledger#month#")) x.ledgers[k.slice(14)] = Number(r.charged || 0);
    else if (k.startsWith("#agent_resume#")) x.resume = true;
    else (byUser[r.user_id] ||= {})[k] = r;
  }
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
      plan: planOf(own["#plan"], own["#grant"]),
      license: own["#grant"] && own["#grant"].plan !== "free" ? { plan: own["#grant"].plan, until: own["#grant"].until || "" } : null,
      waitlist: ["basic", "pro"].filter((p) => own["#waitlist#" + p]),
      waiting: Object.fromEntries(["basic", "pro"].filter((p) => own["#waitlist#" + p])
        .map((p) => [p, { joined_at: own["#waitlist#" + p].joined_at || null, status: own["#waitlist#" + p].status || "waiting" }])),
      tags: tags[sub] || [],
      ...(extra[sub] || { tokens: [], ledgers: {}, resume: false }),
      grant: own["#grant"] ? { plan: own["#grant"].plan, until: own["#grant"].until || "", at: own["#grant"].at || "" } : null,
      paid: own["#plan"] ? { plan: own["#plan"].plan, status: own["#plan"].status || "", subscription_id: own["#plan"].subscription_id || "",
        event_at: own["#plan"].event_at || "" } : null,
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
    ExpressionAttributeValues: { ":u": { S: id } }, ...projection(["alert_id", "created_at", "state", "active"]) }, 10);
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

// A member's billing: the paid plan as Dodo last reported it, the
// license given here, and their credit ledgers (newest first).
export async function billing(env, uid) {
  const getRow = (k) => ddb(env, "GetItem", { TableName: env.ALERTS_TABLE, Key: item({ user_id: uid, alert_id: k }) }).then((r) => plain(r.Item));
  const [paid, grant, ledgers] = await Promise.all([getRow("#plan"), getRow("#grant"),
    ddb(env, "Query", { TableName: env.ALERTS_TABLE, KeyConditionExpression: "user_id = :u AND begins_with(alert_id, :l)",
      ExpressionAttributeValues: { ":u": { S: uid }, ":l": { S: "#ledger#" } }, ScanIndexForward: false, Limit: 6 })]);
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? ""]));
  return {
    plan: planOf(paid, grant),
    paid: paid.plan ? pick(paid, ["plan", "status", "period_end", "subscription_id", "customer_id", "event_at"]) : null,
    license: grant.plan && grant.plan !== "free" ? pick(grant, ["plan", "until", "note", "by", "at"]) : null,
    ledgers: (ledgers.Items || []).map(plain).map((l) => ({ key: l.alert_id, held: Number(l.held || 0), charged: Number(l.charged || 0) })),
  };
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });
export async function setLicense(env, uid, b, who) {
  const plan = String(b.plan || "");
  const until = String(b.until || "");
  if (!["basic", "pro", "free"].includes(plan)) throw bad("Pick Basic or Pro.");
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw bad("The end date must be a date.");
  // Removing a license writes plan "free" rather than deleting the row: the
  // CRM's AWS user can't delete anything in the members' table.
  const row = { user_id: uid, alert_id: "#grant", plan, until: plan === "free" ? "" : until, note: String(b.note || "").trim().slice(0, 300), by: who, at: now() };
  await ddb(env, "PutItem", { TableName: env.ALERTS_TABLE, Item: item(row) });
  dropCache();
  return row;
}

// Frees the credits a ledger has charged, leaving the ones still held by
// applications in progress. Only if nothing changed since the page read it.
export async function resetCredits(env, uid, key, charged, who) {
  if (!/^#ledger#(month#\d{4}-\d{2}|day#\d{4}-\d{2}-\d{2})$/.test(key)) throw bad("That isn't a credit period.");
  const n = Number(charged);
  if (!Number.isInteger(n) || n < 1) throw bad("Nothing to reset.");
  try {
    await ddb(env, "UpdateItem", { TableName: env.ALERTS_TABLE, Key: item({ user_id: uid, alert_id: key }),
      UpdateExpression: "SET held = held - :c, charged = :z, reset_at = :t, reset_by = :w",
      ConditionExpression: "charged = :c AND held >= :c",
      ExpressionAttributeValues: item({ ":c": n, ":z": 0, ":t": now(), ":w": who }) });
  } catch (e) {
    if (e.type && e.type.includes("ConditionalCheckFailed")) throw Object.assign(new Error("The credits changed since you opened this. Reload and try again."), { status: 409 });
    throw e;
  }
}

// Each alert's latest digest: alerts.py keeps only last_digest_at on the
// alert's row (set even when SES refused the address), no history.
export async function alertDigests(env) {
  const r = await all(env, "Scan", { TableName: env.ALERTS_TABLE, FilterExpression: "attribute_exists(#n2)",
    ...projection(["user_id", "alert_id", "last_digest_at", "email", "active"]) }, 20);
  return r.items.filter((a) => a.last_digest_at).sort((a, b) => b.last_digest_at.localeCompare(a.last_digest_at));
}

// The Pro waitlist's places: the counter api/consent.py keeps.
export async function waitlistCounts(env) {
  const r = await ddb(env, "GetItem", { TableName: env.ALERTS_TABLE, Key: item({ user_id: "#waitlist", alert_id: "#count#pro" }) });
  const row = plain(r.Item);
  return { pro: { cap: Number(row.cap ?? 100), taken: Number(row.n || 0) } };
}

// The CRM table.
// onlyNew: fail (ConditionalCheckFailed) when the key is already there.
const put = (env, o, onlyNew = false) => ddb(env, "PutItem", { TableName: env.CRM_TABLE, Item: item(o),
  ...(onlyNew ? { ConditionExpression: "attribute_not_exists(sk)" } : {}) });
export async function batchPut(env, items) {
  if (items.length) await ddb(env, "BatchWriteItem", { RequestItems: { [env.CRM_TABLE]: items.map((o) => ({ PutRequest: { Item: item(o) } })) } });
}
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
  if (!name) throw Object.assign(new Error("Name the group."), { status: 400 });
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
    // "notice": terms and privacy updates, to every member as account email.
    kind: ["update", "notice"].includes(body.kind) ? body.kind : (old && old.kind) || "update",
    subject: String(body.subject || "").trim().slice(0, 150),
    body: String(body.body || "").slice(0, 50000),
    segment: body.segment ? String(body.segment) : "",
    image: typeof body.image === "string" ? body.image.slice(0, 300) : (old && old.image) || "",
    // Members picked by hand in Contacts; when set, it replaces the segment.
    to: Array.isArray(body.to) ? [...new Set(body.to.map(String))].slice(0, 5000) : (old && old.to) || [],
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
