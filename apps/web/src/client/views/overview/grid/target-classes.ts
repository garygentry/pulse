// apps/web/src/client/views/overview/grid/target-classes.ts — token class strings shared by host cards,
// host triggers and service chips.
//
// Status colour is derived from TARGET_STATUS (tone → token class), never chosen locally. The status
// edge uses each tone's foreground token, which meets 3:1 non-text contrast against the card; the
// suppressed entry (an outline badge) is additionally dashed, so it stays distinct from unknown,
// which shares its neutral tone. Kiosk layout is read from the enclosing hosts container
// (`group/hosts` with `data-layout`), so cells take no extra props and their memo equality is
// unchanged. Wallboard type and spacing need no overrides: the density root scales both ramps.

import type { TargetStatus } from "@pulse/web-data/wire";
import { TARGET_STATUS, cn } from "@/ui";
import type { Tone } from "@/ui";

/** Tone → full border colour (service chips). Literal strings so Tailwind generates them. */
const TONE_BORDER: Readonly<Record<Tone, string>> = {
  ok: "border-status-ok-fg",
  warn: "border-status-warn-fg",
  danger: "border-status-danger-fg",
  info: "border-status-info-fg",
  pending: "border-status-pending-fg",
  neutral: "border-status-neutral-fg",
};

/** Tone → leading-edge colour (host cards). */
const TONE_EDGE: Readonly<Record<Tone, string>> = {
  ok: "border-s-status-ok-fg",
  warn: "border-s-status-warn-fg",
  danger: "border-s-status-danger-fg",
  info: "border-s-status-info-fg",
  pending: "border-s-status-pending-fg",
  neutral: "border-s-status-neutral-fg",
};

/** Whether a status renders as an outline badge (suppressed): its border is dashed. */
function isOutline(status: TargetStatus): boolean {
  return TARGET_STATUS[status].variant === "outline";
}

/** Service chip border: the status tone colour, dashed and input-toned for an outline status. */
export function statusBorderClass(status: TargetStatus): string {
  return isOutline(status) ? "border-dashed border-input" : TONE_BORDER[TARGET_STATUS[status].tone];
}

/** Host card leading edge: the status tone colour, dashed and input-toned for an outline status. */
export function statusEdgeClass(status: TargetStatus): string {
  return isOutline(status) ? "border-dashed border-s-input" : TONE_EDGE[TARGET_STATUS[status].tone];
}

/**
 * Host card surface. No `content-visibility: auto`: the first keyboard focus on the page makes Chrome
 * unlock every skipped card at once, a whole-grid restyle that delays the next input by a frame or
 * more. Fully rendered cards cost that once, during the initial paint instead.
 */
export function hostCardClass(status: TargetStatus): string {
  return cn(
    "grid min-h-11 min-w-11 gap-1 rounded-lg border border-border border-s-4 bg-card p-2 text-card-foreground",
    statusEdgeClass(status),
  );
}

/**
 * A roving target trigger (host trigger or service chip): 44px minimum, focus ring, a 2px selected
 * outline, and the change marker — opacity and outline only, never position or size.
 */
export const TARGET_TRIGGER_CLASS = cn(
  "flex min-h-11 min-w-11 max-w-full cursor-pointer flex-wrap items-center gap-1 rounded-md border px-2 py-1",
  "text-start text-sm text-foreground [overflow-wrap:anywhere]",
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
  "aria-selected:border-foreground aria-selected:ring-1 aria-selected:ring-foreground",
  "data-[changed]:outline-2 data-[changed]:outline-offset-2 data-[changed]:outline-solid data-[changed]:outline-foreground",
  "data-[changed=animated]:animate-in data-[changed=animated]:fade-in-50",
  "data-[changed=animated]:duration-(--motion-slow) data-[changed=animated]:ease-(--motion-ease)",
  "motion-reduce:animate-none",
);

/** Muted evidence line under an unknown target. */
export const TARGET_EVIDENCE_CLASS = "basis-full text-xs text-muted-foreground";

/** The static (reduced-motion) 'Changed' text marker. */
export const TARGET_CHANGED_CLASS = "text-xs font-semibold";
