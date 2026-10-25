// Members: the list with its filters and the CSV export, and one member's
// page with their tags, notes and what they have done.
import { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { InputArea, Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Table } from "@cloudflare/kumo/components/table";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { crm, day, plural, type Contact, type Filter } from "./api";
import { Failed, FilterFields, useLoad } from "./App";

type Detail = { contact: Contact; activity: { alerts: number; active_alerts: number; saved: number; applications: number };
  notes: { sk: string; text: string }[] };

function query(f: Filter) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") p.set(k, k === "newsletter" ? (v ? "yes" : "no") : String(v));
  return p.toString();
}

function Member({ id, onClose, onTags }: { id: string; onClose: () => void; onTags: (id: string, tags: string[]) => void }) {
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
      onTags(id, r.tags);
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
        <Dialog.Title className="crm-card-title">{c ? c.email : "Member"}</Dialog.Title>
        {error ? <p className="crm-error">{error}</p> : !d || !c ? <p className="crm-note"><Loader /> Loading</p> : (
          <div className="crm-stack">
            <dl className="crm-dl">
              <dt>Joined</dt><dd>{day(c.created)} with {c.provider}{c.verified ? "" : ", email not verified"}</dd>
              <dt>Plan</dt><dd>{c.plan}</dd>
              <dt>Product updates</dt><dd>{c.newsletter ? `Subscribed ${day(c.newsletter_at)}${c.newsletter_source ? ` from ${c.newsletter_source}` : ""}`
                : c.unsubscribed_at ? `Unsubscribed ${day(c.unsubscribed_at)}` : "Not subscribed"}</dd>
              <dt>Waitlist</dt><dd>{c.waitlist.length ? c.waitlist.join(", ") : "None"}</dd>
              <dt>Terms</dt><dd>{c.agreed_version ? `Agreed to ${c.agreed_version} on ${day(c.agreed_at)}` : "Not agreed yet"}</dd>
              <dt>Activity</dt><dd>{[plural(d.activity.applications, "application"), plural(d.activity.alerts, "alert"), plural(d.activity.saved, "saved job")].join(" · ")}</dd>
            </dl>
            <div className="crm-row">
              <div className="crm-grow"><Input label="Tags" description="Comma separated" value={tags} onChange={(e) => setTags(e.target.value)} /></div>
              <Button onClick={saveTags}>Save tags</Button>
            </div>
            <div className="crm-stack">
              <InputArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
              <div><Button onClick={addNote} disabled={!note.trim()}>Add note</Button></div>
              <div className="crm-notes">
                {d.notes.map((n) => (
                  <div key={n.sk}>
                    <span className="crm-sub">{new Date(n.sk.split("#")[0]).toLocaleString()}</span>{n.text}
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

export function Contacts() {
  const [filter, setFilter] = useState<Filter>({});
  const { data, error, load, setData } = useLoad<{ complete: boolean; contacts: Contact[] }>("/contacts");
  const [open, setOpen] = useState<string | null>(null);
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
  if (error) return <Failed error={error} retry={load} />;
  return (
    <div className="crm-stack">
      <LayerCard><div className="crm-card crm-stack">
        <FilterFields filter={filter} set={setFilter} />
        <div className="crm-row between">
          <span className="crm-note">{data ? `${plural(shown.length, "member")} of ${data.contacts.length.toLocaleString()}` : ""}</span>
          <a href={`/api/contacts.csv?${query(filter)}`} download><Button variant="secondary">Export CSV</Button></a>
        </div>
      </div></LayerCard>
      <LayerCard><div className="crm-card">
        {!data ? <p className="crm-note"><Loader /> Loading</p> : (
          <div className="crm-table"><Table>
            <Table.Header><Table.Row><Table.Head>Member</Table.Head><Table.Head>Joined</Table.Head><Table.Head>Plan</Table.Head>
              <Table.Head>Product updates</Table.Head><Table.Head>Waitlist</Table.Head><Table.Head>Tags</Table.Head></Table.Row></Table.Header>
            <Table.Body>
              {shown.slice(0, 500).map((c) => (
                <Table.Row key={c.id} className="crm-click" onClick={() => setOpen(c.id)}>
                  <Table.Cell><button type="button" className="oj-plain" onClick={() => setOpen(c.id)}>{c.email}</button><span className="crm-sub">{c.provider}</span></Table.Cell>
                  <Table.Cell>{day(c.created)}</Table.Cell>
                  <Table.Cell>{c.plan}</Table.Cell>
                  <Table.Cell>{c.newsletter ? "Subscribed" : "No"}</Table.Cell>
                  <Table.Cell>{c.waitlist.join(", ")}</Table.Cell>
                  <Table.Cell>{c.tags.map((t) => <span key={t} className="crm-chip">{t}</span>)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        )}
      </div></LayerCard>
      {open ? <Member id={open} onClose={() => setOpen(null)}
        onTags={(id, tags) => setData((d) => d && { ...d, contacts: d.contacts.map((c) => (c.id === id ? { ...c, tags } : c)) })} /> : null}
    </div>
  );
}
