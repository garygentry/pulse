import { useMemo } from "react";
import type { FreshnessStamp, FreshnessState } from "@/ui/lib/freshness";
import { formatAge } from "@/ui/lib/format";
import { defineStatusMap } from "@/ui/lib/status";
import { useNow } from "@/ui/hooks/use-now";
import { StatusBadge, type StatusBadgeMapProps } from "@/ui/patterns/status-badge";

/** Presentation of each provider freshness state (shared by every freshness surface). */
export const FRESHNESS_STATUS = defineStatusMap<FreshnessState>({
  fresh: { tone: "ok", icon: "circle-check", label: "Fresh" },
  stale: { tone: "warn", icon: "clock-alert", label: "Stale" },
  unreachable: { tone: "danger", icon: "cloud-off", label: "Unreachable" },
  static: { tone: "neutral", icon: "link", label: "Link" },
  pending: { tone: "pending", icon: "hourglass", label: "Loading…" },
});

/** The supplementary tooltip text: when the data was observed and its TTL. */
export function freshnessTitle(freshness: FreshnessStamp): string {
  if (freshness.state === "static") return "Static link — not polled";
  if (freshness.observedAt == null) return "Awaiting first successful poll";
  const ttl =
    freshness.ttlMs == null ? "" : ` (stale after ${Math.round(freshness.ttlMs / 1_000)}s)`;
  return `Observed ${freshness.observedAt}${ttl}`;
}

export interface FreshnessBadgeProps extends StatusBadgeMapProps {
  freshness: FreshnessStamp;
  /**
   * Reference time for a deterministic age (`now − observedAt`). Omit it and the
   * age is the server's `ageMs` plus the time since this stamp arrived, re-read
   * every `tickMs`.
   */
  now?: number | Date;
  tickMs?: number;
  /** Show `freshnessTitle` as a tooltip (default true). Turn off inside a link. */
  tooltip?: boolean;
}

/**
 * `StatusBadge` bound to a provider `FreshnessStamp`: "Fresh · as of 6m ago".
 * Static links and pending stamps show no age. The age ticks unless `now` is given.
 */
export function FreshnessBadge({
  freshness,
  now,
  tickMs,
  tooltip = true,
  ...props
}: FreshnessBadgeProps) {
  const showAge = freshness.state !== "static" && freshness.state !== "pending";
  // When this stamp arrived; the server's `ageMs` was measured at about that moment.
  const receivedAt = useMemo(() => Date.now(), [freshness]);
  const clock = useNow(tickMs, showAge && now === undefined);

  let ageMs: number | null = null;
  if (showAge) {
    const observed = freshness.observedAt == null ? Number.NaN : Date.parse(freshness.observedAt);
    if (now !== undefined && !Number.isNaN(observed)) ageMs = Number(now) - observed;
    else if (freshness.ageMs != null) ageMs = freshness.ageMs + Math.max(0, clock - receivedAt);
    else if (!Number.isNaN(observed)) ageMs = Number(now ?? clock) - observed;
  }

  const detail =
    ageMs == null ? undefined : freshness.observedAt == null ? (
      `as of ${formatAge(ageMs)}`
    ) : (
      <>
        as of{" "}
        <time dateTime={freshness.observedAt} className="tabular-nums">
          {formatAge(ageMs)}
        </time>
      </>
    );

  const { tone, icon, label, role } = FRESHNESS_STATUS[freshness.state];
  return (
    <StatusBadge
      data-slot="freshness-badge"
      data-freshness={freshness.state}
      tone={tone}
      icon={icon}
      label={label}
      role={role}
      detail={detail}
      title={tooltip ? freshnessTitle(freshness) : undefined}
      {...props}
    />
  );
}
