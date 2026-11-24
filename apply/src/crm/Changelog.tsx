// The changelog: write an entry, publish it to oceanofjobs.com/docs/changelog
// (a GitHub workflow commits it and deploys the docs), and turn it into a
// product update email draft.
import { useState } from "react";
import { markdown } from "../../../crm/lib/mail.mjs";
import { crm, day, type Entry } from "./api";
import { Failed, useLoad } from "./App";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { AreaField, Btn, Loading, Panel, TextField } from "./ui";

export function Changelog({ onEmail }: { onEmail: () => void }) {
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
      toast.success("Publishing", { description: "It's on the website in a few minutes, once the docs deploy." });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(""); }
  };
  const toEmail = async (e: Entry) => {
    setBusy(e.sk);
    try {
      await crm(`/changelog/${e.sk}/email`, "POST");
      toast.success("Email draft made from this entry");
      onEmail();
    } catch (err) {
      toast.error((err as Error).message);
    } finally { setBusy(""); }
  };
  if (error) return <Failed error={error} retry={load} />;
  return (
    <div className="crm-stack">
      <Panel><div className="crm-card crm-stack">
        <div><h2>New entry</h2><p className="crm-note">Publishes to the changelog in the docs, newest first.</p></div>
        <div className="crm-split">
          <div className="crm-stack">
            <div className="crm-row">
              <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <div className="crm-grow"><TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Cloud storage for your resume" /></div>
            </div>
            <AreaField label="What changed" description="Markdown" className="crm-md" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="crm-stack">
            <span className="crm-note">Preview</span>
            <div className="crm-preview"><h2 style={{ margin: "0 0 4px" }}>{title || "Title"}</h2><p style={{ margin: "0 0 12px", color: "#6b7266" }}>{date}</p>
              <div dangerouslySetInnerHTML={{ __html: markdown(body) }} /></div>
          </div>
        </div>
        <div><Btn loading={busy === "publish"} disabled={!title.trim() || !body.trim() || !date} onClick={publish}>Publish</Btn></div>
      </div></Panel>
      <Panel><div className="crm-card">
        <h2>Published</h2>
        {!data ? <Loading /> : !data.entries.length ? <p className="crm-note">Nothing published yet.</p> : (
          <div className="crm-table"><Table className="crm-list"><TableBody>
            {data.entries.map((e) => (
              <TableRow key={e.sk}>
                <TableCell><b>{e.title}</b><span className="crm-sub">{e.date} · published {day(e.published_at)}</span></TableCell>
                <TableCell><Btn variant="outline" loading={busy === e.sk} onClick={() => toEmail(e)}>Turn into email</Btn></TableCell>
              </TableRow>
            ))}
          </TableBody></Table></div>
        )}
      </div></Panel>
    </div>
  );
}
