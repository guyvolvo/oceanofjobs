// The board's shapes (what /api/jobs, /api/facets and /api/stats answer)
// and the formatting app.js used on them.
import { useSyncExternalStore } from "react";

export type Job = {
  id: string; title: string; url?: string; ats?: string; external_id?: string;
  company_name?: string; company_domain?: string; logo_url?: string | null;
  department?: string; location?: string; workplace_type?: string; seniority?: string;
  confidence?: string; closed_at?: string | null; posted_at?: string | null; first_seen?: string | null;
  salary_text?: string; salary_source?: string; salary_is_estimate?: boolean;
  skills?: string; description?: string; match_score?: number;
};
export type SearchInfo = { terms?: string[]; mode?: "all" | "any"; ignored?: string[]; expanded?: string[]; exact?: boolean };
export type JobsResponse = { jobs: Job[]; total: number | null; matched_skills?: string[]; search?: SearchInfo; params?: string };

export type FacetRow = { value: string; n: number | null; name?: string; label?: string; logo_url?: string | null };
export type City = { value: string; label: string; n: number | null };
export type Country = { value: string; label: string; n: number | null; cities: City[] };
export type Facets = {
  categories: FacetRow[]; seniority: FacetRow[]; workplace: FacetRow[]; companies: FacetRow[]; locations: Country[];
  salary: { min: number; max: number; known: number } | null; salary_disclosed: number;
};

export type Scope = {
  open_jobs?: number; companies_hiring?: number; new_jobs_24h?: number; new_jobs_7d?: number; closed_jobs_24h?: number; closed_jobs_7d?: number;
  prev_new_jobs_24h?: number; prev_new_jobs_7d?: number; open_now_basis?: number; open_jobs_7d_ago?: number; companies_now_basis?: number;
  companies_7d_ago?: number; median_open_days?: number; oldest_open_days?: number; top_companies: { domain: string; n: number; logo_url?: string | null }[];
};
export type Stats = { totals: Scope; throughput: Scope; age: Scope; top_companies?: Scope["top_companies"]; freshness: { last_checked?: string };
  meta?: { open_jobs_best_effort?: number }; scoped?: Scope };

export const SENIORITY_LABELS: Record<string, string> = {
  intern: "Intern", junior: "Junior", mid: "Mid", senior: "Senior", staff: "Staff", principal: "Principal", lead: "Lead",
  manager: "Manager", director: "Director", exec: "Executive",
};
export const WORKPLACE_LABELS: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "Onsite" };

export const SALARY_SOURCE_NOTE: Record<string, string> = {
  disclosed: "Published by the employer on this listing, in their own terms.",
  table: "Our estimate of monthly gross pay, from Israeli market rates for this role and seniority. Not the employer's own figure.",
  estimated: "Our estimate of monthly gross pay, from the pay ranges that similar jobs disclose. Not the employer's own figure.",
};
export function salarySource(j: Job) {
  const source = j.salary_source || (j.salary_is_estimate ? "table" : "disclosed");
  return { source, estimate: source !== "disclosed", note: SALARY_SOURCE_NOTE[source] || SALARY_SOURCE_NOTE.estimated };
}

// One formatter: toLocaleString builds a new one per call, and the places tree calls this per row.
const INT = new Intl.NumberFormat();
export const fmtInt = (n: number | null | undefined) => INT.format(n ?? 0);

export function fmtAge(days: number | null | undefined) {
  if (days == null) return "-";
  const totalMinutes = Math.floor(days * 24 * 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hours = totalHours % 24;
  if (totalMinutes < 1) return "<1M";
  if (totalHours < 1) return `${minutes}M`;
  if (totalHours < 12) return `${totalHours}H ${minutes}M`;
  if (totalHours < 24) return `${totalHours}H`;
  if (days < 3) return `${Math.floor(days)}D ${hours}H`;
  return `${Math.floor(days)}D`;
}

export function fmtAgeAgo(days: number | null | undefined) {
  if (days == null) return "-";
  const totalMinutes = Math.floor(days * 24 * 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hours = totalHours % 24;
  if (totalMinutes < 1) return "just now";
  if (totalHours < 1) return `${minutes}m ago`;
  if (totalHours < 12) return minutes ? `${totalHours}h ${minutes}m ago` : `${totalHours}h ago`;
  if (totalHours < 24) return `${totalHours}h ago`;
  if (days < 3) return hours ? `${Math.floor(days)}d ${hours}h ago` : `${Math.floor(days)}d ago`;
  return `${Math.floor(days)}d ago`;
}

export const ageDays = (iso: string | null | undefined) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : null);

// Posted more than a week after the board first saw it: a repost, not a new role.
const REPOST_GAP_DAYS = 7;
export function isReposted(j: Job) {
  // shortcut: Greenhouse rows stored before 2026-10-12 carry the last-edit date as posted_at; drop once re-read.
  if (j.ats === "greenhouse") return false;
  if (!j.posted_at || !j.first_seen) return false;
  return (new Date(j.posted_at).getTime() - new Date(j.first_seen).getTime()) / 86400000 > REPOST_GAP_DAYS;
}
export const fmtPostedAgo = (j: Job, days: number | null) => (isReposted(j) ? `Reposted ${fmtAgeAgo(days)}` : fmtAgeAgo(days));

export function fmtShekels(v: number | null | undefined) {
  if (v == null) return "";
  if (v < 1000) return `₪${Math.round(v)}`;
  const k = v / 1000;
  return `₪${k >= 10 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}K`;
}

export const safeHref = (url?: string) => (/^https?:\/\//i.test(url || "") ? url! : "#");

export function domainLabel(domain?: string) {
  const m = /^(.+)\.invalid$/.exec(domain || "");
  if (!m) return domain || "";
  return m[1].split(/[-.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
export const companyLabel = (j: Job) => j.company_name || domainLabel(j.company_domain);
export const companyDomain = (j: Job) => (j.company_domain && !/\.invalid$/.test(j.company_domain) ? j.company_domain : "");

// A flat initial for a company with no mark, as a data: URI.
export function monogram(domain?: string) {
  const letter = (domain || "").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="33" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#40513b" text-anchor="middle" dominant-baseline="central">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Country names as the facets gave them, then the browser's own.
export const COUNTRY_LABELS_SEEN = new Map<string, string>();
let regions: Intl.DisplayNames | null = null;
try { regions = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* the code is the fallback */ }
export function countryLabel(code: string) {
  if (COUNTRY_LABELS_SEEN.has(code)) return COUNTRY_LABELS_SEEN.get(code)!;
  try {
    const name = regions?.of(code);
    if (name && name !== code) return name;
  } catch { /* not a region code */ }
  return code;
}

// A city filter names its country: "AR:Buenos Aires".
export const cityKey = (country: string, city: string) => `${country}:${city}`;
export const cityCountry = (v: string) => (/^[A-Z]{2}:/.test(v) ? v.slice(0, 2) : null);
export const cityName = (v: string) => v.replace(/^[A-Z]{2}:/, "");

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v === null || v === undefined || v === false) continue;
    p.set(k, String(v));
  }
  return p.toString();
}

// Two rows for one job (a company reachable through two ATS tokens) collapse to one.
export function dedupeJobs(jobs: Job[], seen = new Set<string>()) {
  return jobs.filter((j) => {
    const key = (j.url || "").trim().toLowerCase() || `${j.company_domain}\u0000${j.external_id || j.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function announce(text: string) {
  let el = document.getElementById("live-announce");
  if (!el) {
    el = document.createElement("div");
    el.id = "live-announce";
    el.className = "sr-only";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = "";
  setTimeout(() => { el!.textContent = text; }, 50);
}

// app.js's breakpoints: up to 1100px the sidebar is a drawer and the pane
// a sheet; up to 800px is the phone.
export const PANE_SHEET = "(max-width: 1100px)";
export const PHONE = "(max-width: 800px)";
export const isSheet = () => matchMedia(PANE_SHEET).matches;
export const isPhone = () => matchMedia(PHONE).matches;
// False on the server and in the first (hydrating) render.
export function useMedia(query: string) {
  return useSyncExternalStore((fn) => {
    const mq = matchMedia(query);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, () => matchMedia(query).matches, () => false);
}
