import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Button, type ButtonProps } from "@cloudflare/kumo/components/button";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import type { Option } from "./data";

export function Card({ title, note, action, children, className }: {
  title?: ReactNode; note?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <LayerCard className={className}>
      <div className="oj-card-body">
        {title || action ? (
          <div className="oj-row oj-row-between">
            {title ? <h2 className="oj-card-title">{title}</h2> : <span />}
            {action}
          </div>
        ) : null}
        {note ? <p className="oj-note">{note}</p> : null}
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
// still shows, so it can be seen and removed.
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
      <Combobox.TriggerMultipleWithInput className="oj-picker" placeholder={placeholder}
        renderItem={(o: Option) => <Combobox.Chip key={o.value} removeLabel={`Remove ${o.label}`}>{o.label}</Combobox.Chip>} />
      <Combobox.Content className="oj-picker-menu">
        <Combobox.Empty>No results</Combobox.Empty>
        <Combobox.List>
          {(o: Option) => (
            <Combobox.Item key={`${o.kind || ""}:${o.value}`} value={o} className={o.kind === "city" ? "oj-pick-city" : undefined}>
              {o.label}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}
