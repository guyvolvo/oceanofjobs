// The board's sidebar: which jobs to show, the categories with their
// counts, and the searches kept in this browser. Above 1100px it is a
// column; below, a drawer behind the menu button; on a phone the filters
// sheet carries the same sections.
import { GithubLogo, X } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { RAIL_GROUPS, RAIL_TOP_N, U, currentSearchQuery, currentView, forgetSavedSearch, openSavedSearch, railLabel, railRows, railSelected, railToggle,
  railVisibleRows, saveCurrentSearch, setView, toggleExpanded } from "./store";
import { fmtInt } from "./util";

const VIEWS = [["tech", "Tech jobs"], ["all", "All jobs"], ["matches", "Best matches"], ["saved", "Saved"]] as const;
export const sideRow = "flex min-h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2 text-left font-ui text-sm text-foreground hover:bg-muted";
const on = "bg-foreground/[0.18] font-semibold hover:bg-foreground/[0.18]";
const group = "flex flex-none flex-col gap-0.5 rounded-lg border bg-card p-1.5";
const title = "px-2 py-1.5 font-sans text-xs text-muted-foreground";

export function ViewSwitch({ onPick }: { onPick?: () => void }) {
  const view = currentView();
  return (
    <div id="view-switch" role="tablist" aria-label="Which jobs to show" className="flex flex-col gap-0.5">
      {VIEWS.map(([key, label]) => (
        <button key={key} type="button" role="tab" data-view={key} aria-selected={view === key} className={cn(sideRow, view === key && on)}
          onClick={() => { setView(key); onPick?.(); }}>{label}</button>
      ))}
    </div>
  );
}

const CATEGORY = RAIL_GROUPS[0];
export function Categories({ onPick }: { onPick?: () => void }) {
  const picked = railSelected(CATEGORY);
  const rows = railVisibleRows(CATEGORY);
  const total = railRows(CATEGORY).length;
  if (!rows.length) {
    return U.facetsLoaded ? null : (
      <div className="flex flex-col gap-3.5 px-2 py-2" aria-hidden="true">{[62, 48, 70, 55, 40, 66].map((w) => <Skeleton key={w} className="h-3" style={{ width: `${w}%` }} />)}</div>
    );
  }
  return (
    <div id="side-cats" className="flex flex-col gap-0.5">
      {rows.map((r) => {
        const isOn = picked.has(r.value);
        return (
          <button key={r.value} type="button" aria-pressed={isOn} className={cn(sideRow, isOn && on)} onClick={() => { railToggle("department", r.value, !isOn); onPick?.(); }}>
            <span className="truncate">{railLabel(CATEGORY, r)}</span>
            {r.n == null ? null : <span className="flex-none font-sans text-xs tabular-nums text-muted-foreground">{fmtInt(r.n)}</span>}
          </button>
        );
      })}
      {total > RAIL_TOP_N && !U.railQueries.get("department") ? (
        <button type="button" className={cn(sideRow, "text-[13px] text-muted-foreground")} onClick={() => toggleExpanded("department")}>
          {U.railExpanded.has("department") ? "Show fewer" : `Show all (${fmtInt(total)})`}
        </button>
      ) : null}
    </div>
  );
}

export function SavedSearches({ onPick }: { onPick?: () => void }) {
  const list = U.savedSearches;
  const q = currentSearchQuery();
  const canSave = !!q && !list.some((s) => s.query === q);
  return (
    <div id="side-saved" className="flex flex-col gap-0.5">
      {list.map((s) => (
        <div key={s.id} className="group flex items-center gap-0.5">
          <button type="button" title={s.name} className={cn(sideRow, "min-w-0 flex-1")} onClick={() => { openSavedSearch(s.id); onPick?.(); }}>
            <span className="truncate">{s.name}</span>
            {s.fresh ? <span className="flex-none text-xs font-semibold tabular-nums text-[var(--ooj-green-text)]">{fmtInt(s.fresh)} new</span> : null}
          </button>
          <button type="button" aria-label={`Forget ${s.name}`} onClick={() => forgetSavedSearch(s.id)}
            className="grid size-6 flex-none cursor-pointer place-items-center rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100">
            <X size={11} />
          </button>
        </div>
      ))}
      {canSave ? <button type="button" id="side-save" className={cn(sideRow, "text-[13px] text-muted-foreground")} onClick={saveCurrentSearch}>+ Save this search</button> : null}
    </div>
  );
}

// The sidebar itself. Below 1100px it slides in over a scrim (Board.tsx owns `open`).
export function SideBar({ open, drawer, onClose }: { open: boolean; drawer: boolean; onClose: () => void }) {
  return (
    <>
      <aside id="site-side" aria-label="Site" data-open={open || undefined} inert={drawer && !open}
        onClick={(e) => { if ((e.target as HTMLElement).closest("[role=tab], [aria-pressed], #side-saved button")) onClose(); }}
        className="flex min-h-0 flex-col gap-2.5 overflow-y-auto pb-4 pl-4 [scrollbar-width:none] max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:left-0 max-[1100px]:z-30 max-[1100px]:w-[min(300px,86vw)] max-[1100px]:-translate-x-full max-[1100px]:border-r max-[1100px]:bg-card max-[1100px]:px-3 max-[1100px]:pt-3.5 max-[1100px]:transition-transform max-[1100px]:duration-200 max-[1100px]:data-[open]:translate-x-0 max-[800px]:hidden">
        <div className={group}><ViewSwitch /></div>
        <div className={group}><div className={title}>Categories</div><Categories /></div>
        <div className={group}><div className={title}>Saved searches</div><SavedSearches /></div>
        <div className="mt-auto flex items-center gap-1 pt-3.5">
          <a className="mx-1 grid size-8 place-items-center rounded-lg text-muted-foreground hover:text-[var(--ooj-green-text)]" href="https://github.com/guyvolvo/oceanofjobs" target="_blank" rel="noopener"
            aria-label="Source code on GitHub" title="Source code on GitHub"><GithubLogo size={16} weight="fill" /></a>
          <a className="inline-flex h-8 items-center rounded-lg px-2 font-ui text-[13px] text-muted-foreground hover:text-[var(--ooj-green-text)]" href="/contact">Contact</a>
        </div>
      </aside>
      <div aria-hidden="true" onClick={onClose} data-open={open || undefined}
        className="invisible fixed inset-0 z-[29] bg-overlay opacity-0 transition-[opacity,visibility] duration-200 data-[open]:visible data-[open]:opacity-100 min-[1101px]:hidden" />
    </>
  );
}
