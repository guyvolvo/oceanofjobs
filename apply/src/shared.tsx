import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { GearSix, WarningCircle } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { apply, send, type HistoryRow, type Origin, type Outcome, type QueueItem, type Source, type Status } from "./api";
import { ask, connectExtension, type Ext } from "./ext";
import { LoadingButton, SelectField, useReturnFocus } from "./fields";

// The one warning colour on these pages: DESIGN.md has no amber, so a
// warning is the trend-down red-orange, softer than an error's red.
export const WARN = "text-[var(--ooj-trend-down)]";

// A setting that needs a resume first. The warning takes the user to the
// resume field on the AI agent page, which stays highlighted until they
// touch it (apply/Agent.tsx ResumeField listens for RESUME_FOCUS).
export const RESUME_FOCUS = "ooj-resume-focus";
// Opens the setup guide (Onboarding.tsx) again.
export const SETUP = "ooj-setup";
export function NeedsResume() {
  const go = () => {
    if (location.pathname === "/apply/agent") return dispatchEvent(new Event(RESUME_FOCUS));
    try { sessionStorage.setItem(RESUME_FOCUS, "1"); } catch { /* the page still opens */ }
    location.href = "/apply/agent";
  };
  return (
    <button type="button" onClick={go}
      className="inline-flex cursor-pointer items-center gap-2 self-start rounded-md border border-[var(--ooj-trend-down)] bg-transparent px-3 py-2 text-sm leading-snug text-foreground hover:bg-accent">
      <WarningCircle weight="bold" aria-hidden="true" className={cn("size-[18px] shrink-0", WARN)} />
      To use this setting, add your resume.
    </button>
  );
}

// Each state looks different from the rest. Filled in particular is never
// green: the form was filled, nobody pressed submit.
const LOOK = {
  success: "border-transparent bg-[var(--ooj-green-tint)] text-[var(--ooj-green-text)]",
  warning: "border-[var(--ooj-trend-down)] bg-transparent text-[var(--ooj-trend-down)]",
  info: "border-transparent bg-primary text-primary-foreground",
  error: "border-transparent bg-destructive text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  outline: "border-border bg-transparent text-muted-foreground",
};
export const STATUS: Record<Status, { label: string; look: keyof typeof LOOK }> = {
  submitted: { label: "Submitted", look: "success" },
  unconfirmed: { label: "Submission unconfirmed", look: "warning" },
  sent: { label: "Sent by you, not confirmed", look: "warning" },
  filled: { label: "Filled", look: "info" },
  in_progress: { label: "In progress", look: "secondary" },
  needs_input: { label: "Needs your input", look: "warning" },
  failed: { label: "Failed", look: "error" },
  skipped: { label: "Skipped", look: "outline" },
  abandoned: { label: "Abandoned", look: "outline" },
  not_sent_disputed: { label: "Not sent (refunded)", look: "secondary" },
};

export function StatusBadge({ status }: { status: Status }) {
  const s = STATUS[status] || { label: status, look: "outline" as const };
  return <Badge variant="outline" className={LOOK[s.look]}>{s.label}</Badge>;
}

// A meter, on shadcn's Progress: a label and a value over the bar.
export function Meter({ label, value, max, customValue }: { label: string; value: number; max: number; customValue?: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{customValue ?? `${Math.round(pct)}%`}</span>
      </div>
      <Progress value={pct} aria-label={label} aria-valuetext={customValue} />
    </div>
  );
}

// Where a job came from: a short name for the Overview's breakdown, and the
// words after "From" on a row. A job from before sources were kept has none
// and shows none.
export const SOURCE: Record<Source, { name: string; from: string }> = {
  board: { name: "Job board", from: "the board" },
  alert: { name: "Alerts", from: "an alert" },
  mcp: { name: "AI assistant (MCP)", from: "your AI assistant (MCP)" },
  extension: { name: "Extension", from: "the extension" },
  matches: { name: "Your matches", from: "your matches" },
  other: { name: "Other", from: "elsewhere" },
};

// The first source, and on hover or focus every other place that tried to add the job.
export function SourceLabel({ row }: { row: Origin }) {
  if (!row.source || !SOURCE[row.source]) return null;
  const label = `From ${SOURCE[row.source].from}`;
  const others = (row.sources || []).slice(1).filter((x) => SOURCE[x.source]);
  const look = "mt-0.5 block text-xs text-muted-foreground";
  if (!others.length) return <span className={look}>{label}</span>;
  const also = "Also added from " + others.map((x) => SOURCE[x.source].from + (x.at ? ` on ${fmtDate(x.at)}` : "")).join(", ") + ".";
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className={cn(look, "cursor-default underline decoration-dotted underline-offset-3")} aria-label={`${label}. ${also}`}>
          {label} +{others.length}
        </TooltipTrigger>
        <TooltipContent>{also}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Only an application that went out can have an outcome.
export const SENT: Status[] = ["submitted", "unconfirmed", "sent"];

export const OUTCOME: Record<Outcome | "none", string> = {
  none: "Not marked", interview: "Interview", offer: "Offer", rejected: "Rejected", no_reply: "No reply",
};

// What the user says happened after applying. Only they set it; it never
// changes the status or a credit.
export function OutcomeSelect({ row, onChange }: { row: HistoryRow; onChange: () => void }) {
  const [value, setValue] = useState<string>(row.outcome || "none");
  useEffect(() => setValue(row.outcome || "none"), [row.outcome]);
  const pick = async (v: string) => {
    const before = value;
    setValue(v);
    try {
      await apply(`history/${encodeURIComponent(row.job_id)}`, send("PATCH", { outcome: v }));
      onChange();
    } catch {
      setValue(before);
      toast.error("Couldn't save that", { description: "Try again." });
    }
  };
  return <SelectField aria-label={`Outcome for ${row.title || "this application"}`} value={value} onValueChange={pick} items={OUTCOME} className="min-w-36" />;
}

export const STORE_URL = "https://chromewebstore.google.com/detail/kihjppefdadlodaoecffiemijlielhdi";

export const ATS: Record<string, string> = { greenhouse: "Greenhouse", ashby: "Ashby", workable: "Workable", workday: "Workday",
  smartrecruiters: "SmartRecruiters", bamboohr: "BambooHR", jazzhr: "JazzHR", recruitee: "Recruitee", lever: "Lever", teamtailor: "Teamtailor",
  pinpoint: "Pinpoint", breezy: "Breezy", personio: "Personio", comeet: "Comeet" };

// A site path (/job/<id>) opens here; anything else is the employer's
// own page and opens in a new tab.
export function JobLink({ title, link }: { title: string; link: string }) {
  const name = title || "A job";
  const look = "font-medium text-foreground no-underline [overflow-wrap:anywhere] hover:underline";
  if (!link) return <span className={look}>{name}</span>;
  const external = !link.startsWith("/");
  return <a className={look} href={link} {...(external ? { target: "_blank", rel: "noopener" } : {})}>{name}</a>;
}

export function JobCell({ title, link, sub }: { title: string; link: string; sub?: ReactNode }) {
  return <><JobLink title={title} link={link} />{sub ? <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">{sub}</span> : null}</>;
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
  if (!ext.installed) return <Button variant="outline" asChild><a href="/docs/extension">How to install the extension</a></Button>;
  const open = () => ask<{ ok?: boolean }>({ type: "openOptions" })
    .then((r) => { if (!r.ok) throw new Error("not opened"); })
    .catch(() => toast.error("Couldn't open the extension's settings",
      { description: "Update the extension, or right-click its icon and select Options." }));
  return <Button type="button" variant="outline" onClick={open}><GearSix />Open extension settings</Button>;
}

// The one control that reaches the extension: install it, connect it, or
// open the next queued job.
export function ExtensionAction({ ext, queue, onOpened }: { ext: Ext; queue: QueueItem[] | undefined; onOpened: () => void }) {
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
  if (ext.checking && !ext.installed) return <span className="flex items-center gap-2 text-muted-foreground"><Spinner /> Looking for the extension</span>;
  if (!ext.installed) {
    return <p className="m-0 text-muted-foreground">Install the Ocean of Jobs extension to apply from here: <a className="text-foreground underline underline-offset-[3px] hover:text-link-hover" href={STORE_URL} target="_blank" rel="noopener">Chrome Web Store</a>.</p>;
  }
  if (!ext.connected) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <LoadingButton loading={busy} onClick={connect}>Connect the extension</LoadingButton>
        <span className="text-muted-foreground" role="status">{connectError ? "Couldn't connect the extension. Try again." : "The extension is installed."}</span>
      </div>
    );
  }
  const connectedNote = <span className="text-muted-foreground" role="status">The extension is connected to your account.</span>;
  if (!ext.bridge) return connectedNote;
  const next = async () => {
    const failed = (description: string) => toast.error("Couldn't open the next job", { description });
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
    toast.success("Opened in a new tab", { description: `${job ? job.title + ". " : ""}Check the form, then submit it.` });
    onOpened();
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <LoadingButton loading={busy} disabled={!queue?.length} onClick={next}>Apply to next</LoadingButton>
      {queue?.length ? null : <span className="text-muted-foreground">Your queue is empty.</span>}
    </div>
  );
}

// A setting that lets things happen without the user checking them first:
// choosing it asks once, with a red confirm button, and nothing changes on
// Cancel. The choice still takes effect only when the form is saved.
export function ConfirmDanger({ open, title, children, confirm, onConfirm, onCancel }: {
  open: boolean; title: string; children?: ReactNode; confirm: string; onConfirm: () => void; onCancel: () => void;
}) {
  const back = useReturnFocus(open);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-h-[calc(100dvh-32px)] overflow-y-auto" onCloseAutoFocus={back}>
        <DialogTitle className="leading-snug">{title}</DialogTitle>
        {children ? <DialogDescription>{children}</DialogDescription> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>{confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
