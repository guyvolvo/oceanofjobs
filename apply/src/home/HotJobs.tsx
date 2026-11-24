// Recent job posts: six of the week's most wanted roles from hot.json,
// which the precompute Lambda writes every three hours. Nothing until it
// loads. An island of the home page. Shuffle swaps every card for one not yet shown, one at a time in
// a random order and at random intervals, each easing out and back in.
import { Shuffle } from "@/components/icons";
import { useEffect, useRef, useState } from "react";

type Hot = { id: string; title: string; company: string; domain: string; logo?: boolean; location: string; posted: string; badges?: string[] };

const SIX = 6;

function Card({ j, out, noLogo, onNoLogo }: { j: Hot; out: boolean; noLogo: boolean; onNoLogo: () => void }) {
  const d = new Date(j.posted);
  const date = isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <a className={`hot-card${out ? " is-out" : ""}`} href={`/job/${encodeURIComponent(j.id)}`}>
      <div className="hot-top">
        <span className="hot-logo" aria-hidden="true">
          {(j.company || "?").charAt(0).toUpperCase()}
          {j.logo && !noLogo ? <img src={`/logo/${encodeURIComponent(j.domain)}.png`} alt="" width="24" height="24" loading="lazy" onError={onNoLogo} /> : null}
        </span>
        <span className="hot-co">{j.company}</span>
        {date ? <time className="hot-date" dateTime={j.posted}>{date}</time> : null}
      </div>
      <h3 className="hot-title">{j.title}</h3>
      <p className="hot-loc">{j.location}</p>
      <ul className="hot-badges">{(j.badges || []).map((b) => <li key={b}>{b}</li>)}</ul>
    </a>
  );
}

export function HotJobs() {
  const pool = useRef<Hot[]>([]);
  const used = useRef(new Set<string>());
  const timers = useRef<number[]>([]);
  const [cards, setCards] = useState<Hot[]>([]);
  const [out, setOut] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const [noLogo, setNoLogo] = useState<Set<string>>(new Set());

  // Six not yet shown since the pool last ran out, in random order.
  function draw() {
    let fresh = pool.current.filter((j) => !used.current.has(j.id));
    if (fresh.length < SIX) { used.current.clear(); fresh = pool.current.slice(); }
    for (let i = fresh.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [fresh[i], fresh[k]] = [fresh[k], fresh[i]]; }
    const picks = fresh.slice(0, SIX);
    picks.forEach((j) => used.current.add(j.id));
    return picks;
  }

  useEffect(() => {
    let gone = false;
    fetch("/hot.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { jobs?: Hot[] } | null) => {
        if (gone) return;
        pool.current = d?.jobs || [];
        if (pool.current.length < SIX) return;
        const first = draw();
        setCards(first);
        setOut(first.map(() => false));
      })
      .catch(() => {});
    return () => { gone = true; timers.current.forEach(clearTimeout); };
  }, []);

  function shuffle() {
    const picks = draw();
    const order = cards.map((_, i) => i).sort(() => Math.random() - 0.5);
    let at = 0;
    setBusy(true);
    const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    order.forEach((slot, n) => {
      at += n ? 60 + Math.random() * 180 : 0;
      later(at, () => {
        setOut((o) => o.map((v, i) => (i === slot ? true : v)));
        later(220, () => {
          setCards((c) => c.map((j, i) => (i === slot ? picks[slot] : j)));
          setOut((o) => o.map((v, i) => (i === slot ? false : v)));
          if (n === order.length - 1) later(450, () => setBusy(false));
        });
      });
    });
  }

  // Hidden until hot.json has six, as on the old page.
  return (
    <section className="home-section home-hot" aria-labelledby="hot-title" hidden={!cards.length}>
      <div className="mx-auto max-w-[1180px]">
        <div className="mb-12 flex items-center justify-between gap-4">
          <h2 className="home-h2" id="hot-title">Recent job posts</h2>
          <button type="button" className="home-soft home-soft-sm home-shuffle" disabled={busy} onClick={shuffle}>
            <Shuffle size={16} />Shuffle
          </button>
        </div>
        <div className="home-hot-grid grid grid-cols-1 gap-4 min-[641px]:grid-cols-2 min-[1025px]:grid-cols-3" aria-live="polite">
          {cards.map((j, i) => <Card key={i} j={j} out={out[i]} noLogo={noLogo.has(j.domain)} onNoLogo={() => setNoLogo((s) => new Set(s).add(j.domain))} />)}
        </div>
      </div>
    </section>
  );
}
