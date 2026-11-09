// The board's own column: which listings to show, the categories with
// their counts, and the searches kept in this browser. Above 1100px it
// is the first column; narrower, the filters sheet carries the same
// sections (see Filters.tsx Sheet).
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Button } from "@cloudflare/kumo/components/button";
import { X } from "@phosphor-icons/react";
import { F, RAIL_GROUPS, RAIL_TOP_N, U, currentSearchQuery, currentView, forgetSavedSearch, openSavedSearch, railLabel, railRows, railSelected, railToggle,
  railVisibleRows, saveCurrentSearch, setView, toggleExpanded } from "./store";
import { fmtInt } from "./util";

const VIEWS = [["tech", "Tech jobs"], ["all", "All jobs"], ["matches", "Best matches"], ["saved", "Saved"]] as const;

export function ViewSwitch({ onPick }: { onPick?: () => void }) {
  const view = currentView();
  return (
    <div role="tablist" aria-label="Which jobs to show" className="flex flex-col gap-0.5">
      {VIEWS.map(([key, label]) => {
        const on = view === key;
        return (
          <button key={key} type="button" role="tab" aria-selected={on} onClick={() => { setView(key); onPick?.(); }}
            className={`cursor-pointer rounded-[4px] border-0 px-2 py-1 text-left text-sm ${on ? "bg-kumo-tint font-medium text-kumo-strong" : "bg-transparent text-kumo-default hover:bg-kumo-tint"}`}>
            {label}
          </button>
        );
      })}
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
      <div className="flex flex-col gap-1.5 py-1" aria-hidden="true">{[62, 48, 70, 55].map((w) => <SkeletonLine key={w} minWidth={w} maxWidth={w} />)}</div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {rows.map((r) => {
        const on = picked.has(r.value);
        return (
          <button key={r.value} type="button" aria-pressed={on} onClick={() => { railToggle("department", r.value, !on); onPick?.(); }}
            className={`flex cursor-pointer items-center justify-between gap-2 rounded-[4px] border-0 px-2 py-1 text-left text-sm ${on ? "bg-kumo-tint font-medium text-kumo-strong" : "bg-transparent text-kumo-default hover:bg-kumo-tint"}`}>
            <span className="truncate">{railLabel(CATEGORY, r)}</span>
            {r.n == null ? null : <span className="font-mono text-xs text-kumo-subtle">{fmtInt(r.n)}</span>}
          </button>
        );
      })}
      {total > RAIL_TOP_N && !U.railQueries.get("department") ? (
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => toggleExpanded("department")}>
          {U.railExpanded.has("department") ? "Show fewer" : `Show all (${fmtInt(total)})`}
        </Button>
      ) : null}
    </div>
  );
}

export function SavedSearches({ onPick }: { onPick?: () => void }) {
  const list = U.savedSearches;
  const q = currentSearchQuery();
  const canSave = !!q && !list.some((s) => s.query === q);
  return (
    <div className="flex flex-col gap-0.5">
      {list.map((s) => (
        <div key={s.id} className="group flex items-center gap-1">
          <button type="button" title={s.name} onClick={() => { openSavedSearch(s.id); onPick?.(); }}
            className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-[4px] border-0 bg-transparent px-2 py-1 text-left text-sm text-kumo-default hover:bg-kumo-tint">
            <span className="truncate">{s.name}</span>
            {s.fresh ? <span className="font-mono text-xs text-kumo-brand">{fmtInt(s.fresh)} new</span> : null}
          </button>
          <Button variant="ghost" size="xs" shape="square" icon={<X />} aria-label={`Forget ${s.name}`} onClick={() => forgetSavedSearch(s.id)} />
        </div>
      ))}
      {canSave ? <Button variant="ghost" size="sm" className="justify-start" onClick={saveCurrentSearch}>+ Save this search</Button> : null}
      {!list.length && !canSave ? <p className="m-0 px-2 text-xs text-kumo-subtle">Set a filter, then save the search here.</p> : null}
    </div>
  );
}

export function Side() {
  return (
    <aside aria-label="Views" className="hidden min-h-0 w-[232px] flex-col gap-5 overflow-y-auto border-r border-kumo-hairline px-3 py-4 min-[1100px]:flex">
      <ViewSwitch />
      <section>
        <h2 className="m-0 mb-1 px-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Categories</h2>
        <Categories />
      </section>
      <section>
        <h2 className="m-0 mb-1 px-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Saved searches</h2>
        <SavedSearches />
      </section>
      {F.skills.length ? null : null}
    </aside>
  );
}
