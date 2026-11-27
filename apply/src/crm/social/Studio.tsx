// Makes a post image from Ocean of Jobs data: a ranked list or one big
// number, drawn on a 1080x1350 canvas (Instagram's portrait size, which
// LinkedIn and TikTok take too) and uploaded like any other image.
// The data comes from the public API (oceanofjobs.com/api), read by this
// page directly; the rows stay editable before the image is made.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowDown, ArrowUp, Plus, Trash } from "@/components/icons";
import { Btn, Panel, SelectField, TextField } from "../ui";
import { uploadFile, type Media } from "./data";

const API = "https://oceanofjobs.com/api";
const W = 1080, H = 1350;
type Row = { name: string; domain: string; value: string; sub: string };
type Kind = "salary" | "hiring" | "number" | "custom";
type Look = "dark" | "light";
const KINDS: Record<Kind, string> = { salary: "Highest paying companies", hiring: "Most open roles", number: "One big number", custom: "My own list" };
const LOOKS: Record<Look, [string, string, string, string, string, string]> = {
  // ground, ink, muted, green, tile, line
  dark: ["#050505", "#f4f1ee", "#9a9ca3", "#2fb36a", "#1c1d22", "#222328"],
  light: ["#f2f0ef", "#40513b", "#5d6a58", "#3f6f45", "#e6e3df", "#d2cfcb"],
};

const get = async <T,>(path: string): Promise<T> => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(API + path).catch(() => null);
    if (r && r.ok) {
      const d = await r.json();
      if (!d.error) return d as T;
    }
    // "Took too long" under load, or 429 past 60 requests in 10 seconds: wait and ask again.
    await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
  }
  throw new Error("The Ocean of Jobs API didn't answer. Try again in a minute.");
};
const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
const month = () => new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

// Yearly USD pay from a disclosed range: the midpoint, or null for hourly,
// monthly and other currencies, which don't compare with a yearly figure.
export function yearlyUsd(text?: string | null): number | null {
  if (!text || !text.trim().startsWith("$")) return null;
  if (/\/\s*h|hour|\/\s*mo|month|week|day/i.test(text)) return null;
  const vals = [...text.matchAll(/\$\s*([\d,]+(?:\.\d+)?)\s*([kKmM]?)/g)].slice(0, 2)
    .map(([, n, s]) => Number(n.replace(/,/g, "")) * ({ k: 1e3, m: 1e6 }[s.toLowerCase()] || 1));
  if (!vals.length) return null;
  const mid = vals.reduce((a, b) => a + b, 0) / vals.length;
  return mid >= 20000 && mid <= 2e6 ? mid : null;
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

type Facets = { companies: { value: string; n: number; name?: string }[] };
type Jobs = { total: number; jobs: { salary_text?: string }[] };

// Every company with enough disclosed pay, ranked by its median, three requests at a time
// (the API allows 60 in 10 seconds). A company that keeps failing is left out, not the whole list.
async function highestPaying(minFigures: number, top: number, progress: (done: number, of: number) => void): Promise<Row[]> {
  const companies = (await get<Facets>("/facets?salary_disclosed=1")).companies.filter((c) => c.n >= minFigures);
  const ranked: { c: Facets["companies"][0]; pay: number }[] = [];
  let done = 0;
  const queue = [...companies];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const pays: number[] = [];
      try {
        for (let offset = 0; ; offset += 500) {
          const page = await get<Jobs>(`/jobs?salary_disclosed=1&company=${encodeURIComponent(c.value)}&limit=500&offset=${offset}`);
          for (const j of page.jobs) { const p = yearlyUsd(j.salary_text); if (p) pays.push(p); }
          if (offset + 500 >= page.total || !page.jobs.length) break;
        }
        if (pays.length >= minFigures) ranked.push({ c, pay: median(pays) });
      } catch { skipped.push(c.name || c.value); }
      progress(++done, companies.length);
    }
  };
  const skipped: string[] = [];
  await Promise.all([worker(), worker(), worker()]);
  if (skipped.length) toast(`Left out ${skipped.length} compan${skipped.length === 1 ? "y" : "ies"} the API didn't answer for: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`);
  const best = ranked.sort((a, b) => b.pay - a.pay).slice(0, top);
  const open = await Promise.all(best.map((b) => get<Jobs>(`/jobs?company=${encodeURIComponent(b.c.value)}&limit=1`).then((r) => r.total, () => 0)));
  return best.map((b, i) => ({ name: b.c.name || b.c.value, domain: b.c.value, value: money(b.pay), sub: `${open[i].toLocaleString("en-US")} open roles` }));
}

async function mostHiring(top: number): Promise<Row[]> {
  return (await get<Facets>("/facets")).companies.slice(0, top)
    .map((c) => ({ name: c.name || c.value, domain: c.value, value: c.n.toLocaleString("en-US"), sub: "open roles" }));
}

function logo(domain: string): Promise<HTMLImageElement | null> {
  if (!domain) return Promise.resolve(null);
  return new Promise((ok) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // /logo/ answers with CORS, so the canvas can still be saved
    img.onload = () => ok(img);
    img.onerror = () => ok(null);
    img.src = `https://oceanofjobs.com/logo/${encodeURIComponent(domain)}`;
  });
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/)) {
    const next = line ? line + " " + w : w;
    if (ctx.measureText(next).width > max && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

type Design = { kind: Kind; look: Look; title: string; subtitle: string; note: string; rows: Row[]; big: string; label: string };

async function draw(canvas: HTMLCanvasElement, d: Design) {
  await Promise.all(["500 64px Geist", "400 30px Geist"].map((f) => document.fonts.load(f).catch(() => null)));
  const [ground, ink, muted, green, tile, line] = LOOKS[d.look];
  const ctx = canvas.getContext("2d")!;
  canvas.width = W; canvas.height = H;
  ctx.fillStyle = ground; ctx.fillRect(0, 0, W, H);
  const X = 80, R = W - 80;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = green; ctx.font = "500 28px Geist"; ctx.fillText("OCEAN OF JOBS", X, 112);
  ctx.fillStyle = ink; ctx.font = "500 68px Geist";
  let y = 200;
  for (const l of wrap(ctx, d.title, R - X).slice(0, 3)) { ctx.fillText(l, X, y); y += 78; }
  if (d.subtitle) {
    ctx.fillStyle = muted; ctx.font = "400 32px Geist";
    for (const l of wrap(ctx, d.subtitle, R - X).slice(0, 2)) { ctx.fillText(l, X, y + 4); y += 42; }
  }
  if (d.kind === "number") {
    ctx.fillStyle = green; ctx.font = "500 220px Geist";
    ctx.fillText(fit(ctx, d.big, R - X), X, 820);
    ctx.fillStyle = ink; ctx.font = "400 48px Geist";
    let ly = 900;
    for (const l of wrap(ctx, d.label, R - X).slice(0, 3)) { ctx.fillText(l, X, ly); ly += 60; }
  } else {
    const rows = d.rows.slice(0, 10);
    const top = y + 40, bottom = H - 150;
    const step = Math.min(96, (bottom - top) / Math.max(rows.length, 1));
    const logos = await Promise.all(rows.map((r) => logo(r.domain)));
    rows.forEach((r, i) => {
      const cy = top + step * i + step / 2;
      if (i) { ctx.fillStyle = line; ctx.fillRect(X, top + step * i, R - X, 2); }
      ctx.fillStyle = muted; ctx.font = "500 30px Geist"; ctx.textAlign = "left";
      ctx.fillText(String(i + 1), X, cy + 10);
      const s = Math.min(60, step - 24), lx = X + 56;
      ctx.fillStyle = tile; ctx.beginPath(); ctx.roundRect(lx, cy - s / 2, s, s, 12); ctx.fill();
      const img = logos[i];
      if (img) {
        ctx.save(); ctx.beginPath(); ctx.roundRect(lx, cy - s / 2, s, s, 12); ctx.clip();
        const k = Math.min(s / img.width, s / img.height) * 0.8;
        ctx.drawImage(img, lx + (s - img.width * k) / 2, cy - (img.height * k) / 2, img.width * k, img.height * k);
        ctx.restore();
      } else {
        ctx.fillStyle = ink; ctx.font = "500 28px Geist"; ctx.textAlign = "center";
        ctx.fillText((r.name[0] || "?").toUpperCase(), lx + s / 2, cy + 10); ctx.textAlign = "left";
      }
      ctx.font = "500 38px Geist";
      const valueW = (() => { ctx.font = "500 40px Geist"; return ctx.measureText(r.value).width; })();
      const subW = (() => { ctx.font = "400 24px Geist"; return r.sub ? ctx.measureText(r.sub).width : 0; })();
      ctx.fillStyle = ink; ctx.font = "500 36px Geist";
      ctx.fillText(fit(ctx, r.name, R - lx - s - 40 - Math.max(valueW, subW)), lx + s + 24, cy + 12);
      ctx.textAlign = "right";
      ctx.fillStyle = green; ctx.font = "500 40px Geist"; ctx.fillText(r.value, R, r.sub ? cy + 4 : cy + 14);
      if (r.sub) { ctx.fillStyle = muted; ctx.font = "400 24px Geist"; ctx.fillText(r.sub, R, cy + 34); }
      ctx.textAlign = "left";
    });
  }
  ctx.fillStyle = line; ctx.fillRect(X, H - 120, R - X, 2);
  ctx.fillStyle = muted; ctx.font = "400 24px Geist";
  ctx.fillText(fit(ctx, d.note, R - X - 260), X, H - 72);
  ctx.textAlign = "right"; ctx.fillStyle = ink; ctx.font = "500 26px Geist"; ctx.fillText("oceanofjobs.com", R, H - 72); ctx.textAlign = "left";
}

const START: Record<Kind, Pick<Design, "title" | "subtitle" | "note">> = {
  salary: { title: "Highest paying companies hiring now", subtitle: "Median of the salaries companies state in their own job posts", note: `Yearly USD salaries · ${month()}` },
  hiring: { title: "Companies with the most open roles", subtitle: "Read from each company's own hiring page", note: month() },
  number: { title: "", subtitle: "", note: month() },
  custom: { title: "", subtitle: "", note: month() },
};

export function Studio({ onUse }: { onUse: (m: Media) => void }) {
  const [d, setD] = useState<Design>({ kind: "salary", look: "dark", rows: [], big: "", label: "", ...START.salary });
  const [loading, setLoading] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [min, setMin] = useState("20");
  const canvas = useRef<HTMLCanvasElement>(null);
  const set = (p: Partial<Design>) => setD((x) => ({ ...x, ...p }));
  useEffect(() => { if (canvas.current) draw(canvas.current, d); }, [d]);

  const pick = (kind: Kind) => setD((x) => ({ ...x, kind, rows: kind === "custom" ? x.rows : [], ...START[kind] }));
  const load = async () => {
    setLoading([0, 0]);
    try {
      if (d.kind === "salary") set({ rows: await highestPaying(Math.max(1, Number(min) || 20), 10, (a, b) => setLoading([a, b])) });
      if (d.kind === "hiring") set({ rows: await mostHiring(10) });
      if (d.kind === "number") {
        const s = await get<{ meta: { jobs_open: string; companies_total: string } }>("/stats");
        set({ big: Number(s.meta.jobs_open).toLocaleString("en-US"), label: `open jobs at ${Number(s.meta.companies_total).toLocaleString("en-US")} companies`,
          title: "Open tech jobs right now" });
      }
    } catch (e) { toast.error((e as Error).message); } finally { setLoading(null); }
  };
  const row = (i: number, p: Partial<Row>) => set({ rows: d.rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const move = (i: number, by: number) => {
    const rows = [...d.rows];
    const [r] = rows.splice(i, 1);
    rows.splice(i + by, 0, r);
    set({ rows });
  };
  const use = async () => {
    if (!canvas.current) return;
    setBusy(true);
    try {
      await draw(canvas.current, d);
      const blob = await new Promise<Blob | null>((ok) => canvas.current!.toBlob(ok, "image/jpeg", 0.92));
      if (!blob) throw new Error("Couldn't make the image.");
      onUse({ ...(await uploadFile(blob, "image/jpeg")), w: W, h: H });
      toast.success("Image added to the post");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const download = () => {
    canvas.current?.toBlob((b) => {
      if (!b) return;
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(b), download: `${d.kind}-${new Date().toISOString().slice(0, 10)}.png` });
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  };

  return (
    <div className="soc-studio">
      <div className="crm-stack">
        <Panel><div className="crm-card crm-stack">
          <div className="crm-row">
            <SelectField label="Post" value={d.kind} onValueChange={(v) => pick(v as Kind)} items={KINDS} />
            <SelectField label="Colors" value={d.look} onValueChange={(v) => set({ look: v as Look })} items={{ dark: "Dark", light: "Light" }} />
            {d.kind === "salary" ? <div className="crm-num"><TextField label="Salaries needed" type="number" min={1} value={min} onChange={(e) => setMin(e.target.value)} /></div> : null}
            {d.kind !== "custom" ? <Btn variant="outline" loading={!!loading} onClick={load}>{d.rows.length || d.big ? "Load again" : "Load data"}</Btn> : null}
          </div>
          {d.kind === "salary" ? (
            <p className="crm-note">Ranks companies by the median of their disclosed yearly USD salaries. A company needs at least {min || 20} of them to count. Hourly pay and other currencies are left out.</p>
          ) : null}
          {loading && loading[1] ? (
            <div className="crm-stack"><Progress value={(loading[0] / loading[1]) * 100} />
              <p className="crm-note">Reading salaries from {loading[0]} of {loading[1]} companies</p></div>
          ) : null}
          <TextField label="Title" value={d.title} onChange={(e) => set({ title: e.target.value })} />
          <TextField label="Subtitle" value={d.subtitle} onChange={(e) => set({ subtitle: e.target.value })} />
          {d.kind === "number" ? (
            <div className="crm-row">
              <div className="crm-grow"><TextField label="Number" value={d.big} onChange={(e) => set({ big: e.target.value })} /></div>
              <div className="crm-grow"><TextField label="Under the number" value={d.label} onChange={(e) => set({ label: e.target.value })} /></div>
            </div>
          ) : null}
          <TextField label="Footer" value={d.note} onChange={(e) => set({ note: e.target.value })} />
        </div></Panel>
        {d.kind !== "number" ? (
          <Panel><div className="crm-card crm-stack">
            <div className="crm-row between"><h2>Rows</h2><span className="crm-note">The image shows the first 10</span></div>
            {d.rows.length ? (
              <Table className="soc-rows">
                <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Website</TableHead><TableHead>Number</TableHead><TableHead>Under it</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {d.rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell><input aria-label="Name" className="soc-cell" value={r.name} onChange={(e) => row(i, { name: e.target.value })} /></TableCell>
                      <TableCell><input aria-label="Website, for the logo" className="soc-cell" value={r.domain} onChange={(e) => row(i, { domain: e.target.value.trim() })} /></TableCell>
                      <TableCell><input aria-label="Number" className="soc-cell" value={r.value} onChange={(e) => row(i, { value: e.target.value })} /></TableCell>
                      <TableCell><input aria-label="Under the number" className="soc-cell" value={r.sub} onChange={(e) => row(i, { sub: e.target.value })} /></TableCell>
                      <TableCell className="soc-row-tools">
                        <Button variant="ghost" size="icon" aria-label="Move up" disabled={!i} onClick={() => move(i, -1)}><ArrowUp /></Button>
                        <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === d.rows.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                        <Button variant="ghost" size="icon" aria-label="Remove row" onClick={() => set({ rows: d.rows.filter((_, j) => j !== i) })}><Trash /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <p className="crm-note">{d.kind === "custom" ? "Add the rows to show." : "Load the data to fill the rows. You can edit them after."}</p>}
            <div><Button variant="outline" onClick={() => set({ rows: [...d.rows, { name: "", domain: "", value: "", sub: "" }] })}><Plus />Add row</Button></div>
          </div></Panel>
        ) : null}
      </div>
      <div className="soc-canvas-col">
        <canvas ref={canvas} className="soc-canvas" width={W} height={H} aria-label="Preview of the post image" />
        <div className="crm-row">
          <Btn loading={busy} onClick={use}>Add to post</Btn>
          <Button variant="outline" onClick={download}>Download PNG</Button>
        </div>
      </div>
    </div>
  );
}
