import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // DESIGN.md "Inputs": 1.5px ink border, 38px, 4px corners, the focus a
        // 2px signal-green outline drawn inside. 16px on touch screens, where
        // iPhone Safari zooms into anything smaller.
        "h-[38px] w-full min-w-0 rounded-md border-[1.5px] border-input bg-background px-3 py-1 text-base transition-colors outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 pointer-fine:text-sm",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
