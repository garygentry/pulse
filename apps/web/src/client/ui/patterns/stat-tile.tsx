import type { ComponentProps, ElementType, ReactNode } from "react";
import type { IconName } from "@/ui/lib/icons";
import type { Tone } from "@/ui/lib/status";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";

// Literal class names so Tailwind generates every tone utility.
const TONE_VALUE: Record<Tone, string> = {
  ok: "text-status-ok-fg",
  warn: "text-status-warn-fg",
  danger: "text-status-danger-fg",
  info: "text-status-info-fg",
  pending: "text-status-pending-fg",
  neutral: "text-foreground",
};

const TONE_EDGE: Record<Tone, string> = {
  ok: "border-l-status-ok-border",
  warn: "border-l-status-warn-border",
  danger: "border-l-status-danger-border",
  info: "border-l-status-info-border",
  pending: "border-l-status-pending-border",
  neutral: "border-l-border",
};

export interface StatTileProps {
  label: ReactNode;
  /** The headline number (or short value). Rendered large, in tabular figures. */
  value: ReactNode;
  /** Tints the value and the tile's leading edge. The label carries the meaning. */
  tone?: Tone;
  icon?: IconName;
  subLabel?: ReactNode;
  /** Makes the whole tile a link. */
  href?: string;
  /** Link component for `href` (e.g. the router's link); defaults to `<a>`. */
  linkAs?: ElementType<{ href: string; className?: string; children?: ReactNode }>;
  className?: string;
}

/** One headline number with its label: a single-pair `dl`, optionally a link. */
export function StatTile({
  label,
  value,
  tone = "neutral",
  icon,
  subLabel,
  href,
  linkAs: LinkAs = "a",
  className,
}: StatTileProps) {
  const body = (
    <dl className="m-0 flex flex-col gap-1">
      <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon !== undefined ? <Icon name={icon} size={14} className={TONE_VALUE[tone]} /> : null}
        {label}
      </dt>
      <dd className={cn("m-0 text-2xl leading-tight font-semibold tabular-nums", TONE_VALUE[tone])}>{value}</dd>
      {subLabel !== undefined ? (
        <dd className="m-0 text-xs text-muted-foreground tabular-nums">{subLabel}</dd>
      ) : null}
    </dl>
  );
  const tileClass = cn(
    "block rounded-lg border border-l-4 bg-card p-4 text-card-foreground",
    TONE_EDGE[tone],
    href !== undefined &&
      "transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
    className,
  );

  if (href !== undefined) {
    return (
      <LinkAs href={href} className={tileClass} data-slot="stat-tile" data-tone={tone}>
        {body}
      </LinkAs>
    );
  }
  return (
    <div data-slot="stat-tile" data-tone={tone} className={tileClass}>
      {body}
    </div>
  );
}

/** Auto-fitting grid of {@link StatTile}s. */
export function StatGrid({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-grid"
      className={cn("grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3", className)}
      {...props}
    />
  );
}
