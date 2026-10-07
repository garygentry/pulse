import type { Tone } from "./status";

/**
 * Tone → token utilities. Literal class strings so Tailwind generates them; the
 * colours themselves live in theme.css (`--status-{tone}-fg/-bg/-border`).
 */
export const TONE_SOFT: Readonly<Record<Tone, string>> = {
  ok: "border-status-ok-border bg-status-ok-bg text-status-ok-fg",
  warn: "border-status-warn-border bg-status-warn-bg text-status-warn-fg",
  danger: "border-status-danger-border bg-status-danger-bg text-status-danger-fg",
  info: "border-status-info-border bg-status-info-bg text-status-info-fg",
  pending: "border-status-pending-border bg-status-pending-bg text-status-pending-fg",
  neutral: "border-status-neutral-border bg-status-neutral-bg text-status-neutral-fg",
};

export const TONE_OUTLINE: Readonly<Record<Tone, string>> = {
  ok: "border-status-ok-border text-status-ok-fg",
  warn: "border-status-warn-border text-status-warn-fg",
  danger: "border-status-danger-border text-status-danger-fg",
  info: "border-status-info-border text-status-info-fg",
  pending: "border-status-pending-border text-status-pending-fg",
  neutral: "border-status-neutral-border text-status-neutral-fg",
};

/** Foreground only: for a tinted icon or dot beside neutral text. */
export const TONE_FG: Readonly<Record<Tone, string>> = {
  ok: "text-status-ok-fg",
  warn: "text-status-warn-fg",
  danger: "text-status-danger-fg",
  info: "text-status-info-fg",
  pending: "text-status-pending-fg",
  neutral: "text-status-neutral-fg",
};
