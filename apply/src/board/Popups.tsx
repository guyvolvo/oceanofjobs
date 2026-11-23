// Everything on the board that opens over it and needs Radix: the filter
// pills' popovers, the phone's filters sheet and the country prompt.
// Loaded once the rows are up (Filters.tsx loadPopups), so none of it is
// in the first load; until then the pills are plain buttons that look the same.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { DateSelect, PILLS, PillFace, pill } from "./Filters";
import { Categories, SavedSearches, ViewSwitch } from "./Side";
import { F, RAIL_GROUPS, RAIL_TOP_N, U, answerCountry, commitSalary, openSheet, railLabel, railRows, railSearch, railSelected, railToggle, railVisibleRows, resetAll,
  setRailOpen, toggleExpanded, type RailGroup } from "./store";
import { fmtInt, fmtShekels } from "./util";

function Option({ label, n, checked, onChange, mark }: { label: string; n: number | null; checked: boolean; onChange: (on: boolean) => void; mark?: string }) {
  const i = mark ? label.toLowerCase().indexOf(mark) : -1;
  const text = i < 0 ? label : <>{label.slice(0, i)}<b className="font-semibold">{label.slice(i, i + mark!.length)}</b>{label.slice(i + mark!.length)}</>;
  return (
    <label className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-sm px-1.5 font-ui text-[15px] text-foreground hover:bg-muted">
      <Checkbox checked={checked} onCheckedChange={(c) => onChange(c === true)} />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {n == null ? null : <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtInt(n)}</span>}
    </label>
  );
}

function ListGroup({ group }: { group: RailGroup }) {
  const rows = railVisibleRows(group);
  const picked = railSelected(group);
  const pool = railRows(group);
  const q = U.railQueries.get(group.key) || "";
  if (!pool.length && !picked.size && !q) {
    if (U.facetsLoaded) return null;
    return <div className="flex flex-col gap-2.5 p-1.5" aria-hidden="true">{[70, 55, 80, 45].map((w) => <Skeleton key={w} className="h-3.5" style={{ width: `${w}%` }} />)}</div>;
  }
  const search = (group as { search?: string }).search;
  return (
    <div className="flex flex-col gap-0.5">
      {search ? <Input className="mb-1.5 h-9" type="search" placeholder={search} aria-label={search} autoComplete="off" value={q} onChange={(e) => railSearch(group.key, e.target.value)} /> : null}
      {rows.length ? rows.map((r) => (
        <Option key={r.value} label={railLabel(group, r)} n={r.n} checked={picked.has(r.value)} mark={q.trim().toLowerCase()} onChange={(on) => railToggle(group.key, r.value, on)} />
      )) : <p className="m-0 px-1.5 py-1 font-ui text-sm text-muted-foreground">No results</p>}
      {!q && pool.length > RAIL_TOP_N ? (
        <button type="button" className="cursor-pointer self-start px-1.5 py-1 font-ui text-[13px] text-muted-foreground hover:text-foreground" onClick={() => toggleExpanded(group.key)}>
          {U.railExpanded.has(group.key) ? "Show fewer" : `Show all (${fmtInt(pool.length)})`}
        </button>
      ) : null}
    </div>
  );
}

// Two handles over the range this result set spans; Disclosed stands on its own.
function SalaryGroup() {
  const s = U.facets.salary;
  const track = s && s.min != null && s.max != null && s.max > s.min;
  const lo = track ? Number(F.salary_min) || s.min : 0;
  const hi = track ? Number(F.salary_max) || s.max : 0;
  const [range, setRange] = useState<number[]>([lo, hi]);
  useEffect(() => setRange([lo, hi]), [lo, hi]);
  return (
    <div className="flex flex-col gap-2">
      {track ? (
        <div className="flex flex-col gap-2 px-1.5 pt-2">
          <Slider min={s.min} max={s.max} step={1000} value={range} onValueChange={setRange} onValueCommit={([a, b]) => commitSalary(a, b)} />
          <div className="flex justify-between font-ui text-xs tabular-nums text-muted-foreground"><span>{fmtShekels(range[0])}</span><span>{fmtShekels(range[1])}{range[1] >= s.max ? "+" : ""}</span></div>
          <Option label="Estimated salary" n={s.known} checked={F.salary_known} onChange={(on) => railToggle("salary_known", "1", on)} />
        </div>
      ) : null}
      <Option label="Disclosed salary only" n={U.facets.salary_disclosed || 0} checked={F.salary_disclosed} onChange={(on) => railToggle("salary_disclosed", "1", on)} />
    </div>
  );
}

const BODY: Record<string, () => ReactNode> = {
  work: () => <ListGroup group={RAIL_GROUPS[2]} />,
  pay: () => <SalaryGroup />,
  employer: () => <ListGroup group={RAIL_GROUPS[3]} />,
  level: () => <ListGroup group={RAIL_GROUPS[1]} />,
};

export function PillPopover({ p }: { p: (typeof PILLS)[number] }) {
  return (
    <Popover open={U.railOpen === p.key} onOpenChange={(o) => setRailOpen(o ? p.key : null)}>
      <PopoverTrigger className={cn(pill, "data-[state=open]:bg-foreground data-[state=open]:text-background")} data-pill={p.key}><PillFace p={p} /></PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="max-h-[min(60vh,520px)] w-[320px] overflow-y-auto overscroll-contain rounded-lg bg-card p-2.5">
        {BODY[p.key]()}
      </PopoverContent>
    </Popover>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b px-4 py-3.5">
      <h3 className="m-0 mb-2.5 font-ui text-sm font-bold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

// Every filter at once, from the bottom of the screen.
export function FilterSheet() {
  const total = U.jobs?.total;
  const n = U.empty || total == null ? null : fmtInt(total);
  return (
    <Sheet open={U.sheetOpen} onOpenChange={openSheet}>
      <SheetContent side="bottom" className="h-[min(90svh,760px)] gap-0 rounded-t-lg bg-card p-0" showCloseButton={false} aria-describedby={undefined}
        onCloseAutoFocus={(e) => { e.preventDefault(); document.getElementById("m-filters")?.focus(); }}>
        <div className="mx-auto mt-2 h-1 w-9 flex-none rounded-full bg-border" aria-hidden="true" />
        <div className="flex flex-none items-center justify-between border-b py-2 pr-2 pl-4">
          <SheetTitle className="font-ui text-[17px] font-bold">Filters</SheetTitle>
          <span className="flex items-center gap-1">
            <button type="button" id="m-sheet-reset" className="h-9 cursor-pointer px-2.5 font-ui text-[13px] font-bold text-destructive" onClick={resetAll}>Reset</button>
            <button type="button" aria-label="Close filters" className="grid size-10 cursor-pointer place-items-center text-foreground" onClick={() => openSheet(false)}><X size={18} /></button>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <Section title="Show"><ViewSwitch /></Section>
          <Section title="Category"><Categories /></Section>
          <Section title="Date posted"><DateSelect id="m-date-posted" /></Section>
          {PILLS.map((p) => <Section key={p.key} title={p.title}>{BODY[p.key]()}</Section>)}
          <Section title="Saved searches"><SavedSearches onPick={() => openSheet(false)} /></Section>
        </div>
        <div className="flex-none border-t px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
          <button type="button" id="m-show" className="h-12 w-full cursor-pointer rounded-sm bg-primary font-ui text-[15px] font-bold text-primary-foreground" onClick={() => openSheet(false)}>{n ? `Show ${n} jobs` : "Show jobs"}</button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// "Are you in X?", once ever (store.maybeAskCountry). Escape and the scrim mean Skip.
export function GeoPrompt() {
  // The last question stays while the dialog fades out, so it never reads "Are you in ?".
  const last = useRef(U.geoPrompt);
  if (U.geoPrompt) last.current = U.geoPrompt;
  const g = last.current;
  return (
    <Dialog open={!!U.geoPrompt} onOpenChange={(o) => { if (!o) answerCountry(false); }}>
      <DialogContent showCloseButton={false} className="w-[400px] max-w-[calc(100vw-32px)] gap-3 font-ui">
        <DialogTitle className="m-0 font-display text-[22px] font-normal">Are you in {g?.name}?</DialogTitle>
        <DialogDescription className="m-0 text-sm text-muted-foreground">We guessed your country from your connection. Skip to see jobs from every country.</DialogDescription>
        <div className="mt-2 flex gap-2">
          <Button autoFocus onClick={() => answerCountry(true)}>Show {g?.name} jobs</Button>
          <Button variant="ghost" onClick={() => answerCountry(false)}>Skip</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
