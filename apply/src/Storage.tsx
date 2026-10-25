// The resume the extension attaches, as the Auto apply settings show it:
// the file on cloud storage (api/user_files.py), or a note that it is in
// local storage, in the extension. The Workday password and AI key are
// shown as saved or not, never what they are; only the extension reads
// them. A server without cloud storage keeps the old card.
import { useCallback, useEffect, useRef, useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { DownloadSimple, FileArrowUp } from "@phosphor-icons/react";
import { ApiError, api, send } from "./api";
import { ExtensionSettingsButton } from "./shared";
import type { Ext } from "./ext";

type View = {
  mode: "account" | "local";
  ready: boolean;
  cv: { name: string; type: string; size: number; uploaded_at: string } | null;
  workday: boolean;
  ai: { provider: string; model: string } | null;
};
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MAX = 5 * 1024 * 1024;
const CLOUD_STORAGE = false;
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

async function asBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <LayerCard>
      <div className="oj-card-body">
        <h2 className="oj-card-title">{title}</h2>
        {note ? <p className="oj-note">{note}</p> : null}
        {children}
      </div>
    </LayerCard>
  );
}

export function ResumeStorage({ ext }: { ext: Ext }) {
  const toasts = useKumoToastManager();
  const [view, setView] = useState<View | null | undefined>(undefined); // null: no cloud storage on this server
  const [busy, setBusy] = useState(false);
  const [agree, setAgree] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    // shortcut: the extension in the store can't read cloud storage yet, so the page shows the
    // in-browser card; delete this line once 1.9.12 is published.
    if (!CLOUD_STORAGE) return setView(null);
    api<View>("/me/storage").then(setView, () => setView(null));
  }, []);
  useEffect(load, [load]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!TYPES[ext]) return toasts.add({ variant: "error", title: "Choose a PDF or DOCX file." });
    if (file.size > MAX) return toasts.add({ variant: "error", title: "This file is larger than 5 MB." });
    setBusy(true);
    try {
      const next = await api<View>("/me/cv", send("PUT", { name: file.name, type: TYPES[ext], data: await asBase64(file), consent: true }));
      setView(next);
      toasts.add({ variant: "success", title: "Resume saved to cloud storage", description: "The extension picks it up on its next check." });
    } catch (e) {
      toasts.add({ variant: "error", title: "Couldn't save your resume", description: e instanceof ApiError && e.status === 400 ? e.message : "Try again." });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const download = async () => {
    try {
      const f = await api<{ name: string; type: string; data: string }>("/me/cv");
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: f.type }));
      const a = Object.assign(document.createElement("a"), { href: url, download: f.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      toasts.add({ variant: "error", title: "Couldn't download your resume. Try again." });
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      setView(await api<View>("/me/cv", send("DELETE")));
      toasts.add({ variant: "success", title: "Resume removed" });
    } catch {
      toasts.add({ variant: "error", title: "Couldn't remove your resume. Try again." });
    } finally {
      setBusy(false);
    }
  };
  const picker = <input ref={input} type="file" accept=".pdf,.docx" hidden onChange={(e) => upload(e.target.files?.[0])} />;

  if (view === undefined) return <Card title="Your resume"><div className="oj-row oj-note"><Loader /> Loading</div></Card>;
  if (view === null || (!view.ready && view.mode !== "account")) {
    return (
      <Card title="Extension settings" note="Your resume, your own AI key and where the fill button shows are set in the extension, and stay in your browser.">
        <div className="oj-row"><ExtensionSettingsButton ext={ext} /></div>
      </Card>
    );
  }
  if (view.mode === "local") {
    return (
      <Card title="Your resume" note="Your resume, Workday password and AI key are in local storage, in the extension on the computer where you added them.">
        <div className="oj-answer">
          <Checkbox checked={agree} onCheckedChange={(c) => setAgree(c === true)}
            label={<span>I agree to the <a className="oj-link" href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>. My resume is saved to cloud storage and attached to my applications.</span>} />
          <div className="oj-row">
            <Button variant="secondary" icon={<FileArrowUp />} loading={busy} disabled={!agree} onClick={() => input.current?.click()}>Upload to cloud storage</Button>
            <span className="oj-note">PDF or DOCX, up to 5 MB</span>
          </div>
          {picker}
        </div>
        <div className="oj-row"><ExtensionSettingsButton ext={ext} /></div>
      </Card>
    );
  }
  const saved = [view.workday ? "Workday password" : "", view.ai ? "your own AI key" : ""].filter(Boolean);
  return (
    <>
      <Card title="Your resume" note="Saved to cloud storage. The extension attaches it to your applications.">
        {view.cv ? (
          <div className="oj-answer oj-row oj-row-between">
            <div>
              <span className="oj-job">{view.cv.name}</span>
              <span className="oj-sub">{kb(view.cv.size)} · added {day(view.cv.uploaded_at)}</span>
            </div>
            <div className="oj-row">
              <Button variant="secondary" icon={<FileArrowUp />} loading={busy} onClick={() => input.current?.click()}>Replace</Button>
              <Button variant="secondary" icon={<DownloadSimple />} onClick={download}>Download</Button>
              <Button variant="secondary" className="oj-danger-ghost" disabled={busy} onClick={remove}>Remove</Button>
            </div>
          </div>
        ) : (
          <div className="oj-row">
            <Button variant="secondary" icon={<FileArrowUp />} loading={busy} onClick={() => input.current?.click()}>Upload resume</Button>
            <span className="oj-note">PDF or DOCX, up to 5 MB</span>
          </div>
        )}
        {picker}
      </Card>
      <Card title="Workday password and AI key"
        note={saved.length ? `Your ${saved.join(" and ")} ${saved.length > 1 ? "are" : "is"} saved to cloud storage, encrypted, and never shown here. To change them, open the extension's settings.`
          : "None saved yet. Add them in the extension's settings."}>
        <div className="oj-row"><ExtensionSettingsButton ext={ext} /></div>
      </Card>
    </>
  );
}
