// apps/web/src/client/views/timeline/keyboard.ts — view shortcuts and the keyboard hints table
// (07 §9, REQ-A11Y-02, tech-spec §3.10).
//
// `0`, `l`, `[` and `]` go through the shared a11y registry; the plot, swimlane, lane-tree and range
// selector keys are handled by their own components (06 PlotOverlay, 07 §5.2/§7.5, rovingTabindex, SegmentedControl).
// The registry splits combos on "+", so `+`/`=`/`-` live in PlotOverlay, not here. This is a .ts
// module (alerts precedent), so the hints are built with `h` rather than JSX.
import { createElement } from "react";
import type { ReactElement } from "react";
import { registerShortcut } from "../../a11y/index.js";
import { Kbd, KbdGroup } from "@/ui";

/** Callbacks for the four view shortcuts. Each is read at key time, so the view can install once. */
export interface TimelineKeyboardOptions {
  /** `0` — clear the zoom window (axis.reset()). */ readonly resetZoom: () => void;
  /** `l` — pause when live, resume when paused. */ readonly toggleLive: () => void;
  /** `[` — select the previous (shorter) range; no-op at 1h. */ readonly previousRange: () => void;
  /** `]` — select the next (longer) range; no-op at 7d. */ readonly nextRange: () => void;
}

/**
 * Register the view shortcuts on the shared a11y registry (tech-spec §3.10). They do not fire while
 * focus is in a text input, textarea or contenteditable (`allowInInput: false`). The view installs
 * this on mount in desk mode only (never in kiosk, REQ-KIOSK-03) and calls the disposer on unmount.
 *
 * @param opts - Shortcut callbacks.
 * @returns A disposer that removes all four registrations (idempotent).
 */
export function installTimelineKeyboard(opts: TimelineKeyboardOptions): () => void {
  const disposers = [
    registerShortcut("0", () => opts.resetZoom(), { allowInInput: false }),
    registerShortcut("l", () => opts.toggleLive(), { allowInInput: false }),
    registerShortcut("[", () => opts.previousRange(), { allowInInput: false }),
    registerShortcut("]", () => opts.nextRange(), { allowInInput: false }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** One row of the hints table. */
export interface KeyBindingHint {
  /** Where the binding applies, e.g. "Lane list". */ readonly context: string;
  /** Alternative key combos; each inner array is one combo's keycaps, e.g. [["Shift", "←"], ["Shift", "→"]]. */ readonly combos: readonly (readonly string[])[];
  /** What the binding does. */ readonly action: string;
}

const PLOT = "Plot (lanes, alert history, charts)";
const SWIM = "Alert history row";
const TREE = "Lane list";
const RANGE = "Range selector";
const ANYWHERE = "Anywhere";

/** The 07 §9.1 table as data, in display order (also asserted by timeline-view-keyboard.test.ts). */
export const TIMELINE_KEY_BINDINGS: readonly KeyBindingHint[] = [
  { context: PLOT, combos: [["←"], ["→"]], action: "Move the cursor one step back / forward" },
  { context: PLOT, combos: [["Shift", "←"], ["Shift", "→"]], action: "Move the cursor 10 steps" },
  { context: PLOT, combos: [["Home"], ["End"]], action: "Cursor to the start / end of the visible window" },
  { context: PLOT, combos: [["+"], ["="]], action: "Zoom in 2× around the cursor" },
  { context: PLOT, combos: [["-"]], action: "Zoom out 2× (clamped to the range)" },
  { context: PLOT, combos: [["Enter"]], action: "Pin / unpin the cursor (a pin pauses live)" },
  { context: PLOT, combos: [["Esc"]], action: "Clear the cursor pin" },
  { context: SWIM, combos: [["←"], ["→"]], action: "Previous / next alert interval (by start); shows its details" },
  { context: SWIM, combos: [["Home"], ["End"]], action: "First / last alert interval" },
  { context: SWIM, combos: [["Enter"]], action: "Open in Alerts (filtered to the target, or to the severity)" },
  { context: TREE, combos: [["↑"], ["↓"]], action: "Move between lanes" },
  { context: TREE, combos: [["Home"], ["End"]], action: "First / last lane" },
  { context: TREE, combos: [["→"], ["←"]], action: "Expand / collapse a host or Domains (→ on an expanded row moves to its first child; ← on a child moves to its parent)" },
  { context: TREE, combos: [["Enter"]], action: "Select a host or service lane (opens the detail region); toggles Domains; domain DNS-check lanes are not selectable" },
  { context: RANGE, combos: [["←"], ["→"]], action: "Move between ranges" },
  { context: RANGE, combos: [["Enter"], ["Space"]], action: "Select the focused range" },
  { context: ANYWHERE, combos: [["0"]], action: "Reset zoom" },
  { context: ANYWHERE, combos: [["L"]], action: "Pause / resume live" },
  { context: ANYWHERE, combos: [["["], ["]"]], action: "Previous / next range" },
];

/** Cell classes: token text, a hairline rule under each row. */
const CELL = "border-b border-border px-2 py-1 align-top";

/** One combo: its keycaps joined by a visual "+" (e.g. Shift + ←). */
function combo(keys: readonly string[], index: number): ReactElement {
  const parts: ReactElement[] = [];
  keys.forEach((key, i) => {
    if (i > 0) parts.push(createElement("span", { key: `sep-${i}`, "aria-hidden": "true" }, "+") as ReactElement);
    parts.push(createElement(Kbd, { key: `key-${i}` }, key) as ReactElement);
  });
  return createElement(KbdGroup, { key: String(index) }, ...parts) as ReactElement;
}

/** One hints row: context, the combos as Kbd keycaps separated by " / ", and the action. */
function hintRow(hint: KeyBindingHint, index: number): ReactElement {
  const keys: (ReactElement | string)[] = [];
  hint.combos.forEach((keysOfCombo, i) => {
    if (i > 0) keys.push(" / ");
    keys.push(combo(keysOfCombo, i));
  });
  return createElement(
    "tr",
    { key: String(index) },
    createElement("td", { className: CELL }, hint.context),
    createElement("td", { className: `${CELL} whitespace-nowrap` }, ...keys),
    createElement("td", { className: CELL }, hint.action),
  ) as ReactElement;
}

/**
 * Discoverable keyboard help (REQ-A11Y-02): a native disclosure `<details data-slot="timeline-kbd-hints">`
 * with the summary "Keyboard shortcuts", containing a table with an sr-only caption
 * "Timeline keyboard shortcuts" and columns "Where" / "Keys" / "Action" (`<th scope="col">`).
 * Each combo renders as `Kbd` keycaps in a `KbdGroup`; alternatives are separated by " / ".
 * Presentational only.
 */
export function TimelineKeyboardHints(): ReactElement {
  const head = (label: string): ReactElement =>
    createElement("th", { scope: "col", className: `${CELL} text-left font-medium text-foreground` }, label) as ReactElement;
  return createElement(
    "details",
    { "data-slot": "timeline-kbd-hints", className: "text-sm text-muted-foreground" },
    createElement("summary", { className: "cursor-pointer text-foreground" }, "Keyboard shortcuts"),
    createElement(
      "div",
      { className: "mt-2 max-w-full overflow-x-auto" },
      createElement(
        "table",
        { className: "w-full border-collapse" },
        createElement("caption", { className: "sr-only" }, "Timeline keyboard shortcuts"),
        createElement("thead", null, createElement("tr", null, head("Where"), head("Keys"), head("Action"))),
        createElement("tbody", null, ...TIMELINE_KEY_BINDINGS.map(hintRow)),
      ),
    ),
  ) as ReactElement;
}
