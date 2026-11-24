// One company: its profile (/api/companies/<domain>), its facets under the
// chosen country and its four newest jobs, the same reads companies.js
// made. Loaded on first pick, so the directory's first paint doesn't
// carry it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pub } from "../api";
import { age, atsName, countryQuery, fmt, type Facets, type Jobs, type Profile, type Row } from "./data";
import { Bone, Logo } from "./parts";

// Twelve weeks of open jobs as one line, from company_daily. Before the
// table has a fortnight in it the chart would be two dots, so it says
// when the record starts instead.
function Spark({ history }: { history: Profile["history"] }) {
  const pts = (history || []).map((h) => h.open_n);
  if (!history || pts.length < 14) return <span className="text-[13px] text-muted-foreground">Daily counts start {history?.length ? `on ${history[0].day}` : "within a few hours"}.</span>;
  const w = 280, h = 56, max = Math.max(1, ...pts), min = Math.min(...pts), span = Math.max(1, max - min);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${(i * (w / (pts.length - 1))).toFixed(1)} ${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)}`).join(" ");
  return (
    <>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-1.5 block h-14 w-full overflow-visible text-foreground" aria-hidden="true">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{history[0].day.slice(5)}</span><span>{fmt(min)}–{fmt(max)} open</span><span>{history[history.length - 1].day.slice(5)}</span>
      </div>
    </>
  );
}

function Tile({ label, value, sub, green, words }: { label: string; value: string; sub?: string; green?: boolean; words?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn(words ? "text-[15px] leading-[1.3] font-medium" : "font-ui text-2xl leading-none font-semibold tabular-nums", green ? "text-link-hover" : "text-foreground")}>{value}</span>
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
    </div>
  );
}

function Block({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <div className="mb-2 flex items-baseline justify-between"><h3 className="m-0 text-xs font-medium text-muted-foreground">{title}</h3>{extra}</div>
      {children}
    </section>
  );
}

type Loaded = { profile: Profile | null; newest: Jobs | null; facets: Facets | null };

export function CompanyPanel({ row, country, countryName, takeFocus, onClose }: { row: Row; country: string; countryName: string; takeFocus: boolean; onClose: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const domain = row.domain;
  useEffect(() => {
    let live = true;
    setData(null);
    const here = countryQuery(country);
    const q = (extra: string) => `/jobs?company=${encodeURIComponent(domain)}&confidence=all&${extra}`;
    Promise.all([
      pub<Profile>(`/companies/${encodeURIComponent(domain)}`).catch(() => null),
      pub<Jobs>(q(`limit=4&sort=age&dir=asc${here}`)).catch(() => null),
      pub<Facets>(`/facets?confidence=all&company=${encodeURIComponent(domain)}${here}`).catch(() => null),
    ]).then(([profile, newest, facets]) => { if (live) setData({ profile, newest, facets }); });
    return () => { live = false; };
  }, [domain, country]);
  // Over the list (below 1101px) the panel is a sheet: a pick moves focus into it.
  useEffect(() => { if (takeFocus) close.current?.focus({ preventScroll: true }); }, [takeFocus, domain]);

  const { profile, newest, facets } = data || {};
  // A company outside the top 500 (opened by its address) has only the
  // profile to name it.
  const name = profile?.name || row.name || domain;
  const ats = profile?.ats ?? row.ats;
  const hereN = newest?.total ?? row.n;
  const worldwide = profile && country && profile.open_jobs > hereN ? `of ${fmt(profile.open_jobs)} worldwide` : undefined;
  const cities = (facets?.locations || []).flatMap((c) => (c.cities || []).slice(0, 3).map((x) => x.value));
  const places = cities.slice(0, 3).join(" · ") || (facets?.locations || []).slice(0, 3).map((c) => c.label).join(" · ") || "–";
  const cats = (facets?.categories || []).slice(0, 5);
  const max = Math.max(1, ...cats.map((c) => c.n));
  const ghost = cn(buttonVariants({ variant: "outline" }), "border-[1.5px]");

  return (
    <>
      <div className="flex h-16 flex-none items-center justify-between gap-3 border-b px-5">
        <span className="min-w-0 truncate font-ui text-sm text-muted-foreground">Companies / <b className="font-semibold text-foreground">{name}</b></span>
        <button ref={close} type="button" aria-label="Close" onClick={onClose}
          className="grid size-9 flex-none cursor-pointer place-items-center rounded-md text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><X size={18} /></button>
      </div>
      <div className="flex flex-col gap-[22px] p-5">
        <div className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-x-3.5">
          <Logo row={profile || row} size={56} />
          <div className="min-w-0">
            <h2 className="m-0 font-display text-[clamp(22px,2vw,28px)] leading-[1.05] font-medium tracking-[-0.02em] text-balance text-foreground">{name}</h2>
            <div className="mt-1 text-[13px] text-body">{atsName(ats)} · <a className="text-inherit underline-offset-2 hover:underline" href={`https://${domain}`} target="_blank" rel="noopener">{domain}</a></div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className={buttonVariants()} href={`/board?company=${encodeURIComponent(domain)}${countryQuery(country)}`}>See {hereN == null ? "the" : fmt(hereN)} open jobs</a>
          <a className={ghost} href="/account">Alert me when they post</a>
          <a className={ghost} href={`https://${domain}`} target="_blank" rel="noopener">Careers page ↗</a>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {data ? (
            <>
              <Tile label={country ? `Open jobs in ${countryName}` : "Open jobs"} value={fmt(hereN)} sub={worldwide} />
              <Tile label="New this week" value={profile ? fmt(profile.new_jobs_7d) : "–"} sub="first seen in the past 7 days" green />
              <Tile label="Hiring system" value={atsName(ats)} words />
              <Tile label={country ? "Sites" : "Countries"} value={places} words />
            </>
          ) : [0, 1, 2, 3].map((i) => <div key={i} className="flex flex-col gap-2 rounded-lg border p-3"><Bone w="50%" /><Bone w="40%" h={22} /></div>)}
        </div>
        <Block title="Open jobs, twelve weeks">{data ? <Spark history={profile?.history} /> : <Bone w="100%" h={56} />}</Block>
        <Block title="Hiring for">
          {!data ? <div className="flex flex-col gap-2">{[62, 48, 70].map((w) => <div key={w} className="flex min-h-5 items-center"><Bone w={`${w}%`} /></div>)}</div>
            : cats.length ? (
              <div className="flex flex-col gap-2">
                {cats.map((c) => (
                  <div key={c.value} className="grid grid-cols-[minmax(0,1fr)_120px_40px] items-center gap-x-2.5 text-[13px] text-foreground">
                    <span className="truncate">{c.value}</span>
                    <span className="h-1.5 overflow-hidden rounded-xs bg-muted"><span className="block h-full bg-foreground" style={{ width: `${Math.round(100 * c.n / max)}%` }} /></span>
                    <span className="text-right text-muted-foreground tabular-nums">{fmt(c.n)}</span>
                  </div>
                ))}
              </div>
            ) : <span className="text-[13px] text-muted-foreground">No categorised jobs.</span>}
        </Block>
        <Block title="Newest jobs" extra={<a className="font-ui text-[13px] text-link-hover" href={`/board?company=${encodeURIComponent(domain)}`}>All{data ? ` ${fmt(hereN)}` : ""}</a>}>
          <div className="flex flex-col">
            {newest?.jobs?.length ? newest.jobs.map((j) => (
              <a key={j.id} className="group flex items-baseline justify-between gap-2.5 border-t py-2 font-ui text-sm text-foreground first:border-t-0" href={`/job/${encodeURIComponent(j.id)}`}>
                <span className="min-w-0 truncate font-medium group-hover:text-link-hover">{j.title}{j.location ? <span className="font-normal text-muted-foreground"> · {String(j.location).split(";")[0]}</span> : null}</span>
                <span className="flex-none text-xs text-muted-foreground">{age(j.posted_at)}</span>
              </a>
            )) : data ? <span className="text-[13px] text-muted-foreground">No open jobs here.</span> : null}
          </div>
        </Block>
      </div>
    </>
  );
}
