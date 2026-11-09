// The schema: each table folds open to its columns with their types, a
// column's note shows under the list on click. Typing filters columns by
// name or note across every table and opens the tables that match.
import { useState } from "react";
import { CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SCHEMA } from "./data";

const ROW = "flex w-full cursor-pointer items-center gap-2 rounded-sm text-left text-foreground hover:bg-accent focus-visible:-outline-offset-2";

export function SchemaPanel() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set([SCHEMA[0].table]));
  const [picked, setPicked] = useState<string | null>(null);   // "table.column"
  const want = q.trim().toLowerCase();
  const toggle = (table: string) => setOpen((s) => { const n = new Set(s); if (n.has(table)) n.delete(table); else n.add(table); return n; });
  return (
    <section aria-labelledby="st-s-title" className="min-w-0 border-t pt-[18px] min-[961px]:mt-[22px]">
      <h2 id="st-s-title" className="m-0 mb-2 px-[11px] font-ui text-sm font-bold">Schema</h2>
      <div className="relative mb-2.5">
        <MagnifyingGlass size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" name="column" placeholder="Find a column" aria-label="Find a column" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)}
          className="h-[34px] border border-border pl-8" />
      </div>
      <div className="text-[13px]">
        {SCHEMA.map((t) => {
          const hits = t.columns.filter(([c, , n]) => !want || c.includes(want) || n.toLowerCase().includes(want) || t.table.includes(want));
          if (want && !hits.length) return null;
          const isOpen = want ? true : open.has(t.table);
          const note = picked?.startsWith(`${t.table}.`) ? t.columns.find(([c]) => `${t.table}.${c}` === picked) : null;
          return (
            <div key={t.table}>
              <button type="button" aria-expanded={isOpen} onClick={() => toggle(t.table)} className={cn(ROW, "px-[11px] py-1.5 font-mono text-[13px] leading-[1.2] font-bold")}>
                <CaretRight size={10} className={cn("shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} aria-hidden="true" />
                <span>{t.table}</span>
                <span className="ml-auto font-sans text-xs font-normal text-muted-foreground">{t.columns.length} cols</span>
              </button>
              <div hidden={!isOpen}>
                <p className="m-0 mt-0.5 mb-1.5 ml-7 text-xs text-muted-foreground">{t.note}</p>
                {hits.map(([c, ty, n]) => {
                  const id = `${t.table}.${c}`;
                  const on = picked === id;
                  return (
                    <button key={c} type="button" aria-expanded={on} onClick={() => setPicked(on ? null : id)}
                      className={cn(ROW, "py-1 pr-[11px] pl-7 font-mono text-[12.5px] leading-[1.2]", on && "bg-secondary")}>
                      <span>{c}</span>
                      <span className="ml-auto font-sans text-xs text-muted-foreground">{ty}</span>
                    </button>
                  );
                })}
                {note ? (
                  <p className="m-0 mt-1.5 mb-2 ml-7 rounded-md bg-secondary px-2.5 py-2 text-[12.5px] leading-[1.45]">
                    <code className="font-mono font-bold">{note[0]}</code> · {note[2] || `${note[1]} column`}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
