// The companies directory (/companies). The list is /api/companies/
// directory under the chosen filters; a picked company opens in a panel
// beside it (a sheet over it below 1101px). ?company=<domain> or
// #<domain> opens with that company picked, so a company has a shareable
// address. The frame, the A to Z links and the empty panel are in the
// prerendered HTML; the list itself is fetched in the browser, as before.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PillSelect } from "@/components/pill-select";
import { CalendarBlank, CaretDown, MagnifyingGlass, MapPin, SlidersHorizontal } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { pub } from "../api";
import { Page } from "../shell/Page";
import { TabBar } from "../shell/TabBar";
import { atsKey, atsName, COUNTRY_KEY, countryQuery, FOLLOW_KEY, fmt, type Country, type Directory as Dir, type Row } from "./data";
import { Bone, Logo, RowSpark, SideGroups } from "./parts";

const CompanyPanel = lazy(() => import("./CompanyPanel").then((m) => ({ default: m.CompanyPanel })));
const SideDrawer = lazy(() => import("./SideDrawer").then((m) => ({ default: m.SideDrawer })));

const PAGE = 50;
const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((l) => [l, l.toLowerCase()]).concat([["0-9", "0-9"]]);
const SORTS = [["roles", "Most open jobs"], ["new", "Most new this week"], ["name", "Name"]] as const;
type Sort = (typeof SORTS)[number][0];
type PillKey = "place" | "ats";
type View = "hiring" | "following";

const readCountry = () => { try { return localStorage.getItem(COUNTRY_KEY) || ""; } catch { return ""; } };
const readFollow = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(FOLLOW_KEY) || "[]")); } catch { return new Set<string>(); } };
const readWanted = () => {
  const u = new URL(location.href);
  let hash = u.hash.slice(1);
  try { hash = decodeURIComponent(hash); } catch { /* a stray percent sign: use it raw */ }
  return u.searchParams.get("company") || hash || null;
};
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* per-browser nicety only */ } };

// One row's grid; the column heads use it too, so they sit over what they
// name. Below 641px the trend column goes.
const GRID = "grid grid-cols-[44px_minmax(0,1fr)_90px_auto_auto] items-center gap-x-3.5 px-4 max-[800px]:gap-x-2.5 max-[800px]:px-3 max-[640px]:grid-cols-[44px_minmax(0,1fr)_auto_auto]";
const ring = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const outlined = "border-[1.5px] border-input/40";

// A filter pill and its list under it (a sheet from the bottom on a phone).
function Pill({ id, icon, label, sum, open, onToggle, children }: { id: PillKey; icon: ReactNode; label: string; sum: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="relative flex-none max-[800px]:static" data-pill="">
      <button type="button" id={`pill-${id}`} aria-expanded={open} aria-controls={`pop-${id}`} onClick={onToggle}
        className={cn("inline-flex h-9 cursor-pointer items-center gap-2 rounded-full bg-card pr-3 pl-3.5 font-ui text-[15px] font-medium whitespace-nowrap text-foreground hover:bg-muted", outlined, ring,
          open && "border-primary bg-primary text-primary-foreground hover:bg-primary")}>
        {icon}{label}
        {sum ? <span className={cn("max-w-[220px] truncate text-sm font-normal", open ? "text-primary-foreground" : "text-link-hover")}>{sum}</span> : null}
        <CaretDown size={14} aria-hidden="true" />
      </button>
      <div id={`pop-${id}`} hidden={!open}
        className={cn("absolute top-[calc(100%+6px)] left-0 z-40 flex max-h-[min(78vh,720px)] w-[300px] flex-col rounded-lg border bg-popover p-2 animate-in fade-in-0 zoom-in-95",
          "max-[800px]:fixed max-[800px]:inset-x-0 max-[800px]:top-auto max-[800px]:bottom-0 max-[800px]:z-50 max-[800px]:max-h-[70dvh] max-[800px]:w-auto max-[800px]:rounded-b-none max-[800px]:border-b-0 max-[800px]:pb-[max(20px,env(safe-area-inset-bottom))] max-[800px]:slide-in-from-bottom-4")}>
        {children}
      </div>
    </div>
  );
}

const optClass = (on: boolean) => cn("flex min-h-9 w-full cursor-pointer items-center justify-between gap-3 rounded-sm border-0 bg-transparent px-2.5 text-left font-ui text-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
  on && "bg-accent font-semibold hover:bg-accent");
const optBones = [62, 48, 70, 55, 62, 48].map((w, i) => <div key={i} className="flex min-h-9 items-center px-2.5"><Bone w={`${w}%`} /></div>);

export function Directory() {
  const [ready, setReady] = useState(false);
  const [country, setCountry] = useState("");
  const [countries, setCountries] = useState<Country[] | null>(null);
  const [directory, setDirectory] = useState<Dir | null>(null);
  const [failed, setFailed] = useState(false);
  const [found, setFound] = useState<Row[]>([]);
  const [following, setFollowing] = useState<Set<string>>(() => new Set());
  const [ats, setAts] = useState<string[]>([]);
  const [view, setView] = useState<View>("hiring");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<Sort>("roles");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);
  const [pill, setPill] = useState<PillKey | null>(null);
  const [popQuery, setPopQuery] = useState<Record<PillKey, string>>({ place: "", ats: "" });
  const [drawer, setDrawer] = useState(false);
  const [drawerUsed, setDrawerUsed] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const drawerBtn = useRef<HTMLButtonElement>(null);
  // Picks made on this page (not the one in the address): those move focus into the sheet.
  const picks = useRef(0);
  const q = text.trim();

  // What only the browser knows, read once hydrated so the first render
  // matches the prerendered HTML: the saved country, the follows, the
  // company in the address, and whether the panel is a sheet.
  useEffect(() => {
    setCountry(readCountry());
    setFollowing(readFollow());
    setSelected(readWanted());
    setReady(true);
    const narrow = matchMedia("(max-width: 1100px)");
    const on = () => setOverlay(narrow.matches);
    on();
    narrow.addEventListener("change", on);
    return () => narrow.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    pub<{ locations?: Country[] }>("/facets?confidence=all")
      .then((f) => setCountries((f.locations || []).map(({ value, label, n }) => ({ value, label, n }))))
      .catch(() => setCountries([]));
  }, []);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    setDirectory(null); setFailed(false); setFound([]);
    pub<Dir>(`/companies/directory?confidence=all${countryQuery(country)}`)
      .then((d) => { if (live) setDirectory(d); })
      // Said plainly rather than bones for ever. The status goes to the
      // console; a reader can do nothing with a 503.
      .catch((e) => { if (live) { console.error("companies directory:", e); setFailed(true); } });
    return () => { live = false; };
  }, [ready, country]);

  // The list holds the top 500, filtered here as you type; the server
  // adds the rest a moment later.
  useEffect(() => {
    const want = q.toLowerCase();
    if (!ready || want.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      pub<Dir>(`/companies/directory?confidence=all&name=${encodeURIComponent(want)}${countryQuery(country)}`)
        .then((d) => { if (live) setFound(d.companies || []); }).catch(() => { /* the list's own matches stand */ });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [ready, q, country]);

  // The picked company is in the address, as ?company=.
  useEffect(() => {
    if (!ready) return;
    const u = new URL(location.href);
    if (selected) u.searchParams.set("company", selected); else u.searchParams.delete("company");
    u.hash = "";
    history.replaceState(history.state, "", u.pathname + u.search);
  }, [ready, selected]);

  // The sheet covers the page; the page holds still under it.
  useEffect(() => {
    if (!overlay || !selected) return;
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = was; };
  }, [overlay, selected]);

  const close = () => {
    const d = selected;
    setSelected(null);
    // Back to the row it was opened from.
    if (d && overlay) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-domain="${CSS.escape(d)}"] button`)?.focus({ preventScroll: true }));
  };

  // One pill open at a time; a click outside or Escape shuts it.
  useEffect(() => {
    if (!pill) return;
    const away = (e: PointerEvent) => { if (!(e.target as Element).closest?.("[data-pill]")) setPill(null); };
    document.addEventListener("pointerdown", away);
    // Not on a phone: the keyboard would take half the sheet as it opens.
    if (!matchMedia("(max-width: 800px)").matches) document.querySelector<HTMLInputElement>(`#pop-${pill} input`)?.focus({ preventScroll: true });
    return () => document.removeEventListener("pointerdown", away);
  }, [pill]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "")) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key !== "Escape" || drawer) return;
      if (pill) { setPill(null); document.getElementById(`pill-${pill}`)?.focus(); return; }
      if (selected) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const countryName = (code: string) => countries?.find((c) => c.value === code)?.label || code;
  const where = country ? ` in ${countryName(country)}` : "";

  const systems = useMemo(() => {
    if (!directory) return null;
    const counts: Record<string, number> = {};
    for (const r of directory.companies) { const k = atsKey(r.ats); if (k) counts[k] = (counts[k] || 0) + 1; }
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
    if (next.has(domain)) next.delete(domain); else next.add(domain);
    setFollowing(next);
    remember(FOLLOW_KEY, JSON.stringify([...next]));
  };
  const toggleSystem = (key: string) => { setAts(ats.includes(key) ? ats.filter((a) => a !== key) : [...ats, key]); setShown(PAGE); };
  const pickView = (v: View) => { setView(v); setShown(PAGE); };
  const pickCountry = (code: string) => { setCountry(code); remember(COUNTRY_KEY, code); setShown(PAGE); setPill(null); };
  const reset = () => { pickCountry(""); setView("hiring"); setText(""); setAts([]); };
  const dirty = !!(country || ats.length || view !== "hiring" || q);

  const hit = (key: PillKey, ...labels: string[]) => { const s = popQuery[key].trim().toLowerCase(); return !s || labels.some((l) => l.toLowerCase().includes(s)); };
  const placeOptions = countries == null ? optBones : (() => {
    // The chosen country first, whatever its size.
    const list = [...countries.filter((c) => c.value === country), ...countries.filter((c) => c.value !== country)].filter((c) => hit("place", c.label, c.value));
    const opts = [
      ...(hit("place", "Anywhere") ? [<button key="" type="button" className={optClass(!country)} aria-pressed={!country} onClick={() => pickCountry("")}><span>Anywhere</span></button>] : []),
      ...list.map((c) => (
        <button key={c.value} type="button" className={optClass(country === c.value)} aria-pressed={country === c.value} onClick={() => pickCountry(c.value)}>
          <span className="truncate">{c.label}</span><span className="flex-none text-xs font-normal text-muted-foreground">{fmt(c.n)}</span>
        </button>
      )),
    ];
    return opts.length ? opts : <div className="px-2.5 py-2 text-[13px] text-muted-foreground">No results</div>;
  })();
  const atsOptions = systems == null ? optBones : (() => {
    const opts = systems.filter((s) => hit("ats", s.label)).map((s) => (
      <button key={s.key} type="button" className={optClass(ats.includes(s.key))} aria-pressed={ats.includes(s.key)} onClick={() => toggleSystem(s.key)}>
        <span className="truncate">{s.label}</span><span className="flex-none text-xs font-normal text-muted-foreground">{fmt(s.n)}</span>
      </button>
    ));
    return opts.length ? opts : <div className="px-2.5 py-2 text-[13px] text-muted-foreground">No results</div>;
  })();
  const popSearch = (key: PillKey, placeholder: string) => (
    <Input type="search" placeholder={placeholder} aria-label={placeholder} autoComplete="off" className="mb-1.5 h-9 flex-none border-border"
      value={popQuery[key]} onChange={(e) => setPopQuery({ ...popQuery, [key]: e.target.value })} />
  );

  const side = {
    view, onView: pickView, hiringLabel: `Hiring now${where}`, hiringN: directory ? directory.companies.length : null,
    followingN: ready ? following.size : null, systems, picked: ats, onSystem: toggleSystem,
  };
  const picked = selected ? rows.find((r) => r.domain === selected) || { domain: selected, name: selected, n: null as unknown as number, ats: null } : null;
  const head = failed ? "Couldn't load companies"
    : !directory ? null
    : view === "following" ? `${fmt(rows.length)} companies you follow${where}`
    : q ? `${fmt(rows.length)} companies match${where}`
    : `Top ${fmt(rows.length)} companies by open jobs${where}`;

  return (
    <Page current="companies">
      <h1 className="sr-only">Companies</h1>
      <div className="min-[1101px]:grid min-[1101px]:grid-cols-[236px_minmax(0,1fr)]">
        <aside aria-label="Site" className="sticky top-16 hidden max-h-[calc(100dvh-64px)] flex-col gap-2.5 self-start overflow-y-auto pt-3.5 pb-4 pl-4 [scrollbar-width:none] min-[1101px]:flex">
          <SideGroups {...side} />
        </aside>

        <div className="flex min-w-0 flex-col gap-3 px-5 pt-3.5 max-[1100px]:px-4 max-[800px]:pt-2.5">
          {/* The search has the row to itself, so its placeholder fits whole. */}
          <div role="search" className="relative w-[560px] max-w-full min-w-0">
            <MagnifyingGlass size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input ref={searchRef} type="text" name="q" autoComplete="off" aria-label="Search companies" placeholder="Search companies, domains or hiring systems…"
              value={text} onChange={(e) => { setText(e.target.value); setShown(PAGE); }}
              className={cn("h-10 rounded-full bg-card pr-4 pl-10 text-ellipsis max-[800px]:h-11 max-[800px]:pr-3 max-[800px]:placeholder:text-sm", outlined)} />
          </div>

          <div className="flex items-center gap-2 max-[800px]:-mx-4 max-[800px]:overflow-x-auto max-[800px]:px-4 max-[800px]:[scrollbar-width:none]">
            <button ref={drawerBtn} type="button" aria-label="Filters" aria-expanded={drawer} aria-haspopup="dialog"
              onClick={() => { setDrawerUsed(true); setDrawer(true); }}
              className={cn("grid size-9 flex-none cursor-pointer place-items-center rounded-full bg-card text-foreground hover:bg-muted min-[1101px]:hidden", outlined, ring)}>
              <SlidersHorizontal size={18} aria-hidden="true" />
            </button>
            <Pill id="place" label="Location" icon={<MapPin size={16} aria-hidden="true" />} sum={country ? countryName(country) : ""} open={pill === "place"} onToggle={() => setPill(pill === "place" ? null : "place")}>
              {popSearch("place", "Search countries")}
              <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">{placeOptions}</div>
            </Pill>
            <Pill id="ats" label="Hiring system" icon={<CalendarBlank size={16} aria-hidden="true" />} sum={ats.map(atsName).join(", ")} open={pill === "ats"} onToggle={() => setPill(pill === "ats" ? null : "ats")}>
              {popSearch("ats", "Search hiring systems")}
              <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">{atsOptions}</div>
            </Pill>
            {dirty ? <button type="button" onClick={reset} className={cn("h-9 flex-none cursor-pointer rounded-sm border-0 bg-transparent px-2.5 font-ui text-sm text-destructive", ring)}>Reset</button> : null}
          </div>
          {/* A pill's list is a sheet on a phone, over a scrim. */}
          <div aria-hidden="true" className={cn("fixed inset-0 z-40 hidden bg-overlay", pill && "max-[800px]:block")} />

          <div className="min-[1101px]:grid min-[1101px]:grid-cols-[minmax(0,1fr)_clamp(420px,34vw,600px)] min-[1101px]:items-start min-[1101px]:gap-2.5">
            <section aria-label="Companies" className="min-w-0 overflow-hidden rounded-lg border bg-card max-[800px]:-mx-4 max-[800px]:rounded-none max-[800px]:border-x-0">
              <div className="flex min-h-16 items-center justify-between gap-3 border-b px-5 py-2 max-[800px]:px-3">
                <div className="flex min-w-0 flex-col">
                  {head ? <span className="font-ui text-[17px] leading-tight font-medium text-foreground">{head}</span> : <Bone w="240px" h={14} className="max-w-[45vw]" />}
                  {failed ? <span className="text-xs text-muted-foreground">Try again in a minute.</span> : null}
                </div>
                <PillSelect label="Sort companies" prefix="Sort" valueClassName="font-semibold" className="flex-none bg-card dark:bg-card"
                  value={sort} options={SORTS} onChange={(v) => setSort(v as Sort)} />
              </div>
              <div className={cn(GRID, "border-b py-2 text-xs text-muted-foreground max-[640px]:hidden")} aria-hidden="true">
                <span /><span>Company</span><span className="text-center">Trend chart</span><span className="min-w-16" /><span className="min-w-24 text-right">Open jobs</span>
              </div>
              <div role="list">
                {!directory && !failed ? [55, 40, 66, 48, 55, 40, 66, 48, 55, 40].map((w, i) => (
                  <div key={i} className={cn(GRID, "min-h-[72px] border-b py-2.5")} aria-hidden="true">
                    <span className="size-11 animate-pulse rounded-sm bg-accent" />
                    <div><Bone w={`${w}%`} h={14} /><Bone w={`${w + 15}%`} className="mt-1.5" /></div>
                    <Bone w="90px" h={20} className="max-[640px]:hidden" />
                    <span />
                    <div className="flex justify-end"><Bone w="44px" h={14} /></div>
                  </div>
                )) : rows.slice(0, shown).map((r) => {
                  const on = r.domain === selected;
                  const fol = following.has(r.domain);
                  return (
                    <div key={r.domain} role="listitem" data-domain={r.domain} onClick={() => { if (on) close(); else { picks.current++; setSelected(r.domain); } }}
                      className={cn(GRID, "group relative min-h-[72px] cursor-pointer border-b py-2.5 hover:bg-muted", on && "bg-accent hover:bg-accent")}>
                      {on ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-ring" /> : null}
                      <Logo row={r} />
                      <div className="min-w-0">
                        <button type="button" aria-expanded={on} aria-controls="company-panel"
                          className={cn("block w-full cursor-pointer truncate rounded-xs border-0 bg-transparent p-0 text-left font-ui text-[15px] font-semibold text-foreground group-hover:text-link-hover", ring)}>{r.name}</button>
                        <div className="mt-0.5 truncate text-[13px] text-body">{r.domain} · {atsName(r.ats)}</div>
                      </div>
                      <div className="flex min-h-7 flex-col items-center max-[640px]:hidden"><RowSpark trend={r.trend} /></div>
                      <button type="button" aria-pressed={fol} aria-label={`${fol ? "Unfollow" : "Follow"} ${r.name}`} onClick={(e) => { e.stopPropagation(); toggleFollow(r.domain); }}
                        className={cn("h-7 cursor-pointer rounded-full border px-3 font-ui text-xs font-medium whitespace-nowrap max-[640px]:px-2.5", ring,
                          fol ? "border-primary bg-primary text-primary-foreground" : "border-input/40 bg-transparent text-foreground hover:bg-accent")}>{fol ? "Following" : "Follow"}</button>
                      <div className="min-w-24 text-right max-[640px]:min-w-0">
                        <b className="block font-ui text-[17px] font-semibold text-foreground tabular-nums">{fmt(r.n)}</b>
                        <span className="text-xs whitespace-nowrap text-muted-foreground">{r.new_7d ? `+${fmt(r.new_7d)} this week` : "open jobs"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {directory && rows.length > shown ? (
                <div className="m-3.5"><Button variant="outline" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</Button></div>
              ) : null}
              {directory && !rows.length ? (
                <div className="px-5 py-10 text-center text-muted-foreground">
                  {view === "following" && !following.size ? "You don't follow any companies yet. Select Follow on a company under Hiring now." : "No companies match."}
                </div>
              ) : null}
            </section>

            <div aria-hidden="true" onClick={close}
              className={cn("fixed inset-0 z-40 bg-overlay transition-opacity duration-250 min-[1101px]:hidden", picked ? "opacity-100" : "pointer-events-none invisible opacity-0")} />
            <aside id="company-panel" aria-label="Company" role={overlay && picked ? "dialog" : undefined} aria-modal={overlay && picked ? true : undefined}
              className={cn("flex flex-col bg-card",
                "min-[1101px]:sticky min-[1101px]:top-[78px] min-[1101px]:h-[calc(100dvh-92px)] min-[1101px]:overflow-y-auto min-[1101px]:rounded-lg min-[1101px]:border",
                "max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-50 max-[1100px]:w-[min(440px,100%)] max-[1100px]:overflow-y-auto max-[1100px]:border-l max-[1100px]:transition-transform max-[1100px]:duration-250",
                !picked && "max-[1100px]:invisible max-[1100px]:translate-x-full")}>
              {picked ? (
                <Suspense fallback={null}>
                  <CompanyPanel key={picked.domain} row={picked} country={country} countryName={countryName(country)} takeFocus={overlay && picks.current > 0} onClose={close} />
                </Suspense>
              ) : (
                <>
                  <div className="flex h-16 flex-none flex-col justify-center border-b px-5">
                    <span className="font-ui text-[17px] leading-tight font-medium text-foreground">Company</span>
                    <span className="text-xs text-muted-foreground">{country ? countryName(country) : "Everywhere"}</span>
                  </div>
                  <p className="m-0 p-5 text-sm text-muted-foreground">Select a company to see its details here.</p>
                </>
              )}
            </aside>
          </div>

          {/* Plain links, so a crawler can reach every company page without
              running this bundle (loader/sitemap.py writes these pages). */}
          <nav aria-label="All companies by first letter" className="flex flex-wrap gap-1 pb-6 font-ui text-[13px] font-medium">
            {LETTERS.map(([label, path]) => (
              <a key={path} href={`/companies/${path}`} className={cn("min-w-[30px] rounded-md px-2 py-1.5 text-center text-muted-foreground hover:bg-muted hover:text-foreground", ring)}>{label}</a>
            ))}
          </nav>
        </div>
      </div>
      {drawerUsed ? (
        <Suspense fallback={null}><SideDrawer {...side} open={drawer} onOpenChange={setDrawer} opener={drawerBtn} /></Suspense>
      ) : null}
      <TabBar current="companies" hidden={!!picked && overlay} />
    </Page>
  );
}
