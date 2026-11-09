// The builder, as a sentence: "Count jobs that are open now by category,
// top 25, where Seniority is Senior". Every choice is a pill (a Kumo
// Select); every filter is a tag that opens its editor in a popover and
// can be removed. A pill change runs at once; a filter editor applies as
// you go and runs when it closes.
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import { Popover } from "@cloudflare/kumo/components/popover";
import { Select } from "@cloudflare/kumo/components/select";
import { Plus, X } from "@phosphor-icons/react";
import { filterLabel, fmtInt, GROUP_WORDS, LIMITS, type Picks } from "./data";

type Opt = { value: string; label: string };
type Props = {
  qb: QbState; picks: Picks; pickName: (field: string, v: string) => string;
  // A change to the question (the starter question it came from no longer applies).
  onChange: (next: QbState) => void;
  run: () => void;
};

const PILL = "h-7 w-auto min-w-0 shrink-0 gap-1 rounded-md border-0 bg-kumo-tint px-2 text-sm font-medium text-kumo-strong shadow-none ring-0 hover:bg-kumo-fill";

function Pill({ label, value, options, onChange }: { label: string; value: string; options: Opt[]; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <Select<string> size="sm" aria-label={`${label}: ${current}`} value={value} items={options} className={PILL}
      onValueChange={(v) => { if (v != null && String(v) !== value) onChange(String(v)); }} />
  );
}

const Word = ({ children }: { children: ReactNode }) => <span className="text-kumo-default">{children}</span>;

// shortcut: the group pill is one flat list ("day, week, month, category, ..., one by one"); Kumo Select has no option groups, add headings if it gains them
function groupOptions(): Opt[] {
  return [
    ...["day", "week", "month"].map((v) => ({ value: v, label: v })),
    ...Object.entries(GROUP_WORDS).map(([value, label]) => ({ value, label })),
    { value: "none", label: "one by one" },
  ];
}

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
    setAdding(false);
    setFilters([...qb.filters, { field, values: [], text: "", from: "", to: "" }]);
    setOpenFilter(qb.filters.length);
  };

  const metrics: Opt[] = [{ value: "count", label: "Count" }, ...(time ? [] : [{ value: "share", label: "Share of" }]), { value: "avg_days_open", label: "Average days open of" }];
  const limits = LIMITS.includes(Number(qb.limit)) ? LIMITS : [...LIMITS, Number(qb.limit)].sort((a, b) => a - b);
  const used = new Set(qb.filters.map((f) => f.field));
  const fields = Object.entries(QB.FIELDS).filter(([k]) => !used.has(k));

  return (
    <div className="flex flex-col gap-2.5 text-[15px] leading-7">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
        {rows ? <Word>List</Word> : <Pill label="What to measure" value={qb.metric} options={metrics} onChange={(v) => set("metric", v)} />}
        <Word>jobs</Word>
        {time ? (
          <>
            <Word>that were</Word>
            <Pill label="Which date" value={qb.event} options={Object.entries(QB.EVENTS).map(([value, v]) => ({ value, label: v.label }))} onChange={(v) => set("event", v)} />
            <Word>per</Word>
          </>
        ) : (
          <>
            <Word>that are</Word>
            <Pill label="Which jobs" value={qb.status} options={[{ value: "open", label: "open now" }, { value: "closed", label: "closed" }, { value: "all", label: "open or closed" }]} onChange={(v) => set("status", v)} />
            {rows ? null : <Word>by</Word>}
          </>
        )}
        <Pill label="Group by" value={qb.group} options={groupOptions()} onChange={(v) => set("group", v)} />
        {time ? (
          <>
            <Word>over</Word>
            <Pill label="Time range" value={String(qb.range)} onChange={(v) => set("range", v)}
              options={[{ value: "7", label: "the last 7 days" }, { value: "30", label: "the last 30 days" }, { value: "90", label: "the last 90 days" }, { value: "0", label: "all time" }]} />
          </>
        ) : (
          <>
            <Word>{rows ? "newest first, top" : "top"}</Word>
            <Pill label="How many rows" value={String(qb.limit)} options={limits.map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => set("limit", v)} />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
        <Word>where</Word>
        {qb.filters.map((f, i) => (
          <FilterTag key={`${f.field}-${i}`} f={f} picks={picks} pickName={pickName} open={openFilter === i}
            setOpen={(on) => setOpenFilter(on ? i : openFilter === i ? null : openFilter)}
            onEdit={(nf) => setFilters(qb.filters.map((x, j) => (j === i ? nf : x)))}
            onRemove={() => { setFilters(qb.filters.filter((_, j) => j !== i)); run(); }} run={run} />
        ))}
        <Popover open={adding} onOpenChange={setAdding}>
          <Popover.Trigger render={<Button variant="ghost" size="sm" icon={<Plus />} />}>Add filter</Popover.Trigger>
          <Popover.Content align="start" className="w-56 p-2">
            <div className="px-2 pb-1 text-xs font-medium text-kumo-subtle">Filter by</div>
            {fields.map(([k, v]) => (
              <button key={k} type="button" className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-kumo-tint" onClick={() => addFilter(k)}>{v.label}</button>
            ))}
          </Popover.Content>
        </Popover>
        {QB.canCompare(qb) ? (
          <>
            <span className="w-3" aria-hidden="true" />
            <Word>compare to</Word>
            <Pill label="Compare to" value={qb.compare} options={[{ value: "none", label: "nothing" }, { value: "previous", label: `previous ${Number(qb.range)} days` }]} onChange={(v) => set("compare", v)} />
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
  const spec = QB.FIELDS[f.field];
  // A tag that mounts open was just added, so closing it runs the question.
  const changed = useRef(open);
  const [search, setSearch] = useState("");
  const label = filterLabel(f, pickName);
  const edit = (nf: QbFilter) => { changed.current = true; onEdit(nf); };
  const close = () => setOpen(false);
  const onOpenChange = (on: boolean) => {
    setOpen(on);
    if (!on && changed.current) { changed.current = false; run(); }
  };
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); onOpenChange(false); } };
  if (!spec) return null;

  let editor: ReactNode;
  if (spec.kind === "pick") {
    const options = picks[f.field] || [];
    const searchable = spec.searchable || options.length > 12;
    const want = search.trim().toLowerCase();
    const sel = new Set(f.values || []);
    const shown = (want ? options.filter((o) => o.name.toLowerCase().includes(want)) : options).slice(0, 400);
    editor = (
      <>
        <div className="text-sm font-medium text-kumo-strong">{spec.label} is</div>
        {searchable ? <Input size="sm" type="search" placeholder={`Filter ${spec.label.toLowerCase()}`} aria-label="Filter values" autoFocus
          value={search} onChange={(e) => setSearch(e.target.value)} /> : null}
        <div role="group" aria-label={spec.label} className="-mx-1 max-h-64 overflow-y-auto">
          {shown.length ? shown.map((o) => (
            <div key={o.value} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-kumo-tint">
              <Checkbox className="min-w-0 flex-1" checked={sel.has(o.value)} onCheckedChange={(c) => {
                const next = new Set(sel); if (c) next.add(o.value); else next.delete(o.value);
                edit({ ...f, values: [...next] });
              }} label={<span className="block truncate text-sm">{o.name}</span>} />
              <span className="shrink-0 text-xs tabular-nums text-kumo-subtle">{fmtInt(o.n)}</span>
            </div>
          )) : <div className="px-2 py-2 text-sm text-kumo-subtle">{options.length ? "No results" : "Loading values"}</div>}
        </div>
        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" size="sm" onClick={() => edit({ ...f, values: [] })}>Clear</Button>
          <Button size="sm" onClick={close}>Done</Button>
        </div>
      </>
    );
  } else if (spec.kind === "text") {
    editor = (
      <>
        <div className="text-sm font-medium text-kumo-strong">{spec.label} contains</div>
        <Input size="sm" autoFocus value={f.text || ""} placeholder={`e.g. ${spec.label === "Title" ? "backend" : "Tel Aviv"}`} aria-label={spec.label}
          onChange={(e) => edit({ ...f, text: e.target.value })} onKeyDown={onEnter} />
        <div className="flex justify-end pt-1"><Button size="sm" onClick={close}>Done</Button></div>
      </>
    );
  } else {
    editor = (
      <>
        <div className="text-sm font-medium text-kumo-strong">{spec.label} between</div>
        <div className="flex gap-2">
          <Input size="sm" autoFocus value={f.from || ""} placeholder="from YYYY-MM-DD" aria-label="From" onChange={(e) => edit({ ...f, from: e.target.value.trim() })} onKeyDown={onEnter} />
          <Input size="sm" value={f.to || ""} placeholder="to YYYY-MM-DD" aria-label="To" onChange={(e) => edit({ ...f, to: e.target.value.trim() })} onKeyDown={onEnter} />
        </div>
        <div className="flex justify-end pt-1"><Button size="sm" onClick={close}>Done</Button></div>
      </>
    );
  }

  return (
    <span className="inline-flex h-7 items-stretch rounded-md border border-kumo-hairline bg-kumo-base text-sm leading-none">
      <Popover open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger render={<button type="button" className="flex items-center rounded-l-md px-2 text-kumo-strong hover:bg-kumo-tint" aria-haspopup="dialog" />}>
          {label}
        </Popover.Trigger>
        <Popover.Content align="start" className="flex w-72 flex-col gap-2 p-3">{editor}</Popover.Content>
      </Popover>
      <button type="button" aria-label={`Remove filter: ${label}`} onClick={onRemove}
        className="flex items-center rounded-r-md border-l border-kumo-hairline px-1.5 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-strong">
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}
