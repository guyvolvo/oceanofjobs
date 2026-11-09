// What the account pages share: the signed-out gate, the Settings area's
// sub-navigation, the card, the two-click delete, the chip picker, and the
// class strings the pages repeat (Tailwind on the tokens).
import { useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { CaretDown, Check, X } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useAuth, type Who } from "../site/auth";
import type { WorkKey } from "../site/nav";
import { SignInPage } from "../site/SignIn";
import { Workspace } from "../site/Workspace";
import type { Option } from "./data";

export type User = NonNullable<Who>;

// Every account page needs a token: signed out, it is the sign-in alone.
// The page unmounts on a sign-out, so nothing of the last reader stays on
// screen, and the overview's cached numbers go with it (auth.js clears the
// stars and the job cache itself).
export function gate(current: WorkKey, Page: ComponentType<{ who: User }>) {
  return function Gated() {
    const who = useAuth();
    useEffect(() => { if (!who) try { localStorage.removeItem("iljobs_dash_v1"); } catch { /* storage blocked */ } }, [who]);
    return who ? <Page who={who} /> : <Workspace current={current}><SignInPage /></Workspace>;
  };
}

export const STACK = "flex flex-col gap-4";
export const ROW = "flex flex-wrap items-center gap-x-3 gap-y-2";
export const TIGHT = "gap-1.5";
export const NOTE = "m-0 text-muted-foreground";
export const ERROR = "m-0 text-destructive";
export const TITLE = "m-0 text-base font-semibold leading-tight text-foreground";
export const BODY = "flex flex-col gap-3 px-6 py-5 max-sm:p-4";
export const LINK = "text-foreground underline decoration-1 underline-offset-[3px] hover:text-link-hover hover:decoration-2";
export const JOB = "font-medium text-foreground no-underline hover:underline [overflow-wrap:anywhere]";
export const SUB = "block text-sm text-muted-foreground [overflow-wrap:anywhere]";
export const LABEL = "font-medium text-foreground";
export const TEXT = "flex min-w-0 flex-col gap-0.5";
export const TABLE = "[&_table]:w-full [&_td]:align-top [&_th]:align-top [&_td]:whitespace-normal [&_td]:[overflow-wrap:anywhere]";
export const ACTIONS_CELL = "w-[1%] whitespace-nowrap! text-right";
export const FORM = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-x-4 gap-y-3";
// A layer card: the page's paper, one hairline round it. No shadow (DESIGN.md).
export const PANEL = "rounded-lg border bg-card text-card-foreground";
// Switches here are green when on, as every other "on" mark.
export const SWITCH = "data-[state=checked]:bg-ring data-[state=unchecked]:bg-dim";

export const Loading = () => <div className="flex items-center gap-2 text-muted-foreground"><Spinner /> Loading</div>;

// The Settings area is four pages here and one under /apply; this row at
// the top of each links them. Full navigations, so links, not in-page tabs.
const SETTINGS = [
  ["/account/settings", "Account settings"], ["/apply/settings", "Auto apply"], ["/account/preferences", "Preferences"],
  ["/account/skills", "Resume skills"], ["/account/billing", "Billing"],
] as const;
export function SettingsNav() {
  const here = location.pathname.replace(/\/$/, "");
  return (
    <nav aria-label="Settings" className="-mx-4 mb-5 overflow-x-auto border-b px-4 [scrollbar-width:none] md:mx-0 md:px-0">
      <ul className="m-0 flex list-none gap-1 p-0">
        {SETTINGS.map(([href, label]) => (
          <li key={href}>
            <a href={href} aria-current={href === here ? "page" : undefined}
              className={cn("relative inline-flex h-10 items-center px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground",
                "aria-[current=page]:text-foreground aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-0 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5 aria-[current=page]:after:bg-foreground")}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Card({ title, note, action, children, className }: {
  title?: ReactNode; note?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <div className={cn(PANEL, className)}>
      <div className={BODY}>
        {title || action ? (
          <div className={`${ROW} justify-between`}>
            {title ? <h2 className={TITLE}>{title}</h2> : <span />}
            {action}
          </div>
        ) : null}
        {note ? <p className={NOTE}>{note}</p> : null}
        {children}
      </div>
    </div>
  );
}

// Two clicks in place of the browser's confirm() box: the first turns the
// button into "Delete?" for four seconds, the second goes ahead (app.js
// confirmClick).
export function ConfirmButton({ ask = "Delete?", onConfirm, children, loading, ...props }: Omit<ComponentProps<typeof Button>, "onClick"> & {
  ask?: string; onConfirm: () => void; loading?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button type="button" {...props} disabled={props.disabled || loading} variant={armed ? "destructive" : props.variant}
      size={armed && String(props.size).startsWith("icon") ? "sm" : props.size}
      aria-label={armed ? `${ask} Click again to confirm` : props["aria-label"]}
      onClick={() => {
        if (armed) { clearTimeout(timer.current); setArmed(false); onConfirm(); return; }
        setArmed(true);
        timer.current = window.setTimeout(() => setArmed(false), 4000);
      }}>
      {loading ? <Spinner /> : null}{armed ? ask : children}
    </Button>
  );
}

// A multiple choice from a list, as chips with a filter box. limit keeps a
// long list (44,000 companies) to what can be drawn: 50 until the reader
// types, then 200 of the matches. A picked value the list doesn't carry
// still shows, so it can be seen and removed. The cities sit indented
// under their country.
export function Picker({ label, placeholder, options, value, onChange, limit }: {
  label: string; placeholder: string; options: Option[]; value: string[]; onChange: (v: string[]) => void; limit?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const items = useMemo((): Option[] => {
    const known = new Set(options.map((o) => o.value));
    return [...options, ...value.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }))];
  }, [options, value]);
  const chosen = useMemo(() => value.map((v) => items.find((o) => o.value === v)!).filter(Boolean), [items, value]);
  // Filtered here, not by cmdk, so a 44,000-row list never reaches the DOM.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q ? items.filter((o) => o.label.toLowerCase().includes(q)) : items;
    return limit ? hits.slice(0, q ? limit * 4 : limit) : hits;
  }, [items, query, limit]);
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label id={`${id}-l`} className="leading-snug">{label}</Label>
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
        <PopoverAnchor asChild>
          <div className="flex min-h-[38px] w-full min-w-0 flex-wrap items-center gap-1 rounded-md border-[1.5px] border-input bg-background py-1 pr-1 pl-1.5 text-sm has-[button:focus-visible]:outline-2 has-[button:focus-visible]:-outline-offset-2 has-[button:focus-visible]:outline-ring">
            {chosen.map((o) => (
              <Badge key={o.value} variant="secondary" className="max-w-full gap-1 rounded-sm pr-0.5">
                <span className="truncate">{o.label}</span>
                <button type="button" aria-label={`Remove ${o.label}`} onClick={() => toggle(o.value)}
                  className="inline-grid size-4 cursor-pointer place-items-center rounded-xs outline-none hover:bg-accent focus-visible:bg-accent"><X size={10} /></button>
              </Badge>
            ))}
            <PopoverTrigger asChild>
              <button type="button" role="combobox" aria-expanded={open} aria-labelledby={`${id}-l`}
                className="flex h-7 min-w-[96px] flex-1 cursor-pointer items-center justify-between gap-2 rounded-sm px-1 text-left text-muted-foreground outline-none">
                <span className="truncate">{chosen.length ? "" : placeholder}</span>
                <CaretDown size={14} className="shrink-0" aria-hidden="true" />
              </button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>
        <PopoverContent align="start" className="w-[min(360px,calc(100vw-32px))] p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} aria-label={label} />
            <CommandList className="max-h-[min(320px,50vh)]">
              <CommandEmpty>No results</CommandEmpty>
              <CommandGroup>
                {shown.map((o) => {
                  const on = value.includes(o.value);
                  return (
                    <CommandItem key={`${o.kind || ""}:${o.value}`} value={`${o.kind || ""}:${o.value}`} onSelect={() => toggle(o.value)}
                      className={o.kind === "city" ? "pl-6" : undefined} data-checked={on || undefined}>
                      <Check className={cn("size-4", on ? "opacity-100" : "opacity-0")} aria-hidden="true" />{o.label}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
