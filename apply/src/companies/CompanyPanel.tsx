// One company: its profile (/api/companies/<domain>), its facets under the
// chosen country and its four newest roles, the same reads companies.js made.
import { useEffect, useState } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Meter } from "@cloudflare/kumo/components/meter";
import { ArrowUpRight, X } from "@phosphor-icons/react";
import { pub } from "../api";
import { age, atsName, Bone, countryQuery, fmt, type Facets, type Jobs, type Profile, type Row } from "./data";

export function Logo({ row, size = 44 }: { row: Pick<Row, "domain" | "name" | "has_logo">; size?: number }) {
  const letter = (row.name || row.domain || "?").trim()[0].toUpperCase();
  return (
    <span className="relative grid shrink-0 place-items-center overflow-hidden rounded-xl bg-kumo-tint font-medium text-kumo-subtle" style={{ width: size, height: size }} aria-hidden="true">
      {letter}
      {row.has_logo === false ? null : (
        <img src={`/logo/${encodeURIComponent(row.domain)}.png`} alt="" width={size} height={size} loading="lazy" className="absolute inset-0 size-full object-contain"
          onError={(e) => { e.currentTarget.hidden = true; }} />
      )}
    </span>
  );
}

// Twelve weeks of open roles as one line, from company_daily. Before the
// table has a fortnight in it the chart would be two dots, so it says
// when the record starts instead.
function Spark({ history }: { history: Profile["history"] }) {
  const pts = (history || []).map((h) => h.open_n);
  if (pts.length < 14) return <p className="m-0 text-sm text-kumo-subtle">Daily counts start {history?.length ? `on ${history[0].day}` : "within a few hours"}.</p>;
  const w = 280, h = 56, max = Math.max(1, ...pts), min = Math.min(...pts), span = Math.max(1, max - min);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${(i * (w / (pts.length - 1))).toFixed(1)} ${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)}`).join(" ");
  return (
    <>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block h-14 w-full text-kumo-strong" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      <div className="mt-1 flex justify-between font-mono text-xs text-kumo-subtle"><span>{history![0].day.slice(5)}</span><span>{fmt(min)} to {fmt(max)} open</span><span>{history![history!.length - 1].day.slice(5)}</span></div>
    </>
  );
}

function Tile({ label, value, sub, green, words }: { label: string; value: string; sub?: string; green?: boolean; words?: boolean }) {
  return (
    <div className="flex flex-col gap-1 border border-kumo-hairline p-3">
      <span className="text-xs text-kumo-subtle">{label}</span>
      <span className={`${words ? "text-base font-medium leading-snug" : "text-2xl font-semibold leading-none tracking-tight"} ${green ? "text-kumo-success" : "text-kumo-strong"}`}>{value}</span>
      {sub ? <span className="text-xs text-kumo-subtle">{sub}</span> : null}
    </div>
  );
}

type Loaded = { profile: Profile | null; newest: Jobs | null; facets: Facets | null };

export function CompanyPanel({ row, country, countryName, onClose }: { row: Row; country: string; countryName: string; onClose: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
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

  const boardHref = `/board?company=${encodeURIComponent(domain)}${countryQuery(country)}`;
  const { profile, newest, facets } = data || {};
  // A company outside the top 500 (opened by its address) has only the
  // profile to name it.
  const name = profile?.name || row.name || domain;
  const ats = profile?.ats ?? row.ats;
  const hereN = newest?.total ?? row.n;
  const worldwide = profile && country && profile.open_jobs > hereN ? `of ${fmt(profile.open_jobs)} worldwide` : undefined;
  const cities = (facets?.locations || []).flatMap((c) => (c.cities || []).slice(0, 3).map((x) => x.value));
  const places = cities.slice(0, 3).join(" · ") || (facets?.locations || []).slice(0, 3).map((c) => c.label).join(" · ") || "None";
  const cats = (facets?.categories || []).slice(0, 5);
  const max = Math.max(1, ...cats.map((c) => c.n));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-kumo-hairline px-4 py-2.5">
        <span className="truncate text-sm text-kumo-subtle">Companies / <b className="font-medium text-kumo-strong">{name}</b></span>
        <Button variant="ghost" size="sm" shape="square" icon={<X />} aria-label="Close" onClick={onClose} />
      </div>
      <div className="flex flex-col gap-5 overflow-y-auto p-4">
        <div className="flex items-center gap-3">
          <Logo row={profile || row} />
          <div className="min-w-0">
            <h2 className="m-0 truncate text-lg font-semibold leading-tight text-kumo-strong">{name}</h2>
            <p className="m-0 truncate text-sm text-kumo-subtle">{atsName(ats)} · <a className="text-kumo-link hover:underline" href={`https://${domain}`} target="_blank" rel="noopener">{domain}</a></p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton variant="primary" size="sm" href={boardHref}>See {hereN == null ? "the" : fmt(hereN)} open jobs</LinkButton>
          <LinkButton variant="secondary" size="sm" href="/account">Alert me when they post</LinkButton>
          <LinkButton variant="secondary" size="sm" href={`https://${domain}`} target="_blank" rel="noopener" icon={<ArrowUpRight />}>Careers page</LinkButton>
        </div>
        {!data ? (
          <div className="flex flex-col gap-3" aria-hidden="true"><Bone w={100} h={64} /><Bone w={100} h={56} /><Bone w={60} /><Bone w={45} /><Bone w={70} /></div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Tile label={country ? `Open jobs in ${countryName}` : "Open jobs"} value={fmt(hereN)} sub={worldwide} />
              <Tile label="New this week" value={profile ? fmt(profile.new_jobs_7d) : "Unknown"} sub="first seen in the past 7 days" green />
              <Tile label="Hiring system" value={atsName(ats)} words />
              <Tile label={country ? "Sites" : "Countries"} value={places} words />
            </div>
            <section>
              <h3 className="m-0 mb-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Open jobs, twelve weeks</h3>
              <Spark history={profile?.history} />
            </section>
            <section>
              <h3 className="m-0 mb-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Hiring for</h3>
              {cats.length ? (
                <div className="flex flex-col gap-2">{cats.map((c) => <Meter key={c.value} label={c.value} value={c.n} max={max} customValue={fmt(c.n)} />)}</div>
              ) : <p className="m-0 text-sm text-kumo-subtle">No categorised jobs.</p>}
            </section>
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="m-0 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Newest jobs</h3>
                <a className="text-sm text-kumo-link hover:underline" href={boardHref}>All {fmt(hereN)}</a>
              </div>
              {newest?.jobs?.length ? (
                <ul className="m-0 list-none divide-y divide-kumo-hairline p-0">
                  {newest.jobs.map((j) => (
                    <li key={j.id}>
                      <a className="flex items-baseline justify-between gap-3 py-2 text-sm text-kumo-default hover:text-kumo-link" href={`/job/${j.id}`}>
                        <span className="min-w-0 truncate">{j.title}{j.location ? <span className="text-kumo-subtle"> · {String(j.location).split(";")[0]}</span> : null}</span>
                        <span className="shrink-0 text-xs text-kumo-subtle">{age(j.posted_at)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : <p className="m-0 text-sm text-kumo-subtle">No open jobs here.</p>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
