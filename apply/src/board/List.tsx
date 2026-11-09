// The list column: the count line with the sort, the rows, the empty and
// error states, the search notice, the Best matches panel, the held
// "new jobs" button, and the Load more the observer presses.
import { useEffect, useRef, type ReactNode } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { CaretDown, Check, Lightning, MagnifyingGlass, Star } from "@phosphor-icons/react";
import { requestSignIn } from "../site/auth";
import { signedIn } from "../api";
import { DateSelect, SortSelect } from "./Filters";
import { F, MAX_SEARCH_TERMS, PAGE_SIZE, U, appliedLabel, clearError, dom, dropSkill, loadJobs, loadMoreJobs, moreAvailable, openJobAndPush, resultNoun, searchSkill,
  searchTermsInPlay, setMatchSkillsOpen, setSearch, showHeldJobs, toggleQueue, toggleStar, undoLastFilter, updatedAgo, lastAppliedFilter } from "./store";
import { SENIORITY_LABELS, WORKPLACE_LABELS, ageDays, cityName, companyDomain, companyLabel, fmtInt, fmtPostedAgo, isPhone, isReposted, monogram, safeHref,
  salarySource, type Job } from "./util";

export function Logo({ domain, resolved, size, className = "" }: { domain?: string; resolved?: string | null; size: number; className?: string }) {
  const mono = monogram(domain);
  const cls = `shrink-0 rounded-[4px] bg-white object-contain ring-1 ring-kumo-hairline ${className}`;
  if (resolved === "" || !domain) return <img className={cls} src={mono} alt="" width={size} height={size} />;
  return <img className={cls} src={`/logo/${encodeURIComponent(domain)}.png`} alt="" width={size} height={size} loading="lazy"
    onError={(e) => { const img = e.currentTarget; img.onerror = null; img.src = mono; }} />;
}

// Marks the search words inside a row's text, from the start of a word.
function Highlight({ text }: { text?: string | null }) {
  const safe = text ?? "";
  const terms = [...searchTermsInPlay(), ...U.searchRelated].filter((t) => t.length > 1);
  if (!terms.length || !safe) return <>{safe}</>;
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|");
  let re: RegExp;
  try { re = new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})`, "giu"); } catch { return <>{safe}</>; }
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of safe.matchAll(re)) {
    const i = m.index!;
    if (i > last) out.push(safe.slice(last, i));
    out.push(<mark key={i} className="rounded-[2px] bg-kumo-success-tint text-inherit">{m[0]}</mark>);
    last = i + m[0].length;
  }
  if (last < safe.length) out.push(safe.slice(last));
  return <>{out}</>;
}

export function SalaryChip({ j, className = "" }: { j: Job; className?: string }) {
  if (!j.salary_text) return null;
  const { estimate, note } = salarySource(j);
  return (
    <span title={note} className={`inline-flex max-w-full items-center gap-1 rounded-[4px] border border-kumo-brand px-1.5 py-px text-xs ${estimate ? "" : "bg-kumo-success-tint"} ${className}`}>
      {estimate ? <span className="text-kumo-default">Est.</span> : null}
      <span className="truncate font-medium text-kumo-brand">{j.salary_text}</span>
    </span>
  );
}

const ROW_SKILLS_SHOWN = 3;
export function SkillChips({ j, limit = ROW_SKILLS_SHOWN }: { j: Job; limit?: number }) {
  return (
    <>
      {(j.skills || "").split(",").filter(Boolean).slice(0, limit).map((s) => (
        <button key={s} type="button" title={`Search for ${s}`} onClick={(e) => { e.stopPropagation(); searchSkill(s); }}
          className="inline-flex max-w-full cursor-pointer items-center rounded-[4px] border border-kumo-hairline bg-transparent px-1.5 py-px text-xs text-kumo-subtle hover:bg-kumo-tint">
          <span className="truncate">{s}</span>
        </button>
      ))}
    </>
  );
}

function MatchLine({ j }: { j: Job }) {
  const listed = (j.skills || "").split(",").filter(Boolean);
  const hits = listed.filter((sk) => U.matchedSkills.has(sk));
  const asks = listed.filter((sk) => !U.matchedSkills.has(sk));
  const summary = `${hits.length} of ${U.matchedSkills.size}` + (asks.length ? ` · missing ${asks.join(", ")}` : "");
  return (
    <>
      <SalaryChip j={j} />
      {hits.slice(0, 3).map((sk) => (
        <span key={sk} className="inline-flex items-center gap-1 rounded-[4px] border border-kumo-brand px-1.5 py-px text-xs text-kumo-brand"><Check size={10} aria-hidden="true" />{sk}</span>
      ))}
      <span className="min-w-0 truncate text-xs text-kumo-subtle" title={summary}>{summary}</span>
    </>
  );
}

// The sites an automatic run can apply on (api/apply.py FILLABLE_ATS).
const FILLABLE_ATS = new Set(["greenhouse", "ashby", "workable", "workday", "smartrecruiters", "bamboohr", "jazzhr", "recruitee", "lever", "teamtailor", "pinpoint", "breezy", "personio", "comeet"]);
export function QueueButton({ job, label }: { job: Job; label?: boolean }) {
  if (!FILLABLE_ATS.has(job.ats || "") || U.appliedAt.has(job.id)) return null;
  const on = U.queue.has(job.id);
  return (
    <Button variant={on ? "primary" : "secondary"} size="sm" shape={label ? "base" : "square"} aria-pressed={on} title="Queue for auto apply" aria-label="Queue for auto apply"
      icon={<Lightning weight={on ? "fill" : "regular"} />} onClick={(e) => { e.stopPropagation(); toggleQueue(job.id); }}>
      {label ? (on ? "Queued" : "Auto apply") : ""}
    </Button>
  );
}

function PlaceLine({ j }: { j: Job }) {
  const parts: ReactNode[] = [];
  if (j.location) {
    const places = String(j.location).split(/\s*;\s*|\s*\|\s*/).filter(Boolean);
    if (places.length < 2) parts.push(<Highlight key="l" text={j.location} />);
    else {
      const wanted = F.country.flatMap((c) => [c.toLowerCase(), (U.facets.locations.find((x) => x.value === c)?.label || "").toLowerCase()]).filter(Boolean);
      const pick = places.find((p) => wanted.some((w) => p.toLowerCase().includes(w))) || places[0];
      parts.push(<span key="l" title={places.join("; ")}><Highlight text={pick} /> + {places.length - 1} more</span>);
    }
  }
  if (j.workplace_type) parts.push(<span key="w">{WORKPLACE_LABELS[j.workplace_type] || j.workplace_type}</span>);
  return <>{parts.flatMap((p, i) => (i ? [" · ", p] : [p]))}</>;
}

function Row({ j }: { j: Job }) {
  const age = ageDays(j.posted_at);
  const fresh = age !== null && age <= 3 && !isReposted(j);
  const starred = U.starred.has(j.id);
  const applied = appliedLabel(j.id);
  const selected = j.id === U.selected;
  const domain = companyDomain(j);
  const ageText = applied || fmtPostedAgo(j, age);
  const ageCls = applied ? "text-kumo-brand" : fresh ? "text-kumo-brand" : "text-kumo-subtle";
  const open = () => openJobAndPush(j.id);
  return (
    <div data-row-id={j.id} role="button" tabIndex={0} aria-label={`${j.title}, ${companyLabel(j)}`}
      onClick={(e) => { const t = e.target as HTMLElement; if (t.closest("a, button")) return; open(); }}
      onKeyDown={(e) => { if (e.key !== "Enter" && e.key !== " ") return; if ((e.target as HTMLElement).closest("a, button")) return; e.preventDefault(); open(); }}
      className={`grid cursor-pointer grid-cols-[28px_44px_minmax(0,1fr)] gap-x-3 border-b border-kumo-hairline px-3 py-2.5 outline-none focus-visible:bg-kumo-tint min-[801px]:grid-cols-[28px_44px_minmax(0,1fr)_auto]
        ${selected ? "bg-kumo-success-tint" : "hover:bg-kumo-tint"}`}>
      <button type="button" aria-pressed={starred} aria-label={`${starred ? "Saved" : "Save"} ${j.title}`} title={signedIn() ? "Save to your account" : "Save (this browser only)"}
        onClick={(e) => { e.stopPropagation(); toggleStar(j.id); }}
        className={`-ml-1 grid h-7 w-7 cursor-pointer place-items-center self-start rounded-[4px] border-0 bg-transparent ${starred ? "text-kumo-brand" : "text-kumo-inactive hover:text-kumo-default"}`}>
        <Star size={16} weight={starred ? "fill" : "regular"} />
      </button>
      <Logo domain={j.company_domain} resolved={j.logo_url} size={44} className="self-start" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <a href={`/job/${encodeURIComponent(j.id)}`} title={j.title} className="min-w-0 truncate font-medium text-kumo-strong no-underline hover:underline"
            onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); open(); }}>
            <Highlight text={j.title} />
          </a>
          {j.seniority ? <Badge variant="outline">{SENIORITY_LABELS[j.seniority] || j.seniority}</Badge> : null}
          {j.confidence === "best_effort" ? <span title="Read from the company's careers page, so it may be out of date."><Badge variant="warning">Unverified</Badge></span> : null}
          {j.closed_at ? <span title="This job is no longer open"><Badge variant="neutral">Closed</Badge></span> : null}
        </div>
        <div className="flex min-w-0 items-baseline gap-1 text-sm">
          <span className="min-w-0 truncate">
            {domain ? <a href={`/company/${encodeURIComponent(domain)}`} title={`Every open job at ${companyLabel(j)}`} className="font-medium text-kumo-default no-underline hover:underline"><Highlight text={companyLabel(j)} /></a>
              : <span className="font-medium text-kumo-default"><Highlight text={companyLabel(j)} /></span>}
            {j.department ? <span className="text-kumo-subtle"> · <Highlight text={j.department} /></span> : null}
          </span>
          <span className={`shrink-0 text-xs min-[801px]:hidden ${ageCls}`}> · {ageText}</span>
        </div>
        <div className="truncate text-sm text-kumo-subtle"><PlaceLine j={j} /></div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {U.matchedSkills.size ? <MatchLine j={j} /> : <><SalaryChip j={j} /><SkillChips j={j} /></>}
        </div>
      </div>
      <div className={`hidden self-start pt-0.5 text-right font-mono text-xs min-[801px]:block ${ageCls}`}>{ageText}</div>
    </div>
  );
}

function Bones({ n }: { n: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="grid grid-cols-[28px_44px_minmax(0,1fr)_auto] gap-x-3 border-b border-kumo-hairline px-3 py-2.5">
          <span />
          <SkeletonLine blockHeight={44} minWidth={44} maxWidth={44} />
          <div className="flex flex-col gap-1.5"><SkeletonLine minWidth={40} maxWidth={70} /><SkeletonLine minWidth={30} maxWidth={50} /><SkeletonLine minWidth={20} maxWidth={40} /></div>
          <SkeletonLine minWidth={8} maxWidth={8} />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const e = U.empty!;
  if (e.saved === "none") return <Empty size="sm" icon={<Star size={32} className="text-kumo-inactive" />} title="No saved jobs yet" description="Save a job to find it here." />;
  if (e.saved === "gone") return <Empty size="sm" icon={<Star size={32} className="text-kumo-inactive" />} title="No saved jobs to show" description="The jobs you saved are no longer on the board." />;
  const last = lastAppliedFilter();
  if (e.search) {
    const { terms, mode } = e.search;
    const actions: ReactNode[] = [];
    if (mode === "all" && terms.length > 1) {
      actions.push(<Button key="any" variant="secondary" size="sm" onClick={() => setSearch({ mode: "any" })}>Search any of these words</Button>);
      for (const term of terms.slice(-2).reverse()) {
        actions.push(<Button key={`drop:${term}`} variant="secondary" size="sm" onClick={() => {
          const kept = searchTermsInPlay().filter((t) => t !== term.toLowerCase()).map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" ");
          setSearch({ search: kept });
        }}>Without {term}</Button>);
      }
    }
    actions.push(<Button key="clear" variant="secondary" size="sm" onClick={() => setSearch({ search: "", mode: "", exact: "" })}>Clear the search</Button>);
    if (last && !last.label.startsWith('"')) actions.push(<Button key="undo" variant="secondary" size="sm" onClick={undoLastFilter}>Remove {last.label}</Button>);
    return (
      <Empty size="sm" icon={<MagnifyingGlass size={32} className="text-kumo-inactive" />} title="No results"
        description={`${mode === "any" ? "No job mentions any of these words" : `No job has all ${terms.length} of these words`}: ${terms.join(" · ")}`}
        contents={<div className="flex flex-wrap justify-center gap-2">{actions}</div>} />
    );
  }
  return (
    <Empty size="sm" icon={<MagnifyingGlass size={32} className="text-kumo-inactive" />} title="No results"
      contents={last ? <Button variant="secondary" size="sm" onClick={undoLastFilter}>Remove {last.label}</Button> : undefined} />
  );
}

// Words past the cap, and whether related roles are in.
export function SearchNotice() {
  const info = U.jobs?.search;
  if (!info || F.starred_only) return null;
  const ignored = info.ignored || [];
  const related = (!info.exact && info.expanded) || [];
  const exact = info.exact && (info.terms || []).length;
  if (!ignored.length && !related.length && !exact) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-hairline px-3 py-1.5 text-xs text-kumo-subtle">
      {ignored.length ? <span>Searching the first {MAX_SEARCH_TERMS} words. Not used: {ignored.join(" · ")}</span> : null}
      {related.length ? <><span title={`Also matching ${related.join(", ")}.`}>Also showing related jobs.</span><Button variant="ghost" size="xs" onClick={() => setSearch({ exact: "1" })}>Show exact matches only</Button></> : null}
      {exact ? <><span>Showing exact matches only.</span><Button variant="ghost" size="xs" onClick={() => setSearch({ exact: "" })}>Include related jobs</Button></> : null}
    </div>
  );
}

// Best matches: the skills the order is built from.
export function MatchPanel() {
  if (U.matchPrompt && !F.skills.length) {
    return (
      <div className="border-b border-kumo-hairline px-3 py-2 text-sm text-kumo-subtle">
        Best matches orders jobs by the skills on your resume.{" "}
        {signedIn() ? <a className="text-kumo-link underline" href="/account/skills">Add your resume</a>
          : <><button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-kumo-link underline" onClick={requestSignIn}>Log in</button>, then add your resume on your account page.</>}
      </div>
    );
  }
  if (!F.skills.length || F.starred_only) return null;
  const open = U.matchSkillsOpen;
  return (
    <div className="border-b border-kumo-hairline px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button variant="ghost" size="xs" aria-expanded={open} aria-controls="match-skills" onClick={() => setMatchSkillsOpen(!open)}>
          My skills <Badge variant="secondary" className="ml-1">{F.skills.length}</Badge> <CaretDown size={12} className={open ? "rotate-180" : ""} aria-hidden="true" />
        </Button>
        <span className="text-kumo-subtle" title="Jobs that share at least one of your resume skills, ordered by how many. Newer jobs count higher, and every two weeks since posting counts as one skill fewer.">Ranked by resume skills</span>
        <a className="ml-auto text-kumo-link underline" href="/account/skills">Edit skills</a>
      </div>
      {open ? (
        <div id="match-skills" className="mt-1.5 flex flex-wrap gap-1">
          {F.skills.map((s) => (
            <button key={s} type="button" title={`Stop matching on ${s}`} onClick={() => dropSkill(s)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-[4px] border border-kumo-hairline bg-transparent px-1.5 py-px text-xs text-kumo-default hover:bg-kumo-tint">
              {s} <span aria-hidden="true">✕</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CountLine() {
  const data = U.jobs;
  const updated = updatedAgo();
  if (U.skeleton) return <div className="flex flex-col gap-1"><SkeletonLine minWidth={30} maxWidth={40} /><SkeletonLine minWidth={20} maxWidth={30} /></div>;
  if (F.starred_only) return <span className="text-sm text-kumo-strong">{data?.jobs.length ? <><b>{fmtInt(data.jobs.length)}</b> saved</> : ""}</span>;
  if (!data || !data.jobs.length) {
    return <span className="flex flex-col"><span className="text-sm text-kumo-strong">No {resultNoun()}</span><span className="text-xs text-kumo-subtle">{updated}</span></span>;
  }
  const total = data.total;
  const shown = data.jobs.length;
  const to = total == null ? shown : Math.min(shown, total);
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-sm text-kumo-strong">{total == null ? <><b>{fmtInt(shown)}+</b> {resultNoun()}</> : <><b className="text-kumo-brand">{fmtInt(total)}</b> {resultNoun()}</>}</span>
      <span className="truncate text-xs text-kumo-subtle">{[`Showing 1-${to}`, updated].filter(Boolean).join(" · ")}</span>
    </span>
  );
}

export function List() {
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => { dom.list = listRef.current; dom.rows = rowsRef.current; return () => { dom.list = null; dom.rows = null; }; }, []);
  // The next page is already arriving as the last rows come into view;
  // on a phone the page scrolls, not the list, so the viewport is the root.
  useEffect(() => {
    const el = moreRef.current;
    if (!el) return;
    let obs: IntersectionObserver | null = null;
    const wire = () => {
      obs?.disconnect();
      obs = new IntersectionObserver(([e]) => { if (e.isIntersecting && moreAvailable()) loadMoreJobs(); },
        { root: isPhone() ? null : listRef.current, rootMargin: "600px 0px" });
      obs.observe(el);
    };
    wire();
    const mq = matchMedia("(max-width: 800px)");
    mq.addEventListener("change", wire);
    return () => { obs?.disconnect(); mq.removeEventListener("change", wire); };
  }, []);
  const jobs = U.jobs?.jobs || [];
  const bones = Math.min(PAGE_SIZE, Math.max(16, jobs.length));
  return (
    <section ref={listRef} aria-label="Jobs" className="relative flex min-h-0 flex-col min-[1100px]:overflow-y-auto">
      <div data-list-head className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-kumo-hairline bg-kumo-canvas px-3 py-2">
        <div aria-live="polite" className="min-w-0"><CountLine /></div>
        <div className="hidden items-center gap-1.5 min-[801px]:flex"><DateSelect /><SortSelect /></div>
      </div>
      <MatchPanel />
      <SearchNotice />
      {U.held ? (
        <div className="sticky top-14 z-10 flex justify-center">
          <Button variant="primary" size="sm" className="-mt-px shadow-none" onClick={() => showHeldJobs()}>{fmtInt(U.held)} new {U.held === 1 ? "job" : "jobs"} · Show</Button>
        </div>
      ) : null}
      {U.error ? (
        <div className="p-3">
          <Banner variant="error" size="sm" title={U.error.text} action={U.error.retry ? <Button size="xs" variant="secondary" onClick={() => { clearError(); loadJobs(); }}>Try again</Button> : <Button size="xs" variant="ghost" onClick={clearError}>Dismiss</Button>} />
        </div>
      ) : null}
      <div ref={rowsRef}>
        {U.skeleton ? <><span className="sr-only" role="status">Loading jobs</span><Bones n={bones} /></>
          : U.empty ? <div className="p-4"><EmptyState /></div>
          : jobs.map((j) => <Row key={j.id} j={j} />)}
      </div>
      <div ref={moreRef} className={`flex justify-center p-3 ${moreAvailable() ? "" : "hidden"}`}>
        <Button variant="ghost" size="sm" loading={U.loadingMore} onClick={loadMoreJobs}>{U.loadingMore ? "Loading" : "Load more"}</Button>
      </div>
      {F.starred_only ? null : null}
      {cityName ? null : null}
    </section>
  );
}
