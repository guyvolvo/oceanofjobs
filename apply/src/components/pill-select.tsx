// A rounded pill dropdown (board sort and date, companies sort) on the
// shadcn Select, so the open list is drawn by the page in its own tokens,
// light and dark. A native <select> leaves the list to the operating
// system: white with grey text over the dark theme.
import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// Radix Select doesn't take "" as an item's value; "" is "Any date" here.
const EMPTY = "__empty";

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
  return (
    <Select value={value === "" ? EMPTY : value} onValueChange={(v) => onChange(v === EMPTY ? "" : v)}>
      <SelectTrigger id={id} aria-label={label} title={label}
        className={cn("h-8 cursor-pointer gap-1.5 rounded-full border-[1.5px] border-foreground bg-transparent px-3.5 font-ui text-[13px] text-foreground shadow-none",
          "hover:bg-muted dark:bg-transparent dark:hover:bg-muted focus-visible:border-foreground focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-ring [&_svg]:text-foreground [&_svg]:opacity-100",
          className)}>
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
