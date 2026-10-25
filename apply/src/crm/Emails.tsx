// Product update emails: write in Markdown with a live preview, send a test
// to yourself, then send to a segment's subscribers after typing how many
// people it goes to. The Worker sends in small batches; this page loops.
import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Table } from "@cloudflare/kumo/components/table";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { markdown, page } from "../../../crm/lib/mail.mjs";
import { crm, day, plural, type Campaign, type Segment } from "./api";
import { Failed, useLoad } from "./App";

// The email as members get it: the same template the Worker sends (the
// card, the painting, the footer), with Markdown escaped by mail.mjs.
export function MailPreview({ subject, body }: { subject: string; body: string }) {
  return <div className="crm-mail" dangerouslySetInnerHTML={{ __html: page(subject, markdown(body), "#") }} />;
}

function SendDialog({ c, onClose, onDone }: { c: Campaign; onClose: () => void; onDone: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [sample, setSample] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    crm<{ count: number; sample: string[] }>(`/campaigns/${c.sk}/recipients`).then((r) => { setCount(r.count); setSample(r.sample); }, (e) => setError(e.message));
  }, [c.sk]);
  const send = async () => {
    setBusy(true); setError("");
    let cursor = "";
    let total = 0;
    try {
      for (;;) {
        const r = await crm<{ sent: number; cursor: string; done: boolean; capped: boolean }>(`/campaigns/${c.sk}/send`, "POST", { confirm: Number(typed), cursor });
        total += r.sent;
        cursor = r.cursor;
        setProgress(`Sent to ${plural(total, "person", "people")}`);
        if (r.done) break;
        if (r.capped) { setError("Today's sending limit is reached. Send again tomorrow to reach the rest."); break; }
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <Dialog className="crm-dialog">
        <Dialog.Title className="crm-card-title">Send "{c.subject}"</Dialog.Title>
        {count === null && !error ? <p className="crm-note"><Loader /> Counting who gets it</p> : count !== null ? (
          <div className="crm-stack">
            <p>This goes to {plural(count, "person", "people")} subscribed to product updates{sample.length ? `, including ${sample.slice(0, 3).join(", ")}` : ""}.</p>
            <Input label={`Type ${count} to send it`} value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="numeric" />
            {progress ? <p className="crm-note" role="status">{progress}</p> : null}
          </div>
        ) : null}
        {error ? <p className="crm-error" role="alert">{error}</p> : null}
        <div className="crm-row" style={{ marginTop: 16 }}>
          <Button variant="primary" loading={busy} disabled={count === null || count === 0 || Number(typed) !== count} onClick={send}>Send</Button>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function Editor({ c, segments, sending, onSaved, onClose }: { c: Partial<Campaign>; segments: Segment[]; sending: boolean; onSaved: (c: Campaign) => void; onClose: () => void }) {
  const toasts = useKumoToastManager();
  const [subject, setSubject] = useState(c.subject || "");
  const [body, setBody] = useState(c.body || "");
  const [segment, setSegment] = useState(c.segment || "");
  const [busy, setBusy] = useState("");
  const [sendOpen, setSendOpen] = useState<Campaign | null>(null);
  const draft = c.status === undefined || c.status === "draft";
  const save = async () => {
    const r = await crm<{ campaign: Campaign }>("/campaigns", "POST", { id: c.sk, subject, body, segment, changelog: c.changelog });
    onSaved(r.campaign);
    return r.campaign;
  };
  const run = (what: string, fn: () => Promise<void>) => async () => {
    setBusy(what);
    try { await fn(); } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); } finally { setBusy(""); }
  };
  return (
    <LayerCard><div className="crm-card crm-stack">
      <div className="crm-row between"><h2>{draft ? (c.sk ? "Edit email" : "New email") : c.subject}</h2><Button variant="ghost" onClick={onClose}>Back</Button></div>
      <div className="crm-split">
        <div className="crm-stack">
          <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!draft} maxLength={150} />
          {c.to?.length ? <p className="crm-note">Goes to the {plural(c.to.length, "user")} you picked in Users, if they're subscribed to product updates.</p> : (
          <Select label="Send to" value={segment} onValueChange={(v) => setSegment(String(v ?? ""))} disabled={!draft}
            items={{ "": "Everyone subscribed to product updates", ...Object.fromEntries(segments.map((s) => [s.sk, s.name])) }} />)}
          <InputArea label="Message" description="Markdown: # headings, **bold**, [links](https://…) and - lists" className="crm-md"
            value={body} onChange={(e) => setBody(e.target.value)} disabled={!draft} />
        </div>
        <div className="crm-stack">
          <span className="crm-note">Preview</span>
          <MailPreview subject={subject} body={body} />
        </div>
      </div>
      {draft ? (
        <div className="crm-row">
          <Button variant="secondary" loading={busy === "save"} onClick={run("save", async () => { await save(); toasts.add({ variant: "success", title: "Draft saved" }); })}>Save draft</Button>
          <Button variant="secondary" loading={busy === "test"} disabled={!subject || !body} onClick={run("test", async () => {
            const saved = await save();
            const r = await crm<{ sent_to: string }>(`/campaigns/${saved.sk}/test`, "POST");
            toasts.add({ variant: "success", title: `Test sent to ${r.sent_to}` });
          })}>Send a test to me</Button>
          <Button variant="primary" disabled={!sending || !subject || !body} title={sending ? undefined : "Sending to users is off"}
            onClick={run("send", async () => { setSendOpen(await save()); })}>Send…</Button>
        </div>
      ) : <p className="crm-note">Sent to {plural(c.sent || 0, "person", "people")} {c.sent_at ? `on ${day(c.sent_at)}` : ""}.</p>}
      {sendOpen ? <SendDialog c={sendOpen} onClose={() => setSendOpen(null)} onDone={() => { setSendOpen(null); onClose(); }} /> : null}
    </div></LayerCard>
  );
}

export function Emails({ sending, initial, onOpened }: { sending: boolean; initial?: Campaign | null; onOpened?: () => void }) {
  const { data, error, load } = useLoad<{ campaigns: Campaign[] }>("/campaigns");
  const { data: segs } = useLoad<{ segments: Segment[] }>("/segments");
  const [editing, setEditing] = useState<Partial<Campaign> | null>(initial || null);
  useEffect(() => { if (initial) onOpened?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <Failed error={error} retry={load} />;
  if (editing) return <Editor c={editing} segments={segs?.segments || []} sending={sending} onSaved={(c) => setEditing(c)} onClose={() => { setEditing(null); load(); }} />;
  return (
    <LayerCard><div className="crm-card crm-stack">
      <div className="crm-row between">
        <div><h2>Emails</h2><p className="crm-note">Product updates for users who subscribed. {sending ? "" : "Sending to users is off; tests to you work."}</p></div>
        <Button variant="primary" onClick={() => setEditing({})}>New email</Button>
      </div>
      {!data ? <p className="crm-note"><Loader /> Loading</p> : !data.campaigns.length ? <p className="crm-note">No emails yet.</p> : (
        <div className="crm-table"><Table><Table.Body>
          {data.campaigns.map((c) => (
            <Table.Row key={c.sk} className="crm-click" onClick={() => setEditing(c)}>
              <Table.Cell><b>{c.subject || "No subject"}</b><span className="crm-sub">Updated {day(c.updated)}</span></Table.Cell>
              <Table.Cell><Badge variant={c.status === "sent" ? "secondary" : "outline"}>{c.status === "draft" ? "Draft" : c.status === "sending" ? "Sending" : "Sent"}</Badge></Table.Cell>
              <Table.Cell>{c.status === "draft" ? "" : plural(c.sent || 0, "recipient")}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body></Table></div>
      )}
    </div></LayerCard>
  );
}
