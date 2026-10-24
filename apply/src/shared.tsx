import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { GearSix, WarningCircle } from "@phosphor-icons/react";
import type { QueueItem, Status } from "./api";
import { ask, connectExtension, type Ext } from "./ext";

// A setting that needs a resume first. The warning takes the user to the
// resume field on the AI agent tab, which stays highlighted until they
// touch it (Agent.tsx ResumeField listens for RESUME_FOCUS).
export const RESUME_FOCUS = "ooj-resume-focus";
export function NeedsResume() {
  const go = () => {
    if (location.hash === "#agent") return dispatchEvent(new Event(RESUME_FOCUS));
    try { sessionStorage.setItem(RESUME_FOCUS, "1"); } catch { /* the tab still opens */ }
    location.hash = "agent";
  };
  return (
    <button type="button" className="oj-needs-resume" onClick={go}>
      <WarningCircle weight="bold" aria-hidden="true" />
      To use this setting, add your resume.
    </button>
  );
}

// Each state looks different from the rest. Filled in particular is never
// green: the form was filled, nobody pressed submit.
export const STATUS: Record<Status, { label: string; variant: "success" | "warning" | "info" | "neutral" | "orange" | "error" | "secondary" | "outline" | "teal-subtle" }> = {
  submitted: { label: "Submitted", variant: "success" },
  unconfirmed: { label: "Submission unconfirmed", variant: "warning" },
  filled: { label: "Filled", variant: "info" },
  in_progress: { label: "In progress", variant: "secondary" },
  needs_input: { label: "Needs your input", variant: "warning" },
  failed: { label: "Failed", variant: "error" },
  skipped: { label: "Skipped", variant: "outline" },
  abandoned: { label: "Abandoned", variant: "outline" },
  not_sent_disputed: { label: "Not sent (refunded)", variant: "secondary" },
};

export function StatusBadge({ status }: { status: Status }) {
  const s = STATUS[status] || { label: status, variant: "outline" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export const ATS: Record<string, string> = { greenhouse: "Greenhouse", ashby: "Ashby", workable: "Workable", workday: "Workday",
  smartrecruiters: "SmartRecruiters", bamboohr: "BambooHR", jazzhr: "JazzHR", recruitee: "Recruitee", lever: "Lever", teamtailor: "Teamtailor",
  pinpoint: "Pinpoint", breezy: "Breezy", personio: "Personio", comeet: "Comeet" };

// A site path (/job/<id>) opens here; anything else is the employer's
// own page and opens in a new tab.
export function JobLink({ title, link }: { title: string; link: string }) {
  const name = title || "A job";
  if (!link) return <span className="oj-job">{name}</span>;
  const external = !link.startsWith("/");
  return <a className="oj-job" href={link} {...(external ? { target: "_blank", rel: "noopener" } : {})}>{name}</a>;
}

export function JobCell({ title, link, sub }: { title: string; link: string; sub?: ReactNode }) {
  return <><JobLink title={title} link={link} />{sub ? <span className="oj-sub">{sub}</span> : null}</>;
}

export function fmtDate(iso: string) {
  const d = new Date(iso);
  if (isNaN(+d)) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// The extension's own settings page (CV, own AI key, fill button), which
// only the extension can open: 1.9.8 on answers openOptions.
export function ExtensionSettingsButton({ ext }: { ext: Ext }) {
  const toasts = useKumoToastManager();
  if (!ext.installed) return <LinkButton variant="secondary" href="/docs/extension">How to install the extension</LinkButton>;
  const open = () => ask<{ ok?: boolean }>({ type: "openOptions" })
    .then((r) => { if (!r.ok) throw new Error("not opened"); })
    .catch(() => toasts.add({ variant: "error", title: "Couldn't open the extension's settings",
      description: "Update the extension, or right-click its icon and select Options." }));
  return <Button variant="secondary" icon={<GearSix />} onClick={open}>Open extension settings</Button>;
}

// The one control that reaches the extension: install it, connect it, or
// open the next queued job.
export function ExtensionAction({ ext, queue, onOpened }: { ext: Ext; queue: QueueItem[] | undefined; onOpened: () => void }) {
  const toasts = useKumoToastManager();
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState(false);
  const connect = async () => {
    setBusy(true);
    setConnectError(false);
    try { await connectExtension(); } catch { setConnectError(true); } finally { setBusy(false); }
  };
  // The extension's "Log in instead" opens /apply?connect=1: once the reader
  // has logged in on this device, connect it without another click. The URL
  // is read here, not at render, so the flag is spent once.
  useEffect(() => {
    if (ext.checking || !ext.installed || ext.connected || !new URLSearchParams(location.search).has("connect")) return;
    history.replaceState(null, "", location.pathname + location.hash);
    connect();
  }, [ext.checking, ext.installed, ext.connected]);
  if (ext.checking && !ext.installed) return <span className="oj-row oj-note"><Loader size="sm" /> Looking for the extension</span>;
  if (!ext.installed) {
    return <p className="oj-note">Install the Ocean of Jobs extension to apply from here. It isn't in the Chrome Web Store yet.</p>;
  }
  if (!ext.connected) {
    return (
      <div className="oj-row">
        <Button variant="primary" loading={busy} onClick={connect}>Connect the extension</Button>
        <span className="oj-note" role="status">{connectError ? "Couldn't connect the extension. Try again." : "The extension is installed."}</span>
      </div>
    );
  }
  const connectedNote = <span className="oj-note" role="status">The extension is connected to your account.</span>;
  if (!ext.bridge) return connectedNote;
  const next = async () => {
    const failed = (description: string) => toasts.add({ variant: "error", title: "Couldn't open the next job", description });
    let res: { ok?: boolean; job_id?: string; error?: string };
    setBusy(true);
    try {
      res = await ask({ type: "applyNext" }, 15000);
    } catch {
      return failed("The extension didn't answer. Try again.");
    } finally {
      setBusy(false);
    }
    if (!res.ok) return failed(res.error || "Try again.");
    const job = queue?.find((q) => q.job_id === res.job_id);
    toasts.add({ variant: "success", title: "Opened in a new tab", description: `${job ? job.title + ". " : ""}Check the form, then submit it.` });
    onOpened();
  };
  return (
    <div className="oj-row">
      <Button variant="primary" loading={busy} disabled={!queue?.length} onClick={next}>Apply to next</Button>
      {queue?.length ? null : <span className="oj-note">Your queue is empty.</span>}
    </div>
  );
}


// A setting that lets things happen without the user checking them first:
// choosing it asks once, with a red confirm button, and nothing changes on
// Cancel. The choice still takes effect only when the form is saved.
export function ConfirmDanger({ open, title, children, confirm, onConfirm, onCancel }: {
  open: boolean; title: string; children?: ReactNode; confirm: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <Dialog className="oj-dialog">
        <Dialog.Title className="oj-card-title">{title}</Dialog.Title>
        {children ? <Dialog.Description className="oj-note">{children}</Dialog.Description> : null}
        <div className="oj-row oj-dialog-actions">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" className="oj-destructive" onClick={onConfirm}>{confirm}</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
