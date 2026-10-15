import type { IconName } from "./icons";

/** The six status tones. Each maps to `--status-{tone}-fg/-bg/-border` in theme.css. */
export type Tone = "ok" | "warn" | "danger" | "info" | "pending" | "neutral";

export const TONES: readonly Tone[] = ["ok", "warn", "danger", "info", "pending", "neutral"];

/**
 * The icon a bare tone shows, for a state that has a tone but no map entry of a feature's own
 * (a config-declared status map's): so a toned value still never relies on colour alone.
 */
export const TONE_ICON: Readonly<Record<Tone, IconName>> = {
  ok: "circle-check",
  warn: "triangle-alert",
  danger: "circle-x",
  info: "info",
  pending: "hourglass",
  neutral: "circle-minus",
};

/** How one state of a domain value presents: tone and icon, plus text so colour is never alone. */
export interface StatusPresentation {
  tone: Tone;
  icon: IconName;
  label: string;
  /** Live-region role when the state should be announced; omit for static text. */
  role?: "status" | "alert";
  /** Badge shape for this state (e.g. outline for a suppressed state); omit for the default, soft. */
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
