// /apply: the plan's limit, what the extension has done, what waits, and
// where to go next.
import { Badge } from "@/components/ui/badge";
import type { HistoryRow } from "../api";
import { useExtension } from "../ext";
import { ExtensionAction, Meter, STATUS } from "../shared";
import { PLAN_NAME, period, useApplyData } from "./data";
import { ApplyPage, Card, LINK, Tile, Waiting } from "./Page";

// How the applications the extension worked on ended, in the order the
// statuses mean something: sent first, then the ones that stopped.
function Outcomes({ rows }: { rows: HistoryRow[] }) {
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(r.status, (counts.get(r.status) || 0) + 1));
  const shown = Object.entries(STATUS).filter(([k]) => counts.get(k));
  return (
    <Card title="Outcomes" note={rows.length ? `Of your last ${rows.length} applications.` : "Every job the extension works on shows up here."}>
      {shown.length ? (
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {shown.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 border-b pb-1.5">
              <dt className="text-sm text-muted-foreground">{v.label}</dt>
              <dd className="m-0 tabular-nums text-foreground">{counts.get(k)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <a className={`${LINK} text-sm`} href="/apply/history">All applications</a>
    </Card>
  );
}

export default function OverviewPage() {
  const data = useApplyData();
  const ext = useExtension();
  const s = data.summary;
  const extBadge = ext.installed
    ? (ext.connected ? <Badge variant="outline" className="border-transparent bg-[var(--ooj-green-tint)] text-[var(--ooj-green-text)]">Connected</Badge>
      : <Badge variant="outline" className="border-[var(--ooj-trend-down)] text-[var(--ooj-trend-down)]">Not connected</Badge>)
    : ext.checking ? null : <Badge variant="secondary">Not installed</Badge>;
  return (
    <ApplyPage current="overview" title="Overview" note="What auto apply has done, and what it is waiting on." data={data}>
      {!s ? <Waiting /> : (
        <>
          <Card title={`Applications ${period(s)}`} action={<span className="text-sm text-muted-foreground">{PLAN_NAME[s.plan] || "Free"} plan</span>}>
            <Meter label={`${s.used + s.in_progress} of ${s.limit} used ${period(s)}`} value={s.used + s.in_progress} max={s.limit || 1}
              customValue={`${s.remaining} left`} />
            <p className="m-0 text-muted-foreground">
              {s.used} sent or awaiting confirmation, {s.in_progress} in progress.
              {s.daily_max ? ` You've also set a limit of ${s.daily_max} a day.` : ""}
              {s.plan !== "pro" ? <> <a className={LINK} href="/pricing">Compare plans</a></> : null}
            </p>
          </Card>

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            <Tile label="Forms filled today" value={s.filled_today} />
            <Tile label="In your queue" value={s.queued}>
              <a className={LINK} href="/apply/queue">View queue</a>
            </Tile>
            <Tile label="Need your input" value={s.needs_input}>
              {s.needs_input ? <a className={LINK} href="/apply/needs">Answer questions</a> : <span className="text-muted-foreground">Nothing to answer</span>}
            </Tile>
            <Tile label="Submission unconfirmed" value={s.unconfirmed}>
              {s.unconfirmed ? <a className={LINK} href="/apply/needs">Review</a> : <span className="text-muted-foreground">All confirmed</span>}
            </Tile>
            <Tile label="AI answers" value={s.ai.used}>
              <span className="text-muted-foreground">{s.ai.limit === null ? `Drafted ${period(s)}` : `Of ${s.ai.limit} ${period(s)}`}</span>
            </Tile>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Chrome extension" action={<span className="flex items-center gap-2">{extBadge}{ext.version ? <span className="text-sm tabular-nums text-muted-foreground">v{ext.version}</span> : null}</span>}>
              <ExtensionAction ext={ext} queue={data.queue} onOpened={data.reload} />
            </Card>
            <Card title="Next steps">
              <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5">
                {!s.queued ? <li><a className={LINK} href="/board">Add jobs to your queue</a> from the job board.</li> : null}
                {s.needs_input ? <li><a className={LINK} href="/apply/needs">Answer the questions</a> the forms asked, so those jobs can go back in the queue.</li> : null}
                {s.unconfirmed ? <li><a className={LINK} href="/apply/needs">Check the unconfirmed submissions</a> and refund the ones that never went through.</li> : null}
                <li><a className={LINK} href="/apply/agent">Teach your AI agent</a> the facts it may use when a form asks something new.</li>
                <li><a className={LINK} href="/apply/settings">Review your auto apply settings</a>: where jobs come from, limits, saved answers.</li>
              </ul>
            </Card>
          </div>

          {data.history ? <Outcomes rows={data.history} /> : null}
        </>
      )}
    </ApplyPage>
  );
}
