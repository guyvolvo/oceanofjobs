// The CRM's form pieces, on shadcn/ui: a field with its label and note
// above and below, a select from a { value: label } map, a button that
// shows a spinner while it works, and the card every page sits in.
import { useId, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// The account pages' card (PANEL in apply/Page.tsx).
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-lg border bg-card text-card-foreground", className)}>{children}</div>;
}

export const Loading = ({ children = "Loading" }: { children?: ReactNode }) => (
  <p className="crm-note flex items-center gap-2"><Spinner />{children}</p>
);

export function Btn({ loading, disabled, children, ...props }: ComponentProps<typeof Button> & { loading?: boolean }) {
  return <Button {...props} disabled={disabled || loading}>{loading ? <Spinner /> : null}{children}</Button>;
}

function Labeled({ id, label, description, children }: { id: string; label?: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label ? <Label htmlFor={id}>{label}</Label> : null}
      {children}
      {description ? <p id={`${id}-d`} className="crm-note">{description}</p> : null}
    </div>
  );
}

type FieldProps = { label?: string; description?: string };

export function TextField({ label, description, ...props }: ComponentProps<"input"> & FieldProps) {
  const id = useId();
  return <Labeled id={id} label={label} description={description}><Input id={id} aria-describedby={description ? `${id}-d` : undefined} {...props} /></Labeled>;
}

export function AreaField({ label, description, className, ...props }: ComponentProps<"textarea"> & FieldProps) {
  const id = useId();
  return (
    <Labeled id={id} label={label} description={description}>
      <Textarea id={id} aria-describedby={description ? `${id}-d` : undefined} className={className} {...props} />
    </Labeled>
  );
}

// Radix's Select can't hold "" as a value, and "" is "anyone" in every filter here.
const EMPTY = "__none";
export function SelectField({ label, value, onValueChange, items, disabled }: {
  label?: string; value: string; onValueChange: (v: string) => void; items: Record<string, string>; disabled?: boolean;
}) {
  const id = useId();
  return (
    <Labeled id={id} label={label}>
      <Select value={value || EMPTY} onValueChange={(v) => onValueChange(v === EMPTY ? "" : v)} disabled={disabled}>
        <SelectTrigger id={id} className="w-full min-w-36 bg-background data-[size=default]:h-[38px] dark:bg-background dark:hover:bg-accent"><SelectValue /></SelectTrigger>
        <SelectContent position="popper">
          {Object.entries(items).map(([v, l]) => <SelectItem key={v || EMPTY} value={v || EMPTY}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </Labeled>
  );
}

export function CheckField({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => onCheckedChange(c === true)} />
      <Label htmlFor={id} className="font-normal">{label}</Label>
    </div>
  );
}

// Green when on, as on the account pages (SWITCH in account/ui.tsx).
export function SwitchField({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} className="data-[state=checked]:bg-ring data-[state=unchecked]:bg-dim" checked={checked} onClick={onClick} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}
