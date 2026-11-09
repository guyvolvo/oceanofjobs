// The API section: the words at the left, a request and its answer at the
// right. Copy takes the curl line only. Run swaps in one of ten example
// queries, asks the live API and scrambles both blocks over to the new
// request and its answer (anime.js, loaded on the first click only). The
// sample is a real answer to the real query, taken 2026-10-15.
import { useEffect, useRef, useState } from "react";
import { Island } from "../shell/island";
import { copyText } from "./copy";

const QUERIES = [
  "israel_only=1&limit=1", "company=nvidia.com&limit=1", "company=wiz.io&limit=1", "company=monday.com&limit=1", "company=anthropic.com&limit=1",
  "company=openai.com&limit=1", "company=amazon.com&israel_only=1&limit=1", "company=apple.com&seniority=senior&limit=1",
  "seniority=senior&search=devops&limit=1", "search=security+researcher&seniority=senior&limit=1",
];
const KEYS = ["id", "company_domain", "ats", "title", "location", "confidence", "posted_at", "first_seen", "closed_at", "salary_text", "salary_is_estimate"];
const LINES = 13;
const SAMPLE: [string, string][] = [
  ["id", '"4379ce3773adfb26"'], ["company_domain", '"pendo.com"'], ["ats", '"greenhouse"'], ["title", '"Software Engineer, Mobile SDK"'],
  ["location", '"Herzliya, Israel"'], ["confidence", '"verified"'], ["posted_at", '"2026-10-15T16:59:00+00:00"'], ["first_seen", '"2026-10-15T17:13:47+00:00"'],
  ["closed_at", "null"], ["salary_text", '"₪28K–38K"'], ["salary_is_estimate", "1"],
];
const curl = (q: string) => `curl "https://oceanofjobs.com/api/jobs?${q}"`;

type Anime = { animate: (el: Element, o: object) => void; scrambleText: (o: object) => unknown };
let anime: Anime | null = null;
// The same copy the old page loads, served beside it (frontend/vendor).
const ANIME_URL = "/vendor/animejs/anime.esm.min.js";

function html(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^(\s*)("[a-z_]+")(?=:)/gm, '$1<span class="api-key">$2</span>');
}
function answer(q: string) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  return fetch("/api/jobs?" + q, { signal: ctl.signal }).then((r) => {
    if (!r.ok) return { error: `HTTP ${r.status}, try another` };
    return r.json().then((d: { jobs?: Record<string, unknown>[] }) => {
      const job = d.jobs && d.jobs[0];
      if (!job) return { jobs: [], total: 0 };
      const out: Record<string, unknown> = {};
      KEYS.forEach((k) => { out[k] = job[k] === undefined ? null : job[k]; });
      return out;
    });
  }, () => ({ error: "No answer within 8 seconds, try another" })).finally(() => clearTimeout(timer));
}
const scramble = (el: Element, text: string, ms: number) => new Promise<void>((done) => {
  anime!.animate(el, { innerHTML: anime!.scrambleText({ text: html(text).replace(/<[^>]+>/g, ""), duration: ms }), onComplete: () => done() });
});

// The request and its answer, the section's island.
export function ApiCode() {
  const cmd = useRef<HTMLSpanElement>(null);
  const req = useRef<HTMLPreElement>(null);
  const res = useRef<HTMLPreElement>(null);
  const live = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // The request box is as tall as the longest of the ten commands at this
  // width, so it never resizes between runs.
  useEffect(() => {
    const c = cmd.current!, r = req.current!;
    function fit() {
      const now = c.textContent;
      let tall = 0;
      r.style.height = "";
      QUERIES.forEach((q) => { c.textContent = curl(q); tall = Math.max(tall, r.scrollHeight); });
      c.textContent = now;
      r.style.height = tall + "px";
    }
    fit();
    document.fonts?.ready.then(fit);
    let fitting = 0;
    const onResize = () => { cancelAnimationFrame(fitting); fitting = requestAnimationFrame(fit); };
    addEventListener("resize", onResize);
    return () => { removeEventListener("resize", onResize); cancelAnimationFrame(fitting); };
  }, []);

  const copy = () => copyText(cmd.current!.textContent!.replace(/^\$\s*/, ""), () => {
    setCopied(true);
    const el = live.current!;
    el.textContent = ""; setTimeout(() => { el.textContent = "Command copied"; }, 50);
    setTimeout(() => setCopied(false), 1600);
  });

  function run() {
    const next = (shown.current + 1 + Math.floor(Math.random() * (QUERIES.length - 1))) % QUERIES.length;
    shown.current = next;
    setBusy(true);
    const q = QUERIES[next], c = cmd.current!, r = res.current!;
    const data = answer(q);
    (anime ? Promise.resolve(anime) : (import(/* @vite-ignore */ ANIME_URL) as Promise<Anime>)).then((m) => {
      anime = m;
      return Promise.all([scramble(c, curl(q), 700), data]);
    }).then((out) => {
      // One block per line, padded to the box's 13: the scramble would
      // otherwise swap the line breaks too and fold the answer into one line.
      const pad = (text: string) => { const a = text.split("\n"); while (a.length < LINES) a.push(""); return a; };
      const block = (a: string[]) => a.map((l) => `<span class="api-line">${html(l)}</span>`).join("");
      const want = pad(JSON.stringify(out[1], null, 2));
      if (r.children.length !== LINES || !r.firstElementChild!.classList.contains("api-line")) r.innerHTML = block(pad(r.textContent || ""));
      return Promise.all(want.map((l, i) => scramble(r.children[i], l, 1100))).then(() => { r.innerHTML = block(want); });
    }).catch(() => {}).finally(() => setBusy(false));
  }

  return (
        <div className="home-code-panel">
          <div className="home-code">
            <div className="home-code-pane">
              <div className="home-code-label">Example request</div>
              <button type="button" className="home-code-copy home-code-run" disabled={busy} onClick={run}><svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" /></svg>Run</button>
              <button type="button" className="home-code-copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
              <span className="sr-only" ref={live} role="status" aria-live="polite" />
              <pre className="home-code-req" ref={req}><span className="api-prompt">$</span> <span className="api-cmd" ref={cmd}>{curl(QUERIES[0])}</span></pre>
            </div>
            <div className="home-code-pane">
              <div className="home-code-label">Example response</div>
              <pre className="home-code-res" ref={res} aria-live="polite">{"{\n"}{/* One string per text node, so the HTML reads like the old page's. */}
                {SAMPLE.map(([k, v], i) => <span key={k}>{"  "}<span className="api-key">{`"${k}"`}</span>{`: ${v}${i < SAMPLE.length - 1 ? ",\n" : "\n"}`}</span>)}{"}"}</pre>
            </div>
          </div>
        </div>
  );
}

export function ApiSample() {
  return (
    <section className="home-section" aria-labelledby="api-title">
      <div className="mx-auto grid max-w-[1180px] grid-cols-1 items-start gap-8 min-[901px]:grid-cols-2 min-[901px]:gap-12">
        <div>
          <h2 className="home-h2" id="api-title">API</h2>
          <p className="home-api-p">Use the API to search jobs, look up companies, retrieve statistics, or build your own tools.</p>
          <p className="home-api-p">Check the API documentation to see how you can retrieve data with filters such as location, skills, seniority, workplace type, salary and more.</p>
          <div className="mt-[26px] flex flex-wrap items-center gap-3">
            <a className="home-pill" href="/docs/api">Read the API docs<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></a>
            <a className="home-soft home-soft-sm" href="https://github.com/guyvolvo/oceanofjobs">View on GitHub</a>
          </div>
        </div>
        <Island name="api-code" component={ApiCode} props={{}} />
      </div>
    </section>
  );
}
