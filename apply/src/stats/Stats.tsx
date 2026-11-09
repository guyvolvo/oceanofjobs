// The Statistics page: questions over every listing, run in the browser.
// Two ways to ask: the builder, which reads as a sentence and qb.js
// writes the SQL for, or the SQL itself. "View as SQL" shows what the
// builder wrote. The answer gets a title written from the question, the
// few numbers that matter, and one of three views; the page picks the
// view and the toggle lets you change it. The URL carries the question
// (?b= builder state, ?q= SQL, ?v= view), so a link reproduces it.
//
// Prerendered: the frame, the starter questions, the schema and the first
// question's sentence are in the HTML. The database runtime
// (sql.js-httpvfs) loads when the first query runs, ECharts with the
// first chart.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartBar, ChartBarHorizontal, ChartLine, DownloadSimple, Link as LinkIcon, Play, Table as TableIcon, type Icon } from "@phosphor-icons/react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { Page } from "../shell/Page";
import { Builder } from "./Builder";
import { ResultBody } from "./Result";
import { SchemaPanel } from "./Schema";
import { loadPickerValues, openDatabase, terminate, type Db } from "./db";
import { csvOf, fmtBytes, fmtInt, isTimeAxis, LABELS, MAX_ROWS, pickViz, QUERY_TIMEOUT_MS, resultContext, resultTitle, shape, TEMPLATES, valueColumn, VIZ_KINDS,
  type Cell, type Mode, type Picks, type Question, type Viz } from "./data";

type Result = { columns: string[]; values: Cell[][]; ms: number; read: number; n: number };
const TEMPLATE_ICON: Record<string, Icon> = { line: ChartLine, hbar: ChartBarHorizontal, vbar: ChartBar, table: TableIcon };
const VIEWS: { k: Exclude<Viz, "auto">; label: string; icon: Icon }[] = [{ k: "line", label: "Line", icon: ChartLine }, { k: "bar", label: "Bars", icon: ChartBar }, { k: "table", label: "Table", icon: TableIcon }];

// A starter question as the question on screen.
function template(i: number): Partial<Question> {
  const t = TEMPLATES[i];
  const viz = VIZ_KINDS.includes(t.view as Viz) ? (t.view as Viz) : "auto";
  return t.state ? { template: i, viz, mode: "builder", qb: { ...QB.defaultState(), ...JSON.parse(JSON.stringify(t.state)) } }
    : { template: i, viz, mode: "sql", sql: t.sql || "" };
}

// The segmented controls (mode, view): ink when on, as on the live page.
const SEG = "gap-0.5 rounded-md border p-[3px]";
const SEG_ITEM = "h-7 cursor-pointer gap-1.5 rounded-sm px-2.5 font-ui text-[13px] font-bold text-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring disabled:opacity-40";
const CARD = "min-w-0 rounded-lg border p-3.5 sm:p-[18px]";
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring";
const BTN = cn(FOCUS, "inline-flex h-9 cursor-pointer items-center gap-[7px] rounded-md border px-[13px] font-ui text-[13px] font-bold hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent");
const TEXT_BTN = cn(FOCUS, "cursor-pointer rounded-xs");

export function StatsPage() {
  // The question lives in a ref as well as state: a change runs at once,
  // before React has re-rendered, and run() reads the ref.
  const qRef = useRef<Question>({ mode: "builder", qb: QB.defaultState(), sql: "", viz: "auto", template: null, ...template(0) });
  const [q, setQState] = useState<Question>(qRef.current);
  const setQ = useCallback((patch: Partial<Question>) => { qRef.current = { ...qRef.current, ...patch }; setQState(qRef.current); }, []);

  const dbRef = useRef<Db | null>(null);
  const [status, setStatus] = useState("Loading the database runtime…");
  const [fatal, setFatal] = useState(false);
  const [picks, setPicks] = useState<Picks>({});
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const rerunRef = useRef(false);
  const [copied, setCopied] = useState(false);

  const pickName = useCallback((field: string, v: string) => {
    const hit = (picks[field] || []).find((o) => o.value === v);
    return hit ? hit.name : (LABELS[field] || {})[v] || v;
  }, [picks]);

  // Builder state when in builder mode, the SQL otherwise, so a link
  // reproduces the view either way.
  const writeUrl = useCallback(() => {
    const { mode, qb, sql, viz } = qRef.current;
    const p = new URLSearchParams();
    if (mode === "builder") p.set("b", QB.encodeState(qb));
    else p.set("q", btoa(unescape(encodeURIComponent(sql))));
    if (viz !== "auto") p.set("v", viz);
    history.replaceState(null, "", `${location.pathname}?${p}`);
  }, []);

  const open = useCallback(async () => {
    setStatus("Opening the database…");
    const db = await openDatabase();
    dbRef.current = db;
    setStatus(db.status);
  }, []);

  // Throw the worker away and start another: the old one may still be
  // grinding through a query nobody wants, and the new one starts with an
  // empty page cache.
  const reopen = useCallback(async () => {
    terminate(dbRef.current);
    dbRef.current = null;
    try { await open(); } catch { setStatus("Couldn't reopen the database. Reload the page."); }
  }, [open]);

  const run = useCallback(async () => {
    const db = dbRef.current;
    if (!db) return;
    // A change made while a query runs is run after it, not dropped.
    if (runningRef.current) { rerunRef.current = true; return; }
    const cur = qRef.current;
    let sql = cur.sql;
    if (cur.mode === "builder") { sql = QB.buildSql(cur.qb); setQ({ sql }); }
    sql = sql.trim();
    if (!sql) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    const t0 = performance.now();
    try {
      const before = await db.worker.worker.bytesRead;
      const out = await Promise.race([
        db.worker.db.exec(sql),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Still running after ${QUERY_TIMEOUT_MS / 1000}s.`)), QUERY_TIMEOUT_MS)),
      ]);
      const ms = Math.round(performance.now() - t0);
      const read = (await db.worker.worker.bytesRead) - before;
      writeUrl();
      const last = out[out.length - 1];
      setResult(last ? { columns: last.columns, values: last.values, ms, read, n: last.values.length } : { columns: [], values: [], ms, read, n: 0 });
    } catch (e) {
      // A query that timed out is still running inside the worker, and
      // every later query would queue behind it. A read the network
      // dropped leaves the runtime holding a page it should not trust,
      // which SQLite reports as a malformed file. Either way: reopen.
      const msg = String((e as Error).message || e);
      const broken = /malformed|XMLHttpRequest|Failed to load/.test(msg);
      const timedOut = /Still running/.test(msg);
      setError(timedOut
        ? `Stopped after ${QUERY_TIMEOUT_MS / 1000} s. Narrow it with a filter or an indexed column; the database has been reopened.`
        : broken ? "The network did not deliver every page this query needed. It has been reopened; run it again, or narrow it with a filter."
        : msg);
      if (timedOut || broken) await reopen();
      setResult(null);
    } finally {
      runningRef.current = false;
      setRunning(false);
      if (rerunRef.current) { rerunRef.current = false; run(); }
    }
  }, [reopen, setQ, writeUrl]);

  const loadTemplate = useCallback((i: number) => setQ(template(i)), [setQ]);

  const readUrl = useCallback((): Mode | null => {
    const p = new URLSearchParams(location.search);
    const v = p.get("v") as Viz | null;
    if (v && VIZ_KINDS.includes(v)) setQ({ viz: v });
    const b = p.get("b");
    if (b) {
      const s = QB.decodeState(b);
      if (s) { setQ({ mode: "builder", template: null, qb: { ...QB.defaultState(), ...s } }); return "builder"; }
    }
    const sql = p.get("q");
    if (sql) {
      try { setQ({ mode: "sql", template: null, sql: decodeURIComponent(escape(atob(sql))) }); return "sql"; } catch { /* fall through */ }
    }
    return null;
  }, [setQ]);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    // A shared link's question shows while the database opens.
    readUrl();
    (async () => {
      try {
        await open();
      } catch (e) {
        // Missing WebAssembly is one cause of many, so the detail goes to the
        // console and the reader gets the step that might help.
        console.error("statistics database:", e);
        setStatus("");
        setFatal(true);
        return;
      }
      // The first answer first. Picker values load behind it.
      await run();
      try { setPicks(await loadPickerValues(dbRef.current!.worker)); } catch (e) { console.error("picker values:", e); }
    })();
  }, [open, readUrl, run]);

  // On the document, so the shortcut next to Run query works in both modes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
      e.preventDefault();
      run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [run]);

  // Switching to SQL shows the query the builder wrote; a starter query
  // or a shared link brings its own SQL instead.
  const setMode = (mode: Mode) => {
    if (mode === q.mode) return;
    if (mode === "builder") setQ({ mode, template: null });
    else setQ({ mode, sql: QB.buildSql(qRef.current.qb) });
  };
  const setViz = (viz: Viz) => { setQ({ viz }); writeUrl(); };
  const reset = () => { setQ({ template: null, qb: QB.defaultState(), viz: "auto" }); run(); };
  const copyLink = async () => {
    writeUrl();
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the URL bar already has it */ }
  };
  const exportCsv = () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csvOf(result.columns, result.values)], { type: "text/csv;charset=utf-8" }));
    a.download = `oceanofjobs-stats-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // The answer in the shapes the views need, for the view that is on.
  const view = useMemo(() => {
    if (!result || !result.n) return null;
    const shown = result.values.slice(0, MAX_ROWS);
    return { shown, kind: pickViz(q.viz, result.columns, shown), d: shape(result.columns, shown, Number(q.qb.range)), chartable: valueColumn(result.columns, shown) >= 0, time: isTimeAxis(shown) };
  }, [result, q.viz, q.qb.range]);

  const title = fatal ? "Statistics are unavailable" : error ? "The query failed" : !result && !running ? "Loading…" : resultTitle(q);
  const context = resultContext(q, pickName);
  const sub = running ? "Running…" : result
    ? [...context, `${fmtInt(result.n)} row${result.n === 1 ? "" : "s"} in ${fmtInt(result.ms)} ms${result.n > MAX_ROWS ? `, showing ${fmtInt(MAX_ROWS)}` : ""}`].join(" · ")
    : "";

  return (
    <Page current="companies">
      {/* The database is a static file on the CDN and the query runs in this
          tab, inside SQLite compiled to WebAssembly. Only the pages a query
          touches are fetched, by HTTP range request. Nothing is sent anywhere. */}
      <div className="mx-auto max-w-[1520px] px-[clamp(20px,4vw,64px)] pt-[22px] pb-12 sm:pt-8">
        <h1 className="m-0 mb-6 font-display text-[32px] leading-[1.05] font-normal tracking-[-0.02em] min-[961px]:text-[40px]">Statistics</h1>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-y-5 [grid-template-areas:'q'_'main'_'s'] min-[961px]:grid-cols-[264px_minmax(0,1fr)] min-[961px]:grid-rows-[auto_1fr] min-[961px]:items-start min-[961px]:gap-x-8 min-[961px]:gap-y-0 min-[961px]:[grid-template-areas:'q_main'_'s_main']">
          <nav aria-labelledby="st-q-title" className="[grid-area:q]">
            <h2 id="st-q-title" className="m-0 mb-2 px-[11px] font-ui text-sm font-bold">Start from a question</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-0.5 min-[961px]:flex min-[961px]:flex-col">
              {TEMPLATES.map((t, i) => {
                const I = TEMPLATE_ICON[t.icon];
                const on = q.template === i;
                return (
                  <button key={t.name} type="button" aria-current={on ? "true" : undefined} onClick={() => { loadTemplate(i); run(); }}
                    className={cn("flex w-full cursor-pointer items-start gap-3 rounded-md px-[11px] py-2 text-left text-sm leading-[1.35] hover:bg-accent focus-visible:-outline-offset-2", on && "bg-secondary font-bold")}>
                    <I size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span>{t.name}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="[grid-area:s]"><SchemaPanel /></div>

          <div className="flex min-w-0 flex-col gap-4 [grid-area:main]">
            <section aria-label="Query" className={CARD}>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
                <ToggleGroup type="single" aria-label="Query mode" className={SEG} value={q.mode} onValueChange={(v) => { if (v) setMode(v as Mode); }}>
                  <ToggleGroupItem value="builder" className={SEG_ITEM}>Builder</ToggleGroupItem>
                  <ToggleGroupItem value="sql" className={SEG_ITEM}>SQL</ToggleGroupItem>
                </ToggleGroup>
                <span className="text-[12.5px] text-muted-foreground" title={dbRef.current?.built ? `Built ${new Date(dbRef.current.built).toLocaleString()}` : undefined}>{status}</span>
              </div>
              {q.mode === "builder" ? (
                <Builder qb={q.qb} picks={picks} pickName={pickName} run={run} onChange={(qb) => setQ({ qb, template: null })} />
              ) : (
                <textarea aria-label="SQL query" name="sql" spellCheck={false} autoComplete="off" autoCapitalize="off" rows={9} value={q.sql}
                  onChange={(e) => setQ({ sql: e.target.value, template: null })}
                  className="mt-0.5 block min-h-[200px] w-full resize-y rounded-md border bg-transparent px-3.5 py-3 font-mono text-[13px] leading-[1.55] text-foreground outline-none focus:border-foreground" />
              )}
              <div className="mt-[22px] flex flex-wrap items-center gap-3 border-t pt-4">
                <button type="button" onClick={run} disabled={fatal} aria-busy={running}
                  className={cn(FOCUS, "inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-md bg-primary px-4 font-ui text-sm font-bold text-primary-foreground hover:opacity-90 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45")}>
                  {running ? <span className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : <Play size={12} weight="fill" aria-hidden="true" />}
                  Run query
                </button>
                <span className="text-xs whitespace-nowrap text-muted-foreground" aria-label="Shortcut: Control plus Enter">
                  <kbd className="rounded-xs border px-[5px] py-px font-mono text-[11px]">Ctrl</kbd> + <kbd className="rounded-xs border px-[5px] py-px font-mono text-[11px]">Enter</kbd>
                </span>
                {q.mode === "builder" ? (
                  <>
                    <button type="button" className={cn(TEXT_BTN, "text-sm underline underline-offset-[3px]")} onClick={reset}>Reset</button>
                    <button type="button" className={cn(TEXT_BTN, "ml-auto text-[13px] text-muted-foreground hover:text-foreground")} onClick={() => setMode("sql")}>View as SQL ›</button>
                  </>
                ) : null}
              </div>
            </section>

            <section aria-labelledby="st-rtitle" className={CARD}>
              <div className="mb-[18px] flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 id="st-rtitle" className="m-0 font-ui text-lg leading-[1.3] font-bold">{title}</h2>
                  <p className="m-0 mt-1 text-[12.5px] text-muted-foreground" aria-live="polite" title={result ? `${fmtBytes(result.read)} fetched` : undefined}>{sub}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ToggleGroup type="single" aria-label="Show results as" className={SEG} value={view?.kind ?? ""} onValueChange={(v) => { if (v) setViz(v as Viz); }}>
                    {VIEWS.map(({ k, label, icon: I }) => (
                      <ToggleGroupItem key={k} value={k} className={SEG_ITEM}
                        disabled={!view || (k !== "table" && !view.chartable) || (k === "line" && !view.time)}>
                        <I size={14} aria-hidden="true" />{label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <button type="button" className={BTN} onClick={copyLink}><LinkIcon size={14} aria-hidden="true" />{copied ? "Copied" : "Copy link"}</button>
                  <button type="button" className={BTN} disabled={!result || !result.n} onClick={exportCsv}><DownloadSimple size={14} aria-hidden="true" />CSV</button>
                </div>
              </div>
              <div aria-live="polite">
                {fatal ? <p role="alert" className="m-0 rounded-md border border-destructive px-3 py-2 text-sm text-destructive">Couldn't open the statistics database. Reload the page to try again.</p> : null}
                {error ? <p role="alert" className="m-0 rounded-md border border-destructive px-3 py-2 text-sm whitespace-pre-wrap text-destructive">{error}</p> : null}
                {result && !result.n ? <p className="m-0 py-7 font-ui text-[15px] font-bold">No results</p> : null}
                {view ? <ResultBody key={`${result!.ms}-${result!.read}-${view.kind}`} d={view.d} kind={view.kind} q={q} manifest={dbRef.current?.manifest ?? null} /> : null}
              </div>
            </section>
          </div>
        </div>

        <p className="mt-7 mb-0"><a className="underline underline-offset-[3px] hover:text-link-hover" href="/board">&larr; Back to the job board</a></p>
      </div>
    </Page>
  );
}
