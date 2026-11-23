// The places under the Location box: countries with their cities as a
// tree (React Aria), several at once, with type-ahead and checkboxes. A
// country with some of its cities picked shows as mixed. What is typed in
// the box narrows the tree here and asks the server for more places
// (/api/places/search, store.placeSearch). Loaded on first use.
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Tree, TreeItem, TreeItemContent, type Key, type Selection } from "react-aria-components";
import { CaretRight, Check, Minus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { F, U, placeCountries, placeSearch, railToggle } from "./store";
import { cityCountry, cityKey, countryLabel, fmtInt, type City, type Country } from "./util";

type Node = { country: Country; cities: City[] };

// Nothing typed: every country with jobs, the picked ones first. Typed:
// countries whose name has it (all their cities) and the cities that have
// it, under their country; names that start with it first, then the most jobs.
function nodes(raw: string): Node[] {
  const q = raw.trim().toLowerCase();
  const countries = placeCountries();
  const name = (c: Country) => (c.label || countryLabel(c.value)).toLowerCase();
  const on = (c: Country) => F.country.includes(c.value) || F.city.some((t) => cityCountry(t) === c.value);
  if (!q) return [...countries.filter(on), ...countries.filter((c) => !on(c) && c.n != null)].map((c) => ({ country: c, cities: c.cities }));
  const hits: (Node & { at: number; n: number })[] = [];
  for (const c of countries) {
    const at = name(c).indexOf(q);
    const cities = at >= 0 ? c.cities : c.cities.filter((t) => (t.label || t.value).toLowerCase().includes(q));
    if (at < 0 && !cities.length) continue;
    const cityAt = Math.min(...cities.map((t) => (t.label || t.value).toLowerCase().indexOf(q)).filter((i) => i >= 0), 99);
    hits.push({ country: c, cities, at: at >= 0 ? at : cityAt, n: c.n || 0 });
  }
  return hits.sort((a, b) => Number(a.at > 0) - Number(b.at > 0) || b.n - a.n).slice(0, 40);
}

function Box({ checked, mixed }: { checked: boolean; mixed: boolean }) {
  return (
    <span className={cn("grid size-4 flex-none place-items-center rounded-sm border border-input text-primary-foreground", (checked || mixed) && "border-primary bg-primary")}>
      {checked ? <Check size={12} weight="bold" /> : mixed ? <Minus size={12} weight="bold" /> : null}
    </span>
  );
}

const row = "group flex min-h-8 cursor-pointer items-center gap-2 rounded-sm pr-2 font-ui text-[15px] text-foreground outline-none data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-ring data-[hovered]:bg-muted";
const count = "ml-auto shrink-0 pl-3 text-xs tabular-nums text-muted-foreground";

export default function LocationPanel({ open, query, onClose }: { open: boolean; query: string; onClose: (refocus: boolean) => void }) {
  useEffect(() => { if (open) placeSearch(query); }, [open, query]);
  const list = useMemo(() => nodes(query), [query, U.facets, U.placeFound, F.country, F.city]); // eslint-disable-line react-hooks/exhaustive-deps
  const [opened, setOpened] = useState<Set<Key>>(() => new Set(F.city.map((t) => cityCountry(t) || "")));
  // Typed: every country with a matching city is open.
  const expanded = useMemo(() => (query.trim() ? new Set<Key>([...opened, ...list.filter((n) => n.cities.length).map((n) => n.country.value)]) : opened), [query, list, opened]);
  // A country is ticked when it is picked whole; with some of its cities
  // picked it is mixed, and the cities are ticked.
  const narrowed = new Set(F.city.map(cityCountry));
  const selected = new Set<Key>([...F.country.filter((c) => !narrowed.has(c)), ...F.city]);
  const change = (keys: Selection) => {
    if (keys === "all") return;
    const next = keys as Set<Key>;
    for (const k of next) if (!selected.has(k)) return railToggle(cityCountry(String(k)) ? "city" : "country", String(k), true);
    for (const k of selected) if (!next.has(k)) return railToggle(cityCountry(String(k)) ? "city" : "country", String(k), false);
  };
  if (!open) return null;
  return (
    <div className="absolute top-[calc(100%+8px)] left-0 z-40 w-[min(420px,calc(100vw-32px))] rounded-lg border bg-card p-1.5"
      onKeyDownCapture={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(true); } }}>
      <Tree id="f-location-list" aria-label="Places" selectionMode="multiple" selectedKeys={selected} onSelectionChange={change}
        expandedKeys={expanded} onExpandedChange={(k) => setOpened(new Set(k))}
        className="max-h-[min(360px,60vh)] overflow-y-auto overscroll-contain outline-none"
        renderEmptyState={() => <p className="m-0 px-2 py-1.5 font-ui text-sm text-muted-foreground">{U.placeAsking ? "Looking for places" : "No results"}</p>}>
        {list.map(({ country: c, cities }) => {
          const label = c.label || countryLabel(c.value);
          return (
            <TreeItem key={c.value} id={c.value} textValue={label} className={cn(row, "pl-1")}>
              <TreeItemContent>
                {({ isSelected, isExpanded }) => (
                  <>
                    {cities.length ? (
                      <Button slot="chevron" aria-label={isExpanded ? `Hide cities in ${label}` : `Show cities in ${label}`}
                        className="grid size-6 flex-none cursor-pointer place-items-center rounded-sm text-muted-foreground outline-none hover:text-foreground data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring">
                        <CaretRight size={12} weight="bold" className={cn("transition-transform", isExpanded && "rotate-90")} />
                      </Button>
                    ) : <span className="size-6 flex-none" />}
                    <Checkbox slot="selection" className="flex"><Box checked={isSelected} mixed={!isSelected && narrowed.has(c.value)} /></Checkbox>
                    <span className="min-w-0 truncate">{label}</span>
                    {c.n == null ? null : <span className={count}>{fmtInt(c.n)}</span>}
                  </>
                )}
              </TreeItemContent>
              {cities.map((t) => {
                const key = cityKey(c.value, t.value);
                return (
                  <TreeItem key={key} id={key} textValue={t.label || t.value} className={cn(row, "pl-8")}>
                    <TreeItemContent>
                      {({ isSelected }) => (
                        <>
                          <Checkbox slot="selection" className="flex"><Box checked={isSelected} mixed={false} /></Checkbox>
                          <span className="min-w-0 truncate">{t.label || t.value}</span>
                          {t.n == null ? null : <span className={count}>{fmtInt(t.n)}</span>}
                        </>
                      )}
                    </TreeItemContent>
                  </TreeItem>
                );
              })}
            </TreeItem>
          );
        })}
      </Tree>
    </div>
  );
}
