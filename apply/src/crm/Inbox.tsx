// Mail sent to info@, one conversation per sender, with replies sent from
// info@ in the same thread. A copy of every message also goes to the
// owner's own inbox (the Worker forwards it before saving).
import { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { crm, plural } from "./api";
import { Failed, useLoad } from "./App";

export type Mail = { sk: string; dir: "in" | "out"; email: string; name: string; subject: string; text: string; read: boolean;
  contact: string; attachments?: number; by?: string };

type Sent = { at: string; to: string; subject: string; body: string; source: string };

const when = (sk: string) => new Date(sk.split("#")[0]).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// Everything the CRM sent: replies, emails to one member, campaigns and flow emails.
function SentMail() {
  const { data, error, load } = useLoad<{ sent: Sent[] }>("/inbox/sent");
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <p className="crm-note"><Loader /> Loading</p>;
  const m = open === null ? null : data.sent[open];
  return (
    <div className="crm-inbox">
      <LayerCard><div className="crm-card crm-threads">
        <h2>Sent</h2>
        {!data.sent.length ? <p className="crm-note">Nothing sent yet.</p> : data.sent.map((x, i) => (
          <button key={i} type="button" className={`crm-thread${i === open ? " on" : ""}`} onClick={() => setOpen(i)}>
            <span className="crm-row between"><b>{x.to}</b><span className="crm-sub">{when(x.at)}</span></span>
            <span className="crm-sub">{x.subject || "No subject"}</span>
            <span className="crm-snippet">{x.source}</span>
          </button>
        ))}
      </div></LayerCard>
      <LayerCard><div className="crm-card crm-stack">
        {!m ? <p className="crm-note">Pick an email.</p> : <>
          <div>
            <h2>{m.subject || "No subject"}</h2>
            <p className="crm-note">To {m.to} · {m.source} · {when(m.at)}</p>
          </div>
          <div className="crm-msg out"><div className="crm-msg-text">{m.body || "(no text)"}</div></div>
        </>}
      </div></LayerCard>
    </div>
  );
}

export function Inbox({ sending, onUnread }: { sending: boolean; onUnread: (n: number) => void }) {
  const [view, setView] = useState("in");
  return (
    <div className="crm-stack">
      <div><Tabs variant="segmented" value={view} onValueChange={setView} tabs={[{ value: "in", label: "Received" }, { value: "sent", label: "Sent" }]} /></div>
      {view === "sent" ? <SentMail /> : <Received sending={sending} onUnread={onUnread} />}
    </div>
  );
}

function Received({ sending, onUnread }: { sending: boolean; onUnread: (n: number) => void }) {
  const toasts = useKumoToastManager();
  const { data, error, load, setData } = useLoad<{ messages: Mail[] }>("/inbox");
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Newest conversation first; each one oldest message first.
  const threads = useMemo(() => {
    const by = new Map<string, Mail[]>();
    for (const m of [...(data?.messages || [])].reverse()) by.set(m.email, [...(by.get(m.email) || []), m]);
    return [...by.entries()].map(([email, list]) => ({ email, list, last: list[list.length - 1], unread: list.filter((m) => m.dir === "in" && !m.read).length }))
      .sort((a, b) => b.last.sk.localeCompare(a.last.sk));
  }, [data]);
  useEffect(() => { onUnread(threads.reduce((n, t) => n + t.unread, 0)); }, [threads, onUnread]);
  const thread = threads.find((t) => t.email === open);
  useEffect(() => {
    if (!thread || !thread.unread) return;
    const sk = thread.list.filter((m) => m.dir === "in" && !m.read).map((m) => m.sk);
    crm("/inbox/read", "POST", { sk }).then(() => setData((d) => d && { messages: d.messages.map((m) => (sk.includes(m.sk) ? { ...m, read: true } : m)) }), () => {});
  }, [thread, setData]);
  const lastIn = thread ? [...thread.list].reverse().find((m) => m.dir === "in") : undefined;
  const send = async () => {
    if (!lastIn) return;
    setBusy(true);
    try {
      await crm("/inbox/reply", "POST", { sk: lastIn.sk, body: text });
      setText("");
      toasts.add({ variant: "success", title: `Reply sent to ${lastIn.email}` });
      load();
    } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); } finally { setBusy(false); }
  };
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <p className="crm-note"><Loader /> Loading</p>;
  return (
    <div className="crm-inbox">
      <LayerCard><div className="crm-card crm-threads">
        <h2>Inbox</h2>
        <p className="crm-note">Email sent to info@oceanofjobs.com. A copy also goes to your Gmail.</p>
        {!threads.length ? <p className="crm-note">No messages yet.</p> : threads.map((t) => (
          <button key={t.email} type="button" className={`crm-thread${t.email === open ? " on" : ""}${t.unread ? " unread" : ""}`} onClick={() => setOpen(t.email)}>
            <span className="crm-row between"><b>{t.last.name || t.email}</b><span className="crm-sub">{when(t.last.sk)}</span></span>
            <span className="crm-sub">{t.last.subject || "No subject"}</span>
            <span className="crm-snippet">{t.last.dir === "out" ? "You: " : ""}{t.last.text.slice(0, 90)}</span>
          </button>
        ))}
      </div></LayerCard>
      <LayerCard><div className="crm-card crm-stack">
        {!thread ? <p className="crm-note">Pick a conversation.</p> : <>
          <div>
            <h2>{thread.list[0].name || thread.email}</h2>
            <p className="crm-note">{thread.email}{thread.list.some((m) => m.contact) ? " · user" : " · not a user"} · {plural(thread.list.length, "message")}</p>
          </div>
          {thread.list.map((m) => (
            <div key={m.sk} className={`crm-msg ${m.dir}`}>
              <span className="crm-sub">{m.dir === "out" ? "You" : m.name || m.email} · {when(m.sk)}{m.subject ? ` · ${m.subject}` : ""}
                {m.attachments ? ` · ${plural(m.attachments, "attachment")}, in Gmail` : ""}</span>
              <div className="crm-msg-text">{m.text || "(no text)"}</div>
            </div>
          ))}
          {lastIn ? <>
            <InputArea label={`Reply to ${lastIn.email}`} description="Markdown. Sent from info@oceanofjobs.com in the same thread." className="crm-md crm-md-short"
              value={text} onChange={(e) => setText(e.target.value)} />
            <div className="crm-row">
              <Button variant="primary" loading={busy} disabled={!sending || !text.trim()} onClick={send}>Send reply</Button>
              {!sending ? <span className="crm-note">Sending is off.</span> : null}
            </div>
          </> : null}
        </>}
      </div></LayerCard>
    </div>
  );
}
