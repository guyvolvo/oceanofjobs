// /login: the sign-in as a page of its own, beside the dithered hills from
// the old link preview. The steps are the sign-in window's
// (src/shell/SignIn.tsx). On a phone the picture goes and the form stands
// alone. Signed in, or once signed in, the page sends the visitor on: to
// ?next= when it is a path on this site, else to the account.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SignInSteps } from "../shell/SignIn";
import { useWho } from "../shell/state";
import { nextPath } from "./next";

const Heading = ({ className, children }: { className?: string; children?: ReactNode }) => <h1 className={className}>{children}</h1>;
const Line = ({ className, children }: { className?: string; children?: ReactNode }) => <p className={className}>{children}</p>;

// Squares the size of a few dither dots, lit or darkened in batches on a
// fixed beat, each fading in and out over a couple of seconds.
const CELL = 12;
const BEAT_MS = 700;
const PER_BEAT = 14;
const LIFE_MS = 2400;

function Dither({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    const cells = new Map<number, { light: boolean; at: number }>();
    let cols = 0;
    let rows = 0;
    const size = () => {
      const r = c.getBoundingClientRect();
      const d = devicePixelRatio || 1;
      c.width = Math.round(r.width * d);
      c.height = Math.round(r.height * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      cols = Math.ceil(r.width / CELL);
      rows = Math.ceil(r.height / CELL);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(c);
    const beat = setInterval(() => {
      for (let i = 0; i < PER_BEAT; i++) cells.set(Math.floor(Math.random() * cols * rows), { light: Math.random() < 0.5, at: performance.now() });
    }, BEAT_MS);
    let raf = 0;
    const draw = (now: number) => {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const [k, s] of cells) {
        const age = (now - s.at) / LIFE_MS;
        if (age >= 1) { cells.delete(k); continue; }
        const a = Math.sin(Math.PI * age);
        ctx.fillStyle = s.light ? `rgba(178, 196, 156, ${0.9 * a})` : `rgba(15, 30, 1, ${0.95 * a})`;
        ctx.fillRect((k % cols) * CELL, Math.floor(k / cols) * CELL, CELL, CELL);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { clearInterval(beat); cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return (
    <div className={`relative overflow-hidden rounded-2xl bg-[#0f1e01] bg-[url(/img/dither-hills.png)] bg-cover bg-center [image-rendering:pixelated] ${className}`}>
      <canvas ref={ref} className="absolute inset-0 size-full" aria-hidden="true" />
    </div>
  );
}

export function Login() {
  const [error, setError] = useState("");
  const who = useWho();
  useEffect(() => { if (who) location.replace(nextPath(location.search)); }, [who]);
  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-[minmax(440px,1fr)_1.2fr]">
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">
          <SignInSteps error={error} setError={setError} Title={Heading} Description={Line} />
        </div>
      </section>
      <div className="hidden p-4 lg:block lg:pl-0"><Dither className="h-full" /></div>
    </main>
  );
}
