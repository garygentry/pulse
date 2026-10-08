import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";
import { VisuallyHidden } from "@/ui/patterns/visually-hidden";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/primitives/collapsible";

export interface DisclosureProps {
  /** Trigger text; it names the button. */
  label: ReactNode;
  /**
   * Optional count shown after the label as a pill (e.g. hidden items), in tabular figures. The
   * pill is decorative: the trigger's accessible name gets a separated phrase instead, so it reads
   * "Proposals, 3 items" rather than running the number into the label.
   */
  count?: number;
  /** The spoken count phrase; default "1 item" / "N items". */
  countLabel?: (count: number) => string;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled open state (pair with `onOpenChange`). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * When the panel collapses while focus is inside it (e.g. a "Done" button in
   * the panel, or a programmatic close), move focus back to the trigger instead
   * of losing it to the page. Default true.
   */
  refocusOnCollapse?: boolean;
  className?: string;
  contentClassName?: string;
}

function defaultCountLabel(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/**
 * A collapsible section with a consistent trigger: a chevron, the label and an
 * optional count. The trigger is a real button with `aria-expanded` and
 * `aria-controls` (Radix Collapsible).
 */
export function Disclosure({
  label,
  count,
  countLabel = defaultCountLabel,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  refocusOnCollapse = true,
  className,
  contentClassName,
}: DisclosureProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastFocusedInside = useRef<Element | null>(null);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  // On collapse, if focus was in the panel (still inside it during an exit
  // animation, or already dropped to <body> by the unmount), hand it back to
  // the trigger. Focus the reader moved elsewhere is left alone.
  useLayoutEffect(() => {
    if (open) return;
    const last = lastFocusedInside.current;
    lastFocusedInside.current = null;
    if (!refocusOnCollapse || last === null) return;
    const active = document.activeElement;
    if (active === null || active === document.body || contentRef.current?.contains(active)) {
      triggerRef.current?.focus();
    }
  }, [open, refocusOnCollapse]);

  return (
    <Collapsible
      data-slot="disclosure"
      open={open}
      onOpenChange={handleOpenChange}
      className={cn("flex flex-col gap-2", className)}
    >
      <CollapsibleTrigger
        ref={triggerRef}
        className="group inline-flex w-fit items-center gap-1.5 rounded-md py-1 pr-2 text-sm font-medium text-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Icon
          name="chevron-right"
          className="text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
        />
        <span>
          {label}
          {count !== undefined ? <VisuallyHidden>{`, ${countLabel(count)}`}</VisuallyHidden> : null}
        </span>
        {count !== undefined ? (
          <span aria-hidden="true" className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent
        ref={contentRef}
        className={cn("pl-5.5", contentClassName)}
        onFocus={(event) => {
          lastFocusedInside.current = event.target;
        }}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
