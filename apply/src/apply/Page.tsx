// One auto apply page: the workspace around it with the plan line and the
// sidebar counts, the sign-in when signed out, and the two banners every
// page shows (a request failed; no applications left). Plus the few
// pieces the pages share: a card, a stat tile, a loading row.
import type { ReactNode } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { WarningCircle } from "@phosphor-icons/react";
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
      <div className="flex flex-col gap-5">
        {data.failed ? (
          <Banner variant="error" icon={<WarningCircle weight="fill" />} title="Couldn't load everything"
            description="Some of what's shown here may be out of date." action={<Button onClick={data.reload}>Try again</Button>} />
        ) : null}
        {s && s.remaining === 0 ? (
          <Banner variant="alert" icon={<WarningCircle weight="fill" />} title={`No applications left ${period(s)}`}
            description="Jobs stay in your queue until your plan's limit resets." />
        ) : null}
        {children}
      </div>
    </Workspace>
  );
}

export const Waiting = ({ children = "Loading" }: { children?: ReactNode }) => (
  <div className="flex items-center gap-2 text-kumo-subtle"><Loader /> {children}</div>
);

export function Card({ title, note, action, children, className = "" }: {
  title?: ReactNode; note?: ReactNode | ReactNode[]; action?: ReactNode; children?: ReactNode; className?: string;
}) {
  const notes = Array.isArray(note) ? note : note ? [note] : [];
  return (
    <LayerCard className={`flex flex-col gap-3 p-4 md:p-6 ${className}`}>
      {title || action ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="m-0 text-base font-semibold leading-snug text-kumo-strong">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {notes.map((n, i) => <p key={i} className="m-0 text-kumo-subtle">{n}</p>)}
      {children}
    </LayerCard>
  );
}

// A number with its label, in the overview's grid.
export function Tile({ label, value, children }: { label: string; value: string | number; children?: ReactNode }) {
  return (
    <LayerCard className="flex flex-col gap-1 p-4 md:p-5">
      <span className="text-sm text-kumo-subtle">{label}</span>
      <span className="font-mono text-[28px] font-medium leading-tight tabular-nums text-kumo-strong">{value}</span>
      {children ? <span className="mt-1 text-sm">{children}</span> : null}
    </LayerCard>
  );
}

// The inline link, in the site's green.
export const LINK = "text-kumo-link underline underline-offset-[3px] decoration-1 hover:decoration-2";
