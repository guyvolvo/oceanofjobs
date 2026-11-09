// The companies directory (/companies). The list is /api/companies/
// directory under the chosen filters; a picked company opens in a panel
// beside it (a sheet over it on a phone). ?company=<domain> opens with
// that company selected, so a company has a shareable address.
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Buildings } from "@phosphor-icons/react";
import { pub } from "../api";
import { Workspace } from "../site/Workspace";
import { CompanyPanel, Logo } from "./CompanyPanel";
import { atsKey, atsName, Bone, COUNTRY_KEY, countryQuery, FOLLOW_KEY, fmt, type Country, type Directory as Dir, type Row } from "./data";

const PAGE = 50;
const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((l) => [l, l.toLowerCase()]).concat([["0-9", "0-9"]]);
const SORTS = { roles: "Most open jobs", new: "Most new this week", name: "Name" };
type Sort = keyof typeof SORTS;
type Ats = { key: string; label: string; n: number };

const readCountry = () => { try { return localStorage.getItem(COUNTRY_KEY) || ""; } catch { return ""; } };
const readFollow = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(FOLLOW_KEY) || "[]")); } catch { return new Set<string>(); } };
const readWanted = () => { const u = new URL(location.href); return u.searchParams.get("company") || decodeURIComponent(u.hash.slice(1)) || null; };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* per-browser nicety only */ } };

// A row's trend: the last seven days of open roles as one line. Fewer
// than two days on record draws nothing rather than a dot.
function RowSpark({ trend }: { trend?: (number | null)[] }) {
  const pts = (trend || []).map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 2) return null;
  const w = 90, h = 28, n = (trend || []).length - 1;
  const vals = pts.map(([, v]) => v);
  const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${(i / n * w).toFixed(1)} ${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={`h-7 w-[90px] ${up ? "text-kumo-success" : "text-kumo-danger"}`}
      aria-label={`Open jobs over seven days, ${fmt(vals[0])} to ${fmt(vals[vals.length - 1])}`}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// On a phone the trend column goes; the rest stays on one line.
const ROW = "grid grid-cols-[44px_minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2.5 md:grid-cols-[44px_minmax(0,1fr)_90px_auto_auto] md:px-6";

export function Directory() {
  const [country, setCountry] = useState(readCountry);
  const [countries, setCountries] = useState<Country[] | null>(null);
  const [directory, setDirectory] = useState<Dir | null>(null);
  const [failed, setFailed] = useState(false);
  const [found, setFound] = useState<Row[]>([]);
  const [following, setFollowing] = useState(readFollow);
  const [ats, setAts] = useState<string[]>([]);
  const [view, setView] = useState<"hiring" | "following">("hiring");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("roles");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(readWanted);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pub<{ locations?: Country[] }>("/facets?confidence=all")
      .then((f) => setCountries((f.locations || []).map(({ value, label, n }) => ({ value, label, n }))))
      .catch(() => setCountries([]));
  }, []);

  useEffect(() => {
    let live = true;
    setDirectory(null); setFailed(false); setFound([]); setShown(PAGE);
    pub<Dir>(`/companies/directory?confidence=all${countryQuery(country)}`)
      .then((d) => { if (live) setDirectory(d); })
      .catch((e) => { if (live) { console.error("companies directory:", e); setFailed(true); } });
    return () => { live = false; };
  }, [country]);

  // The list holds the top 500, filtered here as you type; the server
  // adds the rest a moment later.
  useEffect(() => {
    const want = q.toLowerCase();
    if (want.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      pub<Dir>(`/companies/directory?confidence=all&name=${encodeURIComponent(want)}${countryQuery(country)}`)
        .then((d) => { if (live) setFound(d.companies || []); }).catch(() => { /* the list's own matches stand */ });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [q, country]);

  useEffect(() => {
    const u = new URL(location.href);
    if (selected) u.searchParams.set("company", selected); else u.searchParams.delete("company");
    u.hash = "";
    history.replaceState(null, "", u.pathname + u.search);
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "");
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      // Escape inside a Kumo popup (combobox, select) is that popup's.
      else if (e.key === "Escape" && !t.closest("[role=combobox],[role=listbox],[role=dialog]")) setSelected(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const countryName = (code: string) => countries?.find((c) => c.value === code)?.label || code;
  const where = country ? ` in ${countryName(country)}` : "";

  const atsCounts = useMemo<Ats[]>(() => {
    const counts: Record<string, number> = {};
    for (const r of directory?.companies || []) { const k = atsKey(r.ats); if (k) counts[k] = (counts[k] || 0) + 1; }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, label: atsName(key), n }));
  }, [directory]);

  const rows = useMemo(() => {
    const base = directory?.companies || [];
    const have = new Set(base.map((c) => c.domain));
    let out = [...base, ...(q ? found.filter((c) => !have.has(c.domain)) : [])].map((c) => ({ ...c, name: c.name || c.domain }));
    if (view === "following") out = out.filter((r) => following.has(r.domain));
    if (ats.length) out = out.filter((r) => r.ats && ats.includes(atsKey(r.ats)!));
    if (q) {
      const s = q.toLowerCase();
      out = out.filter((r) => r.name.toLowerCase().includes(s) || r.domain.includes(s.replace(/ /g, "")) || atsName(r.ats).toLowerCase().includes(s));
    }
    const byName = (a: Row, b: Row) => (a.name || "").localeCompare(b.name || "");
    out.sort(sort === "name" ? byName
      : sort === "new" ? (a, b) => (b.new_7d || 0) - (a.new_7d || 0) || b.n - a.n || byName(a, b)
      : (a, b) => b.n - a.n || byName(a, b));
    return out;
  }, [directory, found, q, view, following, ats, sort]);

  const toggleFollow = (domain: string) => {
    const next = new Set(following);
    next.has(domain) ? next.delete(domain) : next.add(domain);
    setFollowing(next);
    remember(FOLLOW_KEY, JSON.stringify([...next]));
  };
  const pickCountry = (code: string) => { setCountry(code); remember(COUNTRY_KEY, code); };
  const reset = () => { pickCountry(""); setView("hiring"); setQ(""); setAts([]); setShown(PAGE); };
  const dirty = !!(country || ats.length || view !== "hiring" || q);

  const countryItems = useMemo<Country[]>(() => {
    const all = countries || [];
    // The chosen country first, whatever its size.
    return [{ value: "", label: "Anywhere", n: 0 }, ...all.filter((c) => c.value === country), ...all.filter((c) => c.value !== country)];
  }, [countries, country]);
  const countryValue = countryItems.find((c) => c.value === country) || { value: country, label: countryName(country), n: 0 };

  const picked = selected ? rows.find((r) => r.domain === selected) || { domain: selected, name: selected, n: null as unknown as number, ats: null } : null;
  const head = failed ? "Couldn't load companies"
    : !directory ? null
    : view === "following" ? `${fmt(rows.length)} companies you follow${where}`
    : q ? `${fmt(rows.length)} companies match${where}`
    : `Top ${fmt(rows.length)} companies by open jobs${where}`;

  return (
    <Workspace current="companies" bare>
      <div className="border-b border-kumo-hairline px-4 pt-5 pb-3 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="m-0 text-[26px] font-semibold leading-tight tracking-tight text-kumo-strong">Companies</h1>
          <Input ref={searchRef} type="search" aria-label="Search companies" placeholder="Search companies, domains or hiring systems" autoComplete="off"
            className="w-full md:w-80" value={q} onChange={(e) => { setQ(e.target.value.trim()); setShown(PAGE); }} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Tabs size="sm" value={view} onValueChange={(v) => { setView(v as "hiring" | "following"); setShown(PAGE); }}
            tabs={[{ value: "hiring", label: `Hiring now${directory ? ` · ${fmt(directory.companies.length)}` : ""}` }, { value: "following", label: `Following · ${fmt(following.size)}` }]} />
          <Combobox<Country, false> size="sm" items={countryItems} value={countryValue} isItemEqualToValue={(a, b) => a.value === b.value} itemToStringLabel={(c) => c.label}
            onValueChange={(v) => { pickCountry(v?.value || ""); setShown(PAGE); }}>
            {/* The name goes on the trigger itself; TriggerValue's own props land on the value span. */}
            <Combobox.TriggerValue className="w-44" render={<button type="button" aria-label="Location" />} />
            <Combobox.Content>
              <Combobox.Input placeholder="Search countries" />
              <Combobox.Empty>No results</Combobox.Empty>
              <Combobox.List>
                {(c: Country) => <Combobox.Item key={c.value} value={c}><span className="flex w-full justify-between gap-3"><span>{c.label}</span>{c.value ? <span className="text-kumo-subtle">{fmt(c.n)}</span> : null}</span></Combobox.Item>}
              </Combobox.List>
            </Combobox.Content>
          </Combobox>
          <Combobox<Ats, true> multiple size="sm" items={atsCounts} value={atsCounts.filter((a) => ats.includes(a.key))} isItemEqualToValue={(a, b) => a.key === b.key} itemToStringLabel={(a) => a.label}
            onValueChange={(v) => { setAts(v.map((a) => a.key)); setShown(PAGE); }}>
            <Combobox.TriggerValue className="w-52" render={<button type="button" aria-label="Hiring system" />}>
              {(v: Ats[]) => <span className={`truncate ${v.length ? "" : "text-kumo-placeholder"}`}>{v.length ? v.map((a) => a.label).join(", ") : "Hiring system"}</span>}
            </Combobox.TriggerValue>
            <Combobox.Content>
              <Combobox.Input placeholder="Search hiring systems" />
              <Combobox.Empty>{directory ? "No results" : "Loading"}</Combobox.Empty>
              <Combobox.List>
                {(a: Ats) => <Combobox.Item key={a.key} value={a}><span className="flex w-full justify-between gap-3"><span>{a.label}</span><span className="text-kumo-subtle">{fmt(a.n)}</span></span></Combobox.Item>}
              </Combobox.List>
            </Combobox.Content>
          </Combobox>
          <Select size="sm" aria-label="Sort companies" className="w-44" value={sort} onValueChange={(v) => setSort((v as Sort) || "roles")} items={SORTS} />
          {dirty ? <Button variant="ghost" size="sm" onClick={reset}>Reset</Button> : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1" aria-label="Companies">
          <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2 md:px-6">
            {head ? <p className="m-0 text-sm font-medium text-kumo-strong">{head}{failed ? <span className="font-normal text-kumo-subtle"> Try again in a minute.</span> : null}</p> : <div className="w-60"><Bone w={100} h={20} /></div>}
          </div>
          <div className={`${ROW} py-1 text-xs text-kumo-subtle`} aria-hidden="true"><span /><span>Company</span><span className="hidden md:block">Trend</span><span /><span className="text-right">Open jobs</span></div>
          <div role="list" className="divide-y divide-kumo-hairline border-t border-kumo-hairline">
            {!directory && !failed ? Array.from({ length: 10 }, (_, i) => (
              <div key={i} className={ROW} aria-hidden="true">
                <span className="size-11 rounded-xl bg-kumo-tint" />
                <div><Bone w={[55, 40, 66, 48][i % 4]} h={18} /><Bone w={[70, 58, 76, 62][i % 4]} h={14} /></div>
                <span /><span />
              </div>
            )) : rows.slice(0, shown).map((r) => {
              const on = r.domain === selected;
              const fol = following.has(r.domain);
              return (
                <div key={r.domain} role="listitem" className={`${ROW} cursor-pointer ${on ? "bg-kumo-success-tint" : "hover:bg-kumo-tint"}`} onClick={() => setSelected(on ? null : r.domain)}>
                  <Logo row={r} />
                  <div className="min-w-0">
                    <button type="button" className="block max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-base font-medium text-kumo-strong" aria-expanded={on}>{r.name}</button>
                    <div className="truncate text-sm text-kumo-subtle">{r.domain} · {atsName(r.ats)}</div>
                  </div>
                  <div className="hidden md:block"><RowSpark trend={r.trend} /></div>
                  <div>
                    <Button variant={fol ? "secondary" : "ghost"} size="xs" aria-pressed={fol} aria-label={`${fol ? "Unfollow" : "Follow"} ${r.name}`}
                      onClick={(e) => { e.stopPropagation(); toggleFollow(r.domain); }}>{fol ? "Following" : "Follow"}</Button>
                  </div>
                  <div className="text-right"><b className="block font-semibold text-kumo-strong">{fmt(r.n)}</b><span className={`text-xs ${r.new_7d ? "text-kumo-success" : "text-kumo-subtle"}`}>{r.new_7d ? `+${fmt(r.new_7d)} this week` : "open jobs"}</span></div>
                </div>
              );
            })}
          </div>
          {directory && rows.length > shown ? (
            <div className="flex justify-center py-4"><Button variant="ghost" size="sm" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</Button></div>
          ) : null}
          {directory && !rows.length ? (
            <Empty size="sm" icon={<Buildings size={32} className="text-kumo-inactive" />} title={view === "following" && !following.size ? "You don't follow any companies yet" : "No companies match"}
              description={view === "following" && !following.size ? "Select Follow on a company under Hiring now." : undefined} />
          ) : null}
          {/* Plain links, so a crawler can reach every company page without running this bundle. */}
          <nav className="flex flex-wrap gap-x-3 gap-y-1 px-4 py-6 font-mono text-xs md:px-6" aria-label="All companies by first letter">
            {LETTERS.map(([label, path]) => <a key={path} className="text-kumo-subtle hover:text-kumo-link" href={`/companies/${path}`}>{label}</a>)}
          </nav>
        </section>

        <aside aria-label="Company" className={`${picked ? "fixed inset-0 z-40 flex" : "hidden"} flex-col bg-kumo-base md:sticky md:top-0 md:z-auto md:flex md:h-dvh md:w-[420px] md:shrink-0 md:border-l md:border-kumo-hairline lg:w-[460px]`}>
          {picked ? <CompanyPanel key={picked.domain} row={picked} country={country} countryName={countryName(country)} onClose={() => setSelected(null)} /> : (
            <>
              <div className="border-b border-kumo-hairline px-4 py-2.5 text-sm"><span className="font-medium text-kumo-strong">Company</span><span className="text-kumo-subtle"> · {country ? countryName(country) : "Everywhere"}</span></div>
              <Empty size="sm" icon={<Buildings size={32} className="text-kumo-inactive" />} title="Select a company" description="Its numbers and newest jobs show here." />
            </>
          )}
        </aside>
      </div>
    </Workspace>
  );
}
