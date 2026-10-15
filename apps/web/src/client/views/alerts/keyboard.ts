// src/client/views/alerts/keyboard.ts — j/k/Enter/Escape keyboard triage loop.
//
// `useTriageKeyboard` drives the cursor with `useListNavigation` (vim keys: j/k and ↑/↓ step,
// Home/End and gg/G jump) over EVERY firing row through its `virtual` option, so a move reaches
// rows the virtualized DataTable has not rendered: the cursor is the `selectedIndex` signal, and a
// row outside the window is scrolled in and focused on a later frame (`focusRow`). Moves no-op off
// the Firing tab (the catalog/silences tabs keep their own keys) and from inside a dialog (the
// detail Sheet). Enter and Escape stay on the shared a11y registry (document level, never
// preventDefault), so they coexist with native button activation and the Sheet's own Escape.
// TriageKeyboardHints lives here next to the handlers it documents; this is a .ts module, so the
// hint row is built with `createElement` rather than JSX.
import { createElement, useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { Signal } from "@preact/signals-core";

import { registerShortcut } from "../../a11y/index.js";
import { Kbd, useListNavigation } from "@/ui";
import type { ActiveAlert } from "@pulse/web-data/wire";

export interface TriageKeyboardOptions {
  /** Keyboard cursor into `rows()` — the shared signal TriageTable focuses. */
  readonly selectedIndex: Signal<number>;
  /** Live facet-filtered firing rows (getter — read at handler time, not install time). */
  readonly rows: () => readonly ActiveAlert[];
  /** The TriageTable container element (getter) for focus queries; null before mount. */
  readonly container: () => HTMLElement | null;
  /** Scroll row `index` into view — the triage DataTable handle's `scrollToIndex`, which renders a
   *  virtualized-out row first so it can be focused afterwards. When it returns a promise (the
   *  handle's settles once the row is in place), the row is focused then too, which a far jump
   *  (End, G) needs when the window takes longer than the frame retries to move. */
  readonly scrollToIndex: (index: number) => void | Promise<void>;
  /** True iff the Firing tab is active — gates the moves and Enter. */
  readonly isFiringTabActive: () => boolean;
  /** True iff the detail pane is open (`sel` present) — gates Escape. */
  readonly isPaneOpen: () => boolean;
  /** Open the alert (sets ?sel=…) — Enter. */
  readonly openAlert: (fingerprint: string) => void;
  /** Close the pane (clears ?sel) — Escape. */
  readonly closePane: () => void;
}

/** The row-open controls: one per rendered row, matched by fingerprint. */
const ROW_OPEN_SELECTOR = "[data-triage-open]";

/** The triage keyboard for the alerts page, installed for the component's lifetime. Options are
 *  getters read at key time, so data changes never re-install anything. */
export function useTriageKeyboard(opts: TriageKeyboardOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useListNavigation({
    keys: "vim",
    getItems: () => optsRef.current.container()?.querySelectorAll<HTMLElement>(ROW_OPEN_SELECTOR) ?? [],
    virtual: {
      // Zero items is "nothing to move over": the key is left alone.
      count: () => {
        const o = optsRef.current;
        return o.isFiringTabActive() && !focusInDialog(o.container()) ? o.rows().length : 0;
      },
      activeIndex: () => optsRef.current.selectedIndex.value,
      focus: (index) => {
        const o = optsRef.current;
        o.selectedIndex.value = index;
        focusRow(o, index);
      },
    },
    // Enter belongs to the registry handler below and to native activation of the focused control.
    onActivate: () => false,
  });

  useEffect(() => installTriageShortcuts(optsRef), []);
}

/** Register Enter/Escape; returns a disposer that removes both. */
function installTriageShortcuts(optsRef: { readonly current: TriageKeyboardOptions }): () => void {
  const disposers = [
    // Enter/Escape never preventDefault: the registry listens on `document`, so cancelling would
    // suppress native Enter activation of every button/link on the page (and the Sheet's own Escape).
    registerShortcut(
      "enter",
      (event) => {
        const opts = optsRef.current;
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
        const opts = optsRef.current;
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

/** True when focus is inside a dialog (the detail Sheet): list moves leave its keys alone. */
function focusInDialog(container: HTMLElement | null): boolean {
  const active = (container?.ownerDocument ?? globalThis.document)?.activeElement as { closest?: unknown } | null;
  return (
    active !== null &&
    active !== undefined &&
    typeof active.closest === "function" &&
    (active as Element).closest('[role="dialog"], [role="alertdialog"]') !== null
  );
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
      Array.from(container.querySelectorAll<HTMLElement>(ROW_OPEN_SELECTOR)).find(
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
  const settled = opts.scrollToIndex(index);
  if (settled !== undefined) {
    void settled.then(() => {
      if (opts.selectedIndex.value !== index) return; // the cursor moved on: that move owns focus
      const found = find();
      if (found !== null && found.ownerDocument.activeElement !== found) focus(found);
    });
  }
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
