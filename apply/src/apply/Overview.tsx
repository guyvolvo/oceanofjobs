// /apply: the plan's limit, what the extension has done, what waits, and
// where to go next.
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { HistoryRow, Outcome, Source } from "../api";
import { useExtension } from "../ext";
import { ExtensionAction, JobCell, JobLink, Meter, OUTCOME, OutcomeSelect, SENT, SOURCE, STATUS, SourceLabel, StatusBadge, plural } from "../shared";
import { PLAN_NAME, period, useApplyData } from "./data";
import { ApplyPage, Card, LINK, Tile, Waiting } from "./Page";

const SHOWN = 5;
const LIST = "m-0 flex list-none flex-col p-0";
const ROW = "flex items-start justify-between gap-3 border-b py-2 first:pt-0 last:border-b-0 last:pb-0";

// The latest row for each job (History comes newest first).
function latestPerJob(rows: HistoryRow[]) {
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.job_id) && seen.add(r.job_id));
}

// How the applications the extension worked on ended, in the order the
// statuses mean something: sent first, then the ones that stopped.
function Statuses({ rows }: { rows: HistoryRow[] }) {
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(r.status, (counts.get(r.status) || 0) + 1));
  const shown = Object.entries(STATUS).filter(([k]) => counts.get(k));
  return (
    <Card title="Application status" note={rows.length ? `Of your last ${rows.length} applications.` : "Every job the extension works on shows up here."}>
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
  const { queue, needs, history } = data;
  const extBadge = ext.installed
    ? (ext.connected ? <Badge variant="outline" className="border-transparent bg-[var(--ooj-green-tint)] text-[var(--ooj-green-text)]">Connected</Badge>
      : <Badge variant="outline" className="border-[var(--ooj-trend-down)] text-[var(--ooj-trend-down)]">Not connected</Badge>)
    : ext.checking ? null : <Badge variant="secondary">Not installed</Badge>;
  const next = queue?.[0];
  const jobs = latestPerJob(history || []);

  // Needs attention: questions to answer, then applications to check.
  const attention = [
    ...(needs || []).map((n) => ({ key: n.attempt_id, title: n.title, company: n.company, link: n.link,
      action: n.ready ? "Submit it yourself" : `Answer ${plural(n.questions.length, "question")}` })),
    ...(history || []).filter((r) => r.status === "unconfirmed" && r.attempt_id).map((r) => ({
      key: r.attempt_id!, title: r.title, company: r.company, link: r.link, action: "Check it was sent" })),
  ];

  // Each job once, by the source that first added it.
  const bySource = new Map<Source, { queued: number; applied: number }>();
  const count = (src: Source | null | undefined, k: "queued" | "applied") => {
    if (!src || !SOURCE[src]) return;
    const c = bySource.get(src) || { queued: 0, applied: 0 };
    c[k]++;
    bySource.set(src, c);
  };
  (queue || []).forEach((q) => count(q.source, "queued"));
  jobs.forEach((r) => count(r.source, "applied"));

  const sent = jobs.filter((r) => SENT.includes(r.status));
  const unmarked = sent.filter((r) => !r.outcome).slice(0, 3);

  return (
    <ApplyPage current="overview" title="Overview" data={data}>
      {!s ? <Waiting /> : (
        <>
          <Card title={`Applications ${period(s)}`} action={<span className="text-sm text-muted-foreground">{PLAN_NAME[s.plan] || "Free"} plan</span>}>
            <Meter label={`${s.used + s.in_progress} of ${s.limit} used`} value={s.used + s.in_progress} max={s.limit || 1}
              customValue={`${s.remaining} left ${period(s)}`} />
            <p className="m-0 text-muted-foreground">
              {s.used} sent{s.in_progress ? `, ${s.in_progress} in progress` : ""}, {plural(s.filled_today, "form")} filled today.
              {" "}AI answers: {s.ai.limit === null ? `${s.ai.used} ${period(s)}` : `${s.ai.used} of ${s.ai.limit} ${period(s)}`}.
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
            <Card title="Next up" action={<span className="flex items-center gap-2">{extBadge}{ext.version ? <span className="text-sm tabular-nums text-muted-foreground">v{ext.version}</span> : null}</span>}>
              {next ? (
                <div><JobCell title={next.title} link={next.link} sub={next.company} /><SourceLabel row={next} /></div>
              ) : queue ? (
                <p className="m-0 text-muted-foreground">No jobs in the queue. Add jobs from the <a className={LINK} href="/board">board</a> or ask your AI assistant to queue them.</p>
              ) : null}
              <div><ExtensionAction ext={ext} queue={queue} onOpened={data.reload} /></div>
              {queue && queue.length > 1 ? <p className="m-0 text-muted-foreground">{plural(queue.length - 1, "more job")} after this one. <a className={LINK} href="/apply/queue">View queue</a></p> : null}
            </Card>

            <Card title="Needs your attention">
              {attention.length ? (
                <ul className={LIST}>
                  {attention.slice(0, SHOWN).map((a) => (
                    <li key={a.key} className={ROW}>
                      <div className="min-w-0"><JobCell title={a.title} link={a.link} sub={a.company} /></div>
                      <a className={`${LINK} shrink-0 text-sm`} href="/apply/needs">{a.action}</a>
                    </li>
                  ))}
                </ul>
              ) : <p className="m-0 text-muted-foreground">Nothing needs your attention.</p>}
              {attention.length > SHOWN ? <a className={`${LINK} text-sm`} href="/apply/needs">See all {attention.length}</a> : null}
            </Card>

            <Card title="Job sources">
              {bySource.size ? (
                <ul className={LIST}>
                  {[...bySource].map(([src, c]) => (
                    <li key={src} className={ROW}>
                      <span className="text-foreground">{SOURCE[src].name}</span>
                      <span className="flex flex-wrap justify-end gap-x-3 text-sm tabular-nums">
                        {c.queued ? <a className={LINK} href={`/apply/queue?source=${src}`}>{c.queued} queued</a> : null}
                        {c.applied ? <a className={LINK} href={`/apply/history?source=${src}`}>{c.applied} in history</a> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <p className="m-0 text-muted-foreground">No jobs yet.</p>}
            </Card>

            <Card title="Outcomes">
              {sent.length ? (
                <>
                  <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-muted-foreground">
                    {(Object.keys(OUTCOME).filter((k) => k !== "none") as Outcome[]).map((k) => (
                      <span key={k}>{OUTCOME[k]} <strong className="font-medium text-foreground">{sent.filter((r) => r.outcome === k).length}</strong></span>
                    ))}
                  </p>
                  {unmarked.length ? (
                    <>
                      <p className="m-0 text-muted-foreground">Mark the outcome when you hear back. This won't change the application status.</p>
                      <ul className={LIST}>
                        {unmarked.map((r) => (
                          <li key={r.job_id} className={cn(ROW, "items-center")}>
                            <div className="min-w-0"><JobLink title={r.title} link={r.link} /><span className="mt-1 block"><StatusBadge status={r.status} /></span></div>
                            <OutcomeSelect row={r} onChange={data.reload} />
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : <p className="m-0 text-muted-foreground">You've marked every recent application.</p>}
                  <a className={`${LINK} text-sm`} href="/apply/history">View history</a>
                </>
              ) : <p className="m-0 text-muted-foreground">Once an application is sent, you can mark its outcome here.</p>}
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

            {history ? <Statuses rows={history} /> : null}
          </div>
        </>
      )}
    </ApplyPage>
  );
}
