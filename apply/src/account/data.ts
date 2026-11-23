// The account page's data: the shapes /api/me/* returns (api/handler.py),
// and the helpers app.js used to lend the old page (labels, the alert
// summary, the starred set, the picker option lists).
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, pub, send } from "../api";

export type Cadence = "instant" | "daily" | "weekly";
export type Profile = {
  skills: string[]; seniority: string | null; workplace: string[]; israel_only: boolean;
  country: string[]; city: string[]; cadence: Cadence; digest_time: string; digest_tz: string; digest_day: number;
};
export type Alert = { alert_id: string; active: boolean; filter: Record<string, string>; created_at?: string; last_notified_at?: string };
export type SavedRow = { job_id: string; saved_at?: string };
export type Job = {
  id: string; title: string; company_name?: string; company_domain?: string; logo_url?: string | null; location?: string;
  url?: string; closed_at?: string | null; skills?: string; salary_text?: string;
};
export type Day = { day: string; new: number; open: number };
export type Dashboard = {
  computed_at?: string; history?: { days: Day[] } | null; matches?: Job[]; counts?: Record<string, number>;
  computing?: boolean; updating?: boolean;
};
export type Access = "none" | "read" | "write";
export type Token = { id: string; name: string; hint: string; created_at: string; last_used_at?: string | null; expires_at?: string | null;
  scope?: string; permissions?: Record<string, Access> };
export type Option = { value: string; label: string; kind?: "country" | "city" };

export const EMPTY_PROFILE: Profile = { skills: [], seniority: null, workplace: [], israel_only: true, country: [], city: [], cadence: "instant",
  digest_time: "09:00", digest_tz: "Asia/Jerusalem", digest_day: 0 };

// The same cap the API applies (api/profile.py MAX_SKILLS).
export const MAX_SKILLS = 40;

// probe.py's closed vocabularies, as app.js labels them.
export const SENIORITY_LABELS: Record<string, string> = {
  intern: "Intern", junior: "Junior", mid: "Mid", senior: "Senior", staff: "Staff", principal: "Principal",
  lead: "Lead", manager: "Manager", director: "Director", exec: "Executive",
};
export const WORKPLACE_LABELS: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "Onsite" };

export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// The zones on offer. Not the whole IANA list, which is six hundred
// names nobody scrolls; the browser's own zone is always added, so
// whoever is somewhere else still finds home at the top.
const ZONES = [
  "Asia/Jerusalem", "UTC", "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin",
  "Europe/Amsterdam", "Europe/Madrid", "Europe/Rome", "Europe/Warsaw", "Europe/Athens", "Europe/Kyiv",
  "Europe/Istanbul", "Europe/Moscow", "America/New_York", "America/Toronto", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Vancouver", "America/Sao_Paulo", "America/Mexico_City", "Asia/Dubai",
  "Asia/Kolkata", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Seoul", "Australia/Sydney",
  "Pacific/Auckland", "Africa/Johannesburg", "Africa/Cairo",
];
export function zones(current: string): string[] {
  const out = [...ZONES];
  let here: string | null = null;
  try { here = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* no zone */ }
  if (here && !out.includes(here)) out.unshift(here);
  if (current && !out.includes(current)) out.push(current);
  return out;
}

export function zoneLabel(zone: string): string {
  let offset = "";
  try {
    const part = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    offset = part ? ` (${part.value})` : "";
  } catch { offset = ""; }
  return `${zone.replace(/_/g, " ")}${offset}`;
}

export function cadenceSummary(p: Profile): string {
  if (p.cadence === "daily") return `Daily at ${p.digest_time}, ${zoneLabel(p.digest_tz)}`;
  if (p.cadence === "weekly") return `Weekly on ${DAY_NAMES[p.digest_day] || DAY_NAMES[0]} at ${p.digest_time}, ${zoneLabel(p.digest_tz)}`;
  return "Instant, as matches appear";
}

export const fmt = (n: number | null | undefined) => Number(n || 0).toLocaleString();

// Country names the facets gave, so a saved alert reads Israel rather than IL.
const COUNTRY_LABELS = new Map<string, string>();
let regions: Intl.DisplayNames | null = null;
try { regions = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* the code is the fallback */ }
export function countryLabel(code: string): string {
  if (COUNTRY_LABELS.has(code)) return COUNTRY_LABELS.get(code)!;
  try {
    const name = regions?.of(code);
    if (name && name !== code) return name;
  } catch { /* not a region code */ }
  return code;
}

const csv = (v: unknown) => String(v).split(",").map((x) => x.trim()).filter(Boolean);

// Short, readable summary of a saved filter (app.js describeAlertFilter).
export function describeAlertFilter(filter: Record<string, string>): string {
  const parts: string[] = [];
  if (filter.search || filter.q) parts.push(`"${filter.search || filter.q}"`);
  if (filter.keywords) parts.push(filter.keywords.split(";").map((t) => t.trim()).filter(Boolean).join(", "));
  for (const k of ["department", "seniority", "company", "location", "workplace"]) if (filter[k]) parts.push(csv(filter[k]).join(", "));
  if (filter.country) parts.push(csv(filter.country).map(countryLabel).join(", "));
  if (filter.city) parts.push(csv(filter.city).join(", "));
  if (filter.israel_only === "1") parts.push("Israel only");
  return parts.length ? parts.join(" · ") : "All jobs";
}

export function placeSummary(p: Pick<Profile, "country" | "city">, labels: Record<string, string>): string {
  const names = [...p.country, ...p.city].map((v) => labels[v] || v);
  if (!names.length) return "Anywhere";
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
}

// The board's saved set in this browser. The account is the record; this
// copy keeps the board's stars lit without a request.
const STAR_KEY = "iljobs_starred";
export function starred(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(STAR_KEY) || "[]")); } catch { return new Set(); }
}
export function setStar(id: string, on: boolean) {
  try {
    const s = starred();
    if (on) s.add(id); else s.delete(id);
    localStorage.setItem(STAR_KEY, JSON.stringify([...s]));
  } catch { /* private browsing or a full quota */ }
}

export function safeHref(url?: string): string {
  return /^https?:\/\//i.test(url || "") ? url! : "#";
}

// A static copy the applier publishes, or the API when it isn't there.
async function staticOrApi<T>(file: string, path: string): Promise<T> {
  try {
    const r = await fetch(file, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch { /* the API is the authority anyway */ }
  return pub<T>(path);
}

type FacetCountry = { value: string; label: string; n?: number; cities?: { value: string; n?: number }[] };

// Countries with their cities under them, flattened for one picker.
// The label of each is remembered, so summaries name places.
export async function locationOptions(labels: Record<string, string>): Promise<Option[]> {
  let facets: { locations?: FacetCountry[] } | undefined;
  try {
    const r = await fetch("/facets.json", { cache: "no-store" });
    if (r.ok) facets = (await r.json())?.verified;
  } catch { /* falls through to the API */ }
  // The same fallback the board asked for: its default filters.
  if (!facets) facets = await pub("/facets?confidence=all");
  const out: Option[] = [];
  for (const c of facets?.locations || []) {
    if (!c || typeof c.value !== "string" || typeof c.label !== "string") continue;
    COUNTRY_LABELS.set(c.value, c.label);
    labels[c.value] = c.label;
    out.push({ value: c.value, label: c.label, kind: "country" });
    for (const t of c.cities || []) {
      if (!t || typeof t.value !== "string") continue;
      labels[t.value] = t.value;
      out.push({ value: t.value, label: t.value, kind: "city" });
    }
  }
  return out;
}

export async function departmentOptions(): Promise<Option[]> {
  const stats = await staticOrApi<{ top_departments?: { department: string; n: number }[] }>("/stats.json", "/stats");
  return (stats.top_departments || []).map((r) => ({ value: r.department, label: `${r.department} (${r.n})` }));
}

// Every resolved company, busiest first, so the picker's first 50 are
// the ones most people are after.
export async function companyOptions(): Promise<Option[]> {
  const data = await pub<{ companies: { domain: string; job_count?: number }[] }>("/companies?resolved_only=1");
  return [...data.companies]
    .sort((a, b) => (b.job_count || 0) - (a.job_count || 0) || a.domain.localeCompare(b.domain))
    .map((c) => ({ value: c.domain, label: c.domain }));
}

// The skills in a CV, read in this tab. The engine is /cv_skills.js
// (loaded by account.html), the browser twin of api/skills.py, and the
// rules come down with the profile, so there is one vocabulary.
type Found = { label: string; index: number; count: number };
type CvEngine = { extract: (text: string, spec: unknown) => Found[]; textFromPdf: (pdfjs: unknown, data: ArrayBuffer) => Promise<string> };
const engine = () => (window as unknown as { CvSkills?: CvEngine }).CvSkills;

export function skillsIn(text: string, spec: unknown): string[] {
  const e = engine();
  if (!spec || !e) return [];
  // Strongest evidence first: when a CV yields more than 40, the ones it
  // mentions most are the ones kept.
  return e.extract(text, spec).sort((a, b) => b.count - a.count || a.index - b.index).map((d) => d.label);
}

export async function readCv(file: File): Promise<string> {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    // Imported on demand: a 330KB parser should not load for someone who
    // came to edit an alert.
    const url = "/vendor/pdfjs/pdf.min.mjs";
    const pdfjs = await import(/* @vite-ignore */ url);
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    return engine()!.textFromPdf(pdfjs, await file.arrayBuffer());
  }
  return file.text();
}

// A link to the board with this profile as its filters. skills=, not q=:
// q is a single substring match (see job_filters.wanted_skills).
export function boardLink(p: Profile, skills: string[]): string {
  const q = new URLSearchParams();
  if (skills.length) q.set("skills", skills.join(","));
  if (p.seniority) q.set("seniority", p.seniority);
  if (p.workplace.length) q.set("workplace", p.workplace.join(","));
  if (p.country.length) q.set("country", p.country.join(","));
  if (p.city.length) q.set("city", p.city.join(","));
  return "/board?" + q.toString();
}

// The one-line description of the claims in an id_token. Display only;
// the API verifies the token on every request.
export function claims(idToken: string): Record<string, unknown> {
  try { return JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}

// Which provider signed this reader in: Cognito puts an identities claim
// on a federated user, which today is Google alone.
export function provider(idToken: string): string {
  let ids = claims(idToken).identities as unknown;
  try { if (typeof ids === "string") ids = JSON.parse(ids); } catch { return ""; }
  const first = Array.isArray(ids) ? (ids[0] as { providerName?: string }) : null;
  return first?.providerName === "Google" ? "Google" : "";
}

// The pages' loads. Every one needs a token. A 401 shows the sign-in in
// place of the page (ui.tsx gate) but keeps the tokens: during an outage
// the API answered 401 to valid ones, and api.ts already signs out when
// Cognito refuses the refresh token.
export const REJECTED = "ooj-account-401";
function authGuard(err: unknown) {
  if (err instanceof ApiError && err.status === 401) dispatchEvent(new Event(REJECTED));
}
export const PROFILE_FAILED = "Couldn't load your profile. Reload the page to try again.";
const STUCK = "This is taking longer than it should. Reload the page to try again.";
const FAILED = "Couldn't load this. Reload the page to try again.";

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [spec, setSpec] = useState<unknown>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<{ profile: Profile; skill_spec: unknown }>("/me/profile").then((d) => {
      setProfile({ ...EMPTY_PROFILE, ...(d.profile || {}) });
      setSpec(d.skill_spec || null);
    }).catch((err) => {
      authGuard(err);
      // A profile that won't load isn't worth blocking the page for; the
      // pickers just have nothing to offer until the next load. The page
      // says so, rather than ask for skills the reader may already have.
      setFailed(true);
      setProfile({ ...EMPTY_PROFILE });
    });
  }, []);
  // Every save PUTs the whole profile, so no page can wipe another's part.
  const put = useCallback(async (patch: Partial<Profile>) => {
    // Every save is the whole profile: on top of a profile that never
    // loaded, it would wipe the skills and places the reader has.
    if (failed) throw new Error(PROFILE_FAILED);
    const res = await api<{ profile: Profile }>("/me/profile", send("PUT", { ...(profile || EMPTY_PROFILE), ...patch }));
    const p = { ...EMPTY_PROFILE, ...(res.profile || res) };
    setProfile(p);
    return p;
  }, [profile, failed]);
  return { profile, spec, put, failed };
}

// The overview's numbers, computed on the box once a day. The last answer
// is kept in this browser for half an hour so the page paints at once,
// and while the box is still computing the page asks again every few
// seconds for a couple of minutes. A failed request gets two slower tries.
const DASH_KEY = "iljobs_dash_v1";
export function useDashboard(profile: Profile | null) {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [loaded, setLoaded] = useState(false);
  const skills = profile?.skills || [];
  const country = profile && profile.country.length === 1 ? profile.country[0] : "";
  const key = `${skills.join(",")}|${country}|${Math.min(3, skills.length)}`;
  useEffect(() => {
    if (!profile) return;
    if (!skills.length) { setDash(null); setLoaded(true); return; }
    let live = true, polls = 0, retries = 0, timer = 0;
    try {
      const c = JSON.parse(localStorage.getItem(DASH_KEY) || "null");
      if (c && c.key === key && Date.now() - c.at < 30 * 60 * 1000) {
        setDash({ history: c.history, matches: c.matches, counts: c.counts, computed_at: c.computedAt });
        setLoaded(true);
      }
    } catch { /* a per-browser nicety only */ }
    const run = async () => {
      let d: Dashboard | null = null;
      try { d = await api<Dashboard>("/me/dashboard"); } catch (err) { authGuard(err); d = null; }
      if (!live) return;
      const pending = !!(d && (d.computing || d.updating));
      if (pending && polls < 40) { polls++; timer = window.setTimeout(run, 4000); }
      else if (!d && retries < 2) { retries++; timer = window.setTimeout(run, 20000); }
      // Nothing stored yet: keep the bones up rather than paint empty cards.
      if (pending && !d!.computed_at) return;
      if (d) {
        setDash(d);
        if (d.history) {
          try { localStorage.setItem(DASH_KEY, JSON.stringify({ key, at: Date.now(), history: d.history, matches: (d.matches || []).slice(0, 100), counts: d.counts, computedAt: d.computed_at })); } catch { /* quota */ }
        }
      }
      setLoaded(true);
    };
    run();
    return () => { live = false; clearTimeout(timer); };
  }, [key, !!profile]); // eslint-disable-line react-hooks/exhaustive-deps
  return { dash, loaded };
}

// The lists, each with a watchdog: a request that never settles still
// ends in a sentence, not a spinner.
export function useAlerts() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    const list = (await api<{ alerts: Alert[] }>("/me/alerts")).alerts || [];
    setAlerts(list);
    setError("");
    return list;
  }, []);
  useEffect(() => {
    const stuck = window.setTimeout(() => setError((e) => e || STUCK), 15000);
    reload().catch((err) => { authGuard(err); setError(FAILED); }).finally(() => clearTimeout(stuck));
    return () => clearTimeout(stuck);
  }, [reload]);
  return { alerts, error, reload };
}

// The reader's stars from any device. The account stores the ids; the
// listings come from /api/jobs, so what shows is the live record, closed
// ones included.
export function useSaved() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    let ids: string[];
    try {
      ids = ((await api<{ saved: SavedRow[] }>("/me/saved")).saved || []).map((r) => r.job_id).filter(Boolean);
    } catch (err) {
      authGuard(err);
      setError("Couldn't load your saved jobs.");
      return;
    }
    setCount(ids.length);
    if (!ids.length) { setJobs([]); setError(""); return; }
    try {
      const q = new URLSearchParams({ ids: ids.slice(0, 200).join(","), include_closed: "1", include_outdated: "1", limit: "200" });
      const list = (await pub<{ jobs: Job[] }>(`/jobs?${q}`)).jobs || [];
      // The account knows the order they were starred in; restore it.
      const rank = new Map(ids.map((id, i) => [id, i]));
      list.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
      setJobs(list);
      setError("");
    } catch {
      setError("Couldn't load your saved jobs.");
    }
  }, []);
  useEffect(() => {
    const stuck = window.setTimeout(() => setError((e) => e || STUCK), 15000);
    load().finally(() => clearTimeout(stuck));
    return () => clearTimeout(stuck);
  }, [load]);
  // The board reads the same list from this browser, so its star follows.
  const toggle = async (j: Job, on: boolean) => {
    setStar(j.id, on);
    try {
      await api(`/me/saved/${encodeURIComponent(j.id)}`, { method: on ? "PUT" : "DELETE" });
      load();
    } catch {
      setStar(j.id, !on);
    }
  };
  // false when the API refused; the row stays.
  const remove = async (id: string) => {
    try { await api(`/me/saved/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { return false; }
    setStar(id, false);
    const rest = (jobs || []).filter((j) => j.id !== id);
    setJobs(rest);
    setCount((n) => Math.max(0, n - 1));
    if (!rest.length) load();
    return true;
  };
  return { jobs, count, error, toggle, remove };
}
