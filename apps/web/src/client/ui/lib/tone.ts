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

/** SVG fill (`fill-*`) in the tone's foreground: a chart mark's area or point. */
export const TONE_SVG_FILL: Readonly<Record<Tone, string>> = {
  ok: "fill-status-ok-fg",
  warn: "fill-status-warn-fg",
  danger: "fill-status-danger-fg",
  info: "fill-status-info-fg",
  pending: "fill-status-pending-fg",
  neutral: "fill-status-neutral-fg",
};

/** SVG stroke (`stroke-*`) in the tone's foreground: a chart mark's line or outline. */
export const TONE_SVG_STROKE: Readonly<Record<Tone, string>> = {
  ok: "stroke-status-ok-fg",
  warn: "stroke-status-warn-fg",
  danger: "stroke-status-danger-fg",
  info: "stroke-status-info-fg",
  pending: "stroke-status-pending-fg",
  neutral: "stroke-status-neutral-fg",
};
