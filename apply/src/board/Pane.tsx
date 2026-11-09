// The detail pane: a column above 1100px, a sheet over the list below
// it. Never blank: with nothing open it says what the filters add up to.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Loader, SkeletonLine } from "@cloudflare/kumo/components/loader";
import { ArrowLeft, ArrowUpRight, CaretLeft, CaretRight, Copy, ShareNetwork, Star, X } from "@phosphor-icons/react";
import { Logo, QueueButton, SkillChips } from "./List";
import { F, U, activeFilterSummary, closeJobAndSync, companyLogoFor, companyNameFor, currentScopeMode, globalScope, jobPermalink, setCompany, stepJob, toggleStar } from "./store";
import { WORKPLACE_LABELS, ageDays, companyLabel, copyText, fmtAgeAgo, fmtInt, isPhone, isReposted, salarySource, type Job } from "./util";

function CopyButton({ text, label, children, ...rest }: { text: string; label: string; children?: ReactNode; shape?: "base" | "square"; size?: "xs" | "sm" | "base"; variant?: "ghost" | "secondary" }) {
  const [done, setDone] = useState(false);
  return (
    <Button variant={rest.variant || "ghost"} size={rest.size || "sm"} shape={rest.shape} aria-label={label} title={label}
      icon={done ? undefined : <Copy />} onClick={() => { copyText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}>
      {done ? "Copied" : children}
    </Button>
  );
}

function StarButton({ job, square }: { job: Job; square?: boolean }) {
  const on = U.starred.has(job.id);
  return (
    <Button variant={on ? "primary" : "secondary"} size="sm" shape={square ? "square" : "base"} aria-pressed={on} aria-label={on ? "Saved" : "Save"}
      icon={<Star weight={on ? "fill" : "regular"} />} onClick={() => toggleStar(job.id)}>{square ? "" : on ? "Saved" : "Save"}</Button>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col border-t border-kumo-hairline py-2">
      <span className="text-sm text-kumo-strong">{children}</span>
      <span className="text-xs text-kumo-subtle">{label}</span>
    </div>
  );
}

function Salary({ job }: { job: Job }) {
  if (!job.salary_text) return <span className="text-kumo-subtle">Undisclosed</span>;
  const { estimate, note } = salarySource(job);
  return <span title={note}>{estimate ? <span className="text-kumo-subtle">Est. </span> : null}<span className="text-kumo-brand">{job.salary_text}</span></span>;
}

function Description({ d }: { d: Pick<NonNullable<typeof U.detail>, "job" | "loading" | "error"> }) {
  if (d.error) return <p className="m-0 text-sm text-kumo-danger">Couldn't load the description. Select Apply to read it on the company's site.</p>;
  if (d.loading) return <div className="flex flex-col gap-2" role="status" aria-label="Loading description"><SkeletonLine /><SkeletonLine /><SkeletonLine /><SkeletonLine minWidth={40} maxWidth={60} /></div>;
  const text = d.job?.description;
  if (!text) return <p className="m-0 text-sm text-kumo-subtle">This listing has no description. Select Apply to read it on the company's site.</p>;
  return (
    <div className="board-desc text-sm leading-relaxed text-kumo-default">
      {text.split("\n").map((line, i) => (line.startsWith("## ")
        ? <strong key={i} className="mt-3 block text-kumo-strong">{line.slice(3)}{"\n"}</strong>
        : <span key={i}>{line}{"\n"}</span>))}
    </div>
  );
}

function Body({ job, d, actionsRef }: { job: Job; d: NonNullable<typeof U.detail>; actionsRef: React.RefObject<HTMLDivElement | null> }) {
  const age = ageDays(job.posted_at);
  const applied = U.appliedAt.get(job.id);
  const href = /^https?:\/\//i.test(job.url || "") ? job.url! : "#";
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <Logo domain={job.company_domain} resolved={job.logo_url} size={52} />
        <div className="min-w-0">
          <div className="truncate font-medium text-kumo-strong">{companyLabel(job)}</div>
          <div className="truncate text-sm text-kumo-subtle">{job.location || "-"}</div>
        </div>
      </div>
      <h2 className="m-0 font-sans text-xl font-semibold leading-tight text-kumo-strong">
        {job.title}
        {job.confidence === "best_effort" ? <span className="ml-2 align-middle" title="Read from the company's careers page, so it may be out of date."><Badge variant="warning">Unverified</Badge></span> : null}
        {job.closed_at ? <span className="ml-2 align-middle"><Badge variant="neutral">Closed</Badge></span> : null}
      </h2>
      <div ref={actionsRef} className="flex flex-wrap items-center gap-2">
        <LinkButton variant="primary" size="sm" href={href} target="_blank" rel="noopener" title="Open the original listing to apply">Apply <ArrowUpRight size={12} aria-hidden="true" /></LinkButton>
        <StarButton job={job} />
        <QueueButton job={job} label />
        <CopyButton text={jobPermalink(job.id)} label="Copy a link to this job">Copy link</CopyButton>
      </div>
      <div className="grid grid-cols-2 gap-x-4 min-[801px]:grid-cols-3">
        <Fact label="Monthly salary"><Salary job={job} /></Fact>
        {applied ? <Fact label="Applied"><span className="text-kumo-brand">Applied {fmtAgeAgo((Date.now() - new Date(applied).getTime()) / 86400000)}</span></Fact> : null}
        <Fact label="Posted">{age === null ? <span className="text-kumo-subtle">Unreported</span>
          : isReposted(job) ? `Reposted ${fmtAgeAgo(age)} · first seen ${fmtAgeAgo(ageDays(job.first_seen))}` : fmtAgeAgo(age)}</Fact>
        <Fact label="Department">{job.department || <span className="text-kumo-subtle">-</span>}</Fact>
        <Fact label="Workplace">{job.workplace_type ? WORKPLACE_LABELS[job.workplace_type] || job.workplace_type : <span className="text-kumo-subtle">-</span>}</Fact>
      </div>
      {job.skills ? <div className="flex flex-wrap gap-1"><SkillChips j={job} limit={100} /></div> : null}
      <h3 className="m-0 mt-1 text-xs font-medium uppercase tracking-wide text-kumo-subtle">About this job</h3>
      <Description d={d} />
      <a className="inline-flex items-center gap-1 text-sm text-kumo-link underline" href={href} target="_blank" rel="noopener">View original posting <ArrowUpRight size={12} aria-hidden="true" /></a>
    </div>
  );
}

// What the filters add up to: four numbers with how they moved, and the
// employers with the most open roles as a treemap.
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

type Tile = { value?: string; n: number; other?: boolean; count?: number; rect: Rect; shade: number | null };
function Treemap({ rows }: { rows: { value: string; n: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
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
      setTiles(items.map((it, i) => ({ ...it, rect: rects[i], shade: i === 0 ? null : it.other ? 3 : 3 + 8 * (top === low ? 1 : (shares[i] - low) / (top - low)) })));
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows]);
  const total = rows.reduce((a, r) => a + r.n, 0);
  return (
    <div ref={ref} className="board-tree" style={{ aspectRatio: String(TREEMAP_RATIO) }}>
      {tiles.map((t, i) => {
        const name = t.other ? "Other" : companyNameFor(t.value!);
        const pct = Math.round((t.n / total) * 100);
        const count = t.other ? `${fmtInt(t.n)} · ${t.count} ${t.count === 1 ? "company" : "companies"}` : fmtInt(t.n);
        const title = t.other ? `${t.count} more companies, ${fmtInt(t.n)} open jobs` : `${name}: ${fmtInt(t.n)} open jobs, ${pct}% of these`;
        const style = { left: t.rect.x, top: t.rect.y, width: t.rect.w, height: t.rect.h,
          background: t.shade == null ? "var(--color-kumo-success-tint)" : `color-mix(in srgb, var(--color-kumo-contrast) ${t.shade.toFixed(1)}%, var(--color-kumo-base))` };
        const logo = !t.other && t.rect.w >= TREE_LOGO_MIN_W && t.rect.h >= 100 ? <Logo domain={t.value} resolved={companyLogoFor(t.value!)} size={28} className="mb-1" /> : null;
        const inner = <span className="flex h-full flex-col justify-end p-1.5 text-left">{logo}<span className="truncate text-xs font-medium leading-tight text-kumo-strong">{name}</span><span className="truncate font-mono text-[11px] text-kumo-subtle">{count}</span></span>;
        const cls = "board-tree-cell border border-kumo-canvas";
        return t.other
          ? <div key={i} className={cls} style={style} title={title}>{inner}</div>
          : <button key={i} type="button" className={`${cls} cursor-pointer hover:brightness-95`} style={style} title={title} aria-label={`Show only ${name}, ${fmtInt(t.n)} open jobs`} onClick={() => setCompany(t.value!)}>{inner}</button>;
      })}
    </div>
  );
}

function Dots() {
  return <span role="status" className="inline-flex items-center gap-1 align-middle"><Loader size="sm" /><span className="sr-only">Loading</span></span>;
}

function Overview() {
  const mode = currentScopeMode();
  const pending = mode === "pending";
  const s = (mode === "scoped" ? U.scoped!.data : U.stats ? globalScope(U.stats) : null) || {};
  const total = U.jobs?.total;
  const hiring = U.facets.companies.slice(0, TREEMAP_N).map((r) => ({ value: r.value, n: r.n || 0 }));
  const onBasis = (shown: number | null | undefined, now?: number, prev?: number) => (shown == null || !now || prev == null) ? prev : Math.round((shown * prev) / now);
  const trend = (now?: number, prev?: number, prevText?: string) => {
    if (pending || now == null || prev == null) return <span className="text-xs text-kumo-subtle">&nbsp;</span>;
    if (!prev) return <span className="text-xs text-kumo-subtle">{prevText}</span>;
    const pct = Math.round(((now - prev) / prev) * 100);
    const arrow = pct > 0 ? "↗" : pct < 0 ? "↘" : "→";
    const shown = Math.abs(pct) >= 1000 ? `${Math.round(Math.abs(pct) / 100) / 10}k` : Math.abs(pct);
    return <span className="text-xs text-kumo-subtle"><span className={pct > 0 ? "text-kumo-brand" : pct < 0 ? "text-kumo-danger" : ""} title={`${pct > 0 ? "+" : ""}${pct}% ${(prevText || "").replace(/^[\d,]+ /, "vs ")}`}><span aria-hidden="true">{arrow}</span> {shown}%</span> {prevText}</span>;
  };
  const tiles: { value: ReactNode; label: string; extra: ReactNode }[] = [];
  const add = (value: ReactNode | null, label: string, extra: ReactNode) => { if (value !== null) tiles.push({ value, label, extra }); };
  const rolesPrev = onBasis(total, s.open_now_basis, s.open_jobs_7d_ago);
  const companiesPrev = onBasis(s.companies_hiring, s.companies_now_basis, s.companies_7d_ago);
  add(total == null ? (pending || !U.jobs ? <Dots /> : null) : fmtInt(total), "Matching jobs", trend(s.open_now_basis, s.open_jobs_7d_ago, `${fmtInt(rolesPrev)} a week ago`));
  add(pending ? <Dots /> : s.new_jobs_24h == null ? null : fmtInt(s.new_jobs_24h), "New in 24h", trend(s.new_jobs_24h, s.prev_new_jobs_24h, `${fmtInt(s.prev_new_jobs_24h)} yesterday`));
  add(pending ? <Dots /> : s.companies_hiring == null ? null : fmtInt(s.companies_hiring), "Companies", trend(s.companies_now_basis, s.companies_7d_ago, `${fmtInt(companiesPrev)} a week ago`));
  add(pending ? <Dots /> : s.new_jobs_7d == null ? null : fmtInt(s.new_jobs_7d), "New this week", trend(s.new_jobs_7d, s.prev_new_jobs_7d, `${fmtInt(s.prev_new_jobs_7d)} the week before`));
  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      {tiles.length ? (
        <div className="grid grid-cols-2 gap-px border border-kumo-hairline bg-kumo-hairline">
          {tiles.map((t, i) => (
            <div key={t.label} className="flex flex-col gap-0.5 bg-kumo-canvas p-3">
              <span className="text-xs text-kumo-subtle">{t.label}</span>
              <span className={`font-mono text-2xl leading-none ${i === 0 ? "text-kumo-brand" : "text-kumo-strong"}`}>{t.value}</span>
              {t.extra}
            </div>
          ))}
        </div>
      ) : null}
      {hiring.length ? (
        <div>
          <h3 className="m-0 mb-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Companies with the most open jobs</h3>
          <Treemap rows={hiring} />
        </div>
      ) : null}
      <p className="m-0 text-center text-sm text-kumo-subtle">Select a job to see its details here.</p>
    </div>
  );
}

export function Pane() {
  const d = U.detail;
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
  }, [d?.id, d?.loading]);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [d?.id]);
  // On a phone the sheet drags down to close, from the head or from text at its top.
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
      <div className={`board-scrim bg-black/45 ${U.paneOpen ? "open" : ""}`} aria-hidden="true" onClick={() => { if (U.selected !== null) closeJobAndSync(); }} />
      <aside ref={paneRef} role="complementary" aria-label="Job detail"
        className={`board-pane flex min-h-0 flex-col border-l border-kumo-hairline bg-kumo-canvas ${U.paneOpen ? "open" : ""} min-[1100px]:relative`}>
        <div data-pane-head className="flex shrink-0 items-center gap-1 border-b border-kumo-hairline px-2 py-1.5">
          {d ? (
            <>
              <Button variant="ghost" size="sm" shape="square" icon={<ArrowLeft />} aria-label="Close job" className="min-[801px]:hidden" onClick={closeJobAndSync} />
              <Button variant="ghost" size="sm" shape="square" icon={<CaretLeft />} aria-label="Previous job" disabled={i <= 0} onClick={() => stepJob(-1)} />
              <span className="text-sm text-kumo-strong">{pos}</span>
              <Button variant="ghost" size="sm" shape="square" icon={<CaretRight />} aria-label="Next job" disabled={i < 0 || i >= rows.length - 1} onClick={() => stepJob(1)} />
              <span className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" shape="square" icon={<ShareNetwork />} aria-label="Share"
                  onClick={() => { const url = jobPermalink(d.id); if (navigator.share) navigator.share({ title: job?.title, url }).catch(() => {}); else copyText(url); }} />
                <Button variant="ghost" size="sm" shape="square" icon={<X />} aria-label="Close job" className="hidden min-[801px]:inline-flex" onClick={closeJobAndSync} />
              </span>
            </>
          ) : (
            <div className="flex min-w-0 flex-col px-1 py-0.5">
              <span className="text-sm text-kumo-strong">Results overview</span>
              <span className="truncate text-xs text-kumo-subtle">{[...activeFilterSummary(), view].join(" · ")}</span>
            </div>
          )}
        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto">
          {!d ? <Overview />
            : d.gone ? <div className="p-4"><Empty size="sm" title="Job not found" description="This job is no longer on the board. Jobs get filled and taken down, so links to them go stale."
                contents={<Button variant="secondary" size="sm" onClick={closeJobAndSync}>Back to jobs</Button>} /></div>
            : !job && d.error ? <div className="p-4"><Banner variant="error" size="sm" title="Couldn't load this job. Reload the page to try again." /></div>
            : !job ? <div className="flex items-center gap-2 p-4 text-sm text-kumo-subtle"><Loader size="sm" /> Loading job</div>
            : <Body job={job} d={d} actionsRef={actionsRef} />}
        </div>
        {job && stuck && !d?.gone ? (
          <div className="flex shrink-0 items-center gap-2 border-t border-kumo-hairline bg-kumo-canvas px-3 py-2">
            <StarButton job={job} square />
            <QueueButton job={job} />
            <CopyButton text={jobPermalink(job.id)} label="Copy a link to this job" shape="square" variant="secondary" />
            <LinkButton variant="primary" size="sm" className="min-w-0 flex-1 justify-center" href={/^https?:\/\//i.test(job.url || "") ? job.url! : "#"} target="_blank" rel="noopener">
              <span className="truncate">Apply on {companyLabel(job)}</span> <ArrowUpRight size={12} aria-hidden="true" />
            </LinkButton>
          </div>
        ) : null}
      </aside>
    </>
  );
}
