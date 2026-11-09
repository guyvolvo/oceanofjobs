// The search row (what and where), the filter pills, the date and sort
// selects, and the phone's bar, chips and alert button. What opens over
// the board (the pills' popovers, the filters sheet, the country prompt)
// is in Popups.tsx and the places tree in Location.tsx; both load after
// the first rows, so they stay out of the first load.
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, Buildings, CaretDown, ChartBar, House, MagnifyingGlass, MapPin, Money, SlidersHorizontal, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { F, U, activeChips, alertForSearch, anythingOn, applySearchNow, clearPlaces, emit, locationText, openSheet, removeChip, resetAll, setDatePosted, setRailOpen, setSort,
  typeSearch } from "./store";
import { SENIORITY_LABELS, WORKPLACE_LABELS, fmtInt, fmtShekels } from "./util";

const LocationPanel = lazy(() => import("./Location"));
export const preloadLocation = () => import("./Location");

// The popups module, once loaded; until then the pills are plain buttons.
let popups: typeof import("./Popups") | null = null;
let asked: Promise<void> | null = null;
export function loadPopups() {
  asked ??= import("./Popups").then((m) => { popups = m; emit(); });
  return asked;
}
export const Popups = () => popups;

// The 1.5px ink line every control on the board shares (DESIGN.md "Inputs").
export const pill = "inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border-[1.5px] border-foreground bg-card px-3.5 font-ui text-[15px] font-medium text-foreground whitespace-nowrap hover:bg-muted";
const clearBtn = "grid size-6 flex-none cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground";
const field = "flex min-w-0 flex-1 items-center gap-2 px-4";
const fieldInput = "h-full min-w-0 flex-1 border-0 bg-transparent font-ui text-[15px] text-foreground outline-none placeholder:text-muted-foreground max-[800px]:text-base";

// What: debounced, Enter applies now, Escape clears, "/" focuses.
function SearchField() {
  const [value, setValue] = useState(F.search);
  useEffect(() => setValue(F.search), [F.search]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
      e.preventDefault();
      const el = document.getElementById("f-search") as HTMLInputElement | null;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);
  return (
    <div className={cn(field, "border-r max-[800px]:pr-2.5 max-[800px]:pl-3.5")}>
      <MagnifyingGlass size={15} className="flex-none text-muted-foreground" aria-hidden="true" />
      <label className="sr-only" htmlFor="f-search">Search</label>
      <input id="f-search" name="search" type="text" autoComplete="off" placeholder="Job, company or skill" className={fieldInput}
        title='Every word must appear somewhere in the listing: title, company, location, category or description. "Quote a phrase" to keep it together.'
        value={value}
        onChange={(e) => { setValue(e.target.value); typeSearch(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); applySearchNow(value); }
          else if (e.key === "Escape" && value) { e.preventDefault(); setValue(""); applySearchNow(""); }
        }} />
      {value ? (
        <button type="button" id="f-search-clear" aria-label="Clear search" className={clearBtn}
          onClick={() => { setValue(""); applySearchNow(""); document.getElementById("f-search")?.focus(); }}><X size={10} weight="bold" /></button>
      ) : null}
    </div>
  );
}

// Where: the places as a tree (Location.tsx, React Aria), loaded on first use.
function LocationField() {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const chosen = locationText();
  const show = () => { setUsed(true); setOpen(true); };
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) { setOpen(false); setQuery(""); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("focusin", away); };
  }, [open]);
  const close = (refocus: boolean) => { setOpen(false); setQuery(""); if (refocus) input.current?.focus(); };
  return (
    <div ref={wrap} className={cn(field, "max-[800px]:pl-3 min-[801px]:relative")} onPointerEnter={preloadLocation}>
      <MapPin size={16} weight="fill" className="flex-none text-muted-foreground" aria-hidden="true" />
      <label className="sr-only" htmlFor="f-location">Location</label>
      <input ref={input} id="f-location" name="location" type="text" autoComplete="off" spellCheck={false} role="combobox" aria-autocomplete="list"
        aria-expanded={open} aria-controls="f-location-list" placeholder={chosen || "Location"}
        className={cn(fieldInput, chosen && "placeholder:text-foreground")}
        value={query} onFocus={show} onClick={show}
        onChange={(e) => { setQuery(e.target.value); show(); }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) { e.preventDefault(); close(false); }
          else if (e.key === "ArrowDown") { e.preventDefault(); show(); (document.querySelector("#f-location-list [role=row]") as HTMLElement | null)?.focus(); }
        }} />
      {chosen ? <button type="button" id="f-location-clear" aria-label="Clear location" className={clearBtn} onClick={() => { clearPlaces(); input.current?.focus(); }}><X size={10} weight="bold" /></button> : null}
      {used ? <Suspense fallback={null}><LocationPanel open={open} query={query} onClose={close} /></Suspense> : null}
    </div>
  );
}

export function SearchRow() {
  return (
    <div id="topbar-search" role="search" className="relative flex h-10 min-w-0 flex-[1_1_360px] items-stretch rounded-full border-[1.5px] border-foreground bg-card focus-within:outline-2 focus-within:outline-ring max-[800px]:h-11 min-[1101px]:max-w-[600px]">
      <SearchField />
      <LocationField />
    </div>
  );
}

// the pills

export const PILLS = [
  { key: "work", title: "Work type", icon: House, summary: () => F.workplace.map((v) => WORKPLACE_LABELS[v] || v) },
  { key: "pay", title: "Salary", icon: Money, summary: () => {
    const bits: string[] = [];
    if (F.salary_min || F.salary_max) {
      const s = U.facets.salary;
      const lo = Number(F.salary_min) || s?.min;
      const hi = Number(F.salary_max) || s?.max;
      bits.push(lo && hi ? `${fmtShekels(lo)}-${fmtShekels(hi)}` : "Range set");
    }
    if (F.salary_known) bits.push("With an estimate");
    if (F.salary_disclosed) bits.push("Disclosed only");
    return bits;
  } },
  { key: "employer", title: "Company", icon: Buildings, summary: () => activeChips().filter((c) => c.kind === "company").map((c) => c.text) },
  { key: "level", title: "Experience level", icon: ChartBar, summary: () => F.seniority.map((v) => SENIORITY_LABELS[v] || v) },
];

export function PillFace({ p }: { p: (typeof PILLS)[number] }) {
  const sum = p.summary().join(", ");
  return (
    <>
      <p.icon size={16} aria-hidden="true" />
      <span>{p.title}</span>
      {sum ? <span className="max-w-[220px] truncate text-sm font-normal text-[var(--ooj-green-text)] in-data-[state=open]:text-background">{sum}</span> : null}
      <CaretDown size={12} weight="bold" className="transition-transform in-data-[state=open]:rotate-180" aria-hidden="true" />
    </>
  );
}

export function Pills() {
  const P = Popups();
  // The plain buttons become Radix triggers once the popups load; a focused
  // one stays focused across the swap.
  const focused = useRef<string | null>(null);
  if (!P && typeof document !== "undefined") focused.current = (document.activeElement as HTMLElement | null)?.dataset?.pill || null;
  useLayoutEffect(() => {
    if (P && focused.current) document.querySelector<HTMLElement>(`[data-pill="${focused.current}"]`)?.focus();
    focused.current = null;
  }, [P]);
  return (
    <div className="flex flex-wrap items-center gap-2 max-[800px]:hidden" onPointerEnter={() => { loadPopups(); }} onFocus={() => { loadPopups(); }}>
      {PILLS.map((p) => P ? <P.PillPopover key={p.key} p={p} /> : (
        <button key={p.key} type="button" className={pill} data-pill={p.key} aria-expanded={false} onClick={() => { setRailOpen(p.key); loadPopups(); }}><PillFace p={p} /></button>
      ))}
      {anythingOn() ? <button type="button" id="f-reset" className="h-9 cursor-pointer px-2.5 font-ui text-sm text-destructive" onClick={resetAll}>Reset</button> : null}
    </div>
  );
}

// date and sort: the browser's own selects, as on the live board

const selectPill = "relative inline-flex h-8 items-center rounded-full border-[1.5px] border-foreground font-ui text-[13px] text-foreground";
const selectEl = "h-full cursor-pointer appearance-none rounded-full border-0 bg-transparent pr-8 pl-3.5 font-ui text-[13px] text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring";
function Caret() { return <CaretDown size={12} weight="bold" className="pointer-events-none absolute right-3" aria-hidden="true" />; }

const SORTS: [string, string][] = [["match:asc", "Best match"], ["relevance:asc", "Relevance"], ["age:asc", "Newest"], ["age:desc", "Oldest"]];
const sortValue = () => (F.sort === "age" ? `age:${F.dir}` : F.sort === "match" ? "match:asc" : "relevance:asc");
const pickSort = (v: string) => { const [key, dir] = v.split(":"); setSort(key, dir); };
function SortOptions() {
  return <>{SORTS.filter(([v]) => v !== "match:asc" || F.skills.length).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</>;
}
export function SortSelect() {
  return (
    <span className={cn(selectPill, "pl-3 text-muted-foreground")}>
      <span aria-hidden="true">Sort</span>
      <select id="f-sort" title="Sort" aria-label="Sort by" className={cn(selectEl, "pl-1 font-semibold")} value={sortValue()} onChange={(e) => pickSort(e.target.value)}><SortOptions /></select>
      <Caret />
    </span>
  );
}
const DATES: [string, string][] = [["", "Any date"], ["1", "Past 24 hours"], ["3", "Past 3 days"], ["7", "Past 7 days"], ["14", "Past 14 days"], ["30", "Past 30 days"]];
export function DateSelect({ id = "f-date-posted" }: { id?: string }) {
  const v = F.max_age_days;
  return (
    <span className={selectPill}>
      <select id={id} title="Date posted" aria-label="Date posted" className={selectEl} value={v} onChange={(e) => setDatePosted(e.target.value)}>
        {DATES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        {v && !DATES.some(([x]) => x === v) ? <option value={v}>Past {v} days</option> : null}
      </select>
      <Caret />
    </span>
  );
}

// the phone

export function MobileBar() {
  const all = (F.roles !== "all" && !F.starred_only ? [{ kind: "roles", value: "", text: "Tech jobs" }] : []).concat(activeChips());
  const total = U.jobs?.total;
  const count = U.skeleton || U.empty ? "" : F.starred_only ? `${fmtInt(U.jobs?.jobs.length)} saved` : total == null ? (U.jobs ? `${fmtInt(U.jobs.jobs.length)}+ jobs` : "") : `${fmtInt(total)} jobs`;
  return (
    <div className="flex flex-col gap-2.5 min-[801px]:hidden">
      <div id="m-bar" className="flex items-center gap-2">
        <button type="button" id="m-filters" className={cn(pill, "h-9 gap-1.5 bg-transparent px-3 text-[13px] font-bold")} aria-haspopup="dialog" aria-expanded={U.sheetOpen}
          onClick={() => { openSheet(true); loadPopups(); }}>
          <SlidersHorizontal size={15} aria-hidden="true" />Filters
          {all.length ? <span id="m-badge" className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-foreground px-1.5 text-[11px] tabular-nums text-background">{all.length}</span> : null}
        </button>
        <span className={cn(selectPill, "h-9 border-foreground/40 pl-3 text-muted-foreground")}>
          <span aria-hidden="true">Sort</span>
          <select id="m-sort" aria-label="Sort by" className={cn(selectEl, "pl-1.5 text-[13px] font-bold")} value={sortValue()} onChange={(e) => pickSort(e.target.value)}><SortOptions /></select>
          <Caret />
        </span>
        <span id="m-count" className="ml-auto font-ui text-xs whitespace-nowrap tabular-nums text-muted-foreground" aria-live="polite">{count}</span>
      </div>
      {all.length ? (
        <div id="m-chips" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]">
          {all.map((c) => (
            <button key={`${c.kind}:${c.value}`} type="button" title="Remove this filter" onClick={() => removeChip(c.kind, c.value)}
              className="inline-flex h-[30px] flex-none cursor-pointer items-center gap-1.5 rounded-sm bg-muted px-2.5 font-ui text-xs font-bold whitespace-nowrap text-foreground">
              {c.text}<X size={10} weight="bold" aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="h-[30px] flex-none cursor-pointer px-1.5 font-ui text-xs font-bold text-destructive" onClick={resetAll}>Reset</button>
        </div>
      ) : null}
    </div>
  );
}

// The phone's floating "Alert me for this search". Out of the way once the
// reader scrolls down the results; a new search brings it back.
export function AlertButton() {
  const [gone, setGone] = useState(false);
  const searchKey = JSON.stringify([F.search, F.department, F.seniority, F.company, F.country, F.city, F.workplace, F.roles, F.max_age_days, F.starred_only]);
  useEffect(() => setGone(false), [searchKey]);
  useEffect(() => {
    const on = () => { if (window.scrollY > 120) setGone(true); };
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  if (U.paneOpen || U.sheetOpen) return null;
  return (
    <button type="button" id="m-alert" onClick={alertForSearch} tabIndex={gone ? -1 : undefined} aria-hidden={gone || undefined}
      className={cn("fixed bottom-[calc(76px+env(safe-area-inset-bottom))] left-1/2 z-[35] inline-flex h-10 -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full border-[1.5px] border-foreground bg-card px-4 font-ui text-[13px] font-bold text-foreground transition-[translate,opacity] duration-250 min-[801px]:hidden",
        gone && "pointer-events-none translate-y-6 opacity-0")}>
      <Bell size={15} aria-hidden="true" />Alert me for this search
    </button>
  );
}
