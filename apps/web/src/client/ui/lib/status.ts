// Pulse divergence from deck: `StatusPresentation.variant`, so a map entry can pick the badge
// shape (e.g. outline for suppressed) and stay distinguishable without colour.
import type { IconName } from "./icons";

/** The six status tones. Each maps to `--status-{tone}-fg/-bg/-border` in theme.css. */
export type Tone = "ok" | "warn" | "danger" | "info" | "pending" | "neutral";

export const TONES: readonly Tone[] = ["ok", "warn", "danger", "info", "pending", "neutral"];

/** How one state of a domain value presents: tone and icon, plus text so colour is never alone. */
export interface StatusPresentation {
  tone: Tone;
  icon: IconName;
  label: string;
  /** Live-region role when the state should be announced; omit for static text. */
  role?: "status" | "alert";
  /** Badge shape for this state; omit for the badge default (soft). */
  variant?: "soft" | "outline" | "dot";
}

export type StatusMap<S extends string> = Readonly<Record<S, StatusPresentation>>;

/**
 * Declare a feature's state → presentation map. The identity function exists for
 * the type: every state must be covered, and every icon must be a curated name.
 * Maps stay feature-owned (their contrast/a11y tests import them).
 */
export function defineStatusMap<S extends string>(map: Record<S, StatusPresentation>): StatusMap<S> {
  return map;
}
