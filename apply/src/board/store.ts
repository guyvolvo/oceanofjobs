// The board's state and every loader, app.js's logic with the DOM writes
// replaced by one emit(): the components read these objects and
// re-render on each emit. Kept imperative on purpose, because the
// sequence counters, abort controllers and holds in app.js are what
// make the board right under fast typing, and they port one to one.
import { useSyncExternalStore } from "react";
import { signedIn, api } from "../api";
import { requestSignIn } from "../site/auth";
import { COUNTRY_LABELS_SEEN, SENIORITY_LABELS, WORKPLACE_LABELS, cityCountry, cityName, countryLabel, dedupeJobs, domainLabel, fmtAgeAgo, fmtShekels, isPhone, isSheet,
  qs, type Country, type Facets, type Job, type JobsResponse, type Scope, type Stats } from "./util";

const API_BASE = "/api";
const STAR_KEY = "iljobs_starred";
const SAVED_MERGED_KEY = "iljobs_saved_merged";
const FILTERS_KEY = "iljobs_filters";
const MATCH_SKILLS_OPEN_KEY = "iljobs_match_skills_open";
const SAVED_SEARCHES_KEY = "iljobs_saved_searches";
const JOBS_CACHE_PREFIX = "iljobs_jobs_cache:";
const JOBS_CACHE_MAX = 8;
const STATS_CACHE_KEY = "iljobs_stats_cache";
const GEO_ASKED_KEY = "iljobs_geo_asked";
export const PAGE_SIZE = 50;
export const DEFAULT_ROLES = "all";
export const MAX_SEARCH_TERMS = 10;
export const RAIL_TOP_N = 4;
const STATS_POLL_MS = 120_000;
const HEALTH_POLL_MS = 120_000;

// Filters: the one truth the URL, the rail and the loaders read.
export const F = {
  search: "", sortExplicit: false, search_mode: "" as "" | "any", search_exact: "" as "" | "1",
  skills: [] as string[], department: [] as string[], seniority: [] as string[], company: [] as string[],
  country: [] as string[], city: [] as string[], workplace: [] as string[],
  salary_min: "", salary_max: "", salary_known: false, salary_disclosed: false,
  confidence: "all", max_age_days: "", starred_only: false, roles: DEFAULT_ROLES, sort: "age", dir: "asc", offset: 0,
};
type ListKey = "skills" | "department" | "seniority" | "company" | "country" | "city" | "workplace";

export type SavedSearch = { id: string; name: string; query: string; seen_at: string; fresh: number | null };
export type Detail = { id: string; job: Job | null; loading: boolean; error: string | null; gone: boolean };

// What is on screen.
export const U = {
  jobs: null as JobsResponse | null,
  skeleton: true,
  error: null as { text: string; retry?: boolean } | null,
  empty: null as { saved?: "none" | "gone"; search?: { terms: string[]; mode: string } } | null,
  held: 0,
  listEnded: false, loadingMore: false, listReloading: false,
  facets: { categories: [], seniority: [], workplace: [], companies: [], locations: [], salary: null, salary_disclosed: 0 } as Facets,
  facetsLoaded: false,
  railQueries: new Map<string, string>(),
  railExpanded: new Set<string>(["department"]),
  railFound: new Map<string, { value: string; n: number | null; name?: string }>(),
  railOpen: null as string | null,
  placeFound: new Map<string, Country>(),
  placeAsking: false,
  stats: null as Stats | null,
  scoped: null as { params: string; data: Scope | null; degraded?: boolean } | null,
  lastCheckedAt: null as number | null,
  selected: null as string | null,
  detail: null as Detail | null,
  paneOpen: false,
  starred: new Set<string>(),
  queue: new Set<string>(),
  appliedAt: new Map<string, string>(),
  matchedSkills: new Set<string>(),
  searchRelated: [] as string[],
  savedSearches: [] as SavedSearch[],
  matchPrompt: false,
  matchSkillsOpen: false,
  geoPrompt: null as { code: string; name: string } | null,
  sheetOpen: false,
};

// Elements the loaders have to measure.
export const dom = { list: null as HTMLElement | null, rows: null as HTMLElement | null, reveal: null as ((id: string) => void) | null };

let version = 0;
const subs = new Set<() => void>();
export function emit() { version++; subs.forEach((f) => f()); }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
// The server render (and hydration) sees version 0 and the default state.
export const useBoard = () => useSyncExternalStore(subscribe, () => version, () => 0);

// storage

export function getStarred() {
  try { return new Set<string>(JSON.parse(localStorage.getItem(STAR_KEY) || "[]")); } catch { return new Set<string>(); }
}
function setStarredIds(ids: Iterable<string>) {
  try { localStorage.setItem(STAR_KEY, JSON.stringify([...ids])); } catch { /* storage blocked */ }
  U.starred = new Set(ids);
}
function flipStar(id: string) {
  const s = getStarred();
  s.has(id) ? s.delete(id) : s.add(id);
  setStarredIds(s);
  return s;
}

// The server mirror, never awaited: a star has always felt instant.
function pushStar(id: string, saved: boolean) {
  if (!signedIn()) return;
  api(`/me/saved/${encodeURIComponent(id)}`, { method: saved ? "PUT" : "DELETE" }).catch(() => revertStar(id, saved));
}
function revertStar(id: string, attempted: boolean) {
  if (!signedIn()) return;
  const s = getStarred();
  if (s.has(id) !== attempted) return;
  flipStar(id);
  if (F.starred_only) loadJobs();
  U.error = { text: attempted ? "Couldn't save that job. Try again." : "Couldn't remove that job from your saved jobs. Try again." };
  emit();
}

export function toggleStar(id: string) {
  const on = flipStar(id).has(id);
  pushStar(id, on);
  if (F.starred_only) loadJobs();
  emit();
}

async function syncSavedFromServer() {
  if (!signedIn()) return;
  let data: { saved?: { job_id: string }[] };
  try { data = await api("/me/saved"); } catch { return; }
  const local = getStarred();
  const remote = (data?.saved || []).map((r) => r.job_id).reverse();
  const remoteSet = new Set(remote);
  let merged = false;
  try { merged = localStorage.getItem(SAVED_MERGED_KEY) === "1"; } catch { /* storage blocked */ }
  if (merged) {
    const same = remoteSet.size === local.size && remote.every((id) => local.has(id));
    if (same) return;
    setStarredIds(remoteSet);
    if (F.starred_only) loadJobs();
    emit();
    return;
  }
  const union = new Set([...local, ...remote]);
  if (union.size !== local.size) setStarredIds(union);
  const pushes = [...local].filter((id) => !remoteSet.has(id)).map((id) => api(`/me/saved/${encodeURIComponent(id)}`, { method: "PUT" }));
  Promise.all(pushes).then(() => { try { localStorage.setItem(SAVED_MERGED_KEY, "1"); } catch { /* storage blocked */ } }, () => {});
  if (union.size === local.size) return;
  if (F.starred_only) loadJobs();
  emit();
}

async function syncQueueFromServer() {
  if (!signedIn()) return;
  try {
    const [queue, history] = await Promise.all([
      api<{ queue?: { job_id: string }[] }>("/me/apply/queue"),
      api<{ applied?: { job_id: string; status: string; at?: string }[] }>("/me/apply/history").catch(() => null)]);
    U.queue = new Set((queue?.queue || []).map((r) => r.job_id));
    U.appliedAt = new Map((history?.applied || []).filter((r) => (r.status === "submitted" || r.status === "sent") && r.at).map((r) => [r.job_id, r.at!]));
  } catch { return; }
  emit();
}

export function appliedLabel(id: string) {
  const at = U.appliedAt.get(id);
  return at ? `Applied ${fmtAgeAgo((Date.now() - new Date(at).getTime()) / 86400000)}` : null;
}

export async function toggleQueue(id: string) {
  if (!signedIn()) return requestSignIn();
  const on = !U.queue.has(id);
  U.queue = new Set(U.queue);
  on ? U.queue.add(id) : U.queue.delete(id);
  emit();
  try {
    await api(`/me/apply/queue/${encodeURIComponent(id)}`, { method: on ? "PUT" : "DELETE" });
  } catch (err) {
    if (U.queue.has(id) !== on) return;
    U.queue = new Set(U.queue);
    on ? U.queue.delete(id) : U.queue.add(id);
    const e = err as { status?: number; message?: string };
    U.error = { text: on
      ? `Couldn't queue that job. ${[403, 409, 422].includes(e.status || 0) ? e.message : "Try again."}`
      : "Couldn't take that job off your queue. Try again." };
    emit();
  }
}

// fetch

const RETRY_WAITS = [600, 1500, 3500];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function getJSON<T = any>(path: string, signal?: AbortSignal): Promise<T> {
  // A retried /facets or /stats is more load on the box at its slowest; they wait for the next ask.
  const retries = /^\/(facets|stats)(\?|$)/.test(path) ? 0 : RETRY_WAITS.length;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, signal ? { signal } : undefined);
    } catch (err) {
      if ((err as Error).name === "AbortError" || attempt >= retries) throw err;
      await wait(RETRY_WAITS[attempt]);
      continue;
    }
    if (res.ok) return res.json();
    // Never a 429: asking again inside Cloudflare's window only extends the block.
    if (res.status >= 500 && attempt < retries) {
      await wait(RETRY_WAITS[attempt]);
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      continue;
    }
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  }
}

// views and params

export function currentView() {
  if (F.starred_only) return "saved";
  if (F.skills.length) return "matches";
  return F.roles === "tech" ? "tech" : "all";
}

export function currentFilterParams() {
  return {
    search: F.search, search_mode: F.search_mode, search_exact: F.search_exact,
    department: F.department.join(","), seniority: F.seniority.join(","), company: F.company.join(","),
    country: F.country.join(","), city: F.city.join(","), workplace: F.workplace.join(","), skills: F.skills.join(","),
    salary_min: F.salary_min, salary_max: F.salary_max, salary_known: F.salary_known ? "1" : "", salary_disclosed: F.salary_disclosed ? "1" : "",
    confidence: F.confidence, max_age_days: F.max_age_days,
    roles: !F.starred_only && F.roles === "tech" ? "tech" : "",
  };
}
const countingParams = () => ({ ...currentFilterParams(), confidence: "", skills: "" });

export function buildShareParams() {
  const p = new URLSearchParams();
  if (F.search) p.set("search", F.search);
  if (F.search_mode) p.set("search_mode", F.search_mode);
  if (F.search_exact) p.set("search_exact", "1");
  for (const k of ["department", "seniority", "company", "country", "city", "workplace", "skills"] as const) if (F[k].length) p.set(k, F[k].join(","));
  if (F.salary_min) p.set("salary_min", F.salary_min);
  if (F.salary_max) p.set("salary_max", F.salary_max);
  if (F.salary_known) p.set("salary_known", "1");
  if (F.salary_disclosed) p.set("salary_disclosed", "1");
  if (F.confidence !== "all") p.set("confidence", F.confidence);
  if (F.max_age_days) p.set("max_age_days", F.max_age_days);
  if (F.starred_only) p.set("starred", "1");
  if (F.roles !== DEFAULT_ROLES) p.set("roles", F.roles);
  if (F.sort !== (F.search ? "relevance" : "age")) p.set("sort", F.sort);
  if (F.dir !== "asc") p.set("dir", F.dir);
  if (U.selected) p.set("job", U.selected);
  return p;
}
export function shareUrl() {
  const q = buildShareParams().toString();
  return location.pathname + (q ? `?${q}` : "");
}
function syncUrl() {
  history.replaceState(null, "", shareUrl());
}

const SORTABLE_KEYS = new Set(["age", "match", "relevance"]);
function cleanFilterValue(key: string, value: unknown): any {
  switch (key) {
    case "salary_min": case "salary_max": case "max_age_days": {
      if (value === "" || value == null) return "";
      const s = String(value);
      return /^\d+$/.test(s) && Number(s) > 0 ? s : undefined;
    }
    case "salary_known": case "salary_disclosed":
      if (value === true || value === "1") return true;
      if (value === false || value === "" || value === "0" || value == null) return false;
      return undefined;
    case "sort": return SORTABLE_KEYS.has(value as string) ? value : undefined;
    case "dir": return value === "asc" || value === "desc" ? value : undefined;
    default: return value;
  }
}

function clearFilters() {
  F.search = ""; F.search_mode = ""; F.search_exact = ""; F.sortExplicit = false;
  F.department = []; F.seniority = []; F.company = []; F.country = []; F.city = []; F.workplace = [];
  F.confidence = "all"; F.max_age_days = ""; F.salary_min = ""; F.salary_max = ""; F.salary_known = false; F.salary_disclosed = false;
  F.starred_only = false;
}
function defaultFilters() {
  clearFilters();
  F.skills = [];
  F.roles = DEFAULT_ROLES;
  F.sort = "age"; F.dir = "asc"; F.offset = 0;
}

// reset: the URL is the whole state (Back, Forward, a saved search), so
// nothing it leaves out may survive from the page before. Boot keeps the
// stored location under it.
export function applyStateFromUrl(search: string, { reset = false } = {}) {
  const p = new URLSearchParams(search);
  if (reset) defaultFilters();
  // A CV match says "show me my matches", not inside whatever was typed.
  if (p.has("skills")) clearFilters();
  if (p.has("search")) F.search = p.get("search") || "";
  F.search_mode = p.get("search_mode") === "any" ? "any" : "";
  F.search_exact = p.get("search_exact") === "1" ? "1" : "";
  if (p.has("q") || p.has("keywords")) {
    F.search = [p.get("q") || "", ...(p.get("keywords") || "").split(";")].map((t) => t.trim()).filter(Boolean)
      .map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" ");
  }
  for (const key of ["department", "seniority", "company", "country", "city", "workplace", "skills"] as ListKey[]) {
    if (p.has(key)) F[key] = (p.get(key) || "").split(",").filter(Boolean);
  }
  if (p.has("confidence")) F.confidence = p.get("confidence") || "all";
  if (p.get("israel_only") === "1" && !F.country.includes("IL")) F.country = [...F.country, "IL"];
  if (p.has("max_age_days")) { const v = cleanFilterValue("max_age_days", p.get("max_age_days")); if (v !== undefined) F.max_age_days = v; }
  for (const key of ["salary_min", "salary_max", "salary_known", "salary_disclosed"] as const) {
    if (!p.has(key)) continue;
    const v = cleanFilterValue(key, p.get(key));
    if (v !== undefined) (F as any)[key] = v;
  }
  if (p.has("starred")) F.starred_only = p.get("starred") === "1";
  if (p.has("roles")) F.roles = p.get("roles") === "all" ? "all" : "tech";
  if (p.has("sort")) {
    const v = cleanFilterValue("sort", p.get("sort"));
    if (v !== undefined) { F.sort = v; F.sortExplicit = true; }
  } else if (p.has("skills") && F.skills.length) { F.sort = "match"; F.dir = "asc"; }
  else followSearchSort();
  if (p.has("dir")) { const v = cleanFilterValue("dir", p.get("dir")); if (v !== undefined) F.dir = v; }
  if (p.has("offset")) { const n = parseInt(p.get("offset") || "", 10); F.offset = Number.isFinite(n) && n > 0 ? n : 0; }
}

// Only the location survives a fresh visit.
const PERSISTED_FILTER_KEYS = ["country", "city"] as const;
function saveFiltersToStorage() {
  try {
    const saved: Record<string, unknown> = {};
    for (const key of PERSISTED_FILTER_KEYS) saved[key] = F[key];
    localStorage.setItem(FILTERS_KEY, JSON.stringify(saved));
  } catch { /* quota or private browsing */ }
}
function applyStoredFilters() {
  let saved: any;
  try { saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || "null"); } catch { return; }
  if (!saved || typeof saved !== "object") return;
  if (saved.israel_only && !Array.isArray(saved.country)) saved.country = ["IL"];
  else if (saved.israel_only && !saved.country.includes("IL")) saved.country = [...saved.country, "IL"];
  for (const key of PERSISTED_FILTER_KEYS) {
    if (!(key in saved)) continue;
    const value = cleanFilterValue(key, saved[key]);
    if (Array.isArray(value)) F[key] = value.filter((v) => typeof v === "string");
  }
}

// With a search in the box, relevance; with an empty box, newest. Until
// the reader picks an order themselves.
function followSearchSort() {
  if (F.sortExplicit) return;
  const wanted = F.search ? "relevance" : "age";
  if (F.sort !== wanted) { F.sort = wanted; F.dir = "asc"; }
}

export function setSort(key: string, dir: string, explicit = true) {
  F.sort = key; F.dir = dir;
  if (explicit) F.sortExplicit = true;
  F.offset = 0;
  loadJobs();
}

export function setDatePosted(v: string) {
  F.max_age_days = !v || v === "any" ? "" : v;
  F.offset = 0;
  loadJobs();
}

// the job list

function getCachedJobs(params: string): JobsResponse | null {
  try {
    const raw = localStorage.getItem(JOBS_CACHE_PREFIX + params);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && Array.isArray(parsed.jobs) && parsed.jobs.length ? parsed : null;
  } catch { return null; }
}
function setCachedJobs(params: string, data: JobsResponse | null) {
  try {
    if (!data || !Array.isArray(data.jobs) || !data.jobs.length) return;
    const others = Object.keys(localStorage).filter((k) => k.startsWith(JOBS_CACHE_PREFIX) && k !== JOBS_CACHE_PREFIX + params);
    if (others.length >= JOBS_CACHE_MAX) others.forEach((k) => localStorage.removeItem(k));
    localStorage.setItem(JOBS_CACHE_PREFIX + params, JSON.stringify(data));
  } catch { /* quota or private browsing */ }
}

// The precomputed first pages, keyed by the exact query they answer.
const BOOTSTRAP_FILES: Record<string, string> = {
  "confidence=all&sort=age&dir=asc&limit=50&offset=0": "/bootstrap.json",
  "country=IL&confidence=all&sort=age&dir=asc&limit=50&offset=0": "/bootstrap-il.json",
};
const bootstrapFetches = new Map<string, Promise<any>>();
function getBootstrap(params: string): Promise<{ params: string; jobs: JobsResponse } | null> {
  const url = BOOTSTRAP_FILES[params];
  if (!url) return Promise.resolve(null);
  if (!bootstrapFetches.has(url)) bootstrapFetches.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return bootstrapFetches.get(url)!;
}

let jobsRequestSeq = 0;
// Bumped only by a load that replaces the list. The deferred count belongs
// to the list, so a page appended to it must not throw the count away.
let listSeq = 0;
let jobsInFlight: AbortController | null = null;
let jobCountInFlight: AbortController | null = null;
let listParams: string | null = null;
let heldJobs: JobsResponse | null = null;
let autoAnyFor: string | null = null;
let lastCountedSearch = "";
export function countSearch() {
  if (!F.search || F.search === lastCountedSearch) return;
  lastCountedSearch = F.search;
  const w = window as unknown as { ojCount?: (kind: string, what?: string) => void };
  if (w.ojCount) w.ojCount("search", F.search);
}

// The deep-linked job, kept open through the boot's own load only.
let keepOpen: string | null = null;

// True when the page landed, so a failed or superseded append is not read as the list's end.
export async function loadJobs({ background = false, append: wantAppend = false } = {}): Promise<boolean> {
  let append = wantAppend;
  if (!append && !background) {
    keepOpen = null;
    F.offset = 0;
    U.listEnded = false;
    U.listReloading = true;
  }
  // The refresh would abort a page being appended.
  if (background && (U.loadingMore || (U.jobs?.jobs || []).length > PAGE_SIZE)) return false;
  const seq = ++jobsRequestSeq;
  if (!append) listSeq = seq;
  if (!background) { heldJobs = null; U.held = 0; }
  if (jobsInFlight) jobsInFlight.abort();
  const inFlight = new AbortController();
  jobsInFlight = inFlight;

  if (!append) { syncUrl(); saveFiltersToStorage(); }
  if (!background) U.error = null;
  emit();

  if (F.starred_only) {
    renderStarredOnly(seq, inFlight);
    scheduleFacets();
    return true;
  }
  U.empty = null;

  const params = qs({ ...currentFilterParams(), sort: F.sort, dir: F.dir, limit: PAGE_SIZE, offset: F.offset });
  let cached = getCachedJobs(params);
  if (!cached) {
    const boot = await getBootstrap(params);
    if (seq !== jobsRequestSeq) return false;
    if (boot && boot.params === params && boot.jobs && boot.jobs.jobs.length) cached = boot.jobs;
  }

  if (append) {
    // The rows on screen stay; the new ones land after them.
  } else if (background) {
    cached = U.jobs;
  } else if (cached) {
    U.skeleton = false;
    U.jobs = cached;
    paintJobs(cached);
  } else {
    U.skeleton = true;
    U.jobs = null;
  }
  emit();

  // An appended page asks for no count: the list's own count is in flight.
  const deferCount = !background && !append;
  try {
    let data: JobsResponse = await getJSON(`/jobs?${params}${deferCount || append ? "&count=skip" : ""}`, inFlight.signal);
    if (seq !== jobsRequestSeq) return false;
    if (data.total === null && cached && typeof cached.total === "number") data.total = cached.total;
    const changed = append || !cached || JSON.stringify(data) !== JSON.stringify(cached);
    if (!append) setCachedJobs(params, data);
    if (changed && background && holdForReader(data)) return true;
    if (append && params.replace(/&?offset=\d+/, "") !== listParams) append = false;
    if (append) {
      if (data.jobs.length < PAGE_SIZE) U.listEnded = true;
      const seen =new Set((U.jobs?.jobs || []).map((j) => (j.url || "").trim().toLowerCase() || `${j.company_domain}\u0000${j.external_id || j.id}`));
      data = { ...data, jobs: dedupeJobs(data.jobs, seen) };
      U.jobs = { ...data, jobs: [...(U.jobs?.jobs || []), ...data.jobs], total: data.total ?? U.jobs?.total ?? null };
    } else {
      data = { ...data, jobs: dedupeJobs(data.jobs) };
      listParams = params.replace(/&?offset=\d+/, "");
      if (changed) {
        heldJobs = null; U.held = 0;
        U.jobs = data;
        U.skeleton = false;
        if (!paintJobs(data)) return false;
      }
    }
    U.skeleton = false;
    if (deferCount) loadJobCount(params, seq);
    if (!append) scheduleFacets();
    return true;
  } catch (err) {
    if (seq !== jobsRequestSeq || (err as Error).name === "AbortError") return false;
    // A failed page 2 keeps the rows on screen; Load more asks again.
    if (!cached && !append) {
      U.skeleton = false;
      U.jobs = null;
      U.error = { text: "Couldn't load jobs.", retry: true };
    }
    return false;
  } finally {
    if (!append && !background) U.listReloading = false;
    emit();
  }
}

// What renderJobs decided beyond drawing: an any-word retry, the search
// notice, the empty state, and whether the open listing survived.
// False when it started another load instead.
function paintJobs(data: JobsResponse): boolean {
  U.matchedSkills = new Set(data.matched_skills || []);
  const terms = data.search?.terms || [];
  if (!data.jobs.length && F.search && !F.search_mode && !F.offset && terms.length > 1 && autoAnyFor !== F.search) {
    autoAnyFor = F.search;
    F.search_mode = "any";
    loadJobs();
    refreshStats();
    return false;
  }
  const info = data.search;
  U.searchRelated = (info && !info.exact && info.expanded) || [];
  if (!data.jobs.length) {
    U.empty = F.search ? { search: { terms: info?.terms || searchTermsInPlay(), mode: info?.mode || "all" } } : {};
  } else {
    U.empty = null;
  }
  if (dom.list) dom.list.scrollTop = 0;
  if (isPhone()) window.scrollTo(0, 0);
  if (U.selected !== null) {
    const still = data.jobs.some((j) => j.id === U.selected);
    if (still) requestAnimationFrame(revealSelectedRow);
    // A shared link (?job=) to a job past the first page stays open.
    else if (U.selected !== keepOpen) closeJobAndSync();
  }
  return true;
}

// New rows found by a background refresh while the reader was further
// down wait behind a button, so nothing moves under them.
function atListTop() {
  if (isPhone()) {
    const top = dom.rows?.getBoundingClientRect().top ?? 0;
    return top >= 0;
  }
  return !dom.list || dom.list.scrollTop < 8;
}
function holdForReader(data: JobsResponse) {
  const shown = new Set((U.jobs?.jobs || []).map((j) => j.id));
  const fresh = data.jobs.filter((j) => !shown.has(j.id)).length;
  if (!fresh || atListTop()) return false;
  heldJobs = data;
  U.held = fresh;
  emit();
  return true;
}
export function showHeldJobs({ scroll = true } = {}) {
  if (!heldJobs) return;
  const data = heldJobs;
  heldJobs = null; U.held = 0;
  U.jobs = data;
  paintJobs(data);
  if (scroll) {
    if (dom.list) dom.list.scrollTo({ top: 0, behavior: "smooth" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }
  emit();
}

export function searchTermsInPlay() {
  const out: string[] = [];
  for (const m of (F.search || "").matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (m[1] || m[2] || "").trim().toLowerCase();
    if (term) out.push(term);
  }
  return out.slice(0, MAX_SEARCH_TERMS);
}

async function renderStarredOnly(seq: number, inFlight: AbortController) {
  U.error = null;
  const starred = getStarred();
  if (!starred.size) {
    U.empty = { saved: "none" };
    U.jobs = { jobs: [], total: 0 };
    U.skeleton = false;
    emit();
    return;
  }
  U.empty = null;
  const ids = [...starred].slice(-200);
  U.skeleton = true;
  U.jobs = null;
  emit();
  try {
    const data: JobsResponse = await getJSON(`/jobs?${qs({ ids: ids.join(","), include_closed: 1, include_outdated: 1, limit: 200 })}`, inFlight.signal);
    if (seq !== jobsRequestSeq) return;
    U.skeleton = false;
    U.jobs = { ...data, total: data.jobs.length };
    if (!data.jobs.length) U.empty = { saved: "gone" };
    emit();
  } catch (err) {
    if (seq !== jobsRequestSeq || (err as Error).name === "AbortError") return;
    U.skeleton = false;
    U.jobs = null;
    U.error = { text: "Couldn't load your saved jobs. Try again." };
    emit();
  }
}

async function loadJobCount(params: string, seq: number) {
  if (jobCountInFlight) jobCountInFlight.abort();
  const inFlight = new AbortController();
  jobCountInFlight = inFlight;
  try {
    const data = await getJSON<{ total: number }>(`/jobs?${params}&count=only`, inFlight.signal);
    if (seq !== listSeq || !U.jobs) return;
    U.jobs = { ...U.jobs, total: data.total };
    // The cache holds the first page with its total, never appended pages.
    const first = getCachedJobs(params);
    if (first) setCachedJobs(params, { ...first, total: data.total });
    emit();
  } catch { /* the rows are up; the line keeps reading without a total */ } finally {
    if (jobCountInFlight === inFlight) jobCountInFlight = null;
  }
}

export function resultNoun() {
  if (currentView() === "matches") return "jobs matching your resume";
  return F.roles === "tech" && !F.starred_only ? "tech jobs" : "jobs";
}

export function updatedAgo() {
  if (U.lastCheckedAt === null) return "";
  const mins = Math.max(0, Math.round((Date.now() - U.lastCheckedAt) / 60000));
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `Updated ${hrs}h ago` : `Updated ${Math.round(hrs / 24)}d ago`;
}

export function moreAvailable() {
  const shown = (U.jobs?.jobs || []).length;
  const total = U.jobs?.total;
  if (F.starred_only || !U.jobs) return false;
  return !U.listEnded && (total == null ? shown >= PAGE_SIZE && shown > 0 : shown < total);
}

export async function loadMoreJobs() {
  if (U.loadingMore || U.listReloading || !moreAvailable()) return;
  const shown = (U.jobs?.jobs || []).length;
  U.loadingMore = true;
  emit();
  const previous = F.offset;
  F.offset = shown;
  try {
    const ok = await loadJobs({ append: true });
    // A page that answered but added nothing ends the list too (a short one already did).
    if (ok && (U.jobs?.jobs || []).length === shown) U.listEnded = true;
    // Unless a new search took over the offset meanwhile.
    if (!ok && F.offset === shown) F.offset = previous;
  } finally {
    U.loadingMore = false;
    emit();
  }
}

// the open listing

export const findKnownJob = (id: string) => U.jobs?.jobs.find((j) => j.id === id) || null;
export const jobPermalink = (id: string) => `${location.origin}${location.pathname}?job=${encodeURIComponent(id)}`;

function setCanonical(path: string) {
  const link = document.getElementById("canonical") as HTMLLinkElement | null;
  if (link) link.href = `${location.origin}${path}`;
}

// The list is virtual, so the open row may not be in the page: the list
// scrolls it into view by its index (List.tsx sets dom.reveal).
export function revealSelectedRow() {
  if (U.selected !== null) dom.reveal?.(U.selected);
}

async function fetchDescribed(job: Job): Promise<Job | null> {
  try {
    const res = await fetch(`/descriptions/${encodeURIComponent(job.id)}.json`, { signal: AbortSignal.timeout(10000) });
    const blob = res.ok ? await res.json() : null;
    return blob && blob.description ? { ...job, description: blob.description } : null;
  } catch { return null; }
}

let closeTimer = 0;
export async function openJob(id: string) {
  const w = window as unknown as { ojCount?: (kind: string) => void };
  if (w.ojCount) w.ojCount("job_view");
  const known = findKnownJob(id);
  U.selected = id;
  setCanonical(`/job/${encodeURIComponent(id)}`);
  clearTimeout(closeTimer);
  U.detail = { id, job: known, loading: true, error: null, gone: false };
  U.paneOpen = true;
  emit();
  requestAnimationFrame(revealSelectedRow);
  try {
    const full = (known && await fetchDescribed(known)) || await getJSON<Job>(`/jobs/${encodeURIComponent(id)}`);
    if (U.selected !== id) return;
    U.detail = { id, job: full, loading: false, error: null, gone: false };
  } catch (err) {
    if (U.selected !== id) return;
    const message = (err as Error).message || "";
    if (known) U.detail = { id, job: known, loading: false, error: message, gone: false };
    else U.detail = { id, job: null, loading: false, error: /no job with that id/i.test(message) ? null : message, gone: /no job with that id/i.test(message) };
  }
  emit();
}
export async function openJobAndPush(id: string) {
  await openJob(id);
  if (U.selected === id) history.pushState(null, "", shareUrl());
}
export function stepJob(step: number) {
  const rows = U.jobs?.jobs || [];
  const i = rows.findIndex((r) => r.id === U.selected);
  const next = rows[i + step];
  if (next) openJobAndPush(next.id);
}
// ArrowUp/ArrowDown anywhere on the board (app.js:3700): with nothing open,
// down opens the first job and up the last; otherwise one step, held at the ends.
export function arrowJob(down: boolean) {
  const rows = U.jobs?.jobs || [];
  if (!rows.length || U.skeleton) return false;
  const at = rows.findIndex((r) => r.id === U.selected);
  const next = at === -1 ? (down ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + (down ? 1 : -1)));
  if (next !== at) openJobAndPush(rows[next].id);
  return true;
}
export function closeJob() {
  U.selected = null;
  U.paneOpen = false;
  setCanonical("/board");
  clearTimeout(closeTimer);
  // The empty state waits for the sheet to slide out below 1100px.
  const settle = () => { U.detail = null; emit(); };
  if (isSheet()) closeTimer = window.setTimeout(settle, 250);
  else settle();
  emit();
}
export function closeJobAndSync() {
  closeJob();
  syncUrl();
}

// the rail

export const RAIL_GROUPS = [
  { key: "department", title: "Category", facet: "categories" as const },
  { key: "seniority", title: "Level", facet: "seniority" as const, labels: SENIORITY_LABELS },
  { key: "workplace", title: "Workplace", facet: "workplace" as const, labels: WORKPLACE_LABELS },
  { key: "company", title: "Companies", facet: "companies" as const, search: "Search companies", remote: true },
] as const;
export type RailGroup = (typeof RAIL_GROUPS)[number];

export function railLabel(group: RailGroup, row: { value: string; label?: string; name?: string }) {
  const labels = (group as { labels?: Record<string, string> }).labels;
  if (labels) return labels[row.value] || row.value;
  return row.label || row.name || row.value;
}
export const railSelected = (group: RailGroup) => new Set(F[group.key as ListKey] || []);
export function railRows(group: RailGroup): { value: string; n: number | null; name?: string }[] {
  const counted = U.facets[group.facet];
  if (counted && counted.length) return counted;
  const labels = (group as { labels?: Record<string, string> }).labels;
  if (labels) return Object.keys(labels).map((value) => ({ value, n: null }));
  return [];
}
export function railVisibleRows(group: RailGroup) {
  const q = (U.railQueries.get(group.key) || "").trim().toLowerCase();
  const picked = railSelected(group);
  const extra = (group as { remote?: boolean }).remote ? [...U.railFound.values()].filter((r) => !railRows(group).some((x) => x.value === r.value)) : [];
  const counted = [...railRows(group), ...extra];
  const have = new Set(counted.map((r) => r.value));
  const pool = [...counted, ...[...picked].filter((v) => !have.has(v)).map((v) => ({ value: v, n: 0 }))];
  if (q) return pool.filter((r) => railLabel(group, r).toLowerCase().includes(q));
  if (U.railExpanded.has(group.key)) return pool;
  const top = pool.slice(0, RAIL_TOP_N);
  const shown = new Set(top.map((r) => r.value));
  return [...top, ...pool.filter((r) => picked.has(r.value) && !shown.has(r.value))];
}

export function companyNameFor(domain: string) {
  const facet = U.facets.companies.find((c) => c.value === domain && c.name);
  if (facet) return facet.name!;
  const hit = (U.jobs?.jobs || []).find((j) => j.company_domain === domain && j.company_name);
  return hit ? hit.company_name! : U.railFound.get(domain)?.name || domainLabel(domain);
}
export function companyLogoFor(domain: string) {
  const hit = (U.jobs?.jobs || []).find((j) => j.company_domain === domain && j.logo_url);
  if (hit) return hit.logo_url!;
  for (const list of [U.scoped?.data?.top_companies, U.stats?.top_companies]) {
    const c = (list || []).find((r) => r.domain === domain && r.logo_url);
    if (c) return c.logo_url!;
  }
  return null;
}

export function railToggle(kind: string, value: string, on: boolean) {
  if (kind === "salary_known") F.salary_known = on;
  else if (kind === "salary_disclosed") F.salary_disclosed = on;
  else if (kind === "country") {
    F.city = F.city.filter((t) => cityCountry(t) !== value);
    F.country = on ? [...new Set([...F.country, value])] : F.country.filter((v) => v !== value);
  } else if (kind === "city") {
    F.city = on ? [...new Set([...F.city, value])] : F.city.filter((v) => v !== value);
    const home = cityCountry(value);
    if (home && !F.country.includes(home)) F.country = [...F.country, home];
  } else {
    const next = new Set(F[kind as ListKey] || []);
    on ? next.add(value) : next.delete(value);
    F[kind as ListKey] = [...next];
  }
  railApply();
}
export function railApply() {
  F.offset = 0;
  loadJobs();
}
export function setCompany(domain: string) {
  F.company = [domain];
  F.starred_only = false;
  railApply();
}

export function commitSalary(lo: number, hi: number) {
  const s = U.facets.salary;
  if (!s) return;
  const wasSet = !!(F.salary_min || F.salary_max);
  F.salary_min = lo > s.min ? String(lo) : "";
  F.salary_max = hi < s.max ? String(hi) : "";
  if (!wasSet && (F.salary_min || F.salary_max)) F.salary_known = true;
  railApply();
}

let railSearchSeq = 0;
let railSearchTimer = 0;
export function railSearch(key: string, value: string) {
  U.railQueries.set(key, value);
  emit();
  const group = RAIL_GROUPS.find((g) => g.key === key);
  if (!group || !(group as { remote?: boolean }).remote) return;
  clearTimeout(railSearchTimer);
  const q = value.trim();
  if (q.length < 2) return;
  railSearchTimer = window.setTimeout(async () => {
    const seq = ++railSearchSeq;
    try {
      const data = await getJSON<{ companies?: { value: string; n: number; name?: string }[] }>(`/companies/search?${qs({ ...currentFilterParams(), company: "", name: q })}`);
      if (seq !== railSearchSeq) return;
      (data.companies || []).forEach((r) => U.railFound.set(r.value, { value: r.value, n: r.n, name: r.name }));
      emit();
    } catch { /* the group keeps what it had */ }
  }, 250);
}
export function toggleExpanded(key: string) {
  U.railExpanded.has(key) ? U.railExpanded.delete(key) : U.railExpanded.add(key);
  emit();
}
export function setRailOpen(key: string | null) {
  U.railOpen = key;
  emit();
}

export type Chip = { kind: string; value: string; text: string };
export function activeChips(): Chip[] {
  const chips: Chip[] = [];
  const narrowed = new Set<string>();
  for (const city of F.city) {
    const c = cityCountry(city);
    if (c) narrowed.add(c);
    chips.push({ kind: "city", value: city, text: cityName(city) });
  }
  for (const code of F.country) {
    if (narrowed.has(code)) continue;
    const home = U.facets.locations.find((c) => c.value === code);
    chips.push({ kind: "country", value: code, text: home?.label || countryLabel(code) });
  }
  for (const key of ["department", "seniority", "workplace", "company"] as const) {
    const labels = key === "seniority" ? SENIORITY_LABELS : key === "workplace" ? WORKPLACE_LABELS : null;
    for (const v of F[key]) chips.push({ kind: key, value: v, text: labels ? labels[v] || v : key === "company" ? companyNameFor(v) : v });
  }
  if (F.max_age_days) chips.push({ kind: "max_age_days", value: "", text: `Past ${F.max_age_days} days` });
  if (F.salary_min || F.salary_max) {
    const s = U.facets.salary;
    const lo = Number(F.salary_min) || s?.min;
    const hi = Number(F.salary_max) || s?.max;
    chips.push({ kind: "salary", value: "", text: `${fmtShekels(lo)}-${fmtShekels(hi)}` });
  }
  if (F.salary_known) chips.push({ kind: "salary_known", value: "", text: "Estimated salary" });
  if (F.salary_disclosed) chips.push({ kind: "salary_disclosed", value: "", text: "Disclosed salary" });
  return chips;
}
export function removeChip(kind: string, value: string) {
  if (kind === "max_age_days") F.max_age_days = "";
  else if (kind === "salary") { F.salary_min = ""; F.salary_max = ""; }
  else if (kind === "salary_known") F.salary_known = false;
  else if (kind === "salary_disclosed") F.salary_disclosed = false;
  else if (kind === "country" || kind === "city") return railToggle(kind, value, false);
  else if (kind === "roles") return setView(DEFAULT_ROLES);
  else F[kind as ListKey] = (F[kind as ListKey] || []).filter((v) => v !== value);
  railApply();
}
export const anythingOn = () => activeChips().length > 0 || !!F.search || F.roles !== DEFAULT_ROLES || F.starred_only;

export function resetAll() {
  defaultFilters();
  U.railQueries.clear();
  U.railFound.clear();
  loadJobs();
}

// What the board is filtered by, in the filter bar's own words.
export function activeFilterSummary() {
  const parts: string[] = [];
  if (F.search) parts.push(`"${F.search}"`);
  if (F.department.length) parts.push(F.department.join(", "));
  if (F.seniority.length) parts.push(F.seniority.map((s) => SENIORITY_LABELS[s] || s).join(", "));
  if (F.company.length) parts.push(F.company.map(companyNameFor).join(", "));
  if (F.country.length) parts.push(F.country.map(countryLabel).join(", "));
  if (F.city.length) parts.push(F.city.map(cityName).join(", "));
  if (F.workplace.length) parts.push(F.workplace.map((w) => WORKPLACE_LABELS[w] || w).join(", "));
  if (F.skills.length) parts.push(`${F.skills.length} resume skill${F.skills.length === 1 ? "" : "s"}`);
  if (F.max_age_days) parts.push(`posted in the last ${F.max_age_days} days`);
  return parts;
}

// The most recently applied filter, with the way to undo it.
export function lastAppliedFilter(): { label: string; clear: () => void } | null {
  const undo: [() => unknown, () => void, () => string][] = [
    [() => F.search, () => { F.search = ""; }, () => `"${F.search}"`],
    [() => F.max_age_days, () => { F.max_age_days = ""; }, () => `posted in the last ${F.max_age_days} days`],
    [() => F.workplace.length, () => { F.workplace = []; }, () => F.workplace.map((w) => WORKPLACE_LABELS[w] || w).join(", ")],
    [() => F.city.length, () => { F.city = []; }, () => F.city.map(cityName).join(", ")],
    [() => F.country.length, () => { F.country = []; }, () => F.country.map(countryLabel).join(", ")],
    [() => F.company.length, () => { F.company = []; }, () => F.company.map(companyNameFor).join(", ")],
    [() => F.seniority.length, () => { F.seniority = []; }, () => F.seniority.map((x) => SENIORITY_LABELS[x] || x).join(", ")],
    [() => F.department.length, () => { F.department = []; }, () => F.department.join(", ")],
  ];
  for (const [has, clear, label] of undo) if (has()) return { label: label(), clear };
  return null;
}
export function undoLastFilter() {
  const last = lastAppliedFilter();
  if (!last) return;
  last.clear();
  railApply();
}

// the search box

let searchTimer = 0;
export function typeSearch(value: string) {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => applySearchNow(value), 500);
}
export function applySearchNow(raw: string) {
  clearTimeout(searchTimer);
  const next = raw.trim();
  if (next === F.search) return;
  F.search = next;
  countSearch();
  F.search_mode = "";
  F.search_exact = "";
  followSearchSort();
  F.offset = 0;
  loadJobs();
}
export function setSearch({ search, mode, exact }: { search?: string; mode?: "" | "any"; exact?: "" | "1" }) {
  if (search !== undefined) { F.search = search; countSearch(); }
  if (mode !== undefined) F.search_mode = mode;
  if (exact !== undefined) F.search_exact = exact;
  F.offset = 0;
  loadJobs();
  refreshStats();
}
export function searchSkill(skill: string) {
  F.search = skill.includes(" ") ? `"${skill}"` : skill;
  F.offset = 0;
  countSearch();
  loadJobs();
}

// places

export function locationText() {
  const loose = F.country.filter((c) => !F.city.some((t) => cityCountry(t) === c));
  const first = F.city[0] ? `${cityName(F.city[0])}, ${countryLabel(cityCountry(F.city[0]) || "")}` : loose[0] ? countryLabel(loose[0]) : "";
  const more = F.city.length + loose.length - 1;
  return more > 0 ? `${first} +${more}` : first;
}
export function placeCountries(): Country[] {
  const out = U.facets.locations.map((c) => {
    const f = U.placeFound.get(c.value);
    if (!f) return c;
    const have = new Set(c.cities.map((t) => t.value));
    return { ...c, cities: [...c.cities, ...f.cities.filter((t) => !have.has(t.value))] };
  });
  const listed = new Set(out.map((c) => c.value));
  for (const f of U.placeFound.values()) if (!listed.has(f.value)) out.push(f);
  return out;
}
let placeTimer = 0;
let placeSeq = 0;
export function placeSearch(q: string) {
  clearTimeout(placeTimer);
  const name = q.trim();
  U.placeAsking = name.length >= 2;
  emit();
  if (!U.placeAsking) return;
  placeTimer = window.setTimeout(async () => {
    const seq = ++placeSeq;
    try {
      const data = await getJSON<{ locations?: Country[] }>(`/places/search?${qs({ ...currentFilterParams(), country: "", city: "", name })}`);
      if (seq !== placeSeq) return;
      // A new Map, so Location.tsx's memo on it sees the answer.
      U.placeFound = new Map(U.placeFound);
      for (const f of data.locations || []) {
        const old = U.placeFound.get(f.value);
        const have = new Set((old?.cities || []).map((t) => t.value));
        U.placeFound.set(f.value, { ...f, n: f.n ?? old?.n ?? null,
          cities: [...(old?.cities || []), ...(f.cities || []).filter((t) => !have.has(t.value)).map((t) => ({ value: t.value, label: t.label || t.value, n: t.n }))] });
      }
    } catch { /* the list keeps what the facet sent */ }
    if (seq !== placeSeq) return;
    U.placeAsking = false;
    emit();
  }, 250);
}
export function clearPlaces() {
  F.country = [];
  F.city = [];
  railApply();
}

// views

export function matchSkillsOpen() {
  try { return localStorage.getItem(MATCH_SKILLS_OPEN_KEY) === "1"; } catch { return false; }
}
export function setMatchSkillsOpen(open: boolean) {
  try { localStorage.setItem(MATCH_SKILLS_OPEN_KEY, open ? "1" : "0"); } catch { /* storage blocked */ }
  U.matchSkillsOpen = open;
  emit();
}
export function dropSkill(skill: string) {
  F.skills = F.skills.filter((s) => s !== skill);
  if (!F.skills.length && F.sort === "match") { F.sort = "age"; F.dir = "asc"; }
  F.offset = 0;
  loadJobs();
}
async function profileSkills(): Promise<string[] | null> {
  if (!signedIn()) return null;
  try {
    const data = await api<{ profile?: { skills?: string[] }; skills?: string[] }>("/me/profile");
    const skills = data?.profile?.skills || data?.skills || [];
    return skills.length ? skills : null;
  } catch { return null; }
}
export async function setView(view: string) {
  F.offset = 0;
  U.matchPrompt = false;
  if (view === "saved") { F.starred_only = true; loadJobs(); return; }
  F.starred_only = false;
  if (view === "all" || view === "tech") {
    F.roles = view;
    F.skills = [];
    if (F.sort === "match") { F.sort = "age"; F.dir = "asc"; }
    loadJobs();
    return;
  }
  if (!F.skills.length) {
    const skills = await profileSkills();
    if (!skills) { U.matchPrompt = true; emit(); return; }
    F.skills = skills;
  }
  F.sort = "match"; F.dir = "asc";
  loadJobs();
}

// saved searches

export function savedSearches(): SavedSearch[] {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) || "[]");
    return Array.isArray(list) ? list.filter((s) => s && typeof s.query === "string" && s.name) : [];
  } catch { return []; }
}
function storeSavedSearches(list: SavedSearch[]) {
  try { localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(list)); } catch { /* per-browser nicety */ }
  U.savedSearches = list;
  emit();
}
export function currentSearchQuery() {
  const p = buildShareParams();
  p.delete("job"); p.delete("sort"); p.delete("dir");
  return p.toString();
}
export function saveCurrentSearch() {
  const q = currentSearchQuery();
  if (!q) return;
  const view = F.roles === "tech" && !F.starred_only ? "Tech jobs" : "All jobs";
  const summary = activeFilterSummary();
  const name = [...summary, ...(summary.length ? [] : [view])].join(" · ");
  storeSavedSearches([...savedSearches(), { id: Date.now().toString(36), name, query: q, seen_at: new Date().toISOString(), fresh: 0 }]);
}
export function forgetSavedSearch(id: string) {
  storeSavedSearches(savedSearches().filter((s) => s.id !== id));
}
export function openSavedSearch(id: string) {
  const list = savedSearches();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  history.pushState(null, "", `/board?${s.query}`);
  applyStateFromUrl(`?${s.query}`, { reset: true });
  if (U.selected) closeJob();
  loadJobs();
  s.seen_at = new Date().toISOString();
  s.fresh = 0;
  storeSavedSearches(list);
}
async function countSavedSearches() {
  const list = savedSearches();
  if (!list.length) return;
  await Promise.all(list.map(async (s) => {
    const p = new URLSearchParams(s.query);
    p.set("max_age_days", String(Math.max(1, Math.ceil((Date.now() - Date.parse(s.seen_at || "0")) / 864e5))));
    p.set("limit", "1");
    try {
      const r = await fetch(`${API_BASE}/jobs?${p}`);
      if (r.ok) s.fresh = (await r.json()).total ?? null;
    } catch { /* the row keeps its last count */ }
  }));
  storeSavedSearches(list);
}

// facets and statistics

function normalizeLocationFacets(rows: unknown): Country[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && typeof r.value === "string" && typeof r.label === "string").map((r) => {
    COUNTRY_LABELS_SEEN.set(r.value, r.label);
    return { value: r.value, label: r.label, n: r.n ?? null,
      cities: (Array.isArray(r.cities) ? r.cities : []).filter((c: any) => c && typeof c.value === "string").map((c: any) => ({ value: c.value, label: c.value, n: c.n ?? null })) };
  });
}

async function getStaticFacets(confidence: string) {
  try {
    const r = await fetch("/facets.json", { cache: "no-store" });
    if (r.ok) {
      const byConfidence = await r.json();
      if (byConfidence && byConfidence[confidence]) return byConfidence[confidence];
    }
  } catch { /* falls through to the API */ }
  return getJSON(`/facets?${qs(currentFilterParams())}`);
}
async function getStaticOrApi<T>(staticPath: string, apiPath: string): Promise<T> {
  try {
    const r = await fetch(staticPath, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch { /* falls through to the API */ }
  return getJSON(apiPath);
}

let facetsTimer = 0;
function scheduleFacets() {
  clearTimeout(facetsTimer);
  facetsTimer = window.setTimeout(() => { refreshFacetOptions(); refreshScopedStats(); }, 400);
}
let facetsRequestSeq = 0;
// /api/facets is the box's slowest call, so each question is asked once: a
// second call for the same filters (stats landing, a page appended) is
// dropped while the first is in flight or answered. The two-minute
// refresh forces a new one.
let facetsAsked: string | null = null;
async function refreshFacetOptions({ force = false } = {}) {
  const key = qs({ ...currentFilterParams(), skills: "" });
  if (!force && key === facetsAsked) return;
  facetsAsked = key;
  const seq = ++facetsRequestSeq;
  try {
    const facets = qs(countingParams())
      ? await getJSON(`/facets?${key}`)
      : await getStaticFacets(F.confidence || "verified");
    if (seq !== facetsRequestSeq) return;
    U.facetsLoaded = true;
    U.facets = {
      categories: facets.categories || [], seniority: facets.seniority || [], workplace: facets.workplace || [], companies: facets.companies || [],
      locations: normalizeLocationFacets(facets.locations), salary: facets.salary || null, salary_disclosed: facets.salary_disclosed || 0,
    };
    emit();
  } catch {
    // The rail keeps its previous counts; the same filters may ask again.
    if (seq === facetsRequestSeq) facetsAsked = null;
  }
}

function scopeShape(src: Scope): Scope {
  return { ...src, top_companies: Array.isArray(src.top_companies) ? src.top_companies : [] };
}
export function globalScope(stats: Stats): Scope {
  return scopeShape({ ...stats.totals, ...stats.throughput, ...stats.age, top_companies: stats.top_companies || [] });
}
export function currentScopeMode(): "global" | "pending" | "scoped" | "unavailable" {
  const params = qs(countingParams());
  if (!params) return "global";
  if (!U.scoped || U.scoped.params !== params) return "pending";
  return U.scoped.degraded ? "unavailable" : "scoped";
}

function setLastCheckedAt(iso?: string) {
  if (!iso) return;
  const t = new Date(iso).getTime();
  if (U.lastCheckedAt === null || t > U.lastCheckedAt) U.lastCheckedAt = t;
}

function getCachedStats(): Stats | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATS_CACHE_KEY) || "null");
    return parsed && parsed.totals ? parsed : null;
  } catch { return null; }
}
export async function refreshStats({ force = false } = {}) {
  const cached = getCachedStats();
  if (cached) { U.stats = cached; setLastCheckedAt(cached.freshness?.last_checked); emit(); }
  try {
    const stats = await getStaticOrApi<Stats>("/stats.json", "/stats");
    U.stats = stats;
    setLastCheckedAt(stats.freshness?.last_checked);
    emit();
    refreshFacetOptions({ force });
    refreshScopedStats({ force: true });
    try { localStorage.setItem(STATS_CACHE_KEY, JSON.stringify(stats)); } catch { /* speed-up only */ }
  } catch { /* a cached dashboard stays up */ }
}

let scopedStatsSeq = 0;
let scopedStatsInFlight: AbortController | null = null;
let scopedStatsPending: string | null = null;
const scopedSeen = new Map<string, { at: number; data: Scope }>();
const SCOPED_SEEN_MS = 10 * 60 * 1000;
async function refreshScopedStats({ force = false } = {}) {
  const params = qs(countingParams());
  if (!params) {
    if (scopedStatsInFlight) scopedStatsInFlight.abort();
    scopedStatsInFlight = null; scopedStatsPending = null; scopedStatsSeq++;
    U.scoped = null;
    emit();
    return;
  }
  const held = U.scoped !== null && U.scoped.params === params;
  const asking = scopedStatsPending === params && scopedStatsInFlight !== null;
  if (!force && (held || asking)) { emit(); return; }
  const seq = ++scopedStatsSeq;
  if (scopedStatsInFlight) scopedStatsInFlight.abort();
  const inFlight = new AbortController();
  scopedStatsInFlight = inFlight;
  scopedStatsPending = params;
  if (!held) {
    const seen = scopedSeen.get(params);
    U.scoped = seen && Date.now() - seen.at < SCOPED_SEEN_MS ? { params, data: seen.data } : null;
  }
  emit();
  try {
    const data = await getJSON<Stats>(`/stats?${qs({ ...currentFilterParams(), skills: "" })}`, inFlight.signal);
    if (seq !== scopedStatsSeq) return;
    const scoped = data?.scoped;
    U.scoped = scoped && typeof scoped.open_jobs === "number" ? { params, data: scopeShape(scoped) } : { params, data: null, degraded: true };
    if (U.scoped.data) {
      if (scopedSeen.size > 50) scopedSeen.clear();
      scopedSeen.set(params, { at: Date.now(), data: U.scoped.data });
    }
    emit();
  } catch (err) {
    if (seq !== scopedStatsSeq || (err as Error).name === "AbortError") return;
    U.scoped = { params, data: null, degraded: true };
    emit();
  } finally {
    if (seq === scopedStatsSeq) { scopedStatsPending = null; scopedStatsInFlight = null; }
  }
}

async function refreshFreshness() {
  try {
    const health = await getJSON<{ last_checked?: string }>("/health");
    setLastCheckedAt(health.last_checked);
    emit();
  } catch { /* the next poll catches up */ }
}

// Offers the visitor's own country as a filter, once ever.
async function maybeAskCountry() {
  try { if (localStorage.getItem(GEO_ASKED_KEY)) return; } catch { return; }
  if (F.country.length) return;
  let country: string | null = null;
  try {
    const geo = await fetch("/api/geo").then((r) => (r.ok ? r.json() : null));
    country = geo && geo.country;
  } catch { return; }
  if (!country) return;
  let where = countryLabel(country);
  if (where === country) {
    try {
      const r = await fetch("/facets.json", { cache: "no-store" });
      if (r.ok) {
        const byConfidence = await r.json();
        const facets = byConfidence && (byConfidence[F.confidence || "verified"] || byConfidence.verified);
        if (facets && Array.isArray(facets.locations)) normalizeLocationFacets(facets.locations);
        where = countryLabel(country);
      }
    } catch { /* says nothing below */ }
  }
  if (where === country) return;
  U.geoPrompt = { code: country, name: where };
  emit();
}
export function answerCountry(accept: boolean) {
  try { localStorage.setItem(GEO_ASKED_KEY, "1"); } catch { /* storage blocked */ }
  const code = U.geoPrompt?.code;
  U.geoPrompt = null;
  if (accept && code) { F.country = [code]; saveFiltersToStorage(); loadJobs(); }
  else emit();
}

// "Alert me for this search": the account page's alert form opens with
// these filters in it (account/Alerts.tsx reads the prefill), as app.js:5294 did.
export function alertForSearch() {
  try { sessionStorage.setItem("iljobs_alert_prefill", JSON.stringify(currentFilterParams())); } catch { /* the form opens empty */ }
  location.href = "/account#alerts";
}
export function openSheet(open: boolean) { U.sheetOpen = open; emit(); }
export function clearError() { U.error = null; emit(); }

// boot

let booted = false;
export function boot() {
  if (booted) return;
  booted = true;
  const bootParams = new URLSearchParams(location.search);
  applyStoredFilters();
  applyStateFromUrl(location.search);
  if (F.skills.length && !F.starred_only && !bootParams.has("sort")) F.sort = "match";
  U.starred = getStarred();
  U.matchSkillsOpen = matchSkillsOpen();
  U.savedSearches = savedSearches();
  syncSavedFromServer();
  syncQueueFromServer();
  maybeAskCountry();
  loadJobs();
  refreshStats();
  refreshFreshness();
  countSavedSearches();
  if (bootParams.get("view") === "matches") setView("matches");
  const deepLink = bootParams.get("job");
  if (deepLink) { keepOpen = deepLink; openJob(deepLink).then(syncUrl); }

  window.addEventListener("popstate", () => {
    applyStateFromUrl(location.search, { reset: true });
    const jobId = new URLSearchParams(location.search).get("job");
    if (jobId) { if (jobId !== U.selected) openJob(jobId); }
    else if (U.selected) closeJob();
    loadJobs();
  });

  // One timer, restarted by every refresh; a hidden tab stops it.
  let boardTimer = 0;
  let refreshing = false;
  let hiddenAt: number | null = null;
  async function refreshBoard() {
    schedule();
    if (refreshing) return;
    refreshing = true;
    try { await Promise.allSettled([loadJobs({ background: true }), refreshStats({ force: true }), refreshFreshness()]); } finally { refreshing = false; }
  }
  function schedule() {
    clearTimeout(boardTimer);
    if (document.hidden) return;
    boardTimer = window.setTimeout(refreshBoard, STATS_POLL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); clearTimeout(boardTimer); return; }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (away > 30_000) refreshBoard(); else schedule();
  });
  schedule();
  setInterval(() => { if (!document.hidden) refreshFreshness(); }, HEALTH_POLL_MS);
  // The result line's "Updated x min ago" moves between polls.
  setInterval(emit, 60_000);

  const onScroll = () => { if (heldJobs && atListTop()) showHeldJobs({ scroll: false }); };
  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
}

// Signing out drops the stored skills; the board follows. Signing in
// brings the account's stars and queue.
export function onAuthChange() {
  if (signedIn()) { syncSavedFromServer(); syncQueueFromServer(); emit(); return; }
  // auth.js's signOut has already cleared this browser's stars and cached
  // pages; what is on screen goes with them.
  U.starred = getStarred();
  U.queue = new Set();
  U.appliedAt = new Map();
  U.matchPrompt = false;
  if (F.sort === "match" || F.skills.length) { F.skills = []; setView(F.roles === "all" ? "all" : "tech"); return; }
  if (F.starred_only) { loadJobs(); return; }
  emit();
}
