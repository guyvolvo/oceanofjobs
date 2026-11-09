// The search box, the places box, the filter pills (each one a popover
// over the board), the active chips, and the phone's bar and sheet.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Popover } from "@cloudflare/kumo/components/popover";
import { Select } from "@cloudflare/kumo/components/select";
import { Slider } from "@cloudflare/kumo/components/slider";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Bell, CaretDown, FunnelSimple, MagnifyingGlass, MapPin, X } from "@phosphor-icons/react";
import { requestSignIn } from "../site/auth";
import { signedIn } from "../api";
import { F, RAIL_GROUPS, RAIL_TOP_N, U, activeChips, anythingOn, applySearchNow, clearPlaces, commitSalary, openAlerts, openSheet, placeCountries, placeSearch,
  railLabel, railRows, railSearch, railSelected, railToggle, railVisibleRows, removeChip, resetAll, setDatePosted, setRailOpen, setSort, toggleExpanded, typeSearch,
  type RailGroup } from "./store";
import { SENIORITY_LABELS, WORKPLACE_LABELS, cityCountry, cityKey, countryLabel, fmtInt, fmtShekels, type Country } from "./util";
import { Categories, SavedSearches, ViewSwitch } from "./Side";

// what

export function SearchBox() {
  const [value, setValue] = useState(F.search);
  useEffect(() => setValue(F.search), [F.search]);
  useEffect(() => {
    // "/" focuses the box, unless the reader is typing somewhere already.
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
    <div className="relative min-w-0 flex-1" role="search">
      <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2 text-kumo-subtle" size={15} aria-hidden="true" />
      <Input id="f-search" name="search" autoComplete="off" placeholder="Job, company or skill" aria-label="Search" className="pl-8 pr-8"
        title='Every word must appear somewhere in the listing: title, company, location, category or description. "Quote a phrase" to keep it together.'
        value={value}
        onChange={(e) => { setValue(e.target.value); typeSearch(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); applySearchNow(value); }
          else if (e.key === "Escape" && value) { e.stopPropagation(); setValue(""); applySearchNow(""); }
        }} />
      {value ? (
        <button type="button" aria-label="Clear search" onClick={() => { setValue(""); applySearchNow(""); document.getElementById("f-search")?.focus(); }}
          className="absolute top-1/2 right-1.5 z-10 grid h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded-[4px] border-0 bg-transparent text-kumo-subtle hover:bg-kumo-tint">
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

// where

type Place = { key: string; kind: "country" | "city"; label: string; sub?: string; n: number | null };

// With nothing typed: every country, the ones that are on first, each
// followed by its cities when on. Typed: the places whose names contain
// it, names that start with it first, then the most jobs.
function placeMatches(raw: string): Place[] {
  const q = raw.trim().toLowerCase();
  const countries = placeCountries();
  const cityOn = (c: Country) => c.cities.some((t) => F.city.includes(cityKey(c.value, t.value)));
  const isOn = (c: Country) => F.country.includes(c.value) || cityOn(c);
  const name = (c: Country) => c.label || countryLabel(c.value);
  const row = (c: Country): Place => ({ key: c.value, kind: "country", label: name(c), n: c.n });
  const city = (c: Country, t: Country["cities"][number], sub?: string): Place => ({ key: cityKey(c.value, t.value), kind: "city", label: t.label || t.value, sub, n: t.n });
  if (!q) {
    return [...countries.filter(isOn), ...countries.filter((c) => !isOn(c) && c.n != null)]
      .flatMap((c) => [row(c), ...(isOn(c) ? c.cities.map((t) => city(c, t)) : [])]);
  }
  const hits: { p: Place[]; at: number; n: number | null }[] = [];
  for (const c of countries) {
    const at = name(c).toLowerCase().indexOf(q);
    if (at >= 0) hits.push({ p: [row(c), ...(isOn(c) ? c.cities.map((t) => city(c, t)) : [])], at, n: c.n });
    if (at >= 0 && isOn(c)) continue;
    for (const t of c.cities) {
      const i = (t.label || t.value).toLowerCase().indexOf(q);
      if (i >= 0) hits.push({ p: [city(c, t, name(c))], at: i, n: t.n });
    }
  }
  return hits.sort((a, b) => Number(a.at > 0) - Number(b.at > 0) || (b.n || 0) - (a.n || 0)).slice(0, 40).flatMap((h) => h.p);
}

export function LocationBox() {
  const [query, setQuery] = useState("");
  const items = useMemo(() => placeMatches(query), [query, U.facets, U.placeFound, F.country, F.city]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = useMemo<Place[]>(() => {
    const byKey = new Map(items.map((p) => [p.key, p]));
    const all = [...F.country.filter((c) => !F.city.some((t) => cityCountry(t) === c)), ...F.city];
    return all.map((k) => byKey.get(k) || { key: k, kind: cityCountry(k) ? "city" : "country", label: cityCountry(k) ? k.slice(3) : countryLabel(k), n: null });
  }, [items, F.country, F.city]); // eslint-disable-line react-hooks/exhaustive-deps
  const onChange = (next: Place[]) => {
    const was = new Set(chosen.map((p) => p.key));
    const now = new Set(next.map((p) => p.key));
    for (const p of next) if (!was.has(p.key)) return railToggle(p.kind, p.key, true);
    for (const p of chosen) if (!now.has(p.key)) return railToggle(p.kind, p.key, false);
  };
  return (
    <div className="relative min-w-0 flex-1">
      <MapPin className="pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2 text-kumo-subtle" size={15} aria-hidden="true" />
      <Combobox<Place, true> multiple items={items} value={chosen} onValueChange={(v) => onChange(v as Place[])}
        isItemEqualToValue={(a, b) => a.key === b.key} itemToStringLabel={(p) => p.label} filter={null}
        inputValue={query} onInputValueChange={(v) => { setQuery(v); placeSearch(v); }} aria-label="Location">
        <Combobox.TriggerMultipleWithInput className="pl-7" placeholder={chosen.length ? "" : "Location"}
          renderItem={(p: Place) => <Combobox.Chip key={p.key} removeLabel={`Remove ${p.label}`}>{p.kind === "city" ? p.label : p.label}</Combobox.Chip>} />
        <Combobox.Content className="max-h-[min(360px,60vh)] w-[min(420px,92vw)] overflow-y-auto">
          <Combobox.Empty>{U.placeAsking ? <span className="inline-flex items-center gap-2"><Loader size="sm" /> Looking for places</span> : "No results"}</Combobox.Empty>
          <Combobox.List>
            {(p: Place) => (
              <Combobox.Item key={p.key} value={p} className={p.kind === "city" && !p.sub ? "pl-7" : undefined}>
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="truncate">{p.label}{p.sub ? <span className="text-kumo-subtle">, {p.sub}</span> : null}</span>
                  {p.n == null ? null : <span className="font-mono text-xs text-kumo-subtle">{fmtInt(p.n)}</span>}
                </span>
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Content>
      </Combobox>
      {F.country.length || F.city.length ? (
        <button type="button" aria-label="Clear location" onClick={clearPlaces}
          className="absolute top-1/2 right-1.5 z-10 grid h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded-[4px] border-0 bg-transparent text-kumo-subtle hover:bg-kumo-tint">
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

// the pills

function Option({ label, n, checked, mixed, onChange, mark }: { label: string; n: number | null; checked: boolean; mixed?: boolean; onChange: (on: boolean) => void; mark?: string }) {
  const i = mark ? label.toLowerCase().indexOf(mark) : -1;
  const text = i < 0 ? label : <>{label.slice(0, i)}<b className="font-semibold">{label.slice(i, i + mark!.length)}</b>{label.slice(i + mark!.length)}</>;
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <Checkbox checked={checked} indeterminate={mixed} onCheckedChange={(c) => onChange(c === true)} label={<span className="truncate">{text}</span>} />
      {n == null ? null : <span className="shrink-0 font-mono text-xs text-kumo-subtle">{fmtInt(n)}</span>}
    </div>
  );
}

function ListGroup({ group }: { group: RailGroup }) {
  const rows = railVisibleRows(group);
  const picked = railSelected(group);
  const pool = railRows(group);
  const q = U.railQueries.get(group.key) || "";
  if (!pool.length && !picked.size && !q) {
    if (U.facetsLoaded) return null;
    return <div className="flex flex-col gap-2 py-1">{Array.from({ length: RAIL_TOP_N }, (_, i) => <SkeletonLine key={i} minWidth={50} maxWidth={90} />)}</div>;
  }
  const search = (group as { search?: string }).search;
  return (
    <div className="flex flex-col gap-1">
      {search ? <Input size="sm" type="search" placeholder={search} aria-label={search} autoComplete="off" value={q} onChange={(e) => railSearch(group.key, e.target.value)} /> : null}
      {rows.length ? rows.map((r) => (
        <Option key={r.value} label={railLabel(group, r)} n={r.n} checked={picked.has(r.value)} mark={q.trim().toLowerCase()}
          onChange={(on) => railToggle(group.key, r.value, on)} />
      )) : <p className="m-0 py-1 text-sm text-kumo-subtle">No results</p>}
      {!q && pool.length > RAIL_TOP_N ? (
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => toggleExpanded(group.key)}>
          {U.railExpanded.has(group.key) ? "Show fewer" : `Show all (${fmtInt(pool.length)})`}
        </Button>
      ) : null}
    </div>
  );
}

// Two handles over the range this result set occupies; the track is
// left out when nothing is in shekels. Disclosed stands on its own.
function SalaryGroup() {
  const s = U.facets.salary;
  const track = s && s.min != null && s.max != null && s.max > s.min;
  const lo = track ? Number(F.salary_min) || s.min : 0;
  const hi = track ? Number(F.salary_max) || s.max : 0;
  const [range, setRange] = useState<[number, number]>([lo, hi]);
  useEffect(() => setRange([lo, hi]), [lo, hi]);
  return (
    <div className="flex flex-col gap-2">
      {track ? (
        <>
          <Slider size="sm" min={s.min} max={s.max} step={1000} value={range} className="w-full"
            getAriaLabel={(i) => (i === 0 ? "Lowest monthly salary" : "Highest monthly salary")}
            onValueChange={(v) => setRange([...(v as number[])] as [number, number])}
            onValueCommitted={(v: number | readonly number[]) => { const [a, b] = v as number[]; commitSalary(a, b); }} />
          <div className="flex justify-between font-mono text-xs text-kumo-subtle"><span>{fmtShekels(range[0])}</span><span>{fmtShekels(range[1])}{range[1] >= s.max ? "+" : ""}</span></div>
          <Option label="Estimated salary" n={s.known} checked={F.salary_known} onChange={(on) => railToggle("salary_known", "1", on)} />
        </>
      ) : null}
      <Option label="Disclosed salary only" n={U.facets.salary_disclosed || 0} checked={F.salary_disclosed} onChange={(on) => railToggle("salary_disclosed", "1", on)} />
    </div>
  );
}

const PILLS = [
  { key: "work", title: "Work type", body: () => <ListGroup group={RAIL_GROUPS[2]} />, summary: () => F.workplace.map((v) => WORKPLACE_LABELS[v] || v) },
  { key: "pay", title: "Salary", body: () => <SalaryGroup />, summary: () => {
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
  { key: "employer", title: "Company", body: () => <ListGroup group={RAIL_GROUPS[3]} />, summary: () => activeChips().filter((c) => c.kind === "company").map((c) => c.text) },
  { key: "level", title: "Experience level", body: () => <ListGroup group={RAIL_GROUPS[1]} />, summary: () => F.seniority.map((v) => SENIORITY_LABELS[v] || v) },
];

function Pill({ pill }: { pill: (typeof PILLS)[number] }) {
  const open = U.railOpen === pill.key;
  const sum = pill.summary().join(" · ");
  return (
    <Popover open={open} onOpenChange={(o) => setRailOpen(o ? pill.key : null)}>
      <Popover.Trigger render={<Button variant={sum ? "primary" : "secondary"} size="sm" />}>
        <span className="flex items-center gap-1.5">
          <span>{pill.title}</span>
          {sum ? <span className="max-w-[160px] truncate opacity-80">{sum}</span> : null}
          <CaretDown size={12} aria-hidden="true" />
        </span>
      </Popover.Trigger>
      <Popover.Content align="start" className="w-[min(320px,92vw)] p-3">
        {pill.body()}
      </Popover.Content>
    </Popover>
  );
}

// Between 800 and 1100px the board's own column has no room, so its
// three sections sit behind one more pill.
function ViewsPill() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={<Button variant="secondary" size="sm" />}>
        <span className="flex items-center gap-1.5">Views <CaretDown size={12} aria-hidden="true" /></span>
      </Popover.Trigger>
      <Popover.Content align="start" className="w-[min(300px,92vw)] p-3">
        <div className="flex flex-col gap-4">
          <ViewSwitch onPick={() => setOpen(false)} />
          <section><h3 className="m-0 mb-1 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Categories</h3><Categories /></section>
          <section><h3 className="m-0 mb-1 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Saved searches</h3><SavedSearches onPick={() => setOpen(false)} /></section>
        </div>
      </Popover.Content>
    </Popover>
  );
}

export function AlertButton({ className = "" }: { className?: string }) {
  return (
    <Button variant="secondary" size="sm" icon={<Bell />} className={className} onClick={() => (signedIn() ? openAlerts(true) : requestSignIn())}>
      Alert me for this search
    </Button>
  );
}

export function Pills() {
  return (
    <div className="hidden flex-wrap items-center gap-2 min-[801px]:flex">
      <div className="min-[1100px]:hidden"><ViewsPill /></div>
      {PILLS.map((p) => <Pill key={p.key} pill={p} />)}
      {anythingOn() ? <Button variant="ghost" size="sm" onClick={resetAll}>Reset</Button> : null}
      <AlertButton className="ml-auto" />
    </div>
  );
}

// the active chips (the phone's row; the pills say the same above 800px)

export function Chips() {
  const all = (F.roles !== "all" && !F.starred_only ? [{ kind: "roles", value: "", text: "Tech jobs" }] : []).concat(activeChips());
  if (!all.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 min-[801px]:hidden">
      {all.map((c) => (
        <button key={`${c.kind}:${c.value}`} type="button" title="Remove this filter" onClick={() => removeChip(c.kind, c.value)}
          className="inline-flex cursor-pointer items-center gap-1 rounded-[4px] border border-kumo-line bg-kumo-base px-2 py-0.5 text-xs text-kumo-default hover:bg-kumo-tint">
          <span>{c.text}</span><X size={10} aria-hidden="true" />
        </button>
      ))}
      <Button variant="ghost" size="xs" onClick={resetAll}>Reset</Button>
    </div>
  );
}

// sort and date

export function SortSelect({ size = "sm" }: { size?: "xs" | "sm" | "base" }) {
  const items: Record<string, string> = { ...(F.skills.length ? { "match:asc": "Best match" } : {}), "relevance:asc": "Relevance", "age:asc": "Newest", "age:desc": "Oldest" };
  const value = F.sort === "age" ? `age:${F.dir}` : F.sort === "match" ? "match:asc" : "relevance:asc";
  return (
    <Select aria-label="Sort by" size={size} items={items} value={items[value] ? value : "age:asc"}
      onValueChange={(v) => { const [key, dir] = String(v).split(":"); setSort(key, dir); }} />
  );
}
const DATES: Record<string, string> = { any: "Any date", "1": "Past 24 hours", "3": "Past 3 days", "7": "Past 7 days", "14": "Past 14 days", "30": "Past 30 days" };
export function DateSelect({ size = "sm" }: { size?: "xs" | "sm" | "base" }) {
  return <Select aria-label="Date posted" size={size} items={DATES} value={F.max_age_days || "any"} onValueChange={(v) => setDatePosted(String(v))} />;
}

// the phone's bar and sheet

export function MobileBar() {
  const n = (F.roles !== "all" && !F.starred_only ? 1 : 0) + activeChips().length;
  const total = U.jobs?.total;
  const count = U.empty ? "" : total == null ? (U.jobs ? `${fmtInt(U.jobs.jobs.length)}+ jobs` : "") : `${fmtInt(total)} jobs`;
  return (
    <div className="flex items-center gap-2 px-4 pb-2 min-[801px]:hidden">
      <Button variant="secondary" size="sm" icon={<FunnelSimple />} onClick={() => openSheet(true)} aria-haspopup="dialog" aria-expanded={U.sheetOpen}>
        Filters{n ? <Badge variant="primary" className="ml-1">{n}</Badge> : null}
      </Button>
      <SortSelect />
      <span className="ml-auto text-xs text-kumo-subtle" aria-live="polite">{count}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-kumo-hairline pt-3">
      <h3 className="m-0 mb-1.5 text-xs font-medium uppercase tracking-wide text-kumo-subtle">{title}</h3>
      {children}
    </section>
  );
}

export function Sheet() {
  const total = U.jobs?.total;
  const n = U.empty ? null : total == null ? null : fmtInt(total);
  return (
    <Dialog.Root open={U.sheetOpen} onOpenChange={openSheet}>
      <Dialog size="lg" className="flex max-h-[90dvh] flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <Dialog.Title className="m-0 text-base font-semibold">Filters</Dialog.Title>
          <span className="flex items-center gap-1">
            {anythingOn() ? <Button variant="ghost" size="sm" onClick={resetAll}>Reset</Button> : null}
            <Dialog.Close aria-label="Close filters" render={(p) => <Button {...p} variant="ghost" shape="square" size="sm" icon={<X />} aria-label="Close filters" />} />
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <ViewSwitch />
          <Section title="Category"><Categories /></Section>
          <Section title="Saved searches"><SavedSearches onPick={() => openSheet(false)} /></Section>
          <Section title="Date posted"><DateSelect size="base" /></Section>
          {PILLS.map((p) => <Section key={p.key} title={p.title}>{p.body()}</Section>)}
        </div>
        <div className="flex items-center gap-2 border-t border-kumo-hairline pt-3">
          <Button variant="primary" className="flex-1" onClick={() => openSheet(false)}>{n ? `Show ${n} jobs` : "Show jobs"}</Button>
          <AlertButton />
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
