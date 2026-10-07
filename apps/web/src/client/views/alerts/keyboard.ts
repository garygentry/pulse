// src/client/views/alerts/keyboard.ts — j/k/Enter/Escape keyboard triage loop.
//
// Registers four shortcuts on the shared a11y registry and returns one disposer that removes them
// all (view.tsx installs on mount, disposes on unmount). j/k/Enter no-op off the Firing tab so the
// catalog/silences tabs keep the Tabs roving-tabindex arrow navigation.
// TriageKeyboardHints lives here next to the handlers it documents; this is a .ts module, so the
// hint row is built with `createElement` rather than JSX.
import { createElement } from "react";
import type { ReactElement } from "react";
import type { Signal } from "@preact/signals-core";

import { registerShortcut } from "../../a11y/index.js";
import { Kbd } from "@/ui";
import type { ActiveAlert } from "@pulse/web-data/wire";

export interface TriageKeyboardOptions {
  /** Keyboard cursor into `rows()` — the shared signal TriageTable focuses. */
  readonly selectedIndex: Signal<number>;
  /** Live facet-filtered firing rows (getter — read at handler time, not install time). */
  readonly rows: () => readonly ActiveAlert[];
  /** The TriageTable container element (getter) for focus queries; null before mount. */
  readonly container: () => HTMLElement | null;
  /** Scroll row `index` into view — the triage DataTable handle's `scrollToIndex`, which renders a
   *  virtualized-out row first so it can be focused afterwards. */
  readonly scrollToIndex: (index: number) => void;
  /** True iff the Firing tab is active — gates j/k/Enter. */
  readonly isFiringTabActive: () => boolean;
  /** True iff the detail pane is open (`sel` present) — gates Escape. */
  readonly isPaneOpen: () => boolean;
  /** Open the alert (sets ?sel=…) — Enter. */
  readonly openAlert: (fingerprint: string) => void;
  /** Close the pane (clears ?sel) — Escape. */
  readonly closePane: () => void;
}

/** Register j/k/Enter/Escape; returns a disposer that removes all four (fired on view unmount). */
export function installTriageKeyboard(opts: TriageKeyboardOptions): () => void {
  const move = (delta: number): void => {
    if (!opts.isFiringTabActive()) return;
    const n = opts.rows().length;
    if (n === 0) return;
    const cur = opts.selectedIndex.value;
    const next = cur < 0 ? 0 : Math.min(n - 1, Math.max(0, cur + delta)); // clamp; self-heals stale idx
    opts.selectedIndex.value = next;
    focusRow(opts, next);
  };

  const disposers = [
    registerShortcut("j", () => move(1), { allowInInput: false }),
    registerShortcut("k", () => move(-1), { allowInInput: false }),
    // Enter/Escape never preventDefault: the registry listens on `document`, so cancelling would
    // suppress native Enter activation of every button/link on the page (and the Sheet's own Escape).
    registerShortcut(
      "enter",
      (event) => {
        if (!opts.isFiringTabActive()) return;
        if (isInteractiveTarget(event)) return; // native activation handles the focused control
        if (isInsideDialog(event)) return; // the open detail Sheet (or any dialog) owns its own keys
        const row = opts.rows()[opts.selectedIndex.value];
        if (row !== undefined) opts.openAlert(row.fingerprint);
      },
      { allowInInput: false, preventDefault: false },
    ),
    registerShortcut(
      "escape",
      (event) => {
        // The detail Sheet handles its own Escape (and cancels the event): one key, one close.
        if (event.defaultPrevented) return;
        if (opts.isPaneOpen()) opts.closePane();
      },
      { allowInInput: false, preventDefault: false },
    ),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** Controls whose native Enter activation must win over the triage Enter shortcut. */
const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, summary, [role="tab"], [role="button"], [role="link"], [contenteditable="true"]';

/** True when the keydown originates on (focus is on) an interactive control. Duck-typed on
 *  `matches` so it holds across happy-dom windows; falls back to the document's activeElement. */
function isInteractiveTarget(event: KeyboardEvent): boolean {
  const target = event.target as { matches?: unknown } | null;
  const el =
    target !== null && typeof target.matches === "function"
      ? (target as Element)
      : ((target as Document | null)?.activeElement ?? null);
  return el !== null && typeof el.matches === "function" && el.matches(INTERACTIVE_SELECTOR);
}

/** True when the keydown originates inside a dialog (the detail Sheet focuses its own content). */
function isInsideDialog(event: KeyboardEvent): boolean {
  const target = event.target as { closest?: unknown } | null;
  return (
    target !== null &&
    typeof target.closest === "function" &&
    (target as Element).closest('[role="dialog"], [role="alertdialog"]') !== null
  );
}

/** Frames to wait for a scrolled-to row to render before giving up. */
const FOCUS_RETRY_FRAMES = 4;

/** Focus the row-open control for `rows[index]`. Matches by fingerprint so it survives
 *  virtualization re-windowing. When the control is not mounted (virtualized out), ask the table to
 *  scroll to the row (rendering it) and retry on the next animation frame. */
function focusRow(opts: TriageKeyboardOptions, index: number): void {
  const row = opts.rows()[index];
  if (row === undefined) return;

  const find = (): HTMLElement | null => {
    const container = opts.container();
    if (container === null) return null;
    return (
      Array.from(container.querySelectorAll<HTMLElement>("[data-triage-open]")).find(
        (el) => el.getAttribute("data-triage-open") === row.fingerprint,
      ) ?? null
    );
  };

  const focus = (el: HTMLElement): void => {
    const container = opts.container();
    for (const prev of Array.from(container?.querySelectorAll("[data-triage-open][aria-current]") ?? [])) {
      prev.removeAttribute("aria-current"); // single current row
    }
    el.setAttribute("aria-current", "true");
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    el.focus();
  };

  const el = find();
  if (el !== null) {
    focus(el);
    return;
  }
  opts.scrollToIndex(index);
  const raf =
    (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame ??
    ((cb: FrameRequestCallback) => (cb(0), 0)); // happy-dom / SSR fallback
  const retry = (left: number): void => {
    raf(() => {
      // The cursor moved on while we waited: that move owns focus now.
      if (opts.selectedIndex.value !== index) return;
      const found = find();
      if (found !== null) focus(found);
      else if (left > 1) retry(left - 1);
    });
  };
  retry(FOCUS_RETRY_FRAMES);
}

/** Discoverable keyboard affordances for the firing table. Presentational only. */
export function TriageKeyboardHints(): ReactElement {
  return createElement(
    "div",
    {
      role: "note",
      "aria-label": "Keyboard shortcuts",
      className: "flex flex-wrap items-center gap-3 text-sm text-muted-foreground",
    },
    createElement("span", { className: "inline-flex items-center gap-1" }, createElement(Kbd, null, "J"), " / ", createElement(Kbd, null, "K"), " move"),
    createElement("span", { className: "inline-flex items-center gap-1" }, createElement(Kbd, null, "Enter"), " open"),
    createElement("span", { className: "inline-flex items-center gap-1" }, createElement(Kbd, null, "Esc"), " close"),
  );
}
