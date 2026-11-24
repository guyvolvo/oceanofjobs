import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // The same field as input.tsx, grown to its text.
        "flex field-sizing-content min-h-16 w-full rounded-md border-[1.5px] border-input/30 bg-background px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive pointer-fine:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
