// The schema: each table folds open to its columns with their types, a
// column's note shows under the list on click. Typing filters columns by
// name or note across every table and opens the tables that match.
import { useState } from "react";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Input } from "@cloudflare/kumo/components/input";
import { CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import { SCHEMA } from "./data";

export function SchemaPanel() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set([SCHEMA[0].table]));
  const [picked, setPicked] = useState<string | null>(null);   // "table.column"
  const want = q.trim().toLowerCase();
  const toggle = (table: string, on: boolean) => setOpen((s) => { const n = new Set(s); if (on) n.add(table); else n.delete(table); return n; });
  return (
    <section aria-labelledby="st-s-title" className="min-w-0">
      <h2 id="st-s-title" className="mb-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">Schema</h2>
      <Input size="sm" type="search" name="column" placeholder="Find a column" aria-label="Find a column" autoComplete="off"
        value={q} onChange={(e) => setQ(e.target.value)} className="mb-2" />
      <div className="flex flex-col gap-1">
        {SCHEMA.map((t) => {
          const hits = t.columns.filter(([c, , n]) => !want || c.includes(want) || n.toLowerCase().includes(want) || t.table.includes(want));
          if (want && !hits.length) return null;
          const isOpen = want ? true : open.has(t.table);
          const note = picked?.startsWith(`${t.table}.`) ? t.columns.find(([c]) => `${t.table}.${c}` === picked) : null;
          return (
            <Collapsible.Root key={t.table} open={isOpen} onOpenChange={(on) => toggle(t.table, on)}>
              <Collapsible.Trigger className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-kumo-tint">
                <CaretRight size={10} className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden="true" />
                <span className="font-mono text-[13px] text-kumo-strong">{t.table}</span>
                <span className="ml-auto text-xs text-kumo-subtle">{t.columns.length} cols</span>
              </Collapsible.Trigger>
              <Collapsible.Panel>
                <p className="m-0 px-2 pt-0.5 pb-1.5 text-xs text-kumo-subtle">{t.note}</p>
                {hits.map(([c, ty, n]) => {
                  const id = `${t.table}.${c}`;
                  const on = picked === id;
                  return (
                    <button key={c} type="button" aria-expanded={on} onClick={() => setPicked(on ? null : id)}
                      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-0.5 text-left text-[13px] hover:bg-kumo-tint ${on ? "bg-kumo-tint" : ""}`}
                      title={n || undefined}>
                      <span className="font-mono">{c}</span>
                      <span className="text-xs text-kumo-subtle">{ty}</span>
                    </button>
                  );
                })}
                {note ? (
                  <p className="m-0 mt-1 border-t border-kumo-hairline px-2 pt-1.5 text-xs text-kumo-subtle">
                    <code className="font-mono text-kumo-strong">{note[0]}</code> · {note[2] || `${note[1]} column`}
                  </p>
                ) : null}
              </Collapsible.Panel>
            </Collapsible.Root>
          );
        })}
      </div>
    </section>
  );
}
