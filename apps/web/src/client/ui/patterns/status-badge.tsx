// Pulse divergence from deck: `fromMap` applies the entry's `variant` (caller props still win).
import type { ComponentProps, ReactElement, ReactNode } from "react";
import type { IconName } from "@/ui/lib/icons";
import type { StatusMap, StatusPresentation, Tone } from "@/ui/lib/status";
import { TONE_FG, TONE_OUTLINE, TONE_SOFT } from "@/ui/lib/tone";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/primitives/tooltip";

export type StatusBadgeSize = "sm" | "md";
/** `soft` = tinted pill; `outline` = bordered, no fill; `dot` = tinted icon beside plain text. */
export type StatusBadgeVariant = NonNullable<StatusPresentation["variant"]>;

export interface StatusBadgeProps
  extends Omit<ComponentProps<"span">, "title" | "children" | "role"> {
  tone: Tone;
  icon: IconName | (string & {});
  label: ReactNode;
  /** Muted suffix after a separator, e.g. "as of 58s ago". Part of the accessible text. */
  detail?: ReactNode;
  size?: StatusBadgeSize;
  variant?: StatusBadgeVariant;
  /**
   * Supplementary tooltip (e.g. the full observation time). It must never be the
   * only carrier of information. When set, the badge becomes focusable so the
   * tooltip is reachable by keyboard too.
   */
  title?: ReactNode;
  /** Live-region role when a change should be announced; omit for static text. */
  role?: "status" | "alert" | undefined;
}

const SIZE: Record<StatusBadgeSize, { box: string; icon: number }> = {
  sm: { box: "gap-1 px-1.5 py-0.5 text-xs", icon: 12 },
  md: { box: "gap-1.5 px-2 py-0.5 text-sm", icon: 14 },
};

/**
 * A status as icon + text, never colour alone. Tone picks token colours only;
 * the label carries the meaning. `detail` renders a muted "· …" suffix.
 */
function StatusBadgeBase({
  tone,
  icon,
  label,
  detail,
  size = "sm",
  variant = "soft",
  title,
  className,
  ...props
}: StatusBadgeProps) {
  const sizing = SIZE[size];
  const badge = (
    <span
      data-slot="status-badge"
      data-tone={tone}
      data-variant={variant}
      tabIndex={title == null ? undefined : 0}
      className={cn(
        "inline-flex w-fit max-w-full shrink-0 items-center rounded-full whitespace-nowrap font-medium tabular-nums",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        sizing.box,
        variant === "soft" && ["border", TONE_SOFT[tone]],
        variant === "outline" && ["border bg-transparent", TONE_OUTLINE[tone]],
        variant === "dot" && "px-0 text-foreground",
        className,
      )}
      {...props}
    >
      <Icon
        name={icon}
        size={sizing.icon}
        className={cn("shrink-0", variant === "dot" && TONE_FG[tone])}
      />
      <span className="truncate">{label}</span>
      {detail == null ? null : (
        <span className="truncate font-normal text-muted-foreground">
          <span aria-hidden="true">· </span>
          {detail}
        </span>
      )}
    </span>
  );
  if (title == null) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/** Extra props when binding a map entry: everything but the presentation itself. */
export type StatusBadgeMapProps = Omit<StatusBadgeProps, "tone" | "icon" | "label"> &
  Partial<Pick<StatusBadgeProps, "label">>;

/** Bind a feature's `defineStatusMap` entry to a badge: `StatusBadge.fromMap(MAP, state)`. */
function fromMap<S extends string>(
  map: StatusMap<S>,
  state: S,
  props?: StatusBadgeMapProps,
): ReactElement {
  const { tone, icon, label, role, variant } = map[state];
  return (
    <StatusBadgeBase
      tone={tone}
      icon={icon}
      label={label}
      role={role}
      {...(variant !== undefined ? { variant } : {})}
      {...props}
    />
  );
}

export const StatusBadge: typeof StatusBadgeBase & { fromMap: typeof fromMap } = Object.assign(
  StatusBadgeBase,
  { fromMap },
);
