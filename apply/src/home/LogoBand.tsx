// Two rows of the busiest companies' wordmarks drifting in opposite
// directions, filled from the same static stats.json the board reads, so
// this page costs no API call. Either row can be grabbed and thrown.
import { useEffect, useRef } from "react";

// Each company's own wordmark, flattened to one light colour
// (img/wordmarks/), at a size that gives every mark about the same area.
// [file, width, height] in CSS pixels. A company without one shows its
// name set in Geist instead.
const WORDMARKS: Record<string, [string, number, number]> = { "amazon.com": ["amazon-com.webp", 98, 30], "andurilindustries.com": ["andurilindustries-com.webp", 126, 23], "anthropic.com": ["anthropic-com.webp", 161, 18], "apple.com": ["apple-com.webp", 24, 30], "aws.amazon.com": ["aws-amazon-com.webp", 51, 30], "brex.com": ["brex-com.webp", 88, 30], "checkpoint.com": ["checkpoint-com.webp", 67, 30], "cloudflare.com": ["cloudflare-com.webp", 190, 16], "coinbase.com": ["coinbase-com.webp", 126, 23], "coreweave.com": ["coreweave-com.webp", 145, 20], "crowdstrike.com": ["crowdstrike-com.webp", 128, 23], "crusoe.com": ["crusoe-com.webp", 111, 26], "databricks.com": ["databricks-com.webp", 135, 21], "elastic.co": ["elastic-co.webp", 88, 30], "gitlab.com": ["gitlab-com.webp", 97, 30], "google.com": ["google-com.webp", 93, 30], "microsoft.com": ["microsoft-com.webp", 117, 25], "mongodb.com": ["mongodb-com.webp", 107, 27], "nebius.com": ["nebius-com.webp", 137, 21], "nvidia.com": ["nvidia-com.webp", 125, 23], "openai.com": ["openai-com.webp", 104, 28], "paloaltonetworks.com": ["paloaltonetworks-com.webp", 125, 23], "samsara.com": ["samsara-com.webp", 134, 22], "snowflake.com": ["snowflake-com.webp", 114, 26], "spacex.com": ["spacex-com.webp", 154, 19], "stripe.com": ["stripe-com.webp", 72, 30], "zscaler.com": ["zscaler-com.webp", 118, 24] };

type Company = { domain: string; name?: string };
type Stats = { totals?: { open_jobs?: number }; workplace?: { workplace: string; n: number }[]; top_companies_logos?: Company[]; top_companies?: Company[] };

const CACHE_KEY = "otj-ticker";
const fmt = (n: number | undefined) => Number(n || 0).toLocaleString("en-US");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function logo(c: Company) {
  const m = WORDMARKS[c.domain];
  if (m) return `<span class="hero-logo"><img src="/img/wordmarks/${m[0]}" alt="" width="${m[1]}" height="${m[2]}" loading="eager" decoding="async" draggable="false" /></span>`;
  return `<span class="hero-logo hero-logo-text">${esc(c.name || c.domain)}</span>`;
}

// Repeated until one copy is wider than any screen, then doubled, so the
// track can loop by moving exactly half its width.
function fill(el: HTMLElement, items: string[], minItems: number) {
  let half: string[] = [];
  while (half.length < minItems) half = half.concat(items);
  el.innerHTML = half.join("") + half.join("");
}

type Row = { el: HTMLElement; track: HTMLElement; seconds: number; dir: number; half: number; x: number;
  drag: { id: number; lastX: number; samples: { t: number; x: number }[] } | null; spin: { start: number; v: number } | null };

export function LogoBand() {
  const band = useRef<HTMLDivElement>(null);
  const a = useRef<HTMLDivElement>(null);
  const b = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const block = band.current!, tracks = [a.current!, b.current!];
    // The last visit's companies, so the band moves the moment the page
    // does instead of after the stats fetch. A first visit starts from the
    // companies we hold wordmarks for. Either way the fresh list is saved
    // for next time rather than swapped in mid-scroll, which would jump.
    let shown = false;
    function tickerRows(companies: Company[]) {
      if (shown || !companies.length) return;
      shown = true;
      const halves = [companies.filter((_, i) => i % 2 === 0), companies.filter((_, i) => i % 2 === 1)];
      tracks.forEach((row, k) => {
        fill(row, halves[k].map(logo), 15);
        // A logo that no longer loads leaves the row rather than showing a
        // broken image. Every copy of it fails the same way, so the two
        // halves stay the same width and the loop stays seamless.
        row.querySelectorAll("img").forEach((img) => img.addEventListener("error", () => img.parentElement?.remove(), { once: true }));
      });
    }
    let cached: unknown = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { /* no cache */ }
    tickerRows(Array.isArray(cached) && cached.length ? cached : Object.keys(WORDMARKS).map((domain) => ({ domain })));

    let gone = false;
    function render(stats: Stats) {
      if (gone) return;
      const t = stats.totals || {};
      const remote = (stats.workplace || []).find((w) => w.workplace === "remote")?.n;
      // top_companies_logos is thirty companies, the hand-picked big tech
      // and startups first (api/hot_companies.py). Until a precompute has
      // written it, the ten-row chart list stands in.
      const companies = (stats.top_companies_logos || stats.top_companies || []).slice(0, 30).map((c) => ({ domain: c.domain, name: c.name }));
      try { if (companies.length) localStorage.setItem(CACHE_KEY, JSON.stringify(companies)); } catch { /* storage blocked */ }
      tickerRows(companies);
      if (text.current) text.current.textContent = `${fmt(t.open_jobs)} open jobs, ${fmt(remote)} of them remote.` +
        (companies.length ? ` Hiring now: ${companies.slice(0, 10).map((c) => c.name || c.domain).join(", ")}.` : "");
    }
    // The browser's own copy for its max-age (60s, set by the publisher),
    // then a revalidation, rather than a forced round trip on every visit.
    fetch("/stats.json").then((r) => (r.ok ? r.json() : fetch("/api/stats").then((x) => x.json()))).then(render).catch(() => {});

    // Drag a row and let go: it takes the speed and direction of the last
    // tenth of a second of the drag, holds close to it, then eases back
    // into its own drift over SPIN_MS. The CSS animation is the fallback
    // where this can't run; once it does, it moves the tracks itself.
    if (!("ResizeObserver" in window && window.PointerEvent)) return () => { gone = true; };
    const SPIN_MS = 2600, MAX_THROW = 8000, SAMPLE_MS = 100;
    const rows: Row[] = [
      { el: tracks[0].parentElement!, track: tracks[0], seconds: 46, dir: 1, half: 0, x: 0, drag: null, spin: null },
      { el: tracks[1].parentElement!, track: tracks[1], seconds: 38, dir: -1, half: 0, x: 0, drag: null, spin: null },
    ];
    // Each track holds its content twice, so any position can be folded
    // back into one half's width without a visible jump.
    const wrap = (r: Row, x: number) => { if (!r.half) return 0; x %= r.half; return x > 0 ? x - r.half : x; };
    const place = (r: Row) => { r.track.style.transform = `translate3d(${r.x}px,0,0)`; };
    const drift = (r: Row) => (r.half / r.seconds) * r.dir;
    const smooth = (t: number) => t * t * (3 - 2 * t);
    // Content changes width when stats arrive and when a broken logo
    // leaves, so the half width is re-read then, not on every frame.
    const sizes = new ResizeObserver(() => rows.forEach((r) => { r.half = r.track.scrollWidth / 2; r.x = wrap(r, r.x); }));
    rows.forEach((r) => sizes.observe(r.track));

    let last = 0, running = false;
    function frame(now: number) {
      const dt = last ? Math.min(now - last, 50) / 1000 : 0;
      last = now;
      for (const r of rows) {
        if (r.drag) continue;
        let v = drift(r);
        if (r.spin) {
          const t = (now - r.spin.start) / SPIN_MS;
          if (t >= 1) r.spin = null;
          else v += (r.spin.v - v) * (1 - smooth(t));
        }
        r.x = wrap(r, r.x + v * dt);
        place(r);
      }
      if (running) requestAnimationFrame(frame);
    }
    // Only while the band is on screen.
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !running) { running = true; last = 0; requestAnimationFrame(frame); }
      else if (!entry.isIntersecting) running = false;
    });
    io.observe(block);

    const offs: (() => void)[] = [];
    for (const r of rows) {
      const down = (e: PointerEvent) => {
        if (e.button !== 0) return;
        r.el.setPointerCapture(e.pointerId);
        r.drag = { id: e.pointerId, lastX: e.clientX, samples: [{ t: e.timeStamp, x: e.clientX }] };
        r.spin = null;
        r.el.classList.add("is-dragging");
      };
      const move = (e: PointerEvent) => {
        const d = r.drag;
        if (!d || e.pointerId !== d.id) return;
        r.x = wrap(r, r.x + (e.clientX - d.lastX));
        d.lastX = e.clientX;
        place(r);
        d.samples.push({ t: e.timeStamp, x: e.clientX });
        while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > SAMPLE_MS) d.samples.shift();
      };
      // A cancel is the browser taking the touch for a vertical scroll:
      // the row lets go the same way, just without much of a throw.
      const release = (e: PointerEvent) => {
        const d = r.drag;
        if (!d || e.pointerId !== d.id) return;
        r.drag = null;
        r.el.classList.remove("is-dragging");
        const recent = d.samples.filter((p) => e.timeStamp - p.t <= SAMPLE_MS);
        let v = 0;
        if (recent.length > 1) {
          const p = recent[0], q = recent[recent.length - 1];
          if (q.t > p.t) v = ((q.x - p.x) / (q.t - p.t)) * 1000;
        }
        r.spin = { start: performance.now(), v: Math.max(-MAX_THROW, Math.min(MAX_THROW, v)) };
      };
      r.el.addEventListener("pointerdown", down);
      r.el.addEventListener("pointermove", move);
      r.el.addEventListener("pointerup", release);
      r.el.addEventListener("pointercancel", release);
      offs.push(() => { r.el.removeEventListener("pointerdown", down); r.el.removeEventListener("pointermove", move); r.el.removeEventListener("pointerup", release); r.el.removeEventListener("pointercancel", release); });
    }
    block.classList.add("is-live");
    return () => { gone = true; running = false; sizes.disconnect(); io.disconnect(); offs.forEach((off) => off()); block.classList.remove("is-live"); };
  }, []);

  return (
    <section className="hero-band">
      <a className="hero-band-label" href="/companies">Explore hiring companies</a>
      <div className="logo-band" aria-hidden="true" ref={band}>
        <div className="hero-ticker to-right"><div className="hero-ticker-track" ref={a} /></div>
        <div className="hero-ticker to-left"><div className="hero-ticker-track" ref={b} /></div>
      </div>
      <p className="sr-only" ref={text}>Loading board statistics.</p>
    </section>
  );
}
