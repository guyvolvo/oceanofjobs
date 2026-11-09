// The Statistics page: questions over every listing, run in the browser.
// Two ways to ask: the builder, which reads as a sentence and qb.js
// writes the SQL for, or the SQL itself. "View as SQL" shows what the
// builder wrote. The answer gets a title written from the question, the
// few numbers that matter, and one of three views; the page picks the
// view and the toggle lets you change it. The URL carries the question
// (?b= builder state, ?q= SQL, ?v= view), so a link reproduces it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { ChartBar, ChartLine, DownloadSimple, Link as LinkIcon, Play, Table as TableIcon, type Icon } from "@phosphor-icons/react";
import { Builder } from "./Builder";
import { ResultBody } from "./Result";
import { SchemaPanel } from "./Schema";
import { loadPickerValues, openDatabase, terminate, type Db } from "./db";
import { csvOf, fmtBytes, fmtInt, isTimeAxis, LABELS, MAX_ROWS, pickViz, QUERY_TIMEOUT_MS, resultContext, resultTitle, shape, TEMPLATES, valueColumn, VIZ_KINDS,
  type Cell, type Mode, type Picks, type Question, type Viz } from "./data";

type Result = { columns: string[]; values: Cell[][]; ms: number; read: number; n: number };
const TEMPLATE_ICON: Record<string, Icon> = { line: ChartLine, hbar: ChartBar, vbar: ChartBar, table: TableIcon };
const VIEWS: { k: Exclude<Viz, "auto">; label: string; icon: Icon }[] = [{ k: "line", label: "Line", icon: ChartLine }, { k: "bar", label: "Bars", icon: ChartBar }, { k: "table", label: "Table", icon: TableIcon }];

export function StatsPage() {
  // The question lives in a ref as well as state: a change runs at once,
  // before React has re-rendered, and run() reads the ref.
  const qRef = useRef<Question>({ mode: "builder", qb: QB.defaultState(), sql: "", viz: "auto", template: null });
  const [q, setQState] = useState<Question>(qRef.current);
  const setQ = useCallback((patch: Partial<Question>) => { qRef.current = { ...qRef.current, ...patch }; setQState(qRef.current); }, []);

  const dbRef = useRef<Db | null>(null);
  const [status, setStatus] = useState("Loading the database runtime");
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
    setStatus("Opening the database");
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

  const loadTemplate = useCallback((i: number) => {
    const t = TEMPLATES[i];
    const viz = VIZ_KINDS.includes(t.view as Viz) ? (t.view as Viz) : "auto";
    if (t.state) setQ({ template: i, viz, mode: "builder", qb: { ...QB.defaultState(), ...JSON.parse(JSON.stringify(t.state)) } });
    else setQ({ template: i, viz, mode: "sql", sql: t.sql || "" });
  }, [setQ]);

  const readUrl = useCallback((): Mode | null => {
    const p = new URLSearchParams(location.search);
    const v = p.get("v") as Viz | null;
    if (v && VIZ_KINDS.includes(v)) setQ({ viz: v });
    const b = p.get("b");
    if (b) {
      const s = QB.decodeState(b);
      if (s) { setQ({ mode: "builder", qb: { ...QB.defaultState(), ...s } }); return "builder"; }
    }
    const sql = p.get("q");
    if (sql) {
      try { setQ({ mode: "sql", sql: decodeURIComponent(escape(atob(sql))) }); return "sql"; } catch { /* fall through */ }
    }
    return null;
  }, [setQ]);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
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
      if (!readUrl()) loadTemplate(0);
      // The first answer first. Picker values load behind it.
      await run();
      try { setPicks(await loadPickerValues(dbRef.current!.worker)); } catch (e) { console.error("picker values:", e); }
    })();
  }, [open, readUrl, loadTemplate, run]);

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

  const title = fatal ? "Statistics are unavailable" : error ? "The query failed" : !result && !running ? "Loading" : resultTitle(q);
  const context = resultContext(q, pickName);
  const sub = running ? "Running" : result
    ? [...context, `${fmtInt(result.n)} row${result.n === 1 ? "" : "s"} in ${fmtInt(result.ms)} ms${result.n > MAX_ROWS ? `, showing ${fmtInt(MAX_ROWS)}` : ""}`].join(" · ")
    : "";

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      {/* On a phone the question and its answer come first; the rail follows. */}
      <div className="order-2 flex min-w-0 flex-col gap-6 lg:order-1">
        <nav aria-labelledby="st-q-title">
          <h2 id="st-q-title" className="mb-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Start from a question</h2>
          <div className="flex flex-col gap-0.5">
            {TEMPLATES.map((t, i) => {
              const I = TEMPLATE_ICON[t.icon];
              const on = q.template === i;
              return (
                <button key={t.name} type="button" aria-current={on ? "true" : undefined} onClick={() => { loadTemplate(i); run(); }}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-kumo-tint ${on ? "bg-kumo-tint font-medium text-kumo-strong" : "text-kumo-default"}`}>
                  <I size={15} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
                  <span>{t.name}</span>
                </button>
              );
            })}
          </div>
        </nav>
        <SchemaPanel />
      </div>

      <div className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
        <section aria-label="Query" className="rounded-lg border border-kumo-hairline bg-kumo-base">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline px-4 py-2.5">
            <Tabs size="sm" value={q.mode} onValueChange={(v) => setMode(v as Mode)} tabs={[{ value: "builder", label: "Builder" }, { value: "sql", label: "SQL" }]} />
            <span className="text-xs text-kumo-subtle" title={dbRef.current?.built ? `Built ${new Date(dbRef.current.built).toLocaleString()}` : undefined}>{status}</span>
          </div>
          <div className="px-4 py-4">
            {q.mode === "builder" ? (
              <Builder qb={q.qb} picks={picks} pickName={pickName} run={run} onChange={(qb) => setQ({ qb, template: null })} />
            ) : (
              <InputArea aria-label="SQL query" name="sql" spellCheck={false} autoComplete="off" autoCapitalize="off" rows={9}
                className="w-full font-mono text-[13px] leading-5" value={q.sql} onValueChange={(sql) => setQ({ sql, template: null })} />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-kumo-hairline px-4 py-2.5">
            <Button variant="primary" size="sm" icon={<Play weight="fill" />} loading={running} disabled={fatal} onClick={run}>Run query</Button>
            <span className="text-xs text-kumo-subtle" aria-label="Shortcut: Control plus Enter">
              <kbd className="rounded border border-kumo-hairline px-1 font-sans">Ctrl</kbd> + <kbd className="rounded border border-kumo-hairline px-1 font-sans">Enter</kbd>
            </span>
            {q.mode === "builder" ? (
              <>
                <Button variant="ghost" size="sm" onClick={reset}>Reset</Button>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setMode("sql")}>View as SQL</Button>
              </>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="st-rtitle" className="rounded-lg border border-kumo-hairline bg-kumo-base">
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3">
            <div className="min-w-0">
              <h2 id="st-rtitle" className="m-0 text-lg font-semibold leading-tight text-kumo-strong">{title}</h2>
              <p className="m-0 mt-0.5 text-sm text-kumo-subtle" aria-live="polite" title={result ? `${fmtBytes(result.read)} fetched` : undefined}>{sub}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Show results as" className="flex gap-0.5 rounded-md border border-kumo-hairline p-0.5">
                {VIEWS.map(({ k, label, icon: I }) => {
                  const on = view?.kind === k;
                  const disabled = !view || (k !== "table" && !view.chartable) || (k === "line" && !view.time);
                  return (
                    <Button key={k} size="xs" variant={on ? "secondary" : "ghost"} aria-pressed={on} disabled={disabled} icon={<I />}
                      onClick={() => { if (!on) setViz(k); }}>{label}</Button>
                  );
                })}
              </div>
              <Button size="sm" variant="outline" icon={<LinkIcon />} onClick={copyLink}>{copied ? "Copied" : "Copy link"}</Button>
              <Button size="sm" variant="outline" icon={<DownloadSimple />} disabled={!result || !result.n} onClick={exportCsv}>CSV</Button>
            </div>
          </div>
          <div className="px-4 pb-4" aria-live="polite">
            {fatal ? <p role="alert" className="m-0 rounded-md border border-kumo-danger/40 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">Couldn't open the statistics database. Reload the page to try again.</p> : null}
            {error ? <p role="alert" className="m-0 rounded-md border border-kumo-danger/40 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">{error}</p> : null}
            {result && !result.n ? <p className="m-0 py-8 text-center text-sm font-medium text-kumo-subtle">No results</p> : null}
            {view ? <ResultBody key={`${result!.ms}-${result!.read}-${view.kind}`} d={view.d} kind={view.kind} q={q} manifest={dbRef.current?.manifest ?? null} /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
