// The builder, as a sentence: "Count jobs that are open now by category,
// top 25, where Seniority is Senior". Every choice is a pill that opens a
// menu; every filter is a tag that opens its editor in a popover and can
// be removed. A pill change runs at once; a filter editor applies as you
// go and runs when it closes. The menus load on first use (Menus.tsx);
// until then each is a plain button that looks the same.
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { CaretDown } from "@/components/icons";
import { cn } from "@/lib/utils";
import { filterLabel, GROUP_WORDS, LIMITS, type Picks } from "./data";
import type { Group, Opt } from "./Menus";

const PillMenu = lazy(() => import("./Menus").then((m) => ({ default: m.PillMenu })));
const AddFilterMenu = lazy(() => import("./Menus").then((m) => ({ default: m.AddFilterMenu })));
const FilterPopover = lazy(() => import("./Menus").then((m) => ({ default: m.FilterPopover })));

type Props = {
  qb: QbState; picks: Picks; pickName: (field: string, v: string) => string;
  // A change to the question (the starter question it came from no longer applies).
  onChange: (next: QbState) => void;
  run: () => void;
};

const CHIP = "h-[34px] rounded-md border font-ui text-sm font-bold text-foreground";
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring";
const PILL = cn(CHIP, FOCUS, "group inline-flex cursor-pointer items-center gap-2 pr-[11px] pl-3 whitespace-nowrap hover:bg-accent data-[state=open]:border-foreground data-[state=open]:bg-accent");
const ADD = cn(CHIP, FOCUS, "cursor-pointer border-dashed border-input/40 px-3 text-muted-foreground hover:border-foreground hover:text-foreground");
const TAG = cn(FOCUS, "max-w-[340px] cursor-pointer truncate rounded-l-md pr-1 pl-3");

// The plain button a menu starts as; a click loads the menu, open.
function Lazy({ trigger, used, use, children }: { trigger: { className: string; children: ReactNode; "aria-label"?: string }; used: boolean; use: () => void; children: ReactNode }) {
  const plain = <button type="button" aria-haspopup="menu" aria-expanded={false} {...trigger} onClick={use} />;
  return used ? <Suspense fallback={plain}>{children}</Suspense> : plain;
}

function Pill({ label, value, options, onChange }: { label: string; value: string; options: (Opt | Group)[]; onChange: (v: string) => void }) {
  const [used, setUsed] = useState(false);
  const current = options.flatMap((o) => ("group" in o ? o.options : [o])).find(([v]) => v === value)?.[1] ?? value;
  const trigger = {
    className: PILL, "aria-label": `${label}: ${current}`,
    children: <>{current}<CaretDown size={10} weight="bold" aria-hidden="true" className="transition-transform group-data-[state=open]:rotate-180" /></>,
  };
  return (
    <Lazy trigger={trigger} used={used} use={() => setUsed(true)}>
      <PillMenu trigger={trigger} label={label} value={value} options={options} onChange={onChange} />
    </Lazy>
  );
}

const Word = ({ children }: { children: ReactNode }) => <span className="whitespace-nowrap">{children}</span>;

const groupOptions = (): Group[] => [
  { group: "Over time", options: [["day", "day"], ["week", "week"], ["month", "month"]] },
  { group: "By", options: Object.entries(GROUP_WORDS) },
  { group: "No grouping", options: [["none", "one by one"]] },
];

export function Builder({ qb, picks, pickName, onChange, run }: Props) {
  const [openFilter, setOpenFilter] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const g = QB.GROUPS[qb.group] || {};
  const time = Boolean(g.time);
  const rows = qb.group === "none";

  const set = (key: keyof QbState, value: string) => {
    const next: QbState = { ...qb, [key]: key === "range" || key === "limit" ? Number(value) : value };
    if (key === "group" && QB.GROUPS[value]?.time && !next.range) next.range = 30;
    // A time group has no share metric.
    if (QB.GROUPS[next.group]?.time && next.metric === "share") next.metric = "count";
    onChange(next);
    run();
  };
  const setFilters = (filters: QbFilter[]) => onChange({ ...qb, filters });
  const addFilter = (field: string) => {
    setFilters([...qb.filters, { field, values: [], text: "", from: "", to: "" }]);
    setOpenFilter(qb.filters.length);
  };

  const metrics: Opt[] = [["count", "Count"], ...(time ? [] : [["share", "Share of"] as Opt]), ["avg_days_open", "Average days open of"]];
  const limits = LIMITS.includes(Number(qb.limit)) ? LIMITS : [...LIMITS, Number(qb.limit)].sort((a, b) => a - b);
  const used = new Set(qb.filters.map((f) => f.field));
  const fields = Object.entries(QB.FIELDS).filter(([k]) => !used.has(k));
  const addTrigger = { className: ADD, children: "+ Add filter" };

  return (
    <div className="flex flex-col gap-3 text-[15px]">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        {rows ? <Word>List</Word> : <Pill label="What to measure" value={qb.metric} options={metrics} onChange={(v) => set("metric", v)} />}
        <Word>jobs</Word>
        {time ? (
          <>
            <Word>that were</Word>
            <Pill label="Which date" value={qb.event} options={Object.entries(QB.EVENTS).map(([k, v]) => [k, v.label] as Opt)} onChange={(v) => set("event", v)} />
            <Word>per</Word>
          </>
        ) : (
          <>
            <Word>that are</Word>
            <Pill label="Which jobs" value={qb.status} options={[["open", "open now"], ["closed", "closed"], ["all", "open or closed"]]} onChange={(v) => set("status", v)} />
            {rows ? null : <Word>by</Word>}
          </>
        )}
        <Pill label="Group by" value={qb.group} options={groupOptions()} onChange={(v) => set("group", v)} />
        {time ? (
          <>
            <Word>over</Word>
            <Pill label="Time range" value={String(qb.range)} onChange={(v) => set("range", v)}
              options={[["7", "the last 7 days"], ["30", "the last 30 days"], ["90", "the last 90 days"], ["0", "all time"]]} />
          </>
        ) : (
          <>
            <Word>{rows ? "newest first, top" : "top"}</Word>
            <Pill label="How many rows" value={String(qb.limit)} options={limits.map((n) => [String(n), String(n)] as Opt)} onChange={(v) => set("limit", v)} />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <Word>where</Word>
        {qb.filters.map((f, i) => (
          <FilterTag key={`${f.field}-${i}`} f={f} picks={picks} pickName={pickName} open={openFilter === i}
            setOpen={(on) => setOpenFilter(on ? i : openFilter === i ? null : openFilter)}
            onEdit={(nf) => setFilters(qb.filters.map((x, j) => (j === i ? nf : x)))}
            onRemove={() => { setFilters(qb.filters.filter((_, j) => j !== i)); run(); }} run={run} />
        ))}
        <Lazy trigger={addTrigger} used={adding} use={() => setAdding(true)}>
          <AddFilterMenu trigger={addTrigger} fields={fields} onPick={addFilter} />
        </Lazy>
        {QB.canCompare(qb) ? (
          <>
            <span className="w-3" aria-hidden="true" />
            <Word>compare to</Word>
            <Pill label="Compare to" value={qb.compare} options={[["none", "nothing"], ["previous", `previous ${Number(qb.range)} days`]]} onChange={(v) => set("compare", v)} />
          </>
        ) : null}
      </div>
    </div>
  );
}

type TagProps = {
  f: QbFilter; picks: Picks; pickName: (field: string, v: string) => string; open: boolean; setOpen: (on: boolean) => void;
  onEdit: (f: QbFilter) => void; onRemove: () => void; run: () => void;
};

function FilterTag({ f, picks, pickName, open, setOpen, onEdit, onRemove, run }: TagProps) {
  // A tag that mounts open was just added, so closing it runs the question.
  const changed = useRef(open);
  const [used, setUsed] = useState(open);
  const label = filterLabel(f, pickName);
  if (!QB.FIELDS[f.field]) return null;
  const edit = (nf: QbFilter) => { changed.current = true; onEdit(nf); };
  const onOpenChange = (on: boolean) => {
    setOpen(on);
    if (!on && changed.current) { changed.current = false; run(); }
  };
  const trigger = { className: TAG, children: label };
  return (
    <span className={cn(CHIP, "inline-flex items-stretch hover:bg-accent")}>
      <Lazy trigger={trigger} used={used} use={() => { setUsed(true); setOpen(true); }}>
        <FilterPopover trigger={trigger} f={f} picks={picks} open={open} onOpenChange={onOpenChange} edit={edit} />
      </Lazy>
      <button type="button" aria-label={`Remove filter: ${label}`} onClick={onRemove}
        className={cn(FOCUS, "cursor-pointer rounded-r-md px-[11px] text-base font-normal text-muted-foreground hover:text-foreground")}>
        ×
      </button>
    </span>
  );
}
