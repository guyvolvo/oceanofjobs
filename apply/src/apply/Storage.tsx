// The resume the extension attaches, as the Auto apply settings show it:
// the file on cloud storage (api/user_files.py), or a note that it is in
// local storage, in the extension. The Workday password and AI key are
// shown as saved or not, never what they are; only the extension reads
// them. A server without cloud storage keeps the old card.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CheckField, LoadingButton } from "../fields";
import { DownloadSimple, FileArrowUp } from "@/components/icons";
import { ApiError, api, send } from "../api";
import { ExtensionSettingsButton } from "../shared";
import type { Ext } from "../ext";
import { BOX } from "./Agent";
import { Card, LINK, Waiting } from "./Page";

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
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

async function asBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function ResumeStorage({ ext }: { ext: Ext }) {
  const [view, setView] = useState<View | null | undefined>(undefined); // null: no cloud storage on this server
  const [busy, setBusy] = useState(false);
  const [agree, setAgree] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<View>("/me/storage").then(setView, () => setView(null));
  }, []);
  useEffect(load, [load]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!TYPES[ext]) return void toast.error("Choose a PDF or DOCX file.");
    if (file.size > MAX) return void toast.error("This file is larger than 5 MB.");
    setBusy(true);
    try {
      const next = await api<View>("/me/cv", send("PUT", { name: file.name, type: TYPES[ext], data: await asBase64(file), consent: true }));
      setView(next);
      toast.success("Resume saved to cloud storage", { description: "The extension picks it up on its next check." });
    } catch (e) {
      toast.error("Couldn't save your resume", { description: e instanceof ApiError && e.status === 400 ? e.message : "Try again." });
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
      toast.error("Couldn't download your resume. Try again.");
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      setView(await api<View>("/me/cv", send("DELETE")));
      toast.success("Resume removed");
    } catch {
      toast.error("Couldn't remove your resume. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const picker = <input ref={input} type="file" accept=".pdf,.docx" hidden onChange={(e) => upload(e.target.files?.[0])} />;
  const row = "flex flex-wrap items-center gap-x-3 gap-y-2";

  if (view === undefined) return <Card title="Your resume"><Waiting /></Card>;
  if (view === null || (!view.ready && view.mode !== "account")) {
    return (
      <Card title="Extension settings" note="Your resume, your own AI key and where the fill button shows are set in the extension, and stay in your browser.">
        <div className={row}><ExtensionSettingsButton ext={ext} /></div>
      </Card>
    );
  }
  if (view.mode === "local") {
    return (
      <Card title="Your resume" note="Your resume, Workday password and AI key are in local storage, in the extension on the computer where you added them.">
        <div className={BOX}>
          <CheckField checked={agree} onCheckedChange={setAgree}
            label={<span>I agree to the <a className={LINK} href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>. My resume is saved to cloud storage and attached to my applications.</span>} />
          <div className={row}>
            <LoadingButton variant="outline" loading={busy} disabled={!agree} onClick={() => input.current?.click()}><FileArrowUp />Upload to cloud storage</LoadingButton>
            <span className="text-muted-foreground">PDF or DOCX, up to 5 MB</span>
          </div>
          {picker}
        </div>
        <div className={row}><ExtensionSettingsButton ext={ext} /></div>
      </Card>
    );
  }
  const saved = [view.workday ? "Workday password" : "", view.ai ? "your own AI key" : ""].filter(Boolean);
  return (
    <>
      <Card title="Your resume" note="Saved to cloud storage.">
        {view.cv ? (
          <div className={`${BOX} sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center`}>
            <div className="min-w-0">
              <span className="font-medium text-foreground [overflow-wrap:anywhere]">{view.cv.name}</span>
              <span className="block text-sm text-muted-foreground">{kb(view.cv.size)} · added {day(view.cv.uploaded_at)}</span>
            </div>
            <div className={row}>
              <LoadingButton variant="outline" loading={busy} onClick={() => input.current?.click()}><FileArrowUp />Replace</LoadingButton>
              <Button type="button" variant="outline" onClick={download}><DownloadSimple />Download</Button>
              <Button type="button" variant="outline" className="text-destructive" disabled={busy} onClick={remove}>Remove</Button>
            </div>
          </div>
        ) : (
          <div className={row}>
            <LoadingButton variant="outline" loading={busy} onClick={() => input.current?.click()}><FileArrowUp />Upload resume</LoadingButton>
            <span className="text-muted-foreground">PDF or DOCX, up to 5 MB</span>
          </div>
        )}
        {picker}
      </Card>
      <Card title="Workday password and AI key"
        note={saved.length ? `Your ${saved.join(" and ")} ${saved.length > 1 ? "are" : "is"} saved to cloud storage, encrypted, and never shown here. To change them, open the extension's settings.`
          : "None saved yet. Add them in the extension's settings."}>
        <div className={row}><ExtensionSettingsButton ext={ext} /></div>
      </Card>
    </>
  );
}
