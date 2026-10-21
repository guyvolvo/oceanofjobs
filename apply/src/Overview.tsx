import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Badge } from "@cloudflare/kumo/components/badge";
import type { QueueItem, Summary } from "./api";
import type { Ext } from "./ext";
import { ExtensionAction } from "./shared";

export const PLAN = { free: "Free plan", basic: "Basic plan", pro: "Pro plan" };

function Tile({ label, value, children }: { label: string; value: string | number; children?: React.ReactNode }) {
  return (
    <LayerCard>
      <div className="oj-card-body">
        <span className="oj-note">{label}</span>
        <span className="oj-figure">{value}</span>
        {children}
      </div>
    </LayerCard>
  );
}

export function Overview({ s, ext, queue, reload }: { s: Summary; ext: Ext; queue?: QueueItem[]; reload: () => void }) {
  const period = s.period === "day" ? "today" : "this month";
  const extBadge = ext.installed
    ? (ext.connected ? <Badge variant="success">Connected</Badge> : <Badge variant="warning">Not connected</Badge>)
    : ext.checking ? null : <Badge variant="neutral">Not installed</Badge>;
  return (
    <div className="oj-stack">
      <LayerCard>
        <div className="oj-card-body">
          <div className="oj-row oj-row-between">
            <h2 className="oj-card-title">Applications {period}</h2>
            <span className="oj-note">{PLAN[s.plan] || "Free plan"}</span>
          </div>
          <Meter label={`${s.used + s.in_progress} of ${s.limit} used ${period}`} value={s.used + s.in_progress} max={s.limit || 1}
            customValue={`${s.remaining} left`} />
          <p className="oj-note">
            {s.used} sent or awaiting confirmation, {s.in_progress} in progress.
            {s.daily_max ? ` You've also set a limit of ${s.daily_max} a day.` : ""}
            {s.plan !== "pro" ? <> <a className="oj-link" href="/pricing">Compare plans</a></> : null}
          </p>
        </div>
      </LayerCard>

      <div className="oj-grid">
        <Tile label="Applications filled today" value={s.filled_today} />
        <Tile label="In your queue" value={s.queued}>
          <a className="oj-link" href="#queue">View queue</a>
        </Tile>
        <Tile label="Need your input" value={s.needs_input}>
          {s.needs_input ? <a className="oj-link" href="#needs">Answer questions</a> : <span className="oj-note">Nothing to answer</span>}
        </Tile>
        <Tile label="Submission unconfirmed" value={s.unconfirmed}>
          {s.unconfirmed ? <a className="oj-link" href="#needs">Review</a> : <span className="oj-note">All confirmed</span>}
        </Tile>
        <Tile label="AI answers" value={s.ai.used}>
          <span className="oj-note">{s.ai.limit === null ? `Drafted ${period}` : `Of ${s.ai.limit} ${period}`}</span>
        </Tile>
      </div>

      <LayerCard>
        <div className="oj-card-body">
          <div className="oj-row">
            <h2 className="oj-card-title">Chrome extension</h2>
            {extBadge}
            {ext.version ? <span className="oj-note oj-num">v{ext.version}</span> : null}
          </div>
          <div><ExtensionAction ext={ext} queue={queue} onOpened={reload} /></div>
        </div>
      </LayerCard>
    </div>
  );
}
