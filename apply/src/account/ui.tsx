// What the account pages share: the signed-out gate, the Settings area's
// sub-navigation, the card, the two-click delete, the chip picker, and the
// class strings the pages repeat (Tailwind on Kumo's tokens).
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Button, type ButtonProps } from "@cloudflare/kumo/components/button";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useAuth, type Who } from "../site/auth";
import type { WorkKey } from "../site/nav";
import { SignInPage } from "../site/SignIn";
import { Workspace } from "../site/Workspace";
import type { Option } from "./data";

export type User = NonNullable<Who>;

// Every account page needs a token: signed out, it is the sign-in alone.
export function gate(current: WorkKey, Page: ComponentType<{ who: User }>) {
  return function Gated() {
    const who = useAuth();
    return who ? <Page who={who} /> : <Workspace current={current}><SignInPage /></Workspace>;
  };
}

export const STACK = "flex flex-col gap-4";
export const ROW = "flex flex-wrap items-center gap-x-3 gap-y-2";
export const TIGHT = "gap-1.5";
export const NOTE = "m-0 text-kumo-subtle";
export const ERROR = "m-0 text-kumo-danger";
export const TITLE = "m-0 text-base font-semibold leading-tight text-kumo-strong";
export const BODY = "flex flex-col gap-3 px-6 py-5 max-sm:p-4";
export const LINK = "text-kumo-link underline decoration-1 underline-offset-[3px] hover:decoration-2";
export const JOB = "font-medium text-kumo-strong no-underline hover:underline [overflow-wrap:anywhere]";
export const SUB = "block text-sm text-kumo-subtle [overflow-wrap:anywhere]";
export const LABEL = "font-medium text-kumo-strong";
export const TEXT = "flex min-w-0 flex-col gap-0.5";
export const TABLE = "overflow-x-auto [&_table]:w-full [&_td]:align-top [&_th]:align-top [&_td]:[overflow-wrap:anywhere]";
export const ACTIONS_CELL = "w-[1%] whitespace-nowrap text-right";
export const FORM = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-x-4 gap-y-3";
export const DIALOG = "top-1/2 flex max-h-[calc(100dvh-32px)] -translate-y-1/2 flex-col gap-3 overflow-y-auto p-6";
export const DIALOG_ACTIONS = "mt-2 flex flex-wrap justify-end gap-2";

export const Loading = () => <div className="flex items-center gap-2 text-kumo-subtle"><Loader /> Loading</div>;

// The Settings area is four pages here and one under /apply; this row at
// the top of each links them. Full navigations, not in-page tabs.
const SETTINGS = [
  ["/account/settings", "Account settings"], ["/apply/settings", "Auto apply"], ["/account/preferences", "Preferences"],
  ["/account/skills", "Resume skills"], ["/account/billing", "Billing"],
] as const;
export function SettingsNav() {
  const here = location.pathname.replace(/\/$/, "");
  return (
    <nav aria-label="Settings" className="-mx-4 mb-5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
      <Tabs variant="underline" value={here}
        tabs={SETTINGS.map(([href, label]) => ({ value: href, label, render: <a href={href} />, nativeButton: false }))} />
    </nav>
  );
}

export function Card({ title, note, action, children, className }: {
  title?: ReactNode; note?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <LayerCard className={className}>
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
    </LayerCard>
  );
}

// Two clicks in place of the browser's confirm() box: the first turns the
// button into "Delete?" for four seconds, the second goes ahead (app.js
// confirmClick).
export function ConfirmButton({ ask = "Delete?", onConfirm, children, ...props }: {
  ask?: string; onConfirm: () => void; children: ReactNode; size?: "xs" | "sm" | "base" | "lg"; variant?: ButtonProps["variant"];
  shape?: "base" | "square" | "circle"; title?: string; disabled?: boolean; loading?: boolean; className?: string; "aria-label"?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Kumo's props are a union (an icon-only button must carry a name); these always do.
  const Any = Button as unknown as (p: Record<string, unknown>) => ReactNode;
  return (
    <Any {...props} variant={armed ? "destructive" : props.variant} className={armed ? "oj-destructive" : props.className}
      shape={armed ? "base" : props.shape} aria-label={armed ? `${ask} Click again to confirm` : props["aria-label"]}
      onClick={() => {
        if (armed) { clearTimeout(timer.current); setArmed(false); onConfirm(); return; }
        setArmed(true);
        timer.current = window.setTimeout(() => setArmed(false), 4000);
      }}>
      {armed ? ask : children}
    </Any>
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
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    const known = new Set(options.map((o) => o.value));
    return [...options, ...value.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }))];
  }, [options, value]);
  const chosen = useMemo(() => value.map((v) => items.find((o) => o.value === v)!).filter(Boolean), [items, value]);
  return (
    <Combobox<Option, true> label={label} multiple items={items} value={chosen}
      onValueChange={(v) => onChange((v as Option[]).map((o) => o.value))}
      isItemEqualToValue={(a, b) => a.value === b.value} itemToStringLabel={(o) => o.label}
      inputValue={query} onInputValueChange={setQuery} limit={limit ? (query ? limit * 4 : limit) : undefined}>
      <Combobox.TriggerMultipleWithInput className="w-full min-w-0" placeholder={placeholder}
        renderItem={(o: Option) => <Combobox.Chip key={o.value} removeLabel={`Remove ${o.label}`}>{o.label}</Combobox.Chip>} />
      <Combobox.Content className="max-h-[min(320px,50vh)] overflow-y-auto">
        <Combobox.Empty>No results</Combobox.Empty>
        <Combobox.List>
          {(o: Option) => (
            <Combobox.Item key={`${o.kind || ""}:${o.value}`} value={o} className={o.kind === "city" ? "pl-6" : undefined}>
              {o.label}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}
