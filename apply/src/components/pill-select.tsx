// A rounded pill dropdown (board sort and date, companies sort) on the
// shadcn Select, so the open list is drawn by the page in its own tokens,
// light and dark. A native <select> leaves the list to the operating
// system: white with grey text over the dark theme.
// Radix is imported after the first render, so it stays out of the
// pages' first load, and drawn on the first open: until then the pill is a
// plain button that looks the same, and a click on it opens the list once
// Radix is in.
import { useEffect, useState, type ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// Radix Select doesn't take "" as an item's value; "" is "Any date" here.
const EMPTY = "__empty";

const trigger = cn("h-8 cursor-pointer gap-1.5 rounded-full border-[1.5px] border-foreground/30 bg-transparent px-3.5 font-ui text-[13px] text-foreground shadow-none",
  "hover:bg-muted dark:bg-transparent dark:hover:bg-muted focus-visible:border-foreground focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-ring [&_svg]:text-foreground [&_svg]:opacity-100");
// The shadcn SelectTrigger's own layout, for the plain button.
const plain = "flex w-fit items-center justify-between whitespace-nowrap outline-none data-[size=default]:h-9 [&_svg]:pointer-events-none [&_svg]:shrink-0";

let ui: typeof import("@/components/ui/select") | null = null;
let asked: Promise<unknown> | null = null;

export function PillSelect({ id, label, value, options, onChange, prefix, className, valueClassName }: {
  id?: string;
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  prefix?: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  const [, setLoaded] = useState(!!ui);
  const [wantOpen, setWantOpen] = useState(false);
  useEffect(() => {
    asked ??= import("@/components/ui/select").then((m) => { ui = m; });
  }, []);
  // Radix is drawn on the first open only: mounting the board's three Selects took a throttled phone about 100 ms before the first rows.
  const open = () => { setWantOpen(true); asked?.then(() => setLoaded(true), () => {}); };
  if (!ui || !wantOpen) {
    const text = options.find(([v]) => v === value)?.[1] ?? "";
    return (
      <button type="button" id={id} aria-label={label} title={label} aria-haspopup="listbox" aria-expanded={false} data-size="default"
        className={cn(plain, trigger, className)} onClick={open}
        onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); } }}>
        {prefix ? <span className="text-muted-foreground">{prefix}</span> : null}
        <span className={valueClassName}>{text}</span>
        <CaretDown className="size-4" aria-hidden="true" />
      </button>
    );
  }
  const { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = ui;
  return (
    <Select value={value === "" ? EMPTY : value} onValueChange={(v) => onChange(v === EMPTY ? "" : v)} defaultOpen={wantOpen}>
      <SelectTrigger id={id} aria-label={label} title={label} className={cn(trigger, className)}>
        {prefix ? <span className="text-muted-foreground">{prefix}</span> : null}
        <span className={valueClassName}><SelectValue /></span>
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="min-w-[var(--radix-select-trigger-width)] font-ui">
        {options.map(([v, text]) => (
          <SelectItem key={v || EMPTY} value={v === "" ? EMPTY : v} className="cursor-pointer text-[13px]">{text}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
