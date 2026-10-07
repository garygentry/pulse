import type { ComponentProps } from "react";
import { formatRelative, formatTimestamp } from "@/ui/lib/format";
import { cn } from "@/ui/lib/utils";
import { useNow } from "@/ui/hooks/use-now";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/primitives/tooltip";

export interface RelativeTimeProps
  extends Omit<ComponentProps<"time">, "dateTime" | "children"> {
  /** An ISO timestamp. Unparseable input renders verbatim, without a tooltip. */
  value: string;
  /**
   * The reference time. Pass it for deterministic output (tests, the workbench,
   * or a parent that already ticks); omit it and the text re-reads the clock
   * every `tickMs`.
   */
  now?: number | Date;
  tickMs?: number;
  /** Show the absolute local time in a hover tooltip (default true). */
  tooltip?: boolean;
}

/**
 * `<time dateTime>` with relative text ("6m ago"). The machine-readable instant
 * is always in `dateTime`; the absolute local time is a supplementary tooltip.
 */
export function RelativeTime({
  value,
  now,
  tickMs,
  tooltip = true,
  className,
  ...props
}: RelativeTimeProps) {
  const clock = useNow(tickMs, now === undefined);
  const valid = !Number.isNaN(Date.parse(value));
  const time = (
    <time
      data-slot="relative-time"
      dateTime={value}
      className={cn("tabular-nums", className)}
      {...props}
    >
      {formatRelative(value, now ?? clock)}
    </time>
  );
  if (!tooltip || !valid) return time;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{time}</TooltipTrigger>
      <TooltipContent>{formatTimestamp(value)}</TooltipContent>
    </Tooltip>
  );
}
