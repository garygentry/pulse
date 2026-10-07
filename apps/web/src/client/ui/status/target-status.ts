import type { TargetStatus } from "@pulse/web-data/wire";
import { defineStatusMap } from "@/ui/lib/status";

/**
 * Pulse's target status vocabulary. Suppressed shares the neutral tone with unknown,
 * so it renders as an outline badge with its own icon to stay distinct without colour.
 * No entry carries a live-region role: grids render many badges at once, so a caller opts a single,
 * changing indicator in with `role="alert"`/`"status"`.
 */
export const TARGET_STATUS = defineStatusMap<TargetStatus>({
  ok: { tone: "ok", icon: "circle-check", label: "OK" },
  warning: { tone: "warn", icon: "triangle-alert", label: "Warning" },
  critical: { tone: "danger", icon: "octagon-alert", label: "Critical" },
  unknown: { tone: "neutral", icon: "circle-help", label: "Unknown" },
  suppressed: { tone: "neutral", icon: "circle-minus", label: "Suppressed", variant: "outline" },
});
