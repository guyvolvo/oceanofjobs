// Members: the list with its filters, the CSV export and a bulk email to
// the ones picked; and one member's page with their billing, license,
// credits, tags, notes, a one-to-one email and what they have done.
import { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { InputArea, Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Table } from "@cloudflare/kumo/components/table";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { crm, day, plural, type Billing, type Campaign, type Contact, type DirectEmail, type Filter } from "./api";
import { Failed, FilterFields, useLoad } from "./App";
import { MailPreview } from "./Emails";
import { ImagePicker } from "./ImagePicker";

type Detail = { contact: Contact; activity: { alerts: number; active_alerts: number; saved: number; applications: number };
  notes: { sk: string; text: string }[]; billing: Billing; emails: DirectEmail[]; billing_url: string };

const PLAN = { free: "Free", basic: "Basic", pro: "Pro" } as Record<string, string>;
const at = (sk: string) => new Date(sk.split("#")[0]).toLocaleString();

function query(f: Filter) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") p.set(k, k === "newsletter" ? (v ? "yes" : "no") : String(v));
  return p.toString();
}

// "#ledger#month#2026-10" is October 2026; "#ledger#day#2026-10-25" is that day.
function period(key: string) {
  const [, , kind, date] = key.split("#");
  const d = new Date(date + (kind === "month" ? "-01" : "") + "T00:00:00");
  return kind === "month" ? d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : day(d.toISOString());
}

function BillingSection({ id, d, setBilling }: { id: string; d: Detail; setBilling: (b: Billing) => void }) {
  const toasts = useKumoToastManager();
  const b = d.billing;
  const [plan, setPlan] = useState(b.license?.plan || "pro");
  const [until, setUntil] = useState(b.license?.until || "");
  const [note, setNote] = useState(b.license?.note || "");
  const [busy, setBusy] = useState("");
  const run = (what: string, path: string, method: string, payload: unknown, done: string) => async () => {
    setBusy(what);
    try {
      const r = await crm<{ billing: Billing }>(path, method, payload);
      setBilling(r.billing);
      toasts.add({ variant: "success", title: done });
    } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); } finally { setBusy(""); }
  };
  return (
    <div className="crm-stack">
      <h3 className="crm-h3">Billing</h3>
      <dl className="crm-dl">
        <dt>Plan in force</dt><dd>{PLAN[b.plan] || b.plan}{b.license && b.plan === b.license.plan ? ", from a license" : ""}</dd>
        <dt>Paid plan</dt><dd>{b.paid ? `${PLAN[b.paid.plan] || b.paid.plan}, ${b.paid.status || "no status"}${b.paid.period_end ? `, period ends ${day(b.paid.period_end)}` : ""}` : "None"}</dd>
        {b.paid?.subscription_id ? <><dt>Subscription</dt><dd><code>{b.paid.subscription_id}</code></dd></> : null}
        {b.paid?.customer_id ? <><dt>Customer</dt><dd><code>{b.paid.customer_id}</code></dd></> : null}
      </dl>
      {b.paid && d.billing_url ? <p className="crm-note">Refunds, cancellations and plan changes are in <a className="crm-link" href={d.billing_url} target="_blank" rel="noopener noreferrer">Paddle</a>. Search for the subscription above.</p> : null}

      <h3 className="crm-h3">License</h3>
      <p className="crm-note">{b.license ? `${PLAN[b.license.plan]} ${b.license.until ? `through ${day(b.license.until + "T12:00:00")}` : "with no end date"}, given ${day(b.license.at)}${b.license.note ? `: ${b.license.note}` : ""}.`
        : "A plan you give by hand, without payment. The user gets the higher of this and their paid plan."}</p>
      <div className="crm-row">
        <Select label="Plan" value={plan} onValueChange={(v) => setPlan(String(v))} items={{ basic: "Basic", pro: "Pro" }} />
        <Input label="Ends on" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        <div className="crm-grow"><Input label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Beta tester" /></div>
      </div>
      <div className="crm-row">
        <Button variant="secondary" loading={busy === "license"} onClick={run("license", `/contacts/${id}/license`, "PUT", { plan, until, note },
          b.license ? "License updated" : "License given")}>{b.license ? "Update license" : "Give license"}</Button>
        {b.license ? <Button variant="ghost" loading={busy === "remove"} onClick={run("remove", `/contacts/${id}/license`, "PUT", { plan: "free" }, "License removed")}>Remove license</Button> : null}
      </div>

      <h3 className="crm-h3">Credits</h3>
      {!b.ledgers.length ? <p className="crm-note">No applications counted yet.</p> : (
        <div className="crm-notes">
          {b.ledgers.map((l) => (
            <div key={l.key} className="crm-row between">
              <span>{period(l.key)}: {plural(l.charged, "credit")} used{l.held > l.charged ? `, ${l.held - l.charged} in progress` : ""}</span>
              {l.charged ? <Button variant="ghost" size="sm" loading={busy === l.key}
                onClick={run(l.key, `/contacts/${id}/credits`, "POST", { key: l.key, charged: l.charged }, "Credits reset")}>Reset</Button> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmailSection({ id, d, sending, onSent }: { id: string; d: Detail; sending: boolean; onSent: () => void }) {
  const toasts = useKumoToastManager();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [image, setImage] = useState("");
  const [busy, setBusy] = useState("");
  const send = (test: boolean) => async () => {
    setBusy(test ? "test" : "send");
    try {
      await crm(`/contacts/${id}/email`, "POST", { subject, body, test, image });
      toasts.add({ variant: "success", title: test ? "Test sent to you" : `Sent to ${d.contact.email}` });
      if (!test) { setSubject(""); setBody(""); onSent(); }
    } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); } finally { setBusy(""); }
  };
  return (
    <div className="crm-stack">
      <h3 className="crm-h3">Email {d.contact.email}</h3>
      <p className="crm-note">For messages about this user's account. It goes even if they haven't subscribed to product updates, so don't use it for promotions.</p>
      <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} />
      <InputArea label="Message" className="crm-md crm-md-short" value={body} onChange={(e) => setBody(e.target.value)} />
      <ImagePicker value={image} onChange={setImage} />
      {body.trim() ? <MailPreview subject={subject} body={body} kind="account" image={image} /> : null}
      <div className="crm-row">
        <Button variant="secondary" loading={busy === "test"} disabled={!subject.trim() || !body.trim()} onClick={send(true)}>Send a test to me</Button>
        <Button variant="primary" loading={busy === "send"} disabled={!sending || !subject.trim() || !body.trim()} onClick={send(false)}>Send</Button>
        {!sending ? <span className="crm-note">Sending to users is off.</span> : null}
      </div>
      {d.emails.length ? (
        <div className="crm-notes">
          {d.emails.map((m) => <div key={m.sk}><span className="crm-sub">{at(m.sk)}</span><b>{m.subject}</b></div>)}
        </div>
      ) : null}
    </div>
  );
}

function Member({ id, sending, onClose, onChange }: { id: string; sending: boolean; onClose: () => void; onChange: (id: string, c: Partial<Contact>) => void }) {
  const toasts = useKumoToastManager();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const load = () => crm<Detail>(`/contacts/${id}`).then((x) => { setD(x); setTags(x.contact.tags.join(", ")); }, (e) => setError(e.message));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveTags = async () => {
    try {
      const r = await crm<{ tags: string[] }>(`/contacts/${id}/tags`, "PUT", { tags: tags.split(",") });
      setTags(r.tags.join(", "));
      onChange(id, { tags: r.tags });
      toasts.add({ variant: "success", title: "Tags saved" });
    } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); }
  };
  const addNote = async () => {
    try {
      await crm(`/contacts/${id}/notes`, "POST", { text: note });
      setNote("");
      load();
    } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); }
  };
  const delNote = async (sk: string) => {
    await crm(`/contacts/${id}/notes/${encodeURIComponent(sk)}`, "DELETE").then(load, (e) => toasts.add({ variant: "error", title: e.message }));
  };
  const c = d?.contact;
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog className="crm-dialog">
        <Dialog.Title className="crm-card-title">{c ? c.email : "User"}</Dialog.Title>
        {error ? <p className="crm-error">{error}</p> : !d || !c ? <p className="crm-note"><Loader /> Loading</p> : (
          <div className="crm-stack">
            <dl className="crm-dl">
              <dt>Joined</dt><dd>{day(c.created)} with {c.provider}{c.verified ? "" : ", email not verified"}</dd>
              <dt>Product updates</dt><dd>{c.newsletter ? `Subscribed ${day(c.newsletter_at)}${c.newsletter_source ? ` from ${c.newsletter_source}` : ""}`
                : c.unsubscribed_at ? `Unsubscribed ${day(c.unsubscribed_at)}` : "Not subscribed"}</dd>
              <dt>Waitlist</dt><dd>{c.waitlist.length ? c.waitlist.join(", ") : "None"}</dd>
              <dt>Terms</dt><dd>{c.agreed_version ? `Agreed to ${c.agreed_version} on ${day(c.agreed_at)}` : "Not agreed yet"}</dd>
              <dt>Activity</dt><dd>{[plural(d.activity.applications, "application"), plural(d.activity.alerts, "alert"), plural(d.activity.saved, "saved job")].join(" · ")}</dd>
            </dl>
            <BillingSection id={id} d={d} setBilling={(billing) => { setD({ ...d, billing }); onChange(id, { plan: billing.plan,
              license: billing.license ? { plan: billing.license.plan, until: billing.license.until } : null }); }} />
            <EmailSection id={id} d={d} sending={sending} onSent={load} />
            <h3 className="crm-h3">Tags and notes</h3>
            <div className="crm-row">
              <div className="crm-grow"><Input label="Tags" placeholder="beta, israel" value={tags} onChange={(e) => setTags(e.target.value)} /></div>
              <Button onClick={saveTags}>Save tags</Button>
            </div>
            <div className="crm-stack">
              <InputArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
              <div><Button onClick={addNote} disabled={!note.trim()}>Add note</Button></div>
              <div className="crm-notes">
                {d.notes.map((n) => (
                  <div key={n.sk}>
                    <span className="crm-sub">{at(n.sk)}</span>{n.text}
                    <div><Button variant="ghost" size="sm" onClick={() => delNote(n.sk)}>Delete</Button></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="crm-row" style={{ marginTop: 16 }}><Button onClick={onClose}>Close</Button></div>
      </Dialog>
    </Dialog.Root>
  );
}

export function Contacts({ sending, onEmail }: { sending: boolean; onEmail: (c: Campaign) => void }) {
  const toasts = useKumoToastManager();
  const [filter, setFilter] = useState<Filter>({});
  const { data, error, load, setData } = useLoad<{ complete: boolean; contacts: Contact[] }>("/contacts");
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const shown = useMemo(() => {
    if (!data) return [];
    const q = (filter.search || "").toLowerCase();
    return data.contacts.filter((c) => (filter.newsletter === undefined || c.newsletter === filter.newsletter)
      && (!filter.waitlist || (filter.waitlist === "any" ? c.waitlist.length > 0 : c.waitlist.includes(filter.waitlist)))
      && (!filter.plan || c.plan === filter.plan) && (!filter.tag || c.tags.includes(filter.tag))
      && (!filter.signed_up_after || (c.created || "") >= filter.signed_up_after)
      && (!q || c.email.includes(q) || c.tags.some((t) => t.includes(q))))
      .sort((a, b) => (b.created || "").localeCompare(a.created || ""));
  }, [data, filter]);
  const toggle = (id: string, on: boolean) => setPicked((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  const allOn = shown.length > 0 && shown.every((c) => picked.has(c.id));
  const subscribed = data ? data.contacts.filter((c) => picked.has(c.id) && c.newsletter).length : 0;
  const emailPicked = async () => {
    try {
      const r = await crm<{ campaign: Campaign }>("/campaigns", "POST", { subject: "", body: "", to: [...picked] });
      onEmail(r.campaign);
    } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); }
  };
  if (error) return <Failed error={error} retry={load} />;
  return (
    <div className="crm-stack">
      <LayerCard><div className="crm-card crm-stack">
        <FilterFields filter={filter} set={setFilter} />
        <div className="crm-row between">
          <span className="crm-note">{data ? `${plural(shown.length, "user")} of ${data.contacts.length.toLocaleString()}` : ""}
            {picked.size ? ` · ${picked.size} picked, ${subscribed} subscribed to product updates` : ""}</span>
          <div className="crm-row">
            {picked.size ? <Button variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button> : null}
            <Button variant="primary" disabled={!subscribed} title={picked.size && !subscribed ? "None of them subscribed to product updates" : undefined}
              onClick={emailPicked}>{picked.size ? `Email ${plural(subscribed, "subscriber")}` : "Email picked users"}</Button>
            <a href={`/api/contacts.csv?${query(filter)}`} download><Button variant="secondary">Export CSV</Button></a>
          </div>
        </div>
      </div></LayerCard>
      <LayerCard><div className="crm-card">
        {!data ? <p className="crm-note"><Loader /> Loading</p> : (
          <div className="crm-table"><Table>
            <Table.Header><Table.Row>
              <Table.Head><Checkbox aria-label="Pick every user shown" checked={allOn}
                onCheckedChange={(on) => setPicked((p) => { const n = new Set(p); for (const c of shown) { if (on === true) n.add(c.id); else n.delete(c.id); } return n; })} /></Table.Head>
              <Table.Head>User</Table.Head><Table.Head>Joined</Table.Head><Table.Head>Plan</Table.Head>
              <Table.Head>Product updates</Table.Head><Table.Head>Waitlist</Table.Head><Table.Head>Tags</Table.Head></Table.Row></Table.Header>
            <Table.Body>
              {shown.slice(0, 500).map((c) => (
                <Table.Row key={c.id} className="crm-click" onClick={() => setOpen(c.id)}>
                  <Table.Cell onClick={(e) => e.stopPropagation()}>
                    <Checkbox aria-label={`Pick ${c.email}`} checked={picked.has(c.id)} onCheckedChange={(on) => toggle(c.id, on === true)} />
                  </Table.Cell>
                  <Table.Cell><button type="button" className="oj-plain" onClick={() => setOpen(c.id)}>{c.email}</button><span className="crm-sub">{c.provider}</span></Table.Cell>
                  <Table.Cell>{day(c.created)}</Table.Cell>
                  <Table.Cell>{PLAN[c.plan] || c.plan}{c.license ? <span className="crm-chip">license</span> : null}</Table.Cell>
                  <Table.Cell>{c.newsletter ? "Subscribed" : "No"}</Table.Cell>
                  <Table.Cell>{c.waitlist.join(", ")}</Table.Cell>
                  <Table.Cell>{c.tags.map((t) => <span key={t} className="crm-chip">{t}</span>)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        )}
      </div></LayerCard>
      {open ? <Member id={open} sending={sending} onClose={() => setOpen(null)}
        onChange={(id, x) => setData((d) => d && { ...d, contacts: d.contacts.map((c) => (c.id === id ? { ...c, ...x } : c)) })} /> : null}
    </div>
  );
}
