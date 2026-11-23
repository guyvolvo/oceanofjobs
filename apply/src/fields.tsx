// A labelled control, as the account and auto apply forms use them: the
// label, the control, a line under it and the error, each wired to the
// control by id. Built from shadcn's Field, Input, Textarea, Select and
// Checkbox; nothing here has a look of its own.
import { useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type Wrap = { label?: ReactNode; description?: ReactNode; error?: string; className?: string };

function Frame({ id, label, description, error, className, children }: Wrap & { id: string; children: ReactNode }) {
  return (
    <Field className={cn("gap-1.5", className)} data-invalid={!!error || undefined}>
      {label ? <FieldLabel htmlFor={id}>{label}</FieldLabel> : null}
      {children}
      {description ? <FieldDescription id={`${id}-d`}>{description}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-e`}>{error}</FieldError> : null}
    </Field>
  );
}
const described = (id: string, w: Wrap) => [w.description ? `${id}-d` : "", w.error ? `${id}-e` : ""].filter(Boolean).join(" ") || undefined;

export function TextField({ label, description, error, className, ...props }: Wrap & ComponentProps<typeof Input>) {
  const id = useId();
  return (
    <Frame id={props.id || id} label={label} description={description} error={error} className={className}>
      <Input id={props.id || id} aria-invalid={!!error || undefined} aria-describedby={described(props.id || id, { description, error })} {...props} />
    </Frame>
  );
}

export function AreaField({ label, description, error, className, onValueChange, ...props }: Wrap & ComponentProps<typeof Textarea> & { onValueChange?: (v: string) => void }) {
  const id = useId();
  return (
    <Frame id={id} label={label} description={description} error={error} className={className}>
      <Textarea id={id} aria-invalid={!!error || undefined} aria-describedby={described(id, { description, error })}
        onChange={(e) => onValueChange?.(e.target.value)} {...props} />
    </Frame>
  );
}

// items: value to label, in order. Radix Select can't hold "" as a value.
export function SelectField({ label, description, value, onValueChange, items, className, "aria-label": ariaLabel }: Wrap & {
  value: string; onValueChange: (v: string) => void; items: Record<string, string>; "aria-label"?: string;
}) {
  const id = useId();
  return (
    <Frame id={id} label={label} description={description} className={className}>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} aria-label={ariaLabel}
          className="h-[38px]! w-full border-[1.5px] bg-background focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring dark:bg-background dark:hover:bg-accent"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </Frame>
  );
}

export function CheckField({ label, checked, onCheckedChange, value, className }: {
  label: ReactNode; checked: boolean | "indeterminate"; onCheckedChange: (on: boolean) => void; value?: string; className?: string;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" className={cn("gap-2", className)}>
      <Checkbox id={id} value={value} checked={checked} onCheckedChange={(c) => onCheckedChange(c === true)} />
      <FieldLabel htmlFor={id} className="font-normal leading-snug">{label}</FieldLabel>
    </Field>
  );
}

// A dialog opened from state, not from its own trigger: Radix would send
// focus to <body> on close, so it goes back to whatever had it at open.
// Pass the result as the DialogContent's onCloseAutoFocus.
export function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  // A layout effect runs before the dialog's own effect moves focus in.
  useLayoutEffect(() => { if (open) opener.current = document.activeElement as HTMLElement | null; }, [open]);
  return (e: Event) => { if (opener.current?.isConnected) { e.preventDefault(); opener.current.focus(); } };
}

// A button that shows it is working and can't be pressed twice meanwhile.
// type="button" unless told: these sit inside forms, where a plain button submits.
export function LoadingButton({ loading, disabled, children, type = "button", ...props }: ComponentProps<typeof Button> & { loading?: boolean }) {
  return (
    <Button type={type} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Spinner /> : null}{children}
    </Button>
  );
}
