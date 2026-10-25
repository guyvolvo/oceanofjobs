// The CRM at crm.oceanofjobs.com: one owner, behind Cloudflare Access.
//
// Every request, page or API, needs Access's signed token for OWNER_EMAIL
// (lib/access.mjs); without it the answer is a 403 with nothing in it.
// API writes also need the X-CRM header, which a page on another site
// can't send without a CORS preflight this Worker never answers.
// Sending to members needs SENDING=on as well: until the owner says so,
// only test emails to the owner go out.
import ASSETS from "./assets.mjs";
import { owner } from "./lib/access.mjs";
import { s3Put, sesSend } from "./lib/aws.mjs";
import { message, reply } from "./lib/mail.mjs";
import { address, decodeWords, readMessage } from "./lib/mime.mjs";
import { waitlistChange } from "./lib/admin.mjs";
import * as A from "./lib/auto.mjs";
import * as S from "./lib/store.mjs";

const SECURITY = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://oceanofjobs.com; font-src 'self' data:; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Robots-Tag": "noindex, nofollow",
};
const BATCH = 15; // recipients per send call: two subrequests each, under a free Worker's 50
const REPO = "guyvolvo/oceanofjobs";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...SECURITY, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (status, error) => json(status, { error });

function asset(path) {
  const file = ASSETS[path] || (!path.includes(".") ? ASSETS["/index.html"] : null);
  if (!file) return new Response("Not found", { status: 404, headers: SECURITY });
  const body = file.base64 ? Uint8Array.from(atob(file.body), (c) => c.charCodeAt(0)) : file.body;
  const immutable = path.startsWith("/assets/");
  return new Response(body, { headers: { ...SECURITY, "Content-Type": file.type, "Cache-Control": immutable ? "private, max-age=31536000, immutable" : "no-store" } });
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

// Who gets a campaign: the members picked by hand, or the segment's, and
// of those only the ones with the newsletter on.
async function recipients(env, campaign) {
  const { contacts } = await S.contacts(env);
  const picked = campaign.to && campaign.to.length ? new Set(campaign.to) : null;
  const seg = !picked && campaign.segment ? await S.get(env, "segment", campaign.segment) : null;
  return contacts.filter((c) => c.newsletter && c.enabled && c.email && (picked ? picked.has(c.id) : S.matches(c, seg ? seg.filter : {})))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function dispatchChangelog(env, entry) {
  if (!env.GITHUB_TOKEN) throw Object.assign(new Error("Publishing to the website isn't set up yet."), { status: 503 });
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/publish-changelog.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ooj-crm", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { id: entry.sk, date: entry.date, title: entry.title, body: entry.body } }),
  });
  if (res.status !== 204) throw Object.assign(new Error(`GitHub refused the publish (${res.status}).`), { status: 502 });
}

const CSV_COLS = ["email", "created", "provider", "plan", "newsletter", "newsletter_source", "waitlist", "tags", "agreed_version"];
const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join(" ") : v === null || v === undefined ? "" : String(v);
  // A leading = + - @ would run as a formula when the file is opened.
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

async function api(request, env, who, path) {
  const method = request.method;
  const url = new URL(request.url);
  const q = Object.fromEntries(url.searchParams);
  const parts = path.split("/").filter(Boolean); // ["api", ...]
  const [, area, sub, more, last] = parts;

  if (area === "me" && method === "GET") return json(200, { email: who, sending: env.SENDING === "on" });

  if (area === "dashboard" && method === "GET") {
    const { contacts, complete } = await S.contacts(env, { fresh: q.fresh === "1" });
    const since = (days) => new Date(Date.now() - days * 864e5).toISOString();
    return json(200, {
      complete,
      members: contacts.length,
      new_7: contacts.filter((c) => c.created >= since(7)).length,
      new_30: contacts.filter((c) => c.created >= since(30)).length,
      newsletter: contacts.filter((c) => c.newsletter).length,
      agreed: contacts.filter((c) => c.agreed_version).length,
      waitlist: { basic: contacts.filter((c) => c.waitlist.includes("basic")).length, pro: contacts.filter((c) => c.waitlist.includes("pro")).length },
      plans: contacts.reduce((m, c) => ({ ...m, [c.plan]: (m[c.plan] || 0) + 1 }), {}),
      // Every one of the 30 days, so a day with no sign-ups shows as a gap, not as missing.
      by_day: Array.from({ length: 30 }, (_, i) => since(29 - i).slice(0, 10))
        .map((d) => [d, contacts.filter((c) => (c.created || "").startsWith(d)).length]),
    });
  }

  if (area === "contacts.csv" && method === "GET") {
    const { contacts } = await S.contacts(env);
    const rows = contacts.filter((c) => S.matches(c, q));
    await S.audit(env, who, "export", { count: rows.length, filter: q });
    const csv = [CSV_COLS.join(","), ...rows.map((c) => CSV_COLS.map((k) => csvCell(c[k])).join(","))].join("\n");
    return new Response(csv, { headers: { ...SECURITY, "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="ocean-of-jobs-contacts-${new Date().toISOString().slice(0, 10)}.csv"` } });
  }

  if (area === "contacts") {
    if (!sub && method === "GET") {
      const { contacts, complete } = await S.contacts(env, { fresh: q.fresh === "1" });
      const filter = { ...q, newsletter: q.newsletter === "yes" ? true : q.newsletter === "no" ? false : undefined };
      return json(200, { complete, contacts: contacts.filter((c) => S.matches(c, filter)) });
    }
    if (sub && !more && method === "GET") {
      const { contacts } = await S.contacts(env);
      const c = contacts.find((x) => x.id === sub);
      if (!c) return fail(404, "No user with that id.");
      const [activity, notes, billing, emails] = await Promise.all([S.activity(env, sub), S.list(env, "note#" + sub),
        S.billing(env, sub), S.list(env, "direct#" + sub, { limit: 20 })]);
      await S.audit(env, who, "view contact", { contact: sub });
      return json(200, { contact: c, activity, notes, billing, emails, billing_url: env.BILLING_URL || "" });
    }
    if (sub && more === "license" && method === "PUT") {
      const row = await S.setLicense(env, sub, await body(request), who);
      await S.audit(env, who, row.plan === "free" ? "remove license" : "license", { contact: sub, plan: row.plan, until: row.until });
      return json(200, { billing: await S.billing(env, sub) });
    }
    if (sub && more === "credits" && method === "POST") {
      const b = await body(request);
      await S.resetCredits(env, sub, String(b.key || ""), b.charged, who);
      await S.audit(env, who, "reset credits", { contact: sub, period: b.key, freed: Number(b.charged) });
      return json(200, { billing: await S.billing(env, sub) });
    }
    if (sub && more === "email" && method === "POST") {
      // One email to one member, about their account: not a promotion, so
      // it doesn't need the newsletter on, but it does need SENDING.
      const b = await body(request);
      const subject = String(b.subject || "").trim().slice(0, 150);
      const md = String(b.body || "").slice(0, 50000);
      const image = typeof b.image === "string" ? b.image.slice(0, 300) : "";
      if (!subject || !md.trim()) return fail(400, "Write a subject and a message first.");
      const { contacts } = await S.contacts(env);
      const c = contacts.find((x) => x.id === sub);
      if (!c || !c.email) return fail(404, "No user with that id.");
      if (b.test) {
        const me = contacts.find((x) => x.email === who);
        await sesSend(env, await message(env, { to: who, userId: me ? me.id : "owner-test", subject: "[Test] " + subject, md, image }));
        await S.audit(env, who, "test email", { contact: sub });
        return json(200, { sent_to: who });
      }
      if (env.SENDING !== "on") return fail(403, "Sending to users is turned off. Only test emails go out.");
      await sesSend(env, await message(env, { to: c.email, userId: c.id, subject, md, kind: "account", image }));
      const rec = { pk: "direct#" + sub, sk: S.now() + "#" + S.id(), subject, body: md, to: c.email };
      await S.put(env, rec);
      await S.audit(env, who, "email member", { contact: sub, subject });
      return json(200, { email: rec });
    }
    if (sub && more === "tags" && method === "PUT") {
      const { contacts } = await S.contacts(env);
      const before = new Set((contacts.find((x) => x.id === sub) || {}).tags || []);
      const tags = await S.setTags(env, sub, (await body(request)).tags);
      await S.audit(env, who, "tags", { contact: sub, tags });
      const c = contacts.find((x) => x.id === sub);
      for (const t of tags.filter((x) => !before.has(x))) if (c) await A.fire(env, "tag_added", { ...c, tags }, { tag: t });
      return json(200, { tags });
    }
    if (sub && more === "notes" && method === "POST") {
      const note = await S.addNote(env, sub, (await body(request)).text);
      await S.audit(env, who, "note", { contact: sub });
      return json(200, { note });
    }
    if (sub && more === "notes" && last && method === "DELETE") {
      await S.deleteNote(env, sub, decodeURIComponent(last));
      await S.audit(env, who, "delete note", { contact: sub });
      return json(200, { ok: true });
    }
  }

  if (area === "segments") {
    if (!sub && method === "GET") return json(200, { segments: await S.list(env, "segment", { newest: false }) });
    if (!sub && method === "POST") {
      const seg = await S.saveSegment(env, await body(request));
      await S.audit(env, who, "segment", { segment: seg.sk, name: seg.name });
      return json(200, { segment: seg });
    }
    if (sub && method === "DELETE") {
      await S.deleteSegment(env, sub);
      await S.audit(env, who, "delete segment", { segment: sub });
      return json(200, { ok: true });
    }
  }

  if (area === "campaigns") {
    if (!sub && method === "GET") return json(200, { campaigns: await S.list(env, "campaign") });
    if (!sub && method === "POST") {
      const c = await S.saveCampaign(env, await body(request));
      await S.audit(env, who, "save campaign", { campaign: c.sk });
      return json(200, { campaign: c });
    }
    const c = sub ? await S.get(env, "campaign", sub) : null;
    if (sub && !c) return fail(404, "No email with that id.");
    if (sub && !more && method === "DELETE") {
      if (c.status !== "draft") return fail(409, "A sent email stays in the record.");
      await S.deleteCampaign(env, sub);
      await S.audit(env, who, "delete campaign", { campaign: sub });
      return json(200, { ok: true });
    }
    if (sub && more === "recipients" && method === "GET") {
      const list = await recipients(env, c);
      return json(200, { count: list.length, sample: list.slice(0, 10).map((r) => r.email) });
    }
    if (sub && more === "test" && method === "POST") {
      if (!c.subject || !c.body) return fail(400, "Write a subject and a message first.");
      const { contacts } = await S.contacts(env);
      const me = contacts.find((x) => x.email === who);
      await sesSend(env, await message(env, { to: who, userId: me ? me.id : "owner-test", subject: "[Test] " + c.subject, md: c.body, image: c.image }));
      await S.audit(env, who, "test email", { campaign: sub });
      return json(200, { sent_to: who });
    }
    if (sub && more === "send" && method === "POST") {
      if (env.SENDING !== "on") return fail(403, "Sending to users is turned off. Only test emails go out.");
      if (!c.subject || !c.body) return fail(400, "Write a subject and a message first.");
      const b = await body(request);
      const list = await recipients(env, c);
      if (Number(b.confirm) !== list.length) return fail(409, `Type ${list.length}, the number of people this goes to, to send it.`);
      const cap = Number(env.DAILY_CAP || 500);
      const today = new Date().toISOString().slice(0, 10);
      const day = (await S.get(env, "sent-day", today)) || { pk: "sent-day", sk: today, count: 0 };
      const start = list.findIndex((r) => r.id > String(b.cursor || ""));
      const batch = start < 0 ? [] : list.slice(start, start + BATCH);
      let sent = 0;
      let last = null;
      for (const r of batch) {
        if (day.count + sent >= cap) break;
        last = r;
        // One email per member per campaign, whatever retries happen.
        try {
          await S.put(env, { pk: "sent#" + sub, sk: r.id, at: S.now() }, true);
        } catch (e) {
          if (e.type && e.type.includes("ConditionalCheckFailed")) continue;
          throw e;
        }
        await sesSend(env, await message(env, { to: r.email, userId: r.id, subject: c.subject, md: c.body, image: c.image }));
        sent++;
      }
      day.count += sent;
      await S.put(env, day);
      const cursor = last ? last.id : String(b.cursor || "");
      const done = !batch.length || (last && last.id === list[list.length - 1].id);
      await S.putCampaign(env, { ...c, status: done ? "sent" : "sending", sent: (c.sent || 0) + sent, sent_at: done ? S.now() : c.sent_at || "" });
      await S.audit(env, who, "send batch", { campaign: sub, sent });
      return json(200, { sent, cursor, done: !!done, capped: day.count >= cap, total: list.length });
    }
  }

  if (area === "changelog") {
    if (!sub && method === "GET") return json(200, { entries: await S.list(env, "changelog") });
    if (!sub && method === "POST") {
      const b = await body(request);
      const entry = { pk: "changelog", sk: S.id(), date: String(b.date || "").slice(0, 10), title: String(b.title || "").trim().slice(0, 120),
        body: String(b.body || "").trim().slice(0, 20000), created: S.now(), published_at: "" };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !entry.title || !entry.body) return fail(400, "Add a date, a title and what changed.");
      await dispatchChangelog(env, entry);
      entry.published_at = S.now();
      await S.put(env, entry);
      await S.audit(env, who, "publish changelog", { entry: entry.sk, title: entry.title });
      return json(200, { entry, actions: `https://github.com/${REPO}/actions/workflows/publish-changelog.yml` });
    }
    if (sub && more === "email" && method === "POST") {
      const entry = await S.get(env, "changelog", sub);
      if (!entry) return fail(404, "No entry with that id.");
      const c = await S.saveCampaign(env, { subject: entry.title, changelog: entry.sk,
        body: `${entry.body}\n\n[See every change](https://oceanofjobs.com/docs/changelog)` });
      await S.audit(env, who, "changelog to email", { entry: sub, campaign: c.sk });
      return json(200, { campaign: c });
    }
  }

  if (area === "images" && method === "POST") {
    // A cropped header image (the page crops it to 1104x280, twice the
    // email's 552x140), stored on the site so mail clients can load it.
    const b = await body(request);
    let bytes;
    try { bytes = Uint8Array.from(atob(String(b.data || "")), (ch) => ch.charCodeAt(0)); } catch { return fail(400, "That isn't an image."); }
    if (bytes.length < 100 || bytes.length > 1_500_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return fail(400, "Send a JPEG under 1.5 MB.");
    const key = `mail/${S.id()}${S.id()}.jpg`;
    await s3Put(env, key, bytes, "image/jpeg");
    await S.audit(env, who, "image", { key });
    return json(200, { url: `https://oceanofjobs.com/${key}` });
  }

  if (area === "flows") {
    if (!sub && method === "GET") {
      const flows = (await S.list(env, "flow", { newest: false })).map(({ pk, ...f }) => ({ ...f, id: f.sk }));
      return json(200, { flows, sending: env.SENDING === "on",
        triggers: A.TRIGGERS.map((t) => ({ id: t.id, group: t.group, name: t.name, help: t.help || "", days: t.days ?? null, event: !!t.event })),
        actions: A.ACTIONS });
    }
    if (sub === "run" && method === "POST") return json(200, await A.run(env));
    if (!sub && method === "POST") {
      const b = await body(request);
      const old = b.id ? await S.get(env, "flow", String(b.id)) : null;
      const f = A.clean(b);
      if (f.enabled && !f.actions.length) return fail(400, "Add a step before turning it on.");
      if (f.enabled && f.trigger === "tag_added" && !f.tag) return fail(400, "Name the tag that starts it.");
      const flow = { pk: "flow", sk: old ? old.sk : S.id(), ...f, runs: old ? old.runs || 0 : 0, created: old ? old.created : S.now(), updated: S.now(),
        // Turning it on, or changing what starts it, takes a new baseline on the next run.
        baseline_at: old && old.enabled && f.enabled && old.trigger === f.trigger && old.days === f.days
          && JSON.stringify(old.conditions || {}) === JSON.stringify(f.conditions) ? old.baseline_at || "" : "" };
      await S.put(env, Object.fromEntries(Object.entries(flow).filter(([, v]) => v !== undefined)));
      await S.audit(env, who, f.enabled ? "flow on" : "flow saved", { flow: flow.sk, name: flow.name });
      return json(200, { flow: { ...flow, id: flow.sk } });
    }
    const f = sub ? await S.get(env, "flow", sub) : null;
    if (sub && !f) return fail(404, "No such flow.");
    if (sub && !more && method === "DELETE") {
      await S.del(env, "flow", sub);
      await S.audit(env, who, "delete flow", { flow: sub, name: f.name });
      return json(200, { ok: true });
    }
    if (sub && more === "test" && method === "POST") {
      // Messages only, about you: emails go to you, Slack, Discord and webhooks
      // get a test post; steps that change data are skipped.
      const { contacts } = await S.contacts(env);
      const me = contacts.find((x) => x.email === who) || { id: "owner", email: who, plan: "free", waiting: {}, tags: [] };
      const log = await A.runSteps(env, f, me, A.vars(me, await S.waitlistCounts(env), { tag: f.tag || "", from: who, subject: "Test", message: "A test message." }), { test: true });
      return json(200, { log });
    }
    if (sub && more === "preview" && method === "GET") {
      const { contacts } = await S.contacts(env);
      const list = A.matches(f, contacts);
      return json(200, { count: list.length, sample: list.slice(0, 5).map((m) => m.contact.email) });
    }
  }

  if (area === "waitlist") {
    if (!sub && method === "GET") {
      const [{ contacts }, counts] = await Promise.all([S.contacts(env, { fresh: q.fresh === "1" }), S.waitlistCounts(env)]);
      const people = contacts.flatMap((c) => Object.entries(c.waiting || {}).map(([plan, w]) => ({
        id: c.id, email: c.email, waitlist: plan, joined_at: w.joined_at, status: w.status,
        newsletter: c.newsletter, plan: c.plan, license: c.license })))
        .sort((a, b) => (a.joined_at || "").localeCompare(b.joined_at || ""));
      return json(200, { counts, people });
    }
    if (!sub && method === "POST") {
      const b = await body(request);
      if (!["remove", "move", "cap"].includes(b.op)) return fail(400, "Unknown change.");
      const out = await waitlistChange(env, { op: b.op, user_id: String(b.user_id || ""), plan: String(b.plan || ""),
        ...(b.op === "cap" ? { cap: Number(b.cap) } : {}) });
      S.dropCache();
      await S.audit(env, who, "waitlist " + b.op, { contact: b.user_id || "", plan: b.plan || "", cap: b.cap ?? "" });
      return json(200, out);
    }
    if (sub === "approve" && method === "POST") {
      // Gives each their waitlist's plan as a license until the date, marks
      // them approved and runs the "Approved from the waitlist" flows now
      // rather than on the next scheduled run (the key they leave keeps that
      // run from starting them again). Eight at a time.
      const b = await body(request);
      const people = (Array.isArray(b.people) ? b.people : []).slice(0, 8);
      const until = String(b.until || "");
      if (!people.length) return fail(400, "Pick someone to approve.");
      const flows = await A.flowsFor(env, "waitlist_approved");
      const { contacts } = flows.length ? await S.contacts(env) : { contacts: [] };
      const counts = flows.length ? await S.waitlistCounts(env) : null;
      const done = [];
      let ran = 0;
      for (const p of people) {
        const plan = p.plan === "basic" ? "basic" : "pro";
        await S.setLicense(env, String(p.id), { plan, until, note: "Waitlist" }, who);
        await waitlistChange(env, { op: "mark", user_id: String(p.id), plan, status: "approved" });
        done.push(p.id);
        const c = contacts.find((x) => x.id === p.id);
        if (c) {
          ran += await A.fire(env, "waitlist_approved", { ...c, grant: { plan, until, at: S.now() }, waiting: { ...c.waiting, [plan]: { ...(c.waiting[plan] || {}), status: "approved" } } },
            {}, { key: plan, flows, counts });
        }
      }
      S.dropCache();
      await S.audit(env, who, "waitlist approve", { people: done, until, flows: ran });
      return json(200, { approved: done, flows: ran });
    }
  }

  if (area === "inbox") {
    if (!sub && method === "GET") return json(200, { messages: await S.list(env, "inbox", { limit: 500 }) });
    if (sub === "read" && method === "POST") {
      const sks = ((await body(request)).sk || []).slice(0, 100).map(String);
      for (const sk of sks) {
        const m = await S.get(env, "inbox", sk);
        if (m && !m.read) await S.put(env, { ...m, read: true });
      }
      return json(200, { ok: true });
    }
    if (sub === "reply" && method === "POST") {
      if (env.SENDING !== "on") return fail(403, "Sending is turned off.");
      const b = await body(request);
      const m = await S.get(env, "inbox", String(b.sk || ""));
      if (!m || m.dir !== "in") return fail(404, "No message to reply to.");
      const md = String(b.body || "").slice(0, 50000);
      if (!md.trim()) return fail(400, "Write a reply first.");
      await sesSend(env, reply(env, { to: m.email, subject: m.subject, md, inReplyTo: m.message_id, references: m.references }));
      const out = { pk: "inbox", sk: S.now() + "#" + S.id(), dir: "out", email: m.email, name: m.name, subject: m.subject,
        text: md, contact: m.contact, read: true, reply_to: m.sk, by: who };
      await S.put(env, out);
      await S.audit(env, who, "reply", { to: m.email, contact: m.contact });
      return json(200, { message: out });
    }
  }

  if (area === "audit" && method === "GET") return json(200, { entries: await S.list(env, "audit", { limit: 200 }) });
  return fail(404, "No such route.");
}

// The message as a binary string, one char per byte, read up to `max`.
async function rawText(stream, max = 2_000_000) {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done || out.length > max) break;
    for (let i = 0; i < value.length; i += 0x8000) out += String.fromCharCode(...value.subarray(i, i + 0x8000));
  }
  return out;
}

// Mail to info@ (Cloudflare Email Routing sends it here): forwarded to the
// owner's own inbox first, so nothing is lost if saving it fails, then
// saved for the Inbox tab, matched to a member by address.
export async function receive(msg, env) {
  if (env.FORWARD_TO) {
    try { await msg.forward(env.FORWARD_TO); } catch (e) { console.log("forward failed", e && e.message); }
  }
  try {
    const from = address(msg.headers.get("from") || msg.from);
    const { text, attachments } = readMessage(await rawText(msg.raw));
    const { contacts } = await S.contacts(env);
    const c = contacts.find((x) => x.email === from.email);
    const subject = decodeWords(msg.headers.get("subject") || "").slice(0, 300);
    await S.put(env, { pk: "inbox", sk: S.now() + "#" + S.id(), dir: "in", email: from.email, name: from.name.slice(0, 200),
      subject, text: text.slice(0, 30000), attachments,
      message_id: (msg.headers.get("message-id") || "").slice(0, 500), references: (msg.headers.get("references") || "").slice(0, 2000),
      to: String(msg.to || "").slice(0, 200), contact: c ? c.id : "", read: false });
    await A.fire(env, "inbox_received", c || { email: from.email, tags: [], waiting: {} },
      { from: from.name ? `${from.name} <${from.email}>` : from.email, subject, message: text.slice(0, 3000) });
  } catch (e) {
    console.log("saving mail failed", e && e.message);
  }
}

export default {
  email: (msg, env) => receive(msg, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(A.run(env).catch((e) => console.log("automatic emails failed", e && e.message))),
  async fetch(request, env) {
    const url = new URL(request.url);
    const who = await owner(request, env);
    if (!who) return new Response("Forbidden", { status: 403, headers: { ...SECURITY, "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    if (!url.pathname.startsWith("/api/")) {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: SECURITY });
      return asset(url.pathname === "/" ? "/index.html" : url.pathname);
    }
    if (request.method !== "GET" && request.headers.get("X-CRM") !== "1") return fail(403, "Missing the CRM header.");
    try {
      return await api(request, env, who, url.pathname);
    } catch (e) {
      if (e.status && e.status < 500) return fail(e.status, e.message);
      console.log("crm error", e && e.message);
      return fail(e.status || 500, e.status === 503 || e.status === 502 ? e.message : "Something went wrong. Try again.");
    }
  },
};
