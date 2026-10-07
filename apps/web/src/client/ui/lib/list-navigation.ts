/**
 * Pure keyboard grammar for list, table, grid and tree navigation. Nothing here
 * touches the DOM: `useListNavigation` works out where a key came from (the
 * `origin`), asks `resolveListIntent` what it means, and applies the result
 * with `nextListIndex`.
 *
 * Presets:
 * - `"vim"`: ↑/↓ and j/k step, Home/End, `G` = last, `gg` = first, Enter
 *   activates. Space is left to the browser.
 * - `"arrows"`: ↑/↓ and j/k step, Home/End, Enter activates. Space toggles an
 *   expandable item (or activates when nothing expands), and ←/→ collapse and
 *   expand tree items. `g`/`G` are left to the browser.
 *
 * With `grid`, ←/→ (plus h/l under `"vim"`) move within a row, and ↑/↓ move by
 * a whole row.
 *
 * Modifier passthrough: Alt chords, and any Ctrl/Cmd chord other than Ctrl/Cmd-K
 * (and that one only when a search field exists), resolve to `"none"`, so native
 * shortcuts are never hijacked. Keys typed into an editable control other than
 * the list's own search field always resolve to `"none"`.
 */

export type ListNavPreset = "vim" | "arrows";

/** Where the keystroke came from, classified by the hook. */
export type ListNavOrigin =
  /** A list item, or a non-editable element (body, a heading, a plain link). */
  | "list"
  /** The list's own search/filter field. */
  | "search"
  /** Any other editable or form control (input, select, textarea, button, contenteditable). */
  | "editable";

export type ListNavIntent =
  | "focus-search"
  | "clear"
  | "move-previous"
  | "move-next"
  | "move-left"
  | "move-right"
  | "move-first"
  | "move-last"
  | "g-prefix"
  | "activate"
  | "activate-first"
  | "toggle"
  | "expand"
  | "collapse"
  | "none";

/** The keyboard-event fields the resolver reads. A real `KeyboardEvent` fits. */
export interface ListNavKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey?: boolean;
}

export interface ListNavConfig {
  readonly keys: ListNavPreset;
  /** 2-D navigation: ←/→ (and h/l for vim) move within a row. */
  readonly grid?: boolean;
  /** A search field exists: `/` and Ctrl/Cmd-K focus it. */
  readonly search?: boolean;
  /** Escape is handled (clear the filter, the search text or the scope). */
  readonly escape?: boolean;
  /** Enter in the search field activates the first item. */
  readonly activateFirstFromSearch?: boolean;
  /** Items expand and collapse (a tree): ←/→ and Space are claimed under `"arrows"`. */
  readonly expandable?: boolean;
}

export interface ListNavContext {
  readonly origin: ListNavOrigin;
  /** The first `g` of a `gg` chord has been pressed. */
  readonly gPending: boolean;
}

const LIST_CONTEXT: ListNavContext = { origin: "list", gPending: false };

/** Map one keystroke to an intent. Pure. */
export function resolveListIntent(
  event: ListNavKeyEvent,
  config: ListNavConfig,
  context: ListNavContext = LIST_CONTEXT,
): ListNavIntent {
  if (context.origin === "editable") return "none";
  if (event.altKey === true) return "none";
  if (event.ctrlKey || event.metaKey) {
    return config.search === true && (event.key === "k" || event.key === "K")
      ? "focus-search"
      : "none";
  }

  if (context.origin === "search") {
    if (event.key === "Escape") return config.escape === true ? "clear" : "none";
    if (event.key === "Enter") {
      return config.activateFirstFromSearch === true ? "activate-first" : "none";
    }
    // Everything else is text entry and belongs to the field.
    return "none";
  }

  const vim = config.keys === "vim";
  const grid = config.grid === true;
  const tree = !vim && !grid && config.expandable === true;

  switch (event.key) {
    case "/":
      return config.search === true ? "focus-search" : "none";
    case "Escape":
      return config.escape === true ? "clear" : "none";
    case "ArrowDown":
    case "j":
      return "move-next";
    case "ArrowUp":
    case "k":
      return "move-previous";
    case "Home":
      return "move-first";
    case "End":
      return "move-last";
    case "Enter":
      return "activate";
    case "ArrowLeft":
      return grid ? "move-left" : tree ? "collapse" : "none";
    case "ArrowRight":
      return grid ? "move-right" : tree ? "expand" : "none";
    case "h":
      return vim && grid ? "move-left" : "none";
    case "l":
      return vim && grid ? "move-right" : "none";
    case "G":
      return vim ? "move-last" : "none";
    case "g":
      if (!vim) return "none";
      return context.gPending ? "move-first" : "g-prefix";
    case " ":
      if (vim) return "none";
      return config.expandable === true ? "toggle" : "activate";
    default:
      return "none";
  }
}

/** True when an intent claims the key (the caller should `preventDefault`). */
export function isHandledIntent(intent: ListNavIntent): boolean {
  return intent !== "none";
}

/** Whether the `gg` chord is armed after this intent. Every other intent disarms it. */
export function nextGPending(intent: ListNavIntent): boolean {
  return intent === "g-prefix";
}

/**
 * The item index to focus after a movement intent, or the unchanged index for
 * any other intent. `index` is -1 when no item has focus; `count` is the number
 * of items; `columns` is the grid width (1 for a list).
 *
 * - Nothing to focus in an empty list: -1.
 * - The first move from -1 lands on 0.
 * - Linear moves clamp at the ends; they never wrap.
 * - A row move (↑/↓ with `columns > 1`) that would leave the grid stays put.
 */
export function nextListIndex(
  index: number,
  intent: ListNavIntent,
  count: number,
  columns = 1,
): number {
  const n = Math.max(0, Math.floor(count));
  const cols = Math.max(1, Math.floor(columns));
  const isMove =
    intent === "move-first" ||
    intent === "move-last" ||
    intent === "move-next" ||
    intent === "move-previous" ||
    intent === "move-left" ||
    intent === "move-right";
  if (!isMove) return index;
  if (n === 0) return -1;

  switch (intent) {
    case "move-first":
      return 0;
    case "move-last":
      return n - 1;
    default:
      break;
  }
  if (index < 0) return 0;
  const from = Math.min(index, n - 1);

  switch (intent) {
    case "move-left":
      return Math.max(from - 1, 0);
    case "move-right":
      return Math.min(from + 1, n - 1);
    // A step past either end stays put: for a list (cols 1) that is the clamp.
    case "move-previous":
      return from - cols < 0 ? from : from - cols;
    default:
      return from + cols >= n ? from : from + cols;
  }
}

/**
 * Which item keeps focus after the list changes:
 * 1. the focused id, if it survives;
 * 2. else the item now at its old position, clamped to the new length (the
 *    nearest following item, or the last one);
 * 3. null when nothing remains or the id was not in the old list.
 */
export function nearestSurvivor<T>(
  previous: readonly T[],
  focused: T | null,
  next: readonly T[],
): T | null {
  if (focused !== null && next.includes(focused)) return focused;
  if (next.length === 0 || focused === null) return null;
  const previousIndex = previous.indexOf(focused);
  if (previousIndex === -1) return null;
  return next[Math.min(previousIndex, next.length - 1)] ?? null;
}
