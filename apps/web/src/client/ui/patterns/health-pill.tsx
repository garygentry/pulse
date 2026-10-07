import type { ComponentProps, ReactNode } from "react";
import type { IconName } from "@/ui/lib/icons";
import type { Tone } from "@/ui/lib/status";
import { TONE_FG } from "@/ui/lib/tone";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";
import { VisuallyHidden } from "@/ui/patterns/visually-hidden";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/primitives/tooltip";

export interface HealthPillProps extends Omit<ComponentProps<"a">, "href" | "children" | "title"> {
  tone: Tone;
  icon: IconName | (string & {});
  /** Short visible text; truncates in narrow headers (the tooltip shows it in full). */
  label: string;
  /** The owning page. */
  href: string;
  /** Optional count shown as a tabular badge after the label; a string carries its unit, e.g. "82%". */
  count?: number | string;
  /** Screen-reader wording for the count, e.g. "3 active findings". Defaults to the number. */
  countLabel?: string;
  /** Trailing content inside the link, e.g. a `FreshnessBadge` with `tooltip={false}`. */
  meta?: ReactNode;
  /** Tooltip text; defaults to the label (and count), so truncated text stays readable. */
  title?: ReactNode;
}

/**
 * A compact header link summarising one area's health: tone-tinted icon + short
 * text + optional count, pointing at the page that owns the detail. The whole
 * pill is one link; its accessible name is the label plus the count.
 */
export function HealthPill({
  tone,
  icon,
  label,
  href,
  count,
  countLabel,
  meta,
  title,
  className,
  ...props
}: HealthPillProps) {
  const tip = title ?? (count == null ? label : `${label}: ${count}`);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          data-slot="health-pill"
          data-tone={tone}
          href={href}
          className={cn(
            "inline-flex h-7 max-w-56 min-w-0 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-xs font-medium text-foreground",
            "outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
            className,
          )}
          {...props}
        >
          <Icon name={icon} size={14} className={cn("shrink-0", TONE_FG[tone])} />
          {/* Below md the pill collapses to icon + count; the label stays in the name. */}
          <span className="min-w-0 truncate max-md:sr-only">{label}</span>
          {count == null ? null : (
            <span
              data-slot="health-pill-count"
              className="shrink-0 rounded-full bg-muted px-1.5 text-muted-foreground tabular-nums"
            >
              {countLabel == null ? (
                count
              ) : (
                <>
                  <span aria-hidden="true">{count}</span>
                  <VisuallyHidden>{countLabel}</VisuallyHidden>
                </>
              )}
            </span>
          )}
          {meta == null ? null : <span className="contents max-md:hidden">{meta}</span>}
        </a>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
