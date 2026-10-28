// Flows: automations the owner builds in the CRM, like Power Automate. A
// flow is a trigger, optional conditions on the user, and steps run in
// order (emails, Slack, Discord, a webhook, tags, licenses, approving from
// the waitlist, notes, waiting some days).
//
// Most triggers are read from what the members' rows already say: the
// scheduled run (every 10 minutes) works out who matches now and starts
// the flow for anyone it hasn't run for. Turning a flow on starts from a
// baseline (everyone who matches at that moment is marked done, nothing
// runs for them), so only later matches run. A few triggers are events
// the CRM sees as they happen (mail to info@, a tag added, an approval)
// and run at once through fire().
//
// An "occurrence" makes a trigger repeatable where that makes sense: once
// per user, once per month, once per license end date.
import { all, item, sesSend } from "./aws.mjs";
import { message } from "./mail.mjs";
import { waitlistChange } from "./admin.mjs";
import * as S from "./store.mjs";

const DAY = 864e5;
const LIMITS = { free: 10, basic: 100 }; // api/apply.py LIMITS, monthly plans only
const PLAN = { free: "Free", basic: "Basic", pro: "Pro" };
const fmt = (d) => (d ? new Date(d.length === 10 ? d + "T12:00:00Z" : d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "");
const after = (c, days, now) => c.created && now - Date.parse(c.created) > days * DAY;

export const TRIGGERS = [
  { id: "signup", group: "Account", name: "Signed up", when: (c) => c.created && [["once"]] },
  { id: "subscribed", group: "Account", name: "Subscribed to product updates", when: (c) => c.newsletter && [["once"]] },
  { id: "not_agreed", group: "Account", name: "Hasn't agreed to the updated terms", days: 3, help: "Days after signing up.",
    when: (c, r, now) => !c.agreed_version && after(c, r.days, now) && [["once"]] },
  { id: "extension_connected", group: "Extension", name: "Connected the extension", when: (c) => c.tokens.some((t) => t.scope === "extension") && [["once"]] },
  { id: "no_extension", group: "Extension", name: "Hasn't connected the extension", days: 3, help: "Days after signing up.",
    when: (c, r, now) => !c.tokens.some((t) => t.scope === "extension") && after(c, r.days, now) && [["once"]] },
  { id: "mcp_connected", group: "Extension", name: "Connected an AI agent (MCP)", when: (c) => c.tokens.some((t) => t.scope === "mcp") && [["once"]] },
  { id: "resume_added", group: "Extension", name: "Added a resume", when: (c) => c.resume && [["once"]] },
  { id: "no_resume", group: "Extension", name: "Hasn't added a resume", days: 2, help: "Days after signing up.",
    when: (c, r, now) => !c.resume && after(c, r.days, now) && [["once"]] },
  { id: "first_application", group: "Applications", name: "First application sent", when: (c) => Object.values(c.ledgers).some((n) => n > 0) && [["once"]] },
  { id: "no_application", group: "Applications", name: "No application yet", days: 7, help: "Days after signing up.",
    when: (c, r, now) => !Object.values(c.ledgers).some((n) => n > 0) && after(c, r.days, now) && [["once"]] },
  { id: "credits_used_up", group: "Applications", name: "Used all of this month's applications", help: "Free and Basic; once a month.",
    when: (c, r, now) => {
      const month = new Date(now).toISOString().slice(0, 7);
      return LIMITS[c.plan] && (c.ledgers[month] || 0) >= LIMITS[c.plan] && [[month]];
    } },
  { id: "waitlist_pro", group: "Waitlist", name: "Joined the Pro waitlist", when: (c) => c.waiting.pro && [["once"]] },
  { id: "waitlist_basic", group: "Waitlist", name: "Joined the Basic waitlist", when: (c) => c.waiting.basic && [["once"]] },
  { id: "waitlist_approved", group: "Waitlist", name: "Approved from the waitlist", help: "Runs as soon as you approve.",
    when: (c) => Object.entries(c.waiting).filter(([, w]) => w.status === "approved").map(([plan]) => [plan]) },
  { id: "license_given", group: "Licenses", name: "Given a license", when: (c) => c.grant && c.grant.plan !== "free" && [[`${c.grant.plan}:${c.grant.at}`]] },
  { id: "license_ending", group: "Licenses", name: "License ending soon", days: 7, help: "Days before its last day.",
    when: (c, r, now) => {
      const g = c.grant;
      if (!g || g.plan === "free" || !g.until) return false;
      const left = (Date.parse(g.until + "T23:59:59Z") - now) / DAY;
      return left > 0 && left <= r.days && [[g.until]];
    } },
  { id: "license_ended", group: "Licenses", name: "License ended",
    when: (c, r, now) => c.grant && c.grant.plan !== "free" && c.grant.until && Date.parse(c.grant.until + "T23:59:59Z") < now && [[c.grant.until]] },
  { id: "paid_started", group: "Payments", name: "Started a paid plan", help: "Once payments are live.",
    when: (c) => c.paid && ["active", "trialing"].includes(c.paid.status) && [[c.paid.subscription_id || "once"]] },
  { id: "payment_failed", group: "Payments", name: "A payment failed", help: "Once payments are live.",
    when: (c) => c.paid && ["past_due", "on_hold"].includes(c.paid.status) && [[c.paid.event_at || "once"]] },
  { id: "paid_canceled", group: "Payments", name: "Canceled their paid plan", help: "Once payments are live.",
    when: (c) => c.paid && c.paid.status === "canceled" && [[c.paid.subscription_id || "once"]] },
  { id: "tag_added", group: "CRM", name: "Tag added", event: true, help: "When you add this tag to a user." },
  { id: "inbox_received", group: "CRM", name: "Email received at info@", event: true, help: "{{from}}, {{subject}} and {{message}} hold the email." },
];
export const byId = Object.fromEntries(TRIGGERS.map((t) => [t.id, t]));

// What a step needs, for the editor and for checking what's saved.
export const ACTIONS = {
  email: { name: "Send the user an email", group: "Email", fields: ["subject", "body", "image", "subscribers"] },
  notify: { name: "Email me", group: "Email", fields: ["subject", "body", "image"] },
  slack: { name: "Post to Slack", group: "Connectors", fields: ["url", "text"] },
  discord: { name: "Post to Discord", group: "Connectors", fields: ["url", "text"] },
  webhook: { name: "Call a webhook", group: "Connectors", fields: ["url"] },
  tag_add: { name: "Add a tag", group: "CRM", fields: ["tag"] },
  tag_remove: { name: "Remove a tag", group: "CRM", fields: ["tag"] },
  license: { name: "Give a license", group: "CRM", fields: ["plan", "days"] },
  approve: { name: "Approve from the waitlist", group: "CRM", fields: ["days"] },
  note: { name: "Add a note", group: "CRM", fields: ["text"] },
  wait: { name: "Wait", group: "Timing", fields: ["days"] },
};
const MESSAGING = new Set(["email", "notify", "slack", "discord", "webhook"]);
const URLS = { slack: /^https:\/\/hooks\.slack\.com\//, discord: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//, webhook: /^https:\/\// };

// A flow as saved: only known fields, checked.
export function clean(b) {
  const t = byId[b.trigger];
  if (!t) throw Object.assign(new Error("Pick a trigger."), { status: 400 });
  const actions = (Array.isArray(b.actions) ? b.actions : []).slice(0, 12).map((a) => {
    const spec = ACTIONS[a.type];
    if (!spec) throw Object.assign(new Error("Unknown step."), { status: 400 });
    const out = { type: a.type };
    for (const f of spec.fields) {
      if (f === "subscribers") out[f] = !!a[f];
      else if (f === "image") out[f] = typeof a[f] === "string" && (a[f] === "none" || a[f].startsWith("https://oceanofjobs.com/mail/")) ? a[f] : "";
      else if (f === "days") out[f] = Math.max(0, Math.min(3650, Number(a[f]) || 0));
      else if (f === "plan") out[f] = a[f] === "basic" ? "basic" : "pro";
      else out[f] = String(a[f] ?? "").slice(0, f === "body" || f === "text" ? 50000 : 500).trim();
    }
    if (URLS[a.type] && !URLS[a.type].test(out.url)) throw Object.assign(new Error(`That isn't a ${spec.name.replace(/^Post to |^Call a /, "")} address.`), { status: 400 });
    return out;
  });
  return { name: String(b.name || t.name).trim().slice(0, 120), trigger: t.id, enabled: !!b.enabled,
    days: t.days !== undefined ? Math.max(0, Math.min(365, Number(b.days ?? t.days) || 0)) : undefined,
    tag: t.id === "tag_added" ? String(b.tag || "").trim().toLowerCase().slice(0, 40) : undefined,
    conditions: b.conditions && typeof b.conditions === "object" ? b.conditions : {}, actions };
}

// {{email}} {{plan}} {{waitlist}} {{license_until}} {{pro_left}} {{tag}} {{from}} {{subject}} {{message}}
export function fill(text, vars) {
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
export function vars(c, counts, extra = {}) {
  return {
    email: (c && c.email) || "", plan: (c && (PLAN[c.plan] || c.plan)) || "",
    waitlist: c && c.waiting ? (c.waiting.pro ? "Pro" : c.waiting.basic ? "Basic" : "") : "",
    license_until: c && c.grant && c.grant.until ? fmt(c.grant.until) : "",
    pro_left: counts ? Math.max(0, counts.pro.cap - counts.pro.taken) : "", ...extra,
  };
}

// Who a flow would start for right now: [{ contact, key }].
export function matches(flow, contacts, now = Date.now()) {
  const t = byId[flow.trigger];
  if (!t || !t.when) return [];
  const out = [];
  for (const c of contacts) {
    if (!c.email || !c.enabled || !S.matches(c, flow.conditions || {})) continue;
    for (const [o] of t.when(c, { days: Number(flow.days ?? t.days ?? 0) }, now) || []) out.push({ contact: c, key: `${flow.sk}#${c.id}#${o}` });
  }
  return out;
}

const post = (url, payload) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "ooj-crm" }, body: JSON.stringify(payload) })
  .then((r) => { if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`); });

async function step(env, a, { contact: c, vars: v, flow, test }) {
  const plainText = (s) => fill(s, v);
  if (a.type === "email") {
    if (!c || !c.email || (a.subscribers && !c.newsletter)) return "skipped";
    await sesSend(env, await message(env, { to: test ? env.OWNER_EMAIL : c.email, userId: c.id || "x", subject: (test ? "[Test] " : "") + fill(a.subject, v),
      md: fill(a.body, v), kind: a.subscribers ? "newsletter" : "account", image: a.image }));
  } else if (a.type === "notify") {
    await sesSend(env, await message(env, { to: env.OWNER_EMAIL, userId: "owner", subject: (test ? "[Test] " : "") + fill(a.subject, v), md: fill(a.body, v),
      kind: "account", image: a.image }));
  } else if (a.type === "slack") await post(a.url, { text: plainText(a.text) });
  else if (a.type === "discord") await post(a.url, { content: plainText(a.text).slice(0, 2000) });
  else if (a.type === "webhook") {
    await post(a.url, { flow: flow.name, trigger: flow.trigger, test: !!test, vars: v,
      user: c ? { id: c.id, email: c.email, plan: c.plan, newsletter: c.newsletter, waitlist: c.waitlist, tags: c.tags } : null });
  } else if (test) return "skipped in a test";
  else if (!c || !c.id) return "skipped";
  else if (a.type === "tag_add" || a.type === "tag_remove") {
    const tags = new Set(c.tags || []);
    a.type === "tag_add" ? tags.add(a.tag) : tags.delete(a.tag);
    c.tags = await S.setTags(env, c.id, [...tags]);
  } else if (a.type === "license") {
    const until = a.days ? new Date(Date.now() + a.days * DAY).toISOString().slice(0, 10) : "";
    await S.setLicense(env, c.id, { plan: a.plan, until, note: `Flow: ${flow.name}` }, "flow");
  } else if (a.type === "approve") {
    const plan = c.waiting && c.waiting.pro ? "pro" : c.waiting && c.waiting.basic ? "basic" : "";
    if (!plan) return "skipped";
    const until = a.days ? new Date(Date.now() + a.days * DAY).toISOString().slice(0, 10) : "";
    await S.setLicense(env, c.id, { plan, until, note: `Flow: ${flow.name}` }, "flow");
    await waitlistChange(env, { op: "mark", user_id: c.id, plan, status: "approved" });
  } else if (a.type === "note") await S.addNote(env, c.id, plainText(a.text));
  return "done";
}

// Runs a flow's steps from `from` until the end or a Wait, which parks the
// rest (flow-pending) for the scheduled run to pick up when it's due.
export async function runSteps(env, flow, contact, v, { from = 0, test = false, now = Date.now() } = {}) {
  const log = [];
  for (let i = from; i < flow.actions.length; i++) {
    const a = flow.actions[i];
    if (a.type === "wait") {
      if (test) { log.push([a.type, "skipped in a test"]); continue; }
      await S.put(env, { pk: "flow-pending", sk: new Date(now + a.days * DAY).toISOString() + "#" + S.id(), flow: flow.sk,
        user: contact && contact.id ? contact.id : "", email: contact ? contact.email : "", step: i + 1, vars: v });
      log.push([a.type, `until ${fmt(new Date(now + a.days * DAY).toISOString())}`]);
      return log;
    }
    try { log.push([a.type, await step(env, a, { contact, vars: v, flow, test })]); }
    catch (e) { log.push([a.type, "failed"]); throw Object.assign(e, { steps: log }); }
  }
  return log;
}

// runSteps, plus one row in the flow's log (flowlog#<flow>, keyed by time)
// for this run: who, which trigger, each step's result, or the error. One
// PutItem per run: a scheduled run has 50 subrequests for up to MAX_RUNS.
export async function runLogged(env, flow, contact, v, opts = {}) {
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const row = { pk: "flowlog#" + flow.sk, sk: at + "#" + S.id(), at, trigger: flow.trigger, test: !!opts.test, from: opts.from || 0,
    email: (contact && contact.email) || "", user: (contact && contact.id) || "" };
  try {
    const steps = await runSteps(env, flow, contact, v, opts);
    await S.put(env, { ...row, steps });
    return steps;
  } catch (e) {
    await S.put(env, { ...row, steps: e.steps || [], error: String(e && e.message).slice(0, 300) }).catch(() => {});
    throw e;
  }
}

const enabledFlows = async (env) => (await S.list(env, "flow", { newest: false })).filter((f) => f.enabled && byId[f.trigger] && Array.isArray(f.actions));

// An event the CRM saw happen: runs the matching flows now. A key makes it
// once only (an approval also matches the scheduled trigger, which then
// finds it done).
export async function fire(env, trigger, contact, extra = {}, { key = "", flows = null, counts = null } = {}) {
  if (env.SENDING !== "on") return 0;
  let n = 0;
  for (const f of (flows || await enabledFlows(env)).filter((x) => x.trigger === trigger)) {
    if (trigger === "tag_added" && f.tag !== extra.tag) continue;
    if (contact && contact.id && !S.matches(contact, f.conditions || {})) continue;
    if (key) {
      try { await S.put(env, { pk: "flow-done", sk: `${f.sk}#${contact ? contact.id : ""}#${key}`, at: S.now() }, true); }
      catch (e) { if (e.type && e.type.includes("ConditionalCheckFailed")) continue; throw e; }
    }
    await runLogged(env, f, contact, vars(contact, counts, extra));
    await S.put(env, { ...f, runs: (f.runs || 0) + 1, last_run_at: S.now() });
    n++;
  }
  return n;
}
export const flowsFor = async (env, trigger) => (await enabledFlows(env)).filter((f) => f.trigger === trigger);

const MAX_RUNS = 6; // per scheduled run: a free Worker gets 50 subrequests

export async function run(env, { now = Date.now(), log = console.log } = {}) {
  if (env.SENDING !== "on") return { ran: 0, paused: true };
  const flows = await enabledFlows(env);
  if (!flows.length) return { ran: 0 };
  const [{ contacts }, done, counts, pending] = await Promise.all([S.contacts(env, { fresh: true }),
    all(env, "Query", { TableName: env.CRM_TABLE, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": { S: "flow-done" } },
      ProjectionExpression: "#k", ExpressionAttributeNames: { "#k": "sk" } }, 10),
    S.waitlistCounts(env),
    S.list(env, "flow-pending", { newest: false, limit: MAX_RUNS })]);
  let ran = 0;
  // Flows waiting out a Wait step, oldest due first.
  for (const p of pending) {
    if (ran >= MAX_RUNS || p.sk > new Date(now).toISOString()) break;
    await S.del(env, "flow-pending", p.sk);
    const f = flows.find((x) => x.sk === p.flow);
    if (!f) continue;
    const c = contacts.find((x) => x.id === p.user) || (p.email ? { email: p.email } : null);
    try { await runLogged(env, f, c, p.vars || vars(c, counts), { from: p.step, now }); ran++; } catch (e) { log("flow step failed", f.name, e && e.message); }
  }
  const seen = new Set(done.items.map((i) => i.sk));
  for (const f of flows.filter((x) => byId[x.trigger].when)) {
    const fresh = matches(f, contacts, now).filter((m) => !seen.has(m.key));
    if (!f.baseline_at) {
      // A failure here shows on the flow: it once failed silently for days
      // (the key had no BatchWriteItem), and the flow read 0 runs, no error.
      try {
        for (let i = 0; i < fresh.length; i += 25) {
          await S.batchPut(env, fresh.slice(i, i + 25).map((m) => ({ pk: "flow-done", sk: m.key, at: new Date(now).toISOString(), skipped: true })));
        }
        await S.put(env, { ...f, baseline_at: new Date(now).toISOString(), baseline_count: fresh.length });
      } catch (e) {
        log("flow baseline failed", f.name, e && e.message);
        await S.put(env, { ...f, last_error: String(e && e.message).slice(0, 300), last_error_at: new Date(now).toISOString() }).catch(() => {});
      }
      continue;
    }
    for (const m of fresh) {
      if (ran >= MAX_RUNS) break;
      try { await S.put(env, { pk: "flow-done", sk: m.key, at: new Date(now).toISOString() }, true); }
      catch (e) { if (e.type && e.type.includes("ConditionalCheckFailed")) continue; throw e; }
      try {
        await runLogged(env, f, m.contact, vars(m.contact, counts), { now });
        f.runs = (f.runs || 0) + 1;
        await S.put(env, { ...f, last_run_at: new Date(now).toISOString() });
        ran++;
      } catch (e) {
        log("flow failed", f.name, e && e.message);
        f.errors = (f.errors || 0) + 1;
        await S.put(env, { ...f, last_error: String(e && e.message).slice(0, 300), last_error_at: new Date(now).toISOString() });
      }
    }
  }
  return { ran };
}
