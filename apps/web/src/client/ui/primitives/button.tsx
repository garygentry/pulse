/**
 * Deck edit: `loading`. While loading the button shows a spinner, sets
 * `aria-busy`/`aria-disabled`/`data-loading` (these win over forwarded props),
 * swallows clicks and skips the caller's other activation handlers, and never sets
 * `disabled`, so a focused button keeps focus while its action is in flight. It looks
 * inert (dimmed, progress cursor, no hover change). An icon-size button shows only the
 * spinner: its children stay mounted and in the accessibility tree (so sr-only text
 * still names it) but are visually hidden. A text button keeps its children after the
 * spinner. Without `asChild`, toggling `loading` never remounts children. The spinner
 * only rotates under `prefers-reduced-motion: no-preference`.
 * With `asChild`, Radix `Slot` runs the child's own handlers before the swallowing
 * one and pointer-down triggers (menus) still open: use `loading` on a plain
 * `Button` around an action, not on an `asChild` trigger.
 */
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/ui/lib/utils"
import { LoaderIcon } from "lucide-react"
import * as Slot from "@radix-ui/react-slot"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[loading]:cursor-progress data-[loading]:opacity-70 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-(--destructive-control-foreground) hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/(--destructive-control-alpha) dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const ICON_SIZES = new Set(["icon", "icon-xs", "icon-sm", "icon-lg"])

// While loading, each variant's hover styles are pinned to its resting look (same
// modifiers, so tailwind-merge replaces them) so a busy button does not react to hover.
const LOADING_HOVER: Record<NonNullable<VariantProps<typeof buttonVariants>["variant"]>, string> = {
  default: "hover:bg-primary",
  destructive: "hover:bg-destructive dark:hover:bg-destructive/(--destructive-control-alpha)",
  outline: "hover:bg-background hover:text-inherit dark:hover:bg-input/30",
  secondary: "hover:bg-secondary",
  ghost: "hover:bg-transparent hover:text-inherit dark:hover:bg-transparent",
  link: "hover:no-underline",
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Busy: spinner, `aria-busy`/`aria-disabled`, activation swallowed; focus stays put. */
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"
  const classes = loading
    ? cn(buttonVariants({ variant, size }), LOADING_HOVER[variant ?? "default"], className)
    : cn(buttonVariants({ variant, size, className }))

  if (!loading && asChild) {
    return (
      <Comp
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={classes}
        {...props}
      />
    )
  }

  const {
    children,
    onClick,
    onClickCapture,
    onKeyDown,
    onKeyUp,
    onPointerDown,
    onMouseDown,
    ...rest
  } = props
  const handlers = loading
    ? {}
    : { onClick, onClickCapture, onKeyDown, onKeyUp, onPointerDown, onMouseDown }
  const busy = loading
    ? {
        "data-loading": "",
        "aria-busy": true,
        "aria-disabled": true,
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          event.preventDefault()
          event.stopPropagation()
        },
      }
    : {}
  const spinner = loading ? (
    <LoaderIcon
      aria-hidden="true"
      className="motion-safe:animate-spin"
      data-slot="button-spinner"
    />
  ) : null
  // An icon button has room for one glyph: while loading its children move into an
  // sr-only wrapper (still mounted, still naming the button) and only the spinner
  // shows. The wrapper is always there (`contents` when idle, so layout is
  // unchanged) to keep the child structure stable.
  const content = ICON_SIZES.has(size ?? "") ? (
    <span data-slot="button-content" className={loading ? "sr-only" : "contents"}>
      {children}
    </span>
  ) : (
    children
  )

  // Without `asChild` the child structure is the same loading or not, so toggling
  // `loading` never remounts stateful children (the idle `asChild` path above
  // renders children directly).
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={classes}
      {...rest}
      {...handlers}
      {...busy}
    >
      {spinner}
      {asChild ? <Slot.Slottable>{content}</Slot.Slottable> : content}
    </Comp>
  )
}

export { Button, buttonVariants }
