// Local edit (deck): bg-muted, not bg-accent; the teal-tinted accent read as a highlight.
import { cn } from "@/ui/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
