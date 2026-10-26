// The changelog: write an entry, publish it to oceanofjobs.com/docs/changelog
// (a GitHub workflow commits it and deploys the docs), and turn it into a
// product update email draft.
import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Table } from "@cloudflare/kumo/components/table";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { markdown } from "../../../crm/lib/mail.mjs";
import { crm, day, type Entry } from "./api";
import { Failed, useLoad } from "./App";

export function Changelog({ onEmail }: { onEmail: () => void }) {
  const toasts = useKumoToastManager();
  const { data, error, load } = useLoad<{ entries: Entry[] }>("/changelog");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState("");
  const publish = async () => {
    setBusy("publish");
    try {
      await crm("/changelog", "POST", { date, title, body });
      setTitle(""); setBody("");
      toasts.add({ variant: "success", title: "Publishing", description: "It's on the website in a few minutes, once the docs deploy." });
      load();
    } catch (e) {
      toasts.add({ variant: "error", title: (e as Error).message });
    } finally { setBusy(""); }
  };
  const toEmail = async (e: Entry) => {
    setBusy(e.sk);
    try {
      await crm(`/changelog/${e.sk}/email`, "POST");
      toasts.add({ variant: "success", title: "Email draft made from this entry" });
      onEmail();
    } catch (err) {
      toasts.add({ variant: "error", title: (err as Error).message });
    } finally { setBusy(""); }
  };
  if (error) return <Failed error={error} retry={load} />;
  return (
    <div className="crm-stack">
      <LayerCard><div className="crm-card crm-stack">
        <div><h2>New entry</h2><p className="crm-note">Publishes to the changelog in the docs, newest first.</p></div>
        <div className="crm-split">
          <div className="crm-stack">
            <div className="crm-row">
              <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <div className="crm-grow"><Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Cloud storage for your resume" /></div>
            </div>
            <InputArea label="What changed" description="Markdown" className="crm-md" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="crm-stack">
            <span className="crm-note">Preview</span>
            <div className="crm-preview"><h2 style={{ margin: "0 0 4px" }}>{title || "Title"}</h2><p style={{ margin: "0 0 12px", color: "#6b7266" }}>{date}</p>
              <div dangerouslySetInnerHTML={{ __html: markdown(body) }} /></div>
          </div>
        </div>
        <div><Button variant="primary" loading={busy === "publish"} disabled={!title.trim() || !body.trim() || !date} onClick={publish}>Publish</Button></div>
      </div></LayerCard>
      <LayerCard><div className="crm-card">
        <h2>Published</h2>
        {!data ? <p className="crm-note"><Loader /> Loading</p> : !data.entries.length ? <p className="crm-note">Nothing published yet.</p> : (
          <div className="crm-table"><Table className="crm-list"><Table.Body>
            {data.entries.map((e) => (
              <Table.Row key={e.sk}>
                <Table.Cell><b>{e.title}</b><span className="crm-sub">{e.date} · published {day(e.published_at)}</span></Table.Cell>
                <Table.Cell><Button variant="secondary" loading={busy === e.sk} onClick={() => toEmail(e)}>Turn into email</Button></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body></Table></div>
        )}
      </div></LayerCard>
    </div>
  );
}
