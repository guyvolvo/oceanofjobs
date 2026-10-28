import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Badge } from "@cloudflare/kumo/components/badge";
import type { HistoryRow, Need, Outcome, QueueItem, Source, Summary } from "./api";
import type { Ext } from "./ext";
import { ExtensionAction, JobCell, JobLink, OUTCOME, OutcomeSelect, SENT, SOURCE, SourceLabel, StatusBadge, plural } from "./shared";

export const PLAN = { free: "Free plan", basic: "Basic plan", pro: "Pro plan" };
const SHOWN = 5;

// The latest row for each job (History comes newest first).
function latestPerJob(rows: HistoryRow[]) {
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.job_id) && seen.add(r.job_id));
}

export function Overview({ s, ext, queue, needs, history, reload }: {
  s: Summary; ext: Ext; queue?: QueueItem[]; needs?: Need[]; history?: HistoryRow[]; reload: () => void;
}) {
  const period = s.period === "day" ? "today" : "this month";
  const extBadge = ext.installed
    ? (ext.connected ? <Badge variant="success">Connected</Badge> : <Badge variant="warning">Not connected</Badge>)
    : ext.checking ? null : <Badge variant="neutral">Not installed</Badge>;
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
            {s.used} sent or awaiting confirmation, {s.in_progress} in progress, {plural(s.filled_today, "form")} filled today.
            {" "}AI answers: {s.ai.limit === null ? `${s.ai.used} ${period}` : `${s.ai.used} of ${s.ai.limit} ${period}`}.
            {s.daily_max ? ` You've also set a limit of ${s.daily_max} a day.` : ""}
            {s.plan !== "pro" ? <> <a className="oj-link" href="/pricing">Compare plans</a></> : null}
          </p>
        </div>
      </LayerCard>

      <div className="oj-overview">
        <LayerCard>
          <section className="oj-card-body" aria-labelledby="ov-next">
            <div className="oj-row">
              <h2 className="oj-card-title" id="ov-next">Next up</h2>
              {extBadge}
              {ext.version ? <span className="oj-note oj-num">v{ext.version}</span> : null}
            </div>
            {next ? (
              <div>
                <JobCell title={next.title} link={next.link} sub={next.company} />
                <SourceLabel row={next} />
              </div>
            ) : (
              <p className="oj-note">Your queue is empty. Add jobs with Auto apply on the <a className="oj-link" href="/board">job board</a>, or ask your AI assistant to queue them.</p>
            )}
            <div><ExtensionAction ext={ext} queue={queue} onOpened={reload} /></div>
            {queue && queue.length > 1 ? <p className="oj-note">{plural(queue.length - 1, "more job")} after this one. <a className="oj-link" href="#queue">View queue</a></p> : null}
          </section>
        </LayerCard>

        <LayerCard>
          <section className="oj-card-body" aria-labelledby="ov-attention">
            <h2 className="oj-card-title" id="ov-attention">Needs your attention</h2>
            {attention.length ? (
              <ul className="oj-list">
                {attention.slice(0, SHOWN).map((a) => (
                  <li key={a.key} className="oj-list-row">
                    <div className="oj-grow"><JobCell title={a.title} link={a.link} sub={a.company} /></div>
                    <a className="oj-link oj-num" href="#needs">{a.action}</a>
                  </li>
                ))}
              </ul>
            ) : <p className="oj-note">Nothing needs you right now.</p>}
            {attention.length > SHOWN ? <a className="oj-link" href="#needs">See all {attention.length}</a> : null}
          </section>
        </LayerCard>

        <LayerCard>
          <section className="oj-card-body" aria-labelledby="ov-sources">
            <h2 className="oj-card-title" id="ov-sources">Where your jobs came from</h2>
            {bySource.size ? (
              <ul className="oj-list">
                {[...bySource].map(([src, c]) => (
                  <li key={src} className="oj-list-row">
                    <span className="oj-grow">{SOURCE[src].name}</span>
                    <span className="oj-row oj-num">
                      {c.queued ? <a className="oj-link" href={`#queue?source=${src}`}>{c.queued} queued</a> : null}
                      {c.applied ? <a className="oj-link" href={`#history?source=${src}`}>{c.applied} in history</a> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="oj-note">Shows where each job was added from: the board, an alert, your AI assistant or the extension.</p>}
          </section>
        </LayerCard>

        <LayerCard>
          <section className="oj-card-body" aria-labelledby="ov-after">
            <h2 className="oj-card-title" id="ov-after">After applying</h2>
            {sent.length ? (
              <>
                <p className="oj-row oj-num">
                  {(Object.keys(OUTCOME).filter((k) => k !== "none") as Outcome[]).map((k) => (
                    <span key={k}>{OUTCOME[k]} <strong>{sent.filter((r) => r.outcome === k).length}</strong></span>
                  ))}
                </p>
                {unmarked.length ? (
                  <>
                    <p className="oj-note">What happened with these? Only you mark this, and it doesn't change the status.</p>
                    <ul className="oj-list">
                      {unmarked.map((r) => (
                        <li key={r.job_id} className="oj-list-row">
                          <div className="oj-grow"><JobLink title={r.title} link={r.link} /><span className="oj-sub"><StatusBadge status={r.status} /></span></div>
                          <OutcomeSelect row={r} onChange={reload} />
                        </li>
                      ))}
                    </ul>
                  </>
                ) : <p className="oj-note">You've marked every recent application.</p>}
                <a className="oj-link" href="#history">See all in History</a>
              </>
            ) : <p className="oj-note">Once an application is sent, you can mark what happened here.</p>}
          </section>
        </LayerCard>
      </div>
    </div>
  );
}
