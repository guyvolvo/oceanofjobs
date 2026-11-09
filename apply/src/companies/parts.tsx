// The small pieces the directory and the company panel share: a loading
// bone, a company's logo tile, the 7-day trend line and the sidebar groups.
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { fmt, type Row } from "./data";

// Bones where numbers are still coming: a list says nothing in words while
// it loads, it shows the shape of what is coming.
export function Bone({ w, h = 11, className }: { w: string; h?: number; className?: string }) {
  const style: CSSProperties = { width: w, height: h };
  return <span aria-hidden="true" className={cn("block animate-pulse rounded-xs bg-accent", className)} style={style} />;
}

// The tile: the first letter, with the logo from /logo/ over it when there
// is one. A logo that fails to load leaves the letter.
export function Logo({ row, size = 44 }: { row: Pick<Row, "domain" | "name" | "has_logo">; size?: number }) {
  const letter = (row.name || row.domain || "?").trim()[0]?.toUpperCase() || "?";
  return (
    <span className="relative grid shrink-0 place-items-center overflow-hidden rounded-sm border bg-card" style={{ width: size, height: size }} aria-hidden="true">
      <span className="font-ui text-lg font-semibold text-muted-foreground">{letter}</span>
      {row.has_logo === false ? null : (
        <img src={`/logo/${encodeURIComponent(row.domain)}.png`} alt="" width={size} height={size} loading="lazy"
          className="absolute inset-0 size-full bg-card object-contain" onError={(e) => { e.currentTarget.hidden = true; }} />
      )}
    </span>
  );
}

// A row's trend: the last seven days of open jobs as one line, 90 by 28.
// Fewer than two days on record draws nothing rather than a dot.
export function RowSpark({ trend }: { trend?: (number | null)[] }) {
  const pts = (trend || []).map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 2) return null;
  const w = 90, h = 28, n = (trend || []).length - 1;
  const vals = pts.map(([, v]) => v);
  const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${(i / n * w).toFixed(1)} ${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block h-7 w-[90px] overflow-visible text-foreground" role="img"
      aria-label={`Open jobs over seven days, ${fmt(vals[0])} to ${fmt(vals[vals.length - 1])}`}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export const sideItem = "flex min-h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-sm border-0 bg-transparent px-2 text-left font-ui text-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
const sideOn = "bg-accent font-semibold hover:bg-accent";

export type SideProps = {
  view: "hiring" | "following"; onView: (v: "hiring" | "following") => void;
  hiringLabel: string; hiringN: number | null; followingN: number | null;
  systems: { key: string; label: string; n: number }[] | null; picked: string[]; onSystem: (key: string) => void;
};

// The sidebar's two boxes: which list (everyone hiring, or the companies
// you follow) and the eight biggest hiring systems in it. Drawn in the
// sidebar on a wide screen and in the drawer below that.
export function SideGroups({ view, onView, hiringLabel, hiringN, followingN, systems, picked, onSystem }: SideProps) {
  const box = "flex flex-none flex-col gap-0.5 rounded-lg border bg-card p-1.5";
  const title = "px-2 py-1.5 text-xs text-muted-foreground";
  const count = (n: number | null) => <span className="flex-none text-xs font-normal text-muted-foreground">{n == null ? "" : fmt(n)}</span>;
  return (
    <>
      <div className={box}>
        <div className={title}>Browse</div>
        {([["hiring", hiringLabel, hiringN], ["following", "Following", followingN]] as const).map(([key, label, n]) => (
          <button key={key} type="button" className={cn(sideItem, view === key && sideOn)} aria-pressed={view === key} onClick={() => onView(key)}>
            <span className="truncate">{label}</span>{count(n)}
          </button>
        ))}
      </div>
      {/* The one filter only this site can offer: which hiring system a
          company runs, counted over the list on screen. */}
      <div className={box}>
        <div className={title}>Hiring system</div>
        {systems == null ? [62, 48, 70, 55].map((w) => <div key={w} className="flex min-h-8 items-center px-2"><Bone w={`${w}%`} /></div>)
          : systems.length ? systems.slice(0, 8).map((s) => (
            <button key={s.key} type="button" className={cn(sideItem, picked.includes(s.key) && sideOn)} aria-pressed={picked.includes(s.key)} onClick={() => onSystem(s.key)}>
              <span className="truncate">{s.label}</span>{count(s.n)}
            </button>
          )) : <div className="px-2 py-1.5 text-[13px] text-muted-foreground">None</div>}
      </div>
    </>
  );
}
