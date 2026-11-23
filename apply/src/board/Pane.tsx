// The detail pane: a column above 1100px, a sheet over the list below it,
// a screen of its own on a phone. With nothing open it says what the
// filters add up to. The Apply links keep the old class names, which
// count.js counts as apply clicks.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, CaretLeft, CaretRight, Copy, ShareNetwork, Star, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Logo, QueueButton, SkillChips, tag } from "./List";
import { F, U, activeFilterSummary, closeJobAndSync, companyLogoFor, companyNameFor, currentScopeMode, globalScope, jobPermalink, setCompany, stepJob, toggleStar } from "./store";
import { copyText } from "../home/copy";
import { PANE_SHEET, WORKPLACE_LABELS, ageDays, announce, companyLabel, fmtAgeAgo, fmtInt, isPhone, isReposted, safeHref, salarySource, useMedia, type Job, type Scope } from "./util";

const apply = "inline-flex h-[38px] items-center justify-center gap-1.5 rounded-md border-2 border-[var(--ooj-green-text)] bg-[var(--ooj-green-text)] px-4 font-ui text-[13px] font-bold text-[var(--ooj-paper)] no-underline hover:opacity-90";
const copyLink = (url: string) => copyText(url, () => announce("Link copied"));
const iconBtn = "grid size-8 cursor-pointer place-items-center rounded-sm text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";

function CopyButton({ text, square }: { text: string; square?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <Button variant={square ? "outline" : "ghost"} size={square ? "icon" : "default"} className="font-normal" aria-label="Copy a link to this job" title="Copy a link to this job"
      onClick={() => { copyLink(text); setDone(true); setTimeout(() => setDone(false), 1200); }}>
      {square ? <Copy /> : done ? "Copied" : "Copy link"}
    </Button>
  );
}

function StarButton({ job, square }: { job: Job; square?: boolean }) {
  const on = U.starred.has(job.id);
  return (
    <Button variant="outline" size={square ? "icon" : "default"} aria-pressed={on} aria-label={square ? (on ? "Saved" : "Save") : undefined}
      className={cn("font-normal", on && "border-[var(--ooj-green-text)] text-[var(--ooj-green-text)] hover:border-[var(--ooj-green-text)]")} onClick={() => toggleStar(job.id)}>
      <Star weight={on ? "fill" : "regular"} />{square ? null : on ? "Saved" : "Save"}
    </Button>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border px-3.5 py-2.5 odd:border-r max-[800px]:border-r-0 max-[800px]:px-0">
      <span className="font-ui text-sm text-foreground">{children}</span>
      <span className="font-ui text-xs font-semibold text-muted-foreground">{label}</span>
    </div>
  );
}

function Salary({ job }: { job: Job }) {
  if (!job.salary_text) return <>Undisclosed</>;
  const { estimate, note } = salarySource(job);
  return <span title={note}>{estimate ? "Est. " : null}{job.salary_text}</span>;
}

function Description({ d }: { d: NonNullable<typeof U.detail> }) {
  if (d.error) return <p className="m-0 font-ui text-sm text-destructive">Couldn't load the description. Select Apply to read it on the company's site.</p>;
  if (d.loading) return <div className="flex flex-col gap-2.5" role="status" aria-label="Loading description"><Skeleton className="h-3.5" /><Skeleton className="h-3.5" /><Skeleton className="h-3.5" /><Skeleton className="h-3.5 w-1/2" /></div>;
  const text = d.job?.description;
  if (!text) return <p className="m-0 text-[15px] text-body">This listing has no description. Select Apply to read it on the company's site.</p>;
  return (
    <div className="board-desc text-[15px] leading-relaxed text-body">
      {text.split("\n").map((line, i) => (line.startsWith("## ")
        ? <strong key={i} className="mt-3 block font-semibold text-foreground">{line.slice(3)}{"\n"}</strong>
        : <span key={i}>{line}{"\n"}</span>))}
    </div>
  );
}

function Body({ job, d, actionsRef }: { job: Job; d: NonNullable<typeof U.detail>; actionsRef: React.RefObject<HTMLDivElement | null> }) {
  const age = ageDays(job.posted_at);
  const applied = U.appliedAt.get(job.id);
  const href = safeHref(job.url);
  return (
    <div className="flex flex-col gap-4 px-5 py-6 max-[800px]:px-4 max-[800px]:pt-[18px] max-[800px]:pb-24">
      <div className="flex items-center gap-4">
        <Logo domain={job.company_domain} resolved={job.logo_url} size={52} />
        <div className="min-w-0 font-ui">
          <div className="truncate text-[15px] font-semibold text-foreground">{companyLabel(job)}</div>
          <div className="truncate text-sm text-muted-foreground">{job.location || "-"}</div>
        </div>
      </div>
      <h2 className="m-0 font-display text-[22px] leading-tight font-normal text-foreground max-[800px]:text-[26px]">
        {job.title}
        {job.confidence === "best_effort" ? <span className={cn(tag, "ml-2 align-middle text-muted-foreground")} title="Read from the company's careers page, so it may be out of date.">Unverified</span> : null}
        {job.closed_at ? <span className={cn(tag, "ml-2 align-middle text-muted-foreground")}>Closed</span> : null}
      </h2>
      <div ref={actionsRef} className="flex flex-wrap items-center gap-2 max-[800px]:hidden">
        <a className={cn("job-detail-apply", apply)} href={href} target="_blank" rel="noopener" title="Open the original listing to apply">Apply<ArrowUpRight size={12} weight="bold" aria-hidden="true" /></a>
        <StarButton job={job} />
        <QueueButton job={job} label />
        <CopyButton text={jobPermalink(job.id)} />
      </div>
      <div className="grid grid-cols-2 overflow-hidden rounded-sm border border-b-0 max-[800px]:gap-x-5 max-[800px]:rounded-none max-[800px]:border-x-0">
        <Fact label="Monthly salary"><Salary job={job} /></Fact>
        <Fact label="Posted">{age === null ? "Unreported" : isReposted(job) ? `Reposted ${fmtAgeAgo(age)} · first seen ${fmtAgeAgo(ageDays(job.first_seen))}` : fmtAgeAgo(age)}</Fact>
        {applied ? <Fact label="Applied"><span className="font-semibold text-[var(--ooj-green-text)]">Applied {fmtAgeAgo((Date.now() - new Date(applied).getTime()) / 86400000)}</span></Fact> : null}
        <Fact label="Department">{job.department || "-"}</Fact>
        <Fact label="Workplace">{job.workplace_type ? WORKPLACE_LABELS[job.workplace_type] || job.workplace_type : "-"}</Fact>
      </div>
      {job.skills ? <div className="flex flex-wrap gap-1.5"><SkillChips j={job} limit={100} /></div> : null}
      <h3 className="m-0 font-ui text-sm font-semibold text-foreground">About this job</h3>
      <Description d={d} />
      <a className="job-detail-source inline-flex items-center gap-1 self-start font-ui text-sm font-semibold text-[var(--ooj-green-text)] no-underline hover:underline" href={href} target="_blank" rel="noopener">
        View original posting<ArrowUpRight size={12} weight="bold" aria-hidden="true" />
      </a>
    </div>
  );
}

// What the filters add up to: four numbers with how they moved, and the
// employers with the most open jobs as a treemap.
const TREEMAP_N = 10;
const TREEMAP_RATIO = 1.15;
const TREE_MIN_W = 72;
const TREE_MIN_H = 56;
const TREE_LOGO_MIN_W = 100;
type Rect = { x: number; y: number; w: number; h: number };

function squarify(values: number[], x: number, y: number, w: number, h: number): Rect[] {
  const out: Rect[] = [];
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return out;
  const scale = (w * h) / total;
  let items = values.map((v, i) => ({ i, area: v * scale }));
  const worst = (row: typeof items, side: number) => {
    const s = row.reduce((a, r) => a + r.area, 0);
    const mx = Math.max(...row.map((r) => r.area)), mn = Math.min(...row.map((r) => r.area));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (items.length) {
    const side = Math.min(w, h);
    const row = [items[0]];
    let k = 1;
    while (k < items.length && worst([...row, items[k]], side) <= worst(row, side)) { row.push(items[k]); k++; }
    const s = row.reduce((a, r) => a + r.area, 0);
    if (w >= h) {
      const rw = s / h; let cy = y;
      row.forEach((r) => { const rh = r.area / rw; out[r.i] = { x, y: cy, w: rw, h: rh }; cy += rh; });
      x += rw; w -= rw;
    } else {
      const rh = s / w; let cx = x;
      row.forEach((r) => { const cw = r.area / rh; out[r.i] = { x: cx, y, w: cw, h: rh }; cx += cw; });
      y += rh; h -= rh;
    }
    items = items.slice(k);
  }
  return out;
}

type Tile = { value?: string; n: number; other?: boolean; count?: number; rect: Rect; shade: number };
function Treemap({ rows }: { rows: { value: string; n: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const key = rows.map((r) => `${r.value}:${r.n}`).join();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const layout = () => {
      const W = el.clientWidth, H = el.clientHeight || W / TREEMAP_RATIO;
      if (!rows.length || !W) return setTiles([]);
      const total = rows.reduce((a, r) => a + r.n, 0);
      let k = rows.length, items: { value?: string; n: number; other?: boolean; count?: number }[] = [], rects: Rect[] = [];
      for (;;) {
        const rest = rows.slice(k);
        items = rows.slice(0, k).map((r) => ({ ...r }));
        if (rest.length) items.push({ other: true, n: rest.reduce((a, r) => a + r.n, 0), count: rest.length });
        rects = squarify(items.map((r) => r.n), 0, 0, W, H);
        if (k <= 1 || rects.every((r) => r.w >= TREE_MIN_W - 0.5 && r.h >= TREE_MIN_H - 0.5)) break;
        k--;
      }
      const shares = items.map((r) => r.n / total);
      const top = shares[0], low = Math.min(...shares.slice(1), top);
      setTiles(items.map((it, i) => ({ ...it, rect: rects[i], shade: i === 0 ? 16 : it.other ? 3 : 3 + 8 * (top === low ? 1 : (shares[i] - low) / (top - low)) })));
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = rows.reduce((a, r) => a + r.n, 0);
  return (
    <div ref={ref} className="board-tree" style={{ aspectRatio: String(TREEMAP_RATIO) }}>
      {tiles.map((t, i) => {
        const name = t.other ? "Other" : companyNameFor(t.value!);
        const pct = Math.round((t.n / total) * 100);
        const count = t.other ? `${fmtInt(t.n)} · ${t.count} ${t.count === 1 ? "company" : "companies"}` : fmtInt(t.n);
        const title = t.other ? `${t.count} more companies, ${fmtInt(t.n)} open jobs` : `${name}: ${fmtInt(t.n)} open jobs, ${pct}% of these`;
        const style = { left: t.rect.x, top: t.rect.y, width: t.rect.w, height: t.rect.h,
          background: `color-mix(in srgb, var(--foreground) ${t.shade.toFixed(1)}%, var(--card))` };
        const logo = !t.other && t.rect.w >= TREE_LOGO_MIN_W && t.rect.h >= 100 ? <Logo domain={t.value} resolved={companyLogoFor(t.value!)} size={28} className="mb-1.5 rounded-sm bg-card p-0.5" /> : null;
        const inner = (
          <span className="flex h-full flex-col p-2.5 text-left font-ui">
            {logo}<span className={cn("truncate leading-tight text-foreground", i === 0 ? "text-[15px]" : "text-[13px]", t.rect.w < 110 && "text-xs whitespace-normal")}>{name}</span>
            <span className="truncate text-xs tabular-nums text-muted-foreground">{count}</span>
          </span>
        );
        const cls = "board-tree-cell rounded-sm border-2 border-card";
        return t.other
          ? <div key={i} className={cls} style={style} title={title}>{inner}</div>
          : <button key={i} type="button" className={cn(cls, "cursor-pointer hover:brightness-95")} style={style} title={title} aria-label={`Show only ${name}, ${fmtInt(t.n)} open jobs`} onClick={() => setCompany(t.value!)}>{inner}</button>;
      })}
    </div>
  );
}

function Dots() {
  return <span role="status" className="inline-flex h-[30px] items-center"><Skeleton className="h-5 w-24" /><span className="sr-only">Loading</span></span>;
}

function Overview() {
  const mode = currentScopeMode();
  const pending = mode === "pending";
  const s: Partial<Scope> = (mode === "scoped" ? U.scoped!.data : U.stats ? globalScope(U.stats) : null) || {};
  const total = U.jobs?.total;
  const hiring = U.facets.companies.slice(0, TREEMAP_N).map((r) => ({ value: r.value, n: r.n || 0 }));
  const onBasis = (shown: number | null | undefined, now?: number, prev?: number) => (shown == null || !now || prev == null) ? prev : Math.round((shown * prev) / now);
  const trend = (now?: number, prev?: number) => {
    if (pending || now == null || prev == null || !prev) return null;
    const pct = Math.round(((now - prev) / prev) * 100);
    const arrow = pct > 0 ? "↗" : pct < 0 ? "↘" : "→";
    const shown = Math.abs(pct) >= 1000 ? `${Math.round(Math.abs(pct) / 100) / 10}k` : Math.abs(pct);
    return <span className="font-ui text-xs tabular-nums text-muted-foreground" title={`${pct > 0 ? "+" : ""}${pct}%`}><span aria-hidden="true">{arrow}</span> {shown}%</span>;
  };
  const tiles: { value: ReactNode; label: string; delta: ReactNode; sub: string }[] = [];
  const add = (value: ReactNode | null, label: string, delta: ReactNode, sub: string) => { if (value !== null) tiles.push({ value, label, delta, sub }); };
  const rolesPrev = onBasis(total, s.open_now_basis, s.open_jobs_7d_ago);
  const companiesPrev = onBasis(s.companies_hiring, s.companies_now_basis, s.companies_7d_ago);
  const sub = (n: number | undefined, words: string) => (pending || n == null ? "" : `${fmtInt(n)} ${words}`);
  add(total == null ? (pending || !U.jobs ? <Dots /> : null) : fmtInt(total), "Matching jobs", trend(s.open_now_basis, s.open_jobs_7d_ago), sub(rolesPrev, "a week ago"));
  add(pending ? <Dots /> : s.new_jobs_24h == null ? (U.stats ? null : <Dots />) : fmtInt(s.new_jobs_24h), "New in 24h", trend(s.new_jobs_24h, s.prev_new_jobs_24h), sub(s.prev_new_jobs_24h, "yesterday"));
  add(pending ? <Dots /> : s.companies_hiring == null ? (U.stats ? null : <Dots />) : fmtInt(s.companies_hiring), "Companies", trend(s.companies_now_basis, s.companies_7d_ago), sub(companiesPrev, "a week ago"));
  add(pending ? <Dots /> : s.new_jobs_7d == null ? (U.stats ? null : <Dots />) : fmtInt(s.new_jobs_7d), "New this week", trend(s.new_jobs_7d, s.prev_new_jobs_7d), sub(s.prev_new_jobs_7d, "the week before"));
  return (
    <div className="flex min-h-full flex-col gap-6 px-5 py-6">
      {tiles.length ? (
        <div className="grid grid-cols-2 gap-2">
          {tiles.map((t) => (
            <div key={t.label} className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted px-4 py-3.5 font-ui">
              <span className="text-sm text-foreground">{t.label}</span>
              {/* Proportional figures in the display face: the mono face set "280 , 340" with gaps. */}
              <span className="flex flex-wrap items-baseline gap-x-1.5 font-display text-[28px] leading-[1.1] text-foreground tabular-nums">{t.value}{t.delta}</span>
              <span className="min-h-4 truncate text-xs text-muted-foreground">{t.sub}</span>
            </div>
          ))}
        </div>
      ) : null}
      {hiring.length ? (
        <div>
          <h3 className="m-0 mb-2.5 font-ui text-sm font-semibold text-foreground">Companies with the most open jobs</h3>
          <Treemap rows={hiring} />
        </div>
      ) : null}
      <p className="m-0 mt-auto font-ui text-sm text-muted-foreground">Select a job to see its details here.</p>
    </div>
  );
}

export function Pane() {
  const d = U.detail;
  const sheet = useMedia(PANE_SHEET);
  const bodyRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);
  // Apply and Save again once the real pair has scrolled out of the pane.
  useEffect(() => {
    setStuck(false);
    const actions = actionsRef.current;
    if (!actions || !bodyRef.current || !d?.job) return;
    const obs = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { root: bodyRef.current, threshold: 0 });
    obs.observe(actions);
    return () => obs.disconnect();
  }, [d?.id, d?.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [d?.id]);
  // On a phone the screen drags down to close, from its head or from text at its top.
  useEffect(() => {
    const panel = paneRef.current;
    if (!panel) return;
    let startX = 0, startY = 0, startT = 0, lastY = 0, state: "idle" | "armed" | "dragging" | "off" = "idle";
    const start = (e: TouchEvent) => {
      state = "idle";
      if (!isPhone() || !U.paneOpen || e.touches.length !== 1) return;
      const fromHead = !!(e.target as HTMLElement).closest("[data-pane-head]");
      if (!fromHead && bodyRef.current && bodyRef.current.scrollTop > 0) return;
      startX = e.touches[0].clientX; startY = lastY = e.touches[0].clientY; startT = e.timeStamp;
      state = "armed";
    };
    const move = (e: TouchEvent) => {
      if (state === "idle" || state === "off") return;
      const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
      if (state === "armed") {
        if ((Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) || dy < -4) { state = "off"; return; }
        if (dy < 8) return;
        state = "dragging";
        panel.classList.add("dragging");
      }
      e.preventDefault();
      lastY = e.touches[0].clientY;
      panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
    };
    const end = (e: TouchEvent) => {
      if (state !== "dragging") { state = "idle"; return; }
      state = "idle";
      panel.classList.remove("dragging");
      const dy = Math.max(0, lastY - startY);
      const speed = dy / Math.max(1, e.timeStamp - startT);
      panel.style.transform = "";
      if (dy > panel.getBoundingClientRect().height * 0.25 || speed > 0.6) closeJobAndSync();
    };
    panel.addEventListener("touchstart", start, { passive: true });
    panel.addEventListener("touchmove", move, { passive: false });
    panel.addEventListener("touchend", end);
    panel.addEventListener("touchcancel", end);
    return () => { panel.removeEventListener("touchstart", start); panel.removeEventListener("touchmove", move); panel.removeEventListener("touchend", end); panel.removeEventListener("touchcancel", end); };
  }, []);

  const rows = U.jobs?.jobs || [];
  const i = d ? rows.findIndex((r) => r.id === d.id) : -1;
  const total = U.jobs?.total;
  const pos = !d ? "" : i < 0 ? "Job" : `${fmtInt(i + 1)} of ${total == null ? `${fmtInt(rows.length)}+` : fmtInt(total)}`;
  const view = F.roles === "tech" && !F.starred_only ? "Tech jobs" : "All jobs";
  const job = d?.job;
  return (
    <>
      <div className={cn("board-scrim bg-overlay min-[1101px]:hidden", U.paneOpen && "open")} aria-hidden="true" onClick={() => { if (U.selected !== null) closeJobAndSync(); }} />
      <aside ref={paneRef} id="job-detail" role="complementary" aria-label="Job detail" inert={sheet && !U.paneOpen}
        className={cn("board-pane flex min-h-0 flex-col bg-card min-[1101px]:relative min-[1101px]:rounded-t-[10px] min-[1101px]:border min-[1101px]:border-b-0", U.paneOpen && "open")}>
        <div data-pane-head className="relative flex min-h-[64px] shrink-0 items-center gap-1 border-b px-3 max-[800px]:h-14 max-[800px]:min-h-14">
          {d ? (
            <>
              <span className="absolute top-[5px] left-1/2 hidden h-1 w-9 -translate-x-1/2 rounded-full bg-border max-[800px]:block" aria-hidden="true" />
              <button type="button" aria-label="Close job" className={cn(iconBtn, "size-11 min-[801px]:hidden")} onClick={closeJobAndSync}><ArrowLeft size={20} /></button>
              <span className="flex items-center gap-1 max-[800px]:flex-1 max-[800px]:justify-center">
                <button type="button" aria-label="Previous job" className={cn(iconBtn, "max-[800px]:hidden")} disabled={i <= 0} onClick={() => stepJob(-1)}><CaretLeft size={14} weight="bold" /></button>
                <span className="font-display text-[17px] tabular-nums text-foreground max-[800px]:font-ui max-[800px]:text-xs max-[800px]:text-muted-foreground">{pos}</span>
                <button type="button" aria-label="Next job" className={cn(iconBtn, "max-[800px]:hidden")} disabled={i < 0 || i >= rows.length - 1} onClick={() => stepJob(1)}><CaretRight size={14} weight="bold" /></button>
              </span>
              <span className="ml-auto flex items-center gap-1">
                <button type="button" aria-label="Share" className={cn(iconBtn, "size-11 min-[801px]:hidden")}
                  onClick={() => { const url = jobPermalink(d.id); if (navigator.share) navigator.share({ title: job?.title, url }).catch(() => {}); else copyLink(url); }}><ShareNetwork size={20} /></button>
                <button type="button" aria-label="Close job" className={cn(iconBtn, "border max-[800px]:hidden")} onClick={closeJobAndSync}><X size={16} /></button>
              </span>
            </>
          ) : (
            <div className="flex min-w-0 flex-col px-2 py-3">
              <span className="font-display text-[17px] font-medium text-foreground">Results overview</span>
              <span className="truncate font-ui text-xs text-muted-foreground">{[...activeFilterSummary(), view].join(" · ")}</span>
            </div>
          )}
        </div>
        <div ref={bodyRef} className="pane-body min-h-0 flex-1 overflow-y-auto">
          {!d ? <Overview />
            : d.gone ? (
              <div className="flex flex-col items-center gap-2 px-5 py-12 text-center font-ui">
                <strong className="text-base text-foreground">Job not found</strong>
                <p className="m-0 text-sm text-muted-foreground">This job is no longer on the board. Jobs get filled and taken down, so links to them go stale.</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={closeJobAndSync}>Back to jobs</Button>
              </div>
            )
            : !job && d.error ? <p className="m-5 font-ui text-sm text-destructive" role="alert">Couldn't load this job. Reload the page to try again.</p>
            : !job ? <div className="flex flex-col gap-3 p-5" role="status" aria-label="Loading job"><Skeleton className="size-[52px]" /><Skeleton className="h-6 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
            : <Body job={job} d={d} actionsRef={actionsRef} />}
        </div>
        {job && !d?.gone ? (
          <div className={cn("pane-sticky flex shrink-0 items-center gap-2.5 border-t bg-card px-4 py-3 max-[800px]:fixed max-[800px]:inset-x-0 max-[800px]:bottom-0 max-[800px]:z-[51] max-[800px]:pb-[calc(12px+env(safe-area-inset-bottom))]",
            !stuck && "min-[801px]:hidden")}>
            <StarButton job={job} square />
            <QueueButton job={job} />
            <span className="max-[800px]:hidden"><CopyButton text={jobPermalink(job.id)} square /></span>
            <a className={cn("job-detail-apply pane-apply min-w-0 flex-1", apply, "max-[800px]:h-12 max-[800px]:text-[15px]")} href={safeHref(job.url)} target="_blank" rel="noopener">
              <span className="truncate">Apply on {companyLabel(job)}</span><ArrowUpRight size={12} weight="bold" aria-hidden="true" />
            </a>
          </div>
        ) : null}
      </aside>
    </>
  );
}
