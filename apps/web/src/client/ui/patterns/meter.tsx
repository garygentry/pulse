import { useId, type ReactNode } from "react";
import type { IconName } from "@/ui/lib/icons";
import type { Tone } from "@/ui/lib/status";
import { TONE_FG } from "@/ui/lib/tone";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";

// Literal class names so Tailwind generates every fill; the `-fg` token is the one held
// to contrast on every surface, so it also serves as a visible non-text fill.
const TONE_FILL: Record<Tone, string> = {
  ok: "bg-status-ok-fg",
  warn: "bg-status-warn-fg",
  danger: "bg-status-danger-fg",
  info: "bg-status-info-fg",
  pending: "bg-status-pending-fg",
  neutral: "bg-status-neutral-fg",
};

export interface MeterProps {
  /** Names the meter. */
  label: ReactNode;
  /** The measured value, clamped to `0..max`. */
  value: number;
  max?: number;
  /** Tints the fill and the value text. Always pair a non-neutral tone with `icon`. */
  tone?: Tone;
  /** Shown before the value, so the tone is never carried by colour alone. */
  icon?: IconName;
  /** Visible value text; defaults to the rounded percentage of `max`. */
  valueText?: string;
  /** Screen-reader value wording (`aria-valuetext`), e.g. "82% used, nearing limit". Defaults to `valueText`. */
  srValueText?: string;
  /** Secondary line under the bar, e.g. a reset countdown or source attribution. */
  meta?: ReactNode;
  className?: string;
}

/**
 * A labelled horizontal gauge (`role="meter"`) for a bounded quantity such as
 * quota used. The value is text as well as geometry; the fill width is the only
 * inline style.
 */
export function Meter({
  label,
  value,
  max = 100,
  tone = "neutral",
  icon,
  valueText,
  srValueText,
  meta,
  className,
}: MeterProps) {
  const labelId = useId();
  const clamped = Math.min(max, Math.max(0, Number.isFinite(value) ? value : 0));
  const percent = max > 0 ? (clamped / max) * 100 : 0;
  const shown = valueText ?? `${Math.round(percent)}%`;

  return (
    <div data-slot="meter" data-tone={tone} className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span id={labelId} className="min-w-0 truncate font-medium">
          {label}
        </span>
        <span className={cn("inline-flex shrink-0 items-center gap-1 font-semibold tabular-nums", TONE_FG[tone])}>
          {icon !== undefined ? <Icon name={icon} size={14} /> : null}
          {shown}
        </span>
      </div>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={clamped}
        aria-valuetext={srValueText ?? shown}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full transition-[width]", TONE_FILL[tone])} style={{ width: `${percent}%` }} />
      </div>
      {meta !== undefined ? <div className="text-xs text-muted-foreground tabular-nums">{meta}</div> : null}
    </div>
  );
}
