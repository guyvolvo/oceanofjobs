// The builder's menus and filter editors, loaded on first use (Builder.tsx
// draws a plain button until then), so Radix's menu and popover stay out
// of the page's first load, as the header's menus do.
import { Fragment, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtInt, type Picks } from "./data";

export type Opt = [value: string, label: string];
export type Group = { group: string; options: Opt[] };
type Trigger = { className: string; children: ReactNode; "aria-label"?: string };

// A pill: one choice from a list, with headings where the list has groups.
export function PillMenu({ trigger, label, value, options, onChange }: { trigger: Trigger; label: string; value: string; options: (Opt | Group)[]; onChange: (v: string) => void }) {
  const items = (opts: Opt[]) => opts.map(([v, t]) => <DropdownMenuRadioItem key={v} value={v} className="pr-4 text-sm whitespace-nowrap data-[state=checked]:font-bold">{t}</DropdownMenuRadioItem>);
  return (
    <DropdownMenu modal={false} defaultOpen>
      <DropdownMenuTrigger {...trigger} />
      <DropdownMenuContent align="start" className="max-w-[320px] min-w-[180px] p-1.5" aria-label={label}>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => { if (v !== value) onChange(v); }}>
          {options.map((o) => ("group" in o ? (
            <Fragment key={o.group}>
              <DropdownMenuLabel className="px-2.5 pt-2 pb-1 font-ui text-[11px] font-bold tracking-[0.05em] text-muted-foreground uppercase">{o.group}</DropdownMenuLabel>
              {items(o.options)}
            </Fragment>
          ) : items([o])))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// "+ Add filter": the fields not filtered on yet. A field picked opens its
// editor, which takes the focus.
export function AddFilterMenu({ trigger, fields, onPick }: { trigger: Trigger; fields: [string, { label: string }][]; onPick: (field: string) => void }) {
  const [picked, setPicked] = useState(false);
  return (
    <DropdownMenu modal={false} defaultOpen>
      <DropdownMenuTrigger {...trigger} />
      <DropdownMenuContent align="start" className="w-56 p-1.5" onCloseAutoFocus={(e) => { if (picked) { e.preventDefault(); setPicked(false); } }}>
        <DropdownMenuLabel className="px-2 pt-1 pb-2 font-ui text-[13px] font-bold">Filter by</DropdownMenuLabel>
        {fields.map(([k, v]) => <DropdownMenuItem key={k} onSelect={() => { setPicked(true); onPick(k); }}>{v.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// A filter's editor: values to tick, text to match, or a date range. It
// applies as you go; closing it runs the question (Builder.tsx).
export function FilterPopover({ trigger, f, picks, open, onOpenChange, edit }: {
  trigger: Trigger; f: QbFilter; picks: Picks; open: boolean; onOpenChange: (on: boolean) => void; edit: (f: QbFilter) => void;
}) {
  const spec = QB.FIELDS[f.field];
  const [search, setSearch] = useState("");
  const close = () => onOpenChange(false);
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); close(); } };
  const title = <div className="px-1 pb-1 font-ui text-[13px] font-bold">{spec.label} {spec.kind === "pick" ? "is" : spec.kind === "text" ? "contains" : "between"}</div>;
  const done = <Button size="sm" onClick={close}>Done</Button>;
  let editor: ReactNode;
  if (spec.kind === "pick") {
    const options = picks[f.field] || [];
    const searchable = spec.searchable || options.length > 12;
    const want = search.trim().toLowerCase();
    const sel = new Set(f.values || []);
    const shown = (want ? options.filter((o) => o.name.toLowerCase().includes(want)) : options).slice(0, 400);
    editor = (
      <>
        {title}
        {searchable ? <Input type="search" placeholder={`Filter ${spec.label.toLowerCase()}…`} aria-label="Filter values" autoFocus
          value={search} onChange={(e) => setSearch(e.target.value)} className="h-8" /> : null}
        <div role="group" aria-label={spec.label} className="max-h-[260px] overflow-y-auto">
          {shown.length ? shown.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent">
              <Checkbox checked={sel.has(o.value)} onCheckedChange={(c) => {
                const next = new Set(sel); if (c === true) next.add(o.value); else next.delete(o.value);
                edit({ ...f, values: [...next] });
              }} />
              <span className="min-w-0 truncate">{o.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{fmtInt(o.n)}</span>
            </label>
          )) : <div className="p-2 text-muted-foreground">{options.length ? "No results" : "Loading values…"}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t pt-2">
          <Button variant="link" size="sm" className="font-sans text-sm font-normal underline underline-offset-[3px]" onClick={() => edit({ ...f, values: [] })}>Clear</Button>
          {done}
        </div>
      </>
    );
  } else if (spec.kind === "text") {
    editor = (
      <>
        {title}
        <Input className="h-8" autoFocus value={f.text || ""} placeholder={`e.g. ${spec.label === "Title" ? "backend" : "Tel Aviv"}`} aria-label={spec.label}
          onChange={(e) => edit({ ...f, text: e.target.value })} onKeyDown={onEnter} />
        <div className="flex justify-end border-t pt-2">{done}</div>
      </>
    );
  } else {
    editor = (
      <>
        {title}
        <div className="grid grid-cols-2 gap-1.5">
          <Input className="h-8" autoFocus value={f.from || ""} placeholder="from YYYY-MM-DD" aria-label="From" onChange={(e) => edit({ ...f, from: e.target.value.trim() })} onKeyDown={onEnter} />
          <Input className="h-8" value={f.to || ""} placeholder="to YYYY-MM-DD" aria-label="To" onChange={(e) => edit({ ...f, to: e.target.value.trim() })} onKeyDown={onEnter} />
        </div>
        <div className="flex justify-end border-t pt-2">{done}</div>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger {...trigger} />
      <PopoverContent align="start" className="flex w-[300px] max-w-[calc(100vw-32px)] flex-col gap-1.5 p-2 text-sm">{editor}</PopoverContent>
    </Popover>
  );
}
