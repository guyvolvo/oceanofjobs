// The sidebar as a drawer, below 1101px where there is no room for it
// beside the list. Loaded on first open, so Radix stays out of the first load.
import type { RefObject } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SideGroups, type SideProps } from "./parts";

export function SideDrawer({ open, onOpenChange, opener, ...side }: SideProps & { open: boolean; onOpenChange: (o: boolean) => void; opener: RefObject<HTMLButtonElement | null> }) {
  // A pick in the drawer is the end of the visit to it.
  const done = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); onOpenChange(false); };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[min(300px,86vw)] gap-2.5 overflow-y-auto bg-background px-3 pt-14 pb-4"
        onCloseAutoFocus={(e) => { e.preventDefault(); opener.current?.focus(); }}>
        <SheetTitle className="sr-only">Filters</SheetTitle>
        <SideGroups {...side} onView={done(side.onView)} onSystem={done(side.onSystem)} />
      </SheetContent>
    </Sheet>
  );
}
