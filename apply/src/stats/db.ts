// The database: a static SQLite file the applier rebuilds hourly
// (loader/build_explore.py). SQLite compiled to WebAssembly reads it
// through a virtual filesystem that fetches only the pages a query
// touches, by HTTP range request. Nothing is sent anywhere.
import { ago, fmtInt, LABELS, type Manifest, type Picks } from "./data";

// Absolute from the site root, all three: the worker resolves the wasm
// path relative to ITS location, not the page's, and a page-relative
// path once had the browser instantiate an S3 404 document as WebAssembly.
const MANIFEST_URL = "/explore.json";   // names the current build
const WORKER_URL = "/vendor/httpvfs/sqlite.worker.js";
const WASM_URL = "/vendor/httpvfs/sql-wasm.wasm";
// 64 KB per HTTP read, sixteen pages at a time: the opening question
// took 1,203 ms at 4 KB and 122 ms at 64 KB for the same bytes.
const CHUNK_SIZE = 65536;
const MAX_BYTES = 256 * 1024 * 1024;  // per page load, then the worker refuses

const LIB_URL = "/vendor/httpvfs/index.js";        // UMD: leaves createDbWorker on window

export type Db = { worker: DbWorker; manifest: Manifest; status: string; built: string | null };

// The library loads with the first query, not with the page.
let lib: Promise<void> | null = null;
function loadLib() {
  if (typeof createDbWorker === "function") return Promise.resolve();
  return (lib ||= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LIB_URL;
    s.onload = () => resolve();
    s.onerror = () => { lib = null; reject(new Error(`couldn't load ${LIB_URL}`)); };
    document.head.appendChild(s);
  }));
}

export async function openDatabase(): Promise<Db> {
  const ready = loadLib();
  ready.catch(() => {});   // awaited below, after the manifest
  // Each hourly build is its own file, so the pages this session caches
  // all come from one build, whatever gets published while it is open.
  let manifest: Manifest = null;
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-store" });
    manifest = res.ok ? await res.json() : null;
  } catch { manifest = null; }
  const url = manifest?.url || "/explore.db";
  const config = { from: "inline", config: { serverMode: "full", url, requestChunkSize: CHUNK_SIZE } };
  await ready;
  const worker = await createDbWorker([config], WORKER_URL, WASM_URL, MAX_BYTES);
  const meta = Object.fromEntries(((await worker.db.exec("SELECT key, value FROM meta"))[0]?.values || []) as [string, string][]);
  const built = meta.built_at || manifest?.built_at || null;
  const parts = [`${fmtInt(meta.jobs || 0)} jobs`, `${fmtInt(meta.companies || 0)} companies`];
  if (built) parts.push(`refreshed ${ago(built)}`);
  return { worker, manifest, status: parts.join(" · "), built };
}

// The old worker may still be grinding through a query nobody wants;
// terminating it is the only way to stop it.
export function terminate(db: Db | null) {
  try { db?.worker.raw?.terminate(); } catch { /* already gone */ }
}

// The pickers' options come from the facets table the build precomputes:
// one small indexed query for everything. A file built before the table
// existed falls back to the scans, which is slow but correct.
export async function loadPickerValues(worker: DbWorker): Promise<Picks> {
  const nameOf = (field: string, v: string, name?: string | null) => name || (LABELS[field] || {})[v] || v;
  const out: Picks = {};
  try {
    const r = await worker.db.exec("SELECT field, value, label, n FROM facets ORDER BY field, n DESC");
    for (const [field, v, name, n] of (r[0]?.values || []) as [string, string, string | null, number][]) {
      (out[field] ||= []).push({ value: v, name: nameOf(field, v, name), n });
    }
    if (Object.keys(out).length) return out;
  } catch { /* no facets table in this build; fall through */ }
  for (const col of ["category", "seniority", "workplace", "ats", "salary_source"]) {
    const r = await worker.db.exec(`SELECT ${col}, COUNT(*) n FROM jobs WHERE closed_at IS NULL AND ${col} IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
    out[col] = ((r[0]?.values || []) as [string, number][]).map(([v, n]) => ({ value: v, name: nameOf(col, v), n }));
  }
  const sk = await worker.db.exec("SELECT skill, COUNT(*) n FROM job_skills GROUP BY 1 ORDER BY n DESC");
  out.skill = ((sk[0]?.values || []) as [string, number][]).map(([v, n]) => ({ value: v, name: v, n }));
  const co = await worker.db.exec("SELECT domain, COALESCE(name, domain), open_jobs FROM companies WHERE open_jobs > 0 ORDER BY open_jobs DESC");
  out.company = ((co[0]?.values || []) as [string, string, number][]).map(([d, name, n]) => ({ value: d, name, n }));
  return out;
}
