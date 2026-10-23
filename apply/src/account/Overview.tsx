// The overview: four numbers, the weekly trend of the reader's matches,
// the newest fits, the skills against demand, and the alerts. Every
// number is the reader's own, from /api/me/dashboard (computed on the box
// once a day, api/dashboard.py) and the alert and saved lists.
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Table } from "@cloudflare/kumo/components/table";
import { Meter } from "@cloudflare/kumo/components/meter";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { ArrowDownRight, ArrowUpRight, BookmarkSimple, Check, Pause, PencilSimple, UploadSimple, X } from "@phosphor-icons/react";
import { pub } from "../api";
import { describeAlertFilter, fmt, MAX_SKILLS, starred, type Alert, type Dashboard, type Day, type Job } from "./data";
import { AlertFormView, useAlertActions, type AlertForm } from "./Alerts";
import { Card, ConfirmButton } from "./ui";

const charts = () => import("./Charts");
const TrendChart = lazy(() => charts().then((m) => ({ default: m.TrendChart })));
const PayChart = lazy(() => charts().then((m) => ({ default: m.PayChart })));
const DemandChart = lazy(() => charts().then((m) => ({ default: m.DemandChart })));

const dayLabel = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });
function ago(iso: string) {
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (h < 1) return "just now";
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

// How a number moved against the period before, in percent. Nothing when
// there was nothing to measure against, or when the record was thin then
// (a month-ago figure a fraction of today's).
function change(now: number | null, prev: number | null) {
  if (now == null || prev == null || !prev || prev < now / 4) return null;
  return Math.round(((now - prev) / prev) * 100);
}
function Pill({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const shown = Math.abs(pct) >= 1000 ? `${Math.round(Math.abs(pct) / 100) / 10}k` : Math.abs(pct);
  return (
    <span className={`oj-pill oj-pill-${dir}`} title={`${pct > 0 ? "+" : ""}${pct}% against the period before`}>
      {dir === "up" ? <ArrowUpRight size={11} aria-hidden="true" /> : dir === "down" ? <ArrowDownRight size={11} aria-hidden="true" /> : null}
      <span className="sr-only">{dir === "up" ? "Up " : dir === "down" ? "Down " : ""}</span>{shown}%
    </span>
  );
}

// The 90 days as whole weeks ending today, at most eight: the new matches
// in each, and the roles open on its last day.
function weekly(days: Day[]) {
  const out: { day: string; matches: number; roles: number }[] = [];
  for (let w = Math.min(8, Math.floor(days.length / 7)) - 1; w >= 0; w--) {
    const end = days.length - 1 - 7 * w;
    out.push({ day: days[end].day, matches: days.slice(end - 6, end + 1).reduce((s, d) => s + d.new, 0), roles: days[end].open });
  }
  return out;
}

// Pay, from the matches' own estimates: the median, the middle half, and
// 13 bins of 5K from 20K (the ends hold everything past them).
const k = (n: number) => `₪${Math.round(n / 1000)}K`;
function shekels(text?: string) {
  if (!text || !/₪|ILS|NIS/.test(text)) return null;
  const nums = [...text.matchAll(/(\d[\d,.]*)\s*([kK])?/g)].map((m) => parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1)).filter((n) => n > 1000);
  if (!nums.length) return null;
  return nums.length >= 2 ? (nums[0] + nums[1]) / 2 : nums[0];
}
function pay(matches: Job[]) {
  const pays = matches.map((j) => shekels(j.salary_text)).filter((n): n is number => !!n).sort((a, b) => a - b);
  if (pays.length < 5) return null;
  const q = (f: number) => pays[Math.min(pays.length - 1, Math.floor(f * (pays.length - 1)))];
  const bins = Array(13).fill(0);
  for (const p of pays) bins[Math.max(0, Math.min(12, Math.floor((p - 20000) / 5000)))] += 1;
  return { med: q(0.5), lo: q(0.25), hi: q(0.75), n: pays.length, bins };
}

const bone = (w: number) => <SkeletonLine minWidth={w} maxWidth={w} />;

function Stat({ label, value, trend, aside, extra, title }: { label: string; value: ReactNode; trend?: ReactNode; aside?: ReactNode; extra?: ReactNode; title?: string }) {
  return (
    <LayerCard>
      <div className="oj-card-body oj-stat" title={title}>
        <div className="oj-row oj-row-between"><span className="oj-row oj-tight"><span className="oj-figure">{value}</span>{trend}</span>{extra}</div>
        <div className="oj-row oj-row-between"><span className="oj-note">{label}</span><span className="oj-note oj-aside">{aside}</span></div>
      </div>
    </LayerCard>
  );
}

// The three best matches for skills being edited, not yet saved. The
// saved ones come with the dashboard. Cached ten minutes for this sitting:
// the ranking is 1.8s of real work on the box.
const MATCHES_KEY = "iljobs_acct_matches";
function useEditedMatches(skills: string[], editing: boolean) {
  const [jobs, setJobs] = useState<Job[] | null | "failed">(null);
  const key = skills.join(",");
  useEffect(() => {
    if (!editing || !skills.length) return;
    const q = new URLSearchParams({ skills: key, sort: "match", dir: "asc", limit: "3", count: "skip" }).toString();
    try {
      const hit = JSON.parse(sessionStorage.getItem(MATCHES_KEY) || "null");
      if (hit && hit.key === q && Date.now() - hit.at < 10 * 60 * 1000) { setJobs(hit.jobs); return; }
    } catch { /* private browsing, or someone else's JSON in our key */ }
    setJobs(null);
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const found = (await pub<{ jobs: Job[] }>(`/jobs?${q}`)).jobs || [];
        try { sessionStorage.setItem(MATCHES_KEY, JSON.stringify({ key: q, at: Date.now(), jobs: found })); } catch { /* the list still draws */ }
        if (live) setJobs(found);
      } catch {
        if (live) setJobs("failed");
      }
    }, 500);
    return () => { live = false; clearTimeout(timer); };
  }, [key, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  return jobs;
}

function Logo({ job }: { job: Job }) {
  const letter = (job.company_domain || job.company_name || "?").charAt(0).toUpperCase();
  const [failed, setFailed] = useState(job.logo_url === "" || !job.company_domain);
  return failed
    ? <span className="oj-logo oj-logo-letter" aria-hidden="true">{letter}</span>
    : <img className="oj-logo" src={`/logo/${encodeURIComponent(job.company_domain!)}.png`} alt="" width={28} height={28} loading="lazy" onError={() => setFailed(true)} />;
}

export function Overview({ skills, savedSkills, places, dash, dashLoaded, savedJobs, alerts, form, formOpen, setFormOpen,
  reloadAlerts, addSkill, toggleSave }: {
  skills: string[]; savedSkills: string[]; places: string; dash: Dashboard | null; dashLoaded: boolean;
  savedJobs: Job[] | null; alerts: Alert[] | null; form: AlertForm; formOpen: boolean; setFormOpen: (o: boolean) => void;
  reloadAlerts: () => Promise<unknown>; addSkill: (sk: string) => Promise<boolean>; toggleSave: (j: Job, on: boolean) => Promise<void>;
}) {
  const [series, setSeries] = useState<"matches" | "roles">("matches");
  const [note, setNote] = useState<ReactNode>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [, repaint] = useState(0);
  const act = useAlertActions(reloadAlerts);
  const editing = skills.join(",") !== savedSkills.join(",");
  const edited = useEditedMatches(skills, editing);

  const matches = dash?.matches || [];
  const days = dash?.history?.days || [];
  const weeks = weekly(days);
  const n = days.length;
  const week = weeks.length ? weeks[weeks.length - 1].matches : 0;
  const before = weeks.length > 1 ? weeks[weeks.length - 2].matches : null;
  const open = n ? days[n - 1].open : null;
  const monthAgo = n >= 31 ? days[n - 31].open : null;
  const noSkills = !skills.length;
  const p = pay(matches);
  const stillOpen = (savedJobs || []).filter((j) => !j.closed_at).length;
  const savedN = savedJobs?.length || 0;
  const ready = dashLoaded;

  const best = editing ? (edited === "failed" ? "failed" : edited) : (ready ? matches.slice(0, 3) : null);
  const want = new Set(skills);
  const stars = starred();

  // Gaps: skills the reader doesn't list that at least a fifth of their
  // matches name. Then the listed skills, capped so the card stays short.
  const counts = dash?.counts || {};
  const seen = new Map<string, number>();
  const have = new Set(savedSkills);
  for (const j of matches) for (const sk of (j.skills || "").split(",").filter(Boolean)) if (!have.has(sk)) seen.set(sk, (seen.get(sk) || 0) + 1);
  const gaps = [...seen.entries()].filter(([sk, c]) => matches.length && c / matches.length >= 0.2 && counts[sk] != null)
    .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([sk, c]) => ({ sk, n: counts[sk], share: Math.round((c / matches.length) * 100) }));
  const mine = savedSkills.slice(0, 10).filter((sk) => counts[sk] != null).map((sk) => ({ sk, n: counts[sk] })).sort((a, b) => b.n - a.n);
  const cap = gaps.length ? 6 : 8;
  const more = mine.length - cap;

  const add = async (sk: string) => {
    if (skills.length >= MAX_SKILLS) {
      setNote(<>You have the maximum of {MAX_SKILLS} skills. Remove one in <a className="oj-link" href="#skills">Skills</a> to add <b>{sk}</b>.</>);
      return;
    }
    setAdding(sk);
    setNote(null);
    if (!(await addSkill(sk))) setNote("Couldn't add that skill. Try again.");
    setAdding(null);
  };

  const sent = (alerts || []).map((a) => a.last_notified_at).filter(Boolean).sort().pop();
  const trendValues = weeks.map((w) => w[series]);
  const isM = series === "matches";
  const trendTitle = isM ? "New matches per week" : "Open jobs that fit you, weekly";

  return (
    <div className="oj-stack">
      <div className="oj-grid oj-stats">
        <Stat label="New matches this week" value={!ready ? bone(64) : noSkills ? "–" : fmt(week)} trend={noSkills ? null : <Pill pct={change(week, before)} />}
          aside={!ready ? bone(60) : noSkills ? <a className="oj-link" href="#skills">Add your skills</a> : before == null ? "" : `Prev: ${fmt(before)}`} />
        <Stat label="Open jobs that fit you" value={!ready ? bone(64) : open == null ? "–" : fmt(open)} trend={<Pill pct={change(open, monthAgo)} />}
          aside={!ready ? bone(60) : monthAgo == null ? "" : `Prev: ${fmt(monthAgo)} / mo`} />
        <Stat label="Median salary / mo" value={!ready ? bone(64) : p ? k(p.med) : "–"}
          extra={p ? <span className="oj-bins" aria-hidden="true"><Suspense fallback={null}><PayChart bins={p.bins} lo={p.lo} hi={p.hi} /></Suspense></span> : null}
          aside={!ready ? bone(60) : p ? `Mid: ${k(p.lo)}–${k(p.hi).slice(1)}` : noSkills ? "" : "Too few estimates yet"}
          title={p ? `Estimated from ${p.n} of your matches. The middle half pays ${k(p.lo)} to ${k(p.hi)} a month.` : undefined} />
        <Stat label="Saved jobs" value={savedJobs ? fmt(savedN) : bone(40)}
          extra={savedN ? <a className="oj-link" href="#saved">View</a> : null}
          aside={!savedJobs ? bone(60) : savedN ? `${stillOpen} still open` : <a className="oj-link" href="/board">Save one from the board</a>} />
      </div>

      {ready && !matches.length && !editing ? (
        <Card title="Get matched to jobs">
          <p className="oj-note">{skills.length
            ? `Your ${skills.length} skill${skills.length === 1 ? "" : "s"} don't match any open jobs yet. Add skills from a newer CV or widen your locations to see matches and salary estimates.`
            : "Add your skills from a CV, or widen your locations, to see matches and salary estimates."}</p>
          <div className="oj-row">
            <LinkButton variant="secondary" href="#skills" icon={<UploadSimple />}>Add skills from a CV</LinkButton>
            <LinkButton variant="ghost" href="#preferences">Edit locations</LinkButton>
          </div>
        </Card>
      ) : null}

      <div className="oj-split">
        <LayerCard>
          <section className="oj-card-body" aria-labelledby="trend-title">
            <div className="oj-row oj-row-between">
              <div>
                <h2 className="oj-card-title" id="trend-title">{trendTitle}</h2>
                {weeks.length >= 2 ? (
                  <div className="oj-row oj-tight"><span className="oj-figure">{fmt(trendValues[trendValues.length - 1])}</span>
                    <Pill pct={isM ? change(trendValues[trendValues.length - 1], trendValues[trendValues.length - 2]) : change(open, monthAgo)} /></div>
                ) : null}
              </div>
              <Tabs variant="segmented" value={series} onValueChange={(v) => setSeries(v as "matches" | "roles")}
                tabs={[{ value: "matches", label: "New matches" }, { value: "roles", label: "Open jobs" }]} />
            </div>
            {!ready ? <div className="oj-chart-bones"><SkeletonLine blockHeight={300} /></div>
              : weeks.length < 2 ? (
                <p className="oj-note">{skills.length ? "Not enough history yet. The weeks fill in as the board watches your matches."
                  : <>Add <a className="oj-link" href="#skills">your skills</a> to see your matches week by week.</>}</p>
              ) : (
                <>
                  <Suspense fallback={<div className="oj-chart-bones"><SkeletonLine blockHeight={300} /></div>}>
                    <TrendChart labels={weeks.map((w) => dayLabel(w.day))} values={trendValues} name={isM ? "New matches" : "Open jobs"} />
                  </Suspense>
                  <table className="sr-only">
                    <caption>{trendTitle}</caption>
                    <thead><tr><th scope="col">Week to</th><th scope="col">{isM ? "New matches" : "Open jobs"}</th></tr></thead>
                    <tbody>{weeks.map((w, i) => <tr key={w.day}><td>{dayLabel(w.day)}</td><td>{fmt(trendValues[i])}</td></tr>)}</tbody>
                  </table>
                </>
              )}
          </section>
        </LayerCard>

        <Card title="New best matches" action={<LinkButton variant="ghost" href="/board?view=matches">{week ? `View all ${fmt(week)}` : "View all"}</LinkButton>}>
          {!skills.length ? <p className="oj-note">Add skills to see matches.</p>
            : best === "failed" ? <p className="oj-note">Could not load matches.</p>
            : !best ? <div className="oj-stack">{bone(220)}{bone(180)}{bone(200)}</div>
            : !best.length ? <p className="oj-note">Nothing matches those skills yet.</p>
            : (
              <ul className="oj-matches">
                {best.map((j) => {
                  const hit = (j.skills || "").split(",").filter((sk) => want.has(sk)).length;
                  const on = stars.has(j.id);
                  return (
                    <li key={j.id} className="oj-match">
                      <Logo job={j} />
                      <div className="oj-grow">
                        <a className="oj-job" href={`/job/${encodeURIComponent(j.id)}`}>{j.title}</a>
                        <span className="oj-sub">{j.company_name || j.company_domain || ""}{j.location ? ` · ${j.location}` : ""}</span>
                        <Meter label="Shared skills" value={hit} max={Math.max(1, want.size)} customValue={`${hit} of ${want.size}`} />
                      </div>
                      <Button size="sm" variant={on ? "secondary" : "ghost"} shape="square" aria-pressed={on} aria-label={`${on ? "Saved" : "Save"}: ${j.title}`}
                        onClick={async () => { await toggleSave(j, !on); repaint((x) => x + 1); }}>
                        <BookmarkSimple weight={on ? "fill" : "regular"} />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
        </Card>
      </div>

      <div className="oj-split">
        <Card title="Open jobs per skill" action={
          <span className="oj-row oj-tight">
            <LinkButton variant="secondary" href="#preferences" title="Where these are counted. Change it in Preferences.">{places}</LinkButton>
            <LinkButton variant="ghost" href="#skills">Edit skills</LinkButton>
          </span>}>
          {!savedSkills.length ? <p className="oj-note">Add skills to see demand for them.</p>
            : !ready ? <div className="oj-stack">{bone(240)}{bone(200)}{bone(220)}{bone(180)}</div>
            : (
              <>
                {gaps.length ? <p className="oj-note">Gaps · in {gaps.map((g) => `${g.share}%`).join(" and ")} of your matches</p> : null}
                <Suspense fallback={<SkeletonLine blockHeight={120} />}>
                  <DemandChart rows={[...gaps.map((g) => ({ sk: g.sk, n: g.n, gap: true })), ...mine.slice(0, cap).map((r) => ({ ...r, gap: false }))]} />
                </Suspense>
                {gaps.length ? (
                  <div className="oj-row">
                    {gaps.map((g) => (
                      <Button key={g.sk} variant="secondary" loading={adding === g.sk} aria-label={`Add ${g.sk} to your skills`}
                        title={`${g.sk} is named by ${g.share}% of your matches; ${fmt(g.n)} open jobs ask for it`} onClick={() => add(g.sk)}>Add {g.sk}</Button>
                    ))}
                  </div>
                ) : null}
                {more > 0 ? <a className="oj-link" href="#skills">Show {more} more →</a> : null}
                {note ? <p className="oj-note" role="status">{note}</p> : null}
              </>
            )}
        </Card>

        <Card title={<>Alerts {sent ? <span className="oj-note">· sent {ago(sent)}</span> : null}</>}
          action={<Button variant="secondary" aria-expanded={formOpen} onClick={() => { if (formOpen) form.reset(); setFormOpen(!formOpen); }}>{formOpen ? "Cancel" : "New alert"}</Button>}>
          {formOpen ? <AlertFormView form={form} autoFocus onDone={() => setFormOpen(false)} />
            : !alerts ? <div className="oj-stack">{bone(220)}{bone(180)}</div>
            : !alerts.length ? <p className="oj-note">No alerts yet. Create one and new listings that match it are emailed to you.</p>
            : (
              <div className="oj-table">
                <Table>
                  <Table.Header><Table.Row><Table.Head>Alert</Table.Head><Table.Head>Status</Table.Head><Table.Head><span className="sr-only">Actions</span></Table.Head></Table.Row></Table.Header>
                  <Table.Body>
                    {alerts.map((a) => {
                      const f = a.filter || {};
                      const kw = f.search || f.q || "";
                      const rest = describeAlertFilter({ ...f, search: "", q: "" });
                      const name = describeAlertFilter(f);
                      return (
                        <Table.Row key={a.alert_id}>
                          <Table.Cell className={a.active ? undefined : "oj-muted"}>
                            {kw ? <b>"{kw}" </b> : null}{kw && rest === "All jobs" ? "" : rest}
                          </Table.Cell>
                          <Table.Cell><span className="oj-row oj-tight oj-nowrap">{a.active ? <><Check aria-hidden="true" />Active</> : <><Pause aria-hidden="true" />Paused</>}</span></Table.Cell>
                          <Table.Cell className="oj-actions-cell">
                            <span className="oj-row oj-tight oj-nowrap">
                              <Button variant="secondary" disabled={act.busy === a.alert_id} onClick={() => act.toggle(a)}>{a.active ? "Pause" : "Resume"}</Button>
                              <Button size="sm" variant="ghost" shape="square" aria-label={`Edit alert ${name}`} title="Edit alert"
                                onClick={() => { form.edit(a); setFormOpen(true); }}><PencilSimple /></Button>
                              <ConfirmButton size="sm" variant="ghost" shape="square" title="Delete alert" aria-label={`Delete alert ${name}`}
                                disabled={act.busy === a.alert_id} onConfirm={() => act.remove(a)}><X /></ConfirmButton>
                            </span>
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table>
              </div>
            )}
        </Card>
      </div>
    </div>
  );
}
