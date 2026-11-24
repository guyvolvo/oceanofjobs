// The list box: the count line with the date and sort, the Best matches
// panel, the search notice, the held "new jobs" button, the rows and the
// empty and error states. Rows are virtual (TanStack Virtual): only the
// ones near the screen are in the page, so tests and code find a row by
// its data-id, never by its position.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer, useWindowVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { CaretDown, Check, Lightning, Star } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { requestSignIn } from "../site/auth";
import { signedIn } from "../api";
import { DateSelect, SortSelect } from "./Filters";
import { F, MAX_SEARCH_TERMS, U, appliedLabel, clearError, dom, dropSkill, lastAppliedFilter, loadJobs, loadMoreJobs, moreAvailable, openJobAndPush, resultNoun,
  searchSkill, searchTermsInPlay, setMatchSkillsOpen, setSearch, showHeldJobs, toggleQueue, toggleStar, undoLastFilter, updatedAgo } from "./store";
import { PHONE, SENIORITY_LABELS, WORKPLACE_LABELS, ageDays, companyDomain, companyLabel, fmtInt, fmtPostedAgo, isReposted, monogram, salarySource, useMedia,
  type Job } from "./util";

export const tag = "inline-flex max-w-full items-center rounded-sm border px-1.5 font-ui text-xs leading-[18px]";

export function Logo({ domain, resolved, size, className = "" }: { domain?: string; resolved?: string | null; size: number; className?: string }) {
  const mono = monogram(domain);
  const cls = cn("shrink-0 rounded-sm object-contain", className);
  if (resolved === "" || !domain) return <img className={cn(cls, "outline outline-border -outline-offset-1")} src={mono} alt="" width={size} height={size} />;
  return <img className={cls} src={`/logo/${encodeURIComponent(domain)}.png`} alt="" width={size} height={size} loading="lazy"
    onError={(e) => { const img = e.currentTarget; img.onerror = null; img.src = mono; }} />;
}

// The search words, one pattern for every row (VirtualRows builds it once a render).
function highlightPattern() {
  const terms = [...searchTermsInPlay(), ...U.searchRelated].filter((t) => t.length > 1);
  return terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|");
}
function highlightRe(pattern: string) {
  if (!pattern) return null;
  try { return new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})`, "giu"); } catch { return null; }
}

// The search words inside a row's text, from the start of a word.
function Highlight({ text, re }: { text?: string | null; re: RegExp | null }) {
  const safe = text ?? "";
  if (!re || !safe) return <>{safe}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of safe.matchAll(re)) {
    const i = m.index!;
    if (i > last) out.push(safe.slice(last, i));
    out.push(<mark key={i} className="rounded-xs bg-accent text-inherit">{m[0]}</mark>);
    last = i + m[0].length;
  }
  if (last < safe.length) out.push(safe.slice(last));
  return <>{out}</>;
}

export function SalaryChip({ j }: { j: Job }) {
  if (!j.salary_text) return null;
  const { estimate, note } = salarySource(j);
  return (
    <span title={note} className="inline-flex shrink-0 items-center gap-1 font-ui text-xs font-semibold text-foreground">
      {estimate ? <span className="font-normal">Est.</span> : null}{j.salary_text}
    </span>
  );
}

export function SkillChips({ j, limit = 3 }: { j: Job; limit?: number }) {
  return (
    <>
      {(j.skills || "").split(",").filter(Boolean).slice(0, limit).map((s) => (
        <button key={s} type="button" title={`Search for ${s}`} onClick={(e) => { e.stopPropagation(); searchSkill(s); }}
          className={cn(tag, "cursor-pointer bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground")}>
          <span className="truncate">{s}</span>
        </button>
      ))}
    </>
  );
}

function MatchLine({ j, matched }: { j: Job; matched: Set<string> }) {
  const listed = (j.skills || "").split(",").filter(Boolean);
  const hits = listed.filter((sk) => matched.has(sk));
  const asks = listed.filter((sk) => !matched.has(sk));
  const summary = `${hits.length} of ${matched.size}` + (asks.length ? ` · missing ${asks.join(", ")}` : "");
  return (
    <>
      <SalaryChip j={j} />
      {hits.slice(0, 3).map((sk) => <span key={sk} className={cn(tag, "gap-1 border-ring text-foreground")}><Check size={10} aria-hidden="true" />{sk}</span>)}
      <span className="min-w-0 truncate font-ui text-xs text-muted-foreground" title={summary}>{summary}</span>
    </>
  );
}

// The sites an automatic run can apply on (api/apply.py FILLABLE_ATS).
const FILLABLE_ATS = new Set(["greenhouse", "ashby", "workable", "workday", "smartrecruiters", "bamboohr", "jazzhr", "recruitee", "lever", "teamtailor", "pinpoint", "breezy", "personio", "comeet"]);
export function QueueButton({ job, label }: { job: Job; label?: boolean }) {
  if (!FILLABLE_ATS.has(job.ats || "") || U.appliedAt.has(job.id)) return null;
  const on = U.queue.has(job.id);
  return (
    <Button variant="outline" size={label ? "default" : "icon"} aria-pressed={on} title="Queue for auto apply" aria-label={label ? undefined : "Queue for auto apply"}
      className={cn("font-normal", on && "border-primary bg-primary text-primary-foreground")} onClick={(e) => { e.stopPropagation(); toggleQueue(job.id); }}>
      <Lightning weight={on ? "fill" : "regular"} />{label ? (on ? "Queued" : "Auto apply") : null}
    </Button>
  );
}

// The picked countries' codes and names, lowercased, one a line: a string, so Row's memo compares it.
const wantedPlaces = () => F.country.flatMap((c) => [c.toLowerCase(), (U.facets.locations.find((x) => x.value === c)?.label || "").toLowerCase()]).filter(Boolean).join("\n");

function PlaceLine({ j, re, wanted }: { j: Job; re: RegExp | null; wanted: string }) {
  const parts: ReactNode[] = [];
  if (j.location) {
    const places = String(j.location).split(/\s*;\s*|\s*\|\s*/).filter(Boolean);
    if (places.length < 2) parts.push(<Highlight key="l" text={j.location} re={re} />);
    else {
      const want = wanted ? wanted.split("\n") : [];
      const pick = places.find((p) => want.some((w) => p.toLowerCase().includes(w))) || places[0];
      parts.push(<span key="l" title={places.join("; ")}><Highlight text={pick} re={re} /> + {places.length - 1} more</span>);
    }
  }
  if (j.workplace_type) parts.push(<span key="w">{WORKPLACE_LABELS[j.workplace_type] || j.workplace_type}</span>);
  return <>{parts.flatMap((p, i) => (i ? [" · ", p] : [p]))}</>;
}

// Memoized: a store emit re-renders the list, and only rows whose props changed redraw.
type RowProps = { j: Job; index: number; size: number; selected: boolean; starred: boolean; applied: string | null; re: RegExp | null;
  matched: Set<string>; wanted: string; signed: boolean };
const Row = memo(function Row({ j, index, size, selected, starred, applied, re, matched, wanted, signed }: RowProps) {
  const age = ageDays(j.posted_at);
  const fresh = age !== null && age <= 3 && !isReposted(j);
  const domain = companyDomain(j);
  const ageText = applied || fmtPostedAgo(j, age);
  const ageCls = applied || fresh ? "font-semibold text-foreground" : "text-muted-foreground";
  const open = () => openJobAndPush(j.id);
  return (
    <div data-id={j.id} data-row-id={j.id} role="listitem" aria-posinset={index + 1} aria-setsize={size} aria-current={selected || undefined}
      onClick={(e) => { if ((e.target as HTMLElement).closest("a, button")) return; open(); }}
      className={cn("grid cursor-pointer grid-cols-[40px_minmax(0,1fr)_28px] gap-x-3 border-b px-4 py-3.5 min-[801px]:min-h-[84px] min-[801px]:grid-cols-[44px_minmax(0,1fr)_auto] min-[801px]:border-b-0 min-[801px]:border-l-[3px] min-[801px]:border-l-transparent min-[801px]:py-3 min-[801px]:pl-[13px]",
        selected ? "bg-accent min-[801px]:border-l-foreground" : "hover:bg-muted")}>
      <Logo domain={j.company_domain} resolved={j.logo_url} size={44} className="size-10 self-start min-[801px]:size-11" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="min-w-0 font-ui leading-[1.35]">
          <a href={`/job/${encodeURIComponent(j.id)}`} title={j.title} className="text-[15px] font-semibold text-foreground no-underline hover:underline focus-visible:rounded-xs max-[800px]:line-clamp-2"
            onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); open(); }}>
            <Highlight text={j.title} re={re} />
          </a>
          {j.seniority ? <span className={cn(tag, "ml-1.5 border-[1.5px] border-foreground/30 align-[2px] font-semibold text-foreground")}>{SENIORITY_LABELS[j.seniority] || j.seniority}</span> : null}
          {j.confidence === "best_effort" ? <span title="Read from the company's careers page, so it may be out of date." className={cn(tag, "ml-1.5 align-[2px] text-muted-foreground")}>Unverified</span> : null}
          {j.closed_at ? <span title="This job is no longer open" className={cn(tag, "ml-1.5 align-[2px] text-muted-foreground")}>Closed</span> : null}
        </div>
        <div className="min-w-0 truncate font-ui text-sm text-foreground max-[800px]:text-[13px]">
          {domain ? <a href={`/company/${encodeURIComponent(domain)}`} title={`Every open job at ${companyLabel(j)}`} className="text-foreground no-underline hover:underline"><Highlight text={companyLabel(j)} re={re} /></a>
            : <Highlight text={companyLabel(j)} re={re} />}
          {j.department ? <> · <Highlight text={j.department} re={re} /></> : null}
          <span className="text-muted-foreground max-[800px]:hidden">{j.location || j.workplace_type ? " · " : ""}<PlaceLine j={j} re={re} wanted={wanted} /></span>
        </div>
        <div className={cn("flex min-w-0 items-center gap-2", !(matched.size || j.salary_text || j.skills) && "min-[801px]:hidden")}>
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            {matched.size ? <MatchLine j={j} matched={matched} /> : <><SalaryChip j={j} /><SkillChips j={j} /></>}
          </span>
          <span className={cn("shrink-0 pl-2 font-ui text-xs min-[801px]:hidden", ageCls)}>{ageText}</span>
        </div>
      </div>
      <div className={cn("hidden self-start pt-0.5 text-right font-ui text-[13px] whitespace-nowrap min-[801px]:block", ageCls)}>{ageText}</div>
      <button type="button" aria-pressed={starred} aria-label={`${starred ? "Saved" : "Save"} ${j.title}`} title={signed ? "Save to your account" : "Save (this browser only)"}
        onClick={(e) => { e.stopPropagation(); toggleStar(j.id); }}
        className={cn("grid size-7 cursor-pointer place-items-center self-start rounded-sm min-[801px]:hidden", starred ? "text-[var(--ooj-green-text)]" : "text-muted-foreground hover:text-foreground")}>
        <Star size={18} weight={starred ? "fill" : "regular"} />
      </button>
    </div>
  );
});

// One bone row, the real row's shape, so nothing moves when rows land.
function Bones({ n }: { n: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="grid grid-cols-[40px_minmax(0,1fr)_28px] gap-x-3 border-b px-4 py-3.5 min-[801px]:min-h-[84px] min-[801px]:grid-cols-[44px_minmax(0,1fr)_auto] min-[801px]:border-b-0 min-[801px]:py-3">
          <Skeleton className="size-10 min-[801px]:size-11" />
          <div className="flex flex-col gap-2 pt-0.5"><Skeleton className="h-3.5 w-3/5" /><Skeleton className="h-3 w-2/5" /><Skeleton className="h-3 w-1/4" /></div>
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const e = U.empty!;
  const box = (title: string, text?: ReactNode, actions?: ReactNode) => (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center font-ui" id="jobs-empty">
      <strong className="text-base text-foreground">{title}</strong>
      {text ? <p className="m-0 text-sm text-muted-foreground">{text}</p> : null}
      {actions ? <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
  if (e.saved === "none") return box("No saved jobs yet", "Save a job to find it here.");
  if (e.saved === "gone") return box("No saved jobs to show", "The jobs you saved are no longer on the board.");
  const last = lastAppliedFilter();
  const act = (key: string, label: string, run: () => void) => <Button key={key} variant="outline" size="sm" onClick={run}>{label}</Button>;
  if (e.search) {
    const { terms, mode } = e.search;
    const actions: ReactNode[] = [];
    if (mode === "all" && terms.length > 1) {
      actions.push(act("any", "Search any of these words", () => setSearch({ mode: "any" })));
      for (const term of terms.slice(-2).reverse()) {
        actions.push(act(`drop:${term}`, `Without ${term}`, () => {
          const kept = searchTermsInPlay().filter((t) => t !== term.toLowerCase()).map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" ");
          setSearch({ search: kept });
        }));
      }
    }
    actions.push(act("clear", "Clear the search", () => setSearch({ search: "", mode: "", exact: "" })));
    if (last && !last.label.startsWith('"')) actions.push(act("undo", `Remove ${last.label}`, undoLastFilter));
    return box("No results", `${mode === "any" ? "No job mentions any of these words" : `No job has all ${terms.length} of these words`}: ${terms.join(" · ")}`, actions);
  }
  return box("No results", undefined, last ? act("undo", `Remove ${last.label}`, undoLastFilter) : undefined);
}

// Words past the cap, and whether related roles are in.
export function SearchNotice() {
  const info = U.jobs?.search;
  if (!info || F.starred_only) return null;
  const ignored = info.ignored || [];
  const related = (!info.exact && info.expanded) || [];
  const exact = info.exact && (info.terms || []).length;
  if (!ignored.length && !related.length && !exact) return null;
  const link = "cursor-pointer font-semibold text-[var(--ooj-green-text)] underline-offset-2 hover:underline";
  return (
    <div id="search-notice" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-2 font-ui text-[13px] text-muted-foreground">
      {ignored.length ? <span>Searching the first {MAX_SEARCH_TERMS} words. Not used: {ignored.join(" · ")}</span> : null}
      {related.length ? <><span title={`Also matching ${related.join(", ")}.`}>Also showing related jobs.</span><button type="button" className={link} onClick={() => setSearch({ exact: "1" })}>Show exact matches only</button></> : null}
      {exact ? <><span>Showing exact matches only.</span><button type="button" className={link} onClick={() => setSearch({ exact: "" })}>Include related jobs</button></> : null}
    </div>
  );
}

// Best matches: the skills the order is built from.
export function MatchPanel() {
  const link = "font-semibold text-[var(--ooj-green-text)] underline-offset-2 hover:underline";
  if (U.matchPrompt && !F.skills.length) {
    return (
      <div id="match-panel" className="border-b px-5 py-2.5 font-ui text-sm text-muted-foreground">
        Best matches orders jobs by the skills on your resume.{" "}
        {signedIn() ? <a className={link} href="/account#skills">Add your resume</a>
          : <><button type="button" className={cn(link, "cursor-pointer")} onClick={requestSignIn}>Log in</button>, then add your resume on your account page.</>}
      </div>
    );
  }
  if (!F.skills.length || F.starred_only) return null;
  const open = U.matchSkillsOpen;
  return (
    <div id="match-panel" className="border-b px-5 py-2.5 font-ui">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="button" aria-expanded={open} aria-controls="match-skills" onClick={() => setMatchSkillsOpen(!open)}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-foreground/30 px-3 py-0.5 font-semibold text-foreground hover:bg-muted">
          My skills <span className="tabular-nums text-muted-foreground">{F.skills.length}</span><CaretDown size={12} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
        <span className="text-muted-foreground" title="Jobs that share at least one of your resume skills, ordered by how many. Newer jobs count higher, and every two weeks since posting counts as one skill fewer.">Ranked by resume skills</span>
        <a className={cn(link, "ml-auto")} href="/account#skills">Edit skills</a>
      </div>
      {open ? (
        <div id="match-skills" className="mt-2 flex flex-wrap gap-1.5">
          {F.skills.map((s) => (
            <button key={s} type="button" title={`Stop matching on ${s}`} onClick={() => dropSkill(s)}
              className={cn(tag, "cursor-pointer gap-1 bg-transparent text-foreground hover:bg-muted")}>{s} <span aria-hidden="true">✕</span></button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CountLine() {
  const data = U.jobs;
  const updated = updatedAgo();
  const title = "font-display text-[17px] font-medium text-foreground [&_b]:font-medium [&_b]:tabular-nums";
  if (U.skeleton) return <span className="flex flex-col gap-1.5" aria-hidden="true"><Skeleton className="h-4 w-36" /><Skeleton className="h-3 w-48" /></span>;
  if (F.starred_only) return <span id="result-count" className={title}>{data?.jobs.length ? <><b>{fmtInt(data.jobs.length)}</b> saved</> : ""}</span>;
  if (!data || !data.jobs.length) {
    return <span className="flex flex-col"><span id="result-count" className={title}>No {resultNoun()}</span><span id="result-sub" className="font-ui text-xs text-muted-foreground">{updated}</span></span>;
  }
  const total = data.total;
  const shown = data.jobs.length;
  const to = total == null ? shown : Math.min(shown, total);
  return (
    <span className="flex min-w-0 flex-col">
      <span id="result-count" className={cn(title, "truncate")}>{total == null ? <><b>{fmtInt(shown)}+</b> {resultNoun()}</> : <><b>{fmtInt(total)}</b> {resultNoun()}</>}</span>
      <span id="result-sub" className="truncate font-ui text-xs text-muted-foreground">{[`Showing 1–${to}`, updated].filter(Boolean).join(" · ")}</span>
    </span>
  );
}

// Rows fill the space under the head; the virtualizer only needs to know
// where they start inside the thing that scrolls.
function useRowsStart(rows: React.RefObject<HTMLDivElement | null>, scroller: () => Element | null) {
  const [start, setStart] = useState(0);
  const measure = () => {
    const el = rows.current;
    if (!el) return;
    const s = scroller();
    const top = s ? el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop : el.getBoundingClientRect().top + window.scrollY;
    setStart(Math.round(top));
  };
  const latest = useRef(measure);
  latest.current = measure;
  // Every render: a banner or the phone's chips above move the rows without resizing what the observer watches.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const el = rows.current;
    if (!el) return;
    const ro = new ResizeObserver(() => latest.current());
    ro.observe(el.parentElement || el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return start;
}

function VirtualRows({ jobs, v, start }: { jobs: Job[]; v: Virtualizer<any, Element>; start: number }) {
  const items = v.getVirtualItems();
  // The next page is asked for while the last rows are still a screen away.
  const last = items[items.length - 1];
  useEffect(() => { if (last && last.index >= jobs.length - 8 && moreAvailable()) loadMoreJobs(); }, [last?.index, jobs.length]);
  const pattern = highlightPattern();
  const re = useMemo(() => highlightRe(pattern), [pattern]);
  const wanted = wantedPlaces();
  const signed = signedIn();
  const size = U.jobs?.total ?? jobs.length;
  useEffect(() => {
    dom.reveal = (id) => {
      const i = jobs.findIndex((j) => j.id === id);
      if (i >= 0) v.scrollToIndex(i, { align: "auto" });
    };
    return () => { dom.reveal = null; };
  }, [jobs, v]);
  return (
    <div id="jobs-body" role="list" aria-label="Jobs" className="relative" style={{ height: v.getTotalSize() }}>
      {items.map((it) => {
        const j = jobs[it.index];
        return (
          <div key={j.id} data-index={it.index} ref={v.measureElement} className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${it.start - start}px)` }}>
            <Row j={j} index={it.index} size={size} selected={j.id === U.selected} starred={U.starred.has(j.id)} applied={appliedLabel(j.id)}
              re={re} matched={U.matchedSkills} wanted={wanted} signed={signed} />
          </div>
        );
      })}
    </div>
  );
}

const ROW_ESTIMATE = 92;
function BoxRows({ jobs, scroller }: { jobs: Job[]; scroller: React.RefObject<HTMLElement | null> }) {
  const rows = useRef<HTMLDivElement>(null);
  const start = useRowsStart(rows, () => scroller.current);
  const v = useVirtualizer({ count: jobs.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_ESTIMATE, overscan: 6,
    scrollMargin: start, getItemKey: (i) => jobs[i].id, scrollPaddingStart: 72 });
  return <div ref={rows}><VirtualRows jobs={jobs} v={v} start={start} /></div>;
}
function PageRows({ jobs }: { jobs: Job[] }) {
  const rows = useRef<HTMLDivElement>(null);
  const start = useRowsStart(rows, () => null);
  const v = useWindowVirtualizer({ count: jobs.length, estimateSize: () => 104, overscan: 6, scrollMargin: start, getItemKey: (i) => jobs[i].id,
    scrollPaddingStart: 72, scrollPaddingEnd: 80 });
  return <div ref={rows}><VirtualRows jobs={jobs} v={v as unknown as Virtualizer<any, Element>} start={start} /></div>;
}

export function List() {
  const box = useRef<HTMLElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const phone = useMedia(PHONE);
  useEffect(() => { dom.list = phone ? null : box.current; dom.rows = rows.current; return () => { dom.list = null; dom.rows = null; }; }, [phone]);
  const jobs = U.jobs?.jobs || [];
  return (
    <section ref={box} aria-label="Job list" className="quiet-scroll relative flex min-h-0 flex-col min-[801px]:overflow-y-auto min-[801px]:rounded-t-lg min-[801px]:border min-[801px]:border-b-0 min-[801px]:bg-card">
      <div data-list-head className="sticky top-0 z-10 hidden items-center justify-between gap-3 border-b bg-card px-5 py-3 min-[801px]:flex">
        <div aria-live="polite" className="min-w-0"><CountLine /></div>
        <div className="flex items-center gap-2"><DateSelect /><SortSelect /></div>
      </div>
      <MatchPanel />
      <SearchNotice />
      {U.held ? (
        <div className="sticky top-[72px] z-10 flex h-0 justify-center overflow-visible">
          <Button size="sm" className="mt-2 rounded-full" onClick={() => showHeldJobs()}>{fmtInt(U.held)} new {U.held === 1 ? "job" : "jobs"} · Show</Button>
        </div>
      ) : null}
      {U.error ? (
        <div id="jobs-error" role="status" aria-live="polite" className="m-4 flex flex-wrap items-center gap-3 rounded-md border border-destructive px-3 py-2 font-ui text-sm text-destructive">
          <span>{U.error.text}</span>
          {U.error.retry ? <Button size="xs" variant="outline" onClick={() => { clearError(); loadJobs(); }}>Try again</Button>
            : <Button size="xs" variant="ghost" onClick={clearError}>Dismiss</Button>}
        </div>
      ) : null}
      <div ref={rows} className="min-[801px]:pb-2">
        {U.skeleton ? <><span id="jobs-loading" className="sr-only" role="status">Loading jobs</span><Bones n={16} /></>
          : U.empty ? <EmptyState />
          : !jobs.length ? null
          : phone ? <PageRows jobs={jobs} /> : <BoxRows jobs={jobs} scroller={box} />}
      </div>
      <div id="jobs-more" className={cn("flex justify-center p-3", !moreAvailable() && "hidden")}>
        <Button id="jobs-more-btn" variant="outline" size="sm" disabled={U.loadingMore} onClick={loadMoreJobs}>{U.loadingMore ? "Loading…" : "Load more"}</Button>
      </div>
    </section>
  );
}
