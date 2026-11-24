// One auto apply page: the workspace around it with the plan line and the
// sidebar counts, the sign-in when signed out, and the two banners every
// page shows (a request failed; no applications left). Plus the few
// pieces the pages share: a card, a stat tile, a loading row, a banner,
// an empty state.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { WarningCircle } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { WARN } from "../shared";
import type { WorkKey } from "../site/nav";
import { SignInPage } from "../site/SignIn";
import { Workspace } from "../site/Workspace";
import { badges, period, statusLine, type ApplyData } from "./data";

export function ApplyPage({ current, title, note, actions, data, children }: {
  current: WorkKey; title: ReactNode; note?: ReactNode; actions?: ReactNode; data: ApplyData; children: ReactNode;
}) {
  const s = data.summary;
  if (data.signedOut) return <Workspace current={current}><SignInPage /></Workspace>;
  return (
    <Workspace current={current} title={title} note={note} actions={actions} status={statusLine(s)} badges={badges(s)}>
      <Failed.Provider value={data.failed}>
      <div className="flex flex-col gap-5">
        {data.failed ? (
          <Banner tone="error" title="Couldn't load everything" description="Some of what's shown here may be out of date."
            action={<Button variant="outline" size="sm" onClick={data.reload}>Try again</Button>} />
        ) : null}
        {s && s.remaining === 0 ? (
          <Banner tone="warning" title={`No applications left ${period(s)}`}
            description="Jobs stay in your queue until your plan's limit resets." />
        ) : null}
        {children}
      </div>
      </Failed.Provider>
    </Workspace>
  );
}

// A banner, on shadcn's Alert: an icon, a title, a line, an action.
export function Banner({ tone = "info", icon, title, description, action }: {
  tone?: "info" | "warning" | "error"; icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode;
}) {
  return (
    <Alert variant={tone === "error" ? "destructive" : "default"}
      className={cn(tone === "warning" && "border-[var(--ooj-trend-down)]")}>
      {icon ?? <WarningCircle weight="fill" className={tone === "warning" ? WARN : undefined} />}
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
      {description ? <AlertDescription>{description}</AlertDescription> : null}
      {action ? <div data-slot="alert-action" className="col-start-2 mt-2">{action}</div> : null}
    </Alert>
  );
}

// An empty state, on shadcn's Empty: an icon, a title, a line, maybe a button.
export function Nothing({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return (
    <Empty className={PANEL}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}

// After a failed load the banner above says so and offers Try again; a
// spinner under it would wait for an answer that is not coming.
const Failed = createContext(false);
export function Waiting({ children = "Loading" }: { children?: ReactNode }) {
  if (useContext(Failed)) return null;
  return <div className="flex items-center gap-2 text-muted-foreground"><Spinner /> {children}</div>;
}

// A layer card: the page's paper, one hairline round it. No shadow (DESIGN.md).
export const PANEL = "rounded-lg border bg-card text-card-foreground";

export function Card({ title, note, action, children, className = "" }: {
  title?: ReactNode; note?: ReactNode | ReactNode[]; action?: ReactNode; children?: ReactNode; className?: string;
}) {
  const notes = Array.isArray(note) ? note : note ? [note] : [];
  return (
    <div className={cn(PANEL, "flex flex-col gap-3 p-4 md:p-6", className)}>
      {title || action ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="m-0 text-base font-semibold leading-snug text-foreground">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {notes.map((n, i) => <p key={i} className="m-0 text-muted-foreground">{n}</p>)}
      {children}
    </div>
  );
}

// A number with its label, in the overview's grid.
export function Tile({ label, value, children }: { label: string; value: string | number; children?: ReactNode }) {
  return (
    <div className={cn(PANEL, "flex flex-col gap-1 p-4 md:p-5")}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-[28px] font-medium leading-tight tabular-nums text-foreground">{value}</span>
      {children ? <span className="mt-1 text-sm">{children}</span> : null}
    </div>
  );
}

// The inline link, in the site's ink, green on hover.
export const LINK = "text-foreground underline underline-offset-[3px] decoration-1 hover:text-link-hover hover:decoration-2";

// A long settings form in sections, one shown at a time. The hidden ones
// stay mounted, so one Save keeps the edits in all of them. The hash names
// the open section, so a link can open one (/apply/settings#limits).
export function useSection(ids: readonly string[]) {
  const read = () => { const h = location.hash.slice(1); return ids.includes(h) ? h : ids[0]; };
  const [open, setOpen] = useState(read);
  useEffect(() => {
    const on = () => setOpen(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const show = (id: string) => { setOpen(id); history.replaceState(history.state, "", `#${id}`); };
  return [open, show] as const;
}
export function Sections({ open, show, items, children }: {
  open: string; show: (id: string) => void; items: readonly (readonly [string, string])[]; children: ReactNode;
}) {
  return (
    <Tabs value={open} onValueChange={show} className="gap-4">
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
        <TabsList variant="line" aria-label="Sections" className="h-10! w-full justify-start border-b">
          {items.map(([id, label]) => <TabsTrigger key={id} value={id} className="flex-none px-3">{label}</TabsTrigger>)}
        </TabsList>
      </div>
      {children}
    </Tabs>
  );
}
export function Section({ id, children }: { id: string; children: ReactNode }) {
  return <TabsContent value={id} forceMount className="flex flex-col gap-4 data-[state=inactive]:hidden">{children}</TabsContent>;
}
