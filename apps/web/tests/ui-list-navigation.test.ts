// apps/web/tests/ui-list-navigation.test.ts — ported from deck's `ui-list-navigation` suite (vendored `@/ui`).
import { describe, expect, it } from "bun:test";
import {
  isHandledIntent,
  nearestSurvivor,
  nextGPending,
  nextListIndex,
  resolveListIntent,
  type ListNavConfig,
  type ListNavContext,
  type ListNavIntent,
  type ListNavKeyEvent,
} from "@/ui";

// The legacy per-feature keyboard modules re-expressed against the one shared
// resolver. Each feature is one config:
//   portal      vim + grid, search, Escape, Enter-from-search opens the first card
//   inventory   vim, search, Escape, Enter-from-search opens the first row
//   drift       vim, search, Escape
//   monitoring  vim only (no search field, no Escape)
//   sources     arrows + expandable tree, search, Escape
// Legacy intent names map onto the shared ones:
//   focus-filter → focus-search; clear-search / clear-filter / clear-search-or-scope → clear;
//   open-focused / activate-focused → activate; open-first → activate-first;
//   portal move-up / move-down → move-previous / move-next;
//   sources toggle-expand → collapse (←) / expand (→) / toggle (Space).

const PORTAL: ListNavConfig = {
  keys: "vim",
  grid: true,
  search: true,
  escape: true,
  activateFirstFromSearch: true,
};
const INVENTORY: ListNavConfig = {
  keys: "vim",
  search: true,
  escape: true,
  activateFirstFromSearch: true,
};
const DRIFT: ListNavConfig = { keys: "vim", search: true, escape: true };
const MONITORING: ListNavConfig = { keys: "vim" };
const SOURCES: ListNavConfig = { keys: "arrows", search: true, escape: true, expandable: true };

function key(k: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}): ListNavKeyEvent {
  return { key: k, ctrlKey: mods.ctrl ?? false, metaKey: mods.meta ?? false, altKey: mods.alt ?? false };
}

const IDLE: ListNavContext = { origin: "list", gPending: false };
const SEARCHING: ListNavContext = { origin: "search", gPending: false };
const G_PENDING: ListNavContext = { origin: "list", gPending: true };
const EDITING: ListNavContext = { origin: "editable", gPending: false };

const ALL_INTENTS: readonly ListNavIntent[] = [
  "focus-search",
  "clear",
  "move-previous",
  "move-next",
  "move-left",
  "move-right",
  "move-first",
  "move-last",
  "g-prefix",
  "activate",
  "activate-first",
  "toggle",
  "expand",
  "collapse",
  "none",
];

/** Drive a key sequence through resolver + gg latch + index stepper, like the hook does. */
function run(config: ListNavConfig, keys: readonly string[], count: number, columns = 1): number {
  let index = -1;
  let gPending = false;
  for (const k of keys) {
    const intent = resolveListIntent(key(k), config, { origin: "list", gPending });
    gPending = nextGPending(intent);
    index = nextListIndex(index, intent, count, columns);
  }
  return index;
}

// ---------------------------------------------------------------------------
// sources-docs-and-configs (sources-keyboard.test.ts)
// ---------------------------------------------------------------------------

describe("ported: sources tree/search keys (arrows preset)", () => {
  it("maps each navigation key to its intent", () => {
    expect(resolveListIntent(key("/"), SOURCES)).toBe("focus-search");
    expect(resolveListIntent(key("Escape"), SOURCES)).toBe("clear");
    expect(resolveListIntent(key("ArrowUp"), SOURCES)).toBe("move-previous");
    expect(resolveListIntent(key("ArrowDown"), SOURCES)).toBe("move-next");
    expect(resolveListIntent(key("ArrowLeft"), SOURCES)).toBe("collapse");
    expect(resolveListIntent(key("ArrowRight"), SOURCES)).toBe("expand");
    expect(resolveListIntent(key("Enter"), SOURCES)).toBe("activate");
  });

  it("maps the vim/edge navigation aliases", () => {
    expect(resolveListIntent(key("j"), SOURCES)).toBe("move-next");
    expect(resolveListIntent(key("k"), SOURCES)).toBe("move-previous");
    expect(resolveListIntent(key("Home"), SOURCES)).toBe("move-first");
    expect(resolveListIntent(key("End"), SOURCES)).toBe("move-last");
    expect(resolveListIntent(key(" "), SOURCES)).toBe("toggle");
  });

  it("maps Ctrl/Cmd-K to focus-search but leaves other modifier chords to the browser", () => {
    expect(resolveListIntent(key("k", { ctrl: true }), SOURCES)).toBe("focus-search");
    expect(resolveListIntent(key("K", { meta: true }), SOURCES)).toBe("focus-search");
    expect(resolveListIntent(key("/", { ctrl: true }), SOURCES)).toBe("none");
    expect(resolveListIntent(key("Enter", { meta: true }), SOURCES)).toBe("none");
    expect(resolveListIntent(key("ArrowDown", { ctrl: true }), SOURCES)).toBe("none");
    expect(resolveListIntent(key("Escape", { ctrl: true }), SOURCES)).toBe("none");
  });

  it("returns none for unhandled keys", () => {
    for (const k of ["a", "Tab", "F1", "1", "Backspace", "Delete", "PageUp", "Shift"]) {
      expect(resolveListIntent(key(k), SOURCES)).toBe("none");
    }
  });

  it("claims every handled intent and never none", () => {
    for (const intent of ALL_INTENTS) expect(isHandledIntent(intent)).toBe(intent !== "none");
  });
});

// ---------------------------------------------------------------------------
// alerts-and-health (alerts-keyboard.test.ts)
// ---------------------------------------------------------------------------

describe("ported: monitoring keys (vim, no search)", () => {
  const cases: ReadonlyArray<[string, ListNavIntent]> = [
    ["j", "move-next"],
    ["ArrowDown", "move-next"],
    ["k", "move-previous"],
    ["ArrowUp", "move-previous"],
    ["Home", "move-first"],
    ["End", "move-last"],
    ["G", "move-last"],
    ["g", "g-prefix"],
    ["Enter", "activate"],
    ["x", "none"],
  ];
  for (const [k, intent] of cases) {
    it(`maps "${k}" → ${intent}`, () => {
      expect(resolveListIntent(key(k), MONITORING)).toBe(intent);
    });
  }

  it("yields none for any ctrl/meta chord so native shortcuts are never hijacked", () => {
    expect(resolveListIntent(key("j", { ctrl: true }), MONITORING)).toBe("none");
    expect(resolveListIntent(key("j", { meta: true }), MONITORING)).toBe("none");
    expect(resolveListIntent(key("Enter", { meta: true }), MONITORING)).toBe("none");
    // No search field on the page: Ctrl/Cmd-K, "/" and Escape stay unclaimed too.
    expect(resolveListIntent(key("k", { ctrl: true }), MONITORING)).toBe("none");
    expect(resolveListIntent(key("/"), MONITORING)).toBe("none");
    expect(resolveListIntent(key("Escape"), MONITORING)).toBe("none");
  });

  it("claims every handled intent and not none", () => {
    for (const intent of [
      "move-previous",
      "move-next",
      "move-first",
      "move-last",
      "g-prefix",
      "activate",
    ] as const) {
      expect(isHandledIntent(intent)).toBe(true);
    }
    expect(isHandledIntent("none")).toBe(false);
  });

  it("move-first / move-last land on the ends", () => {
    expect(nextListIndex(-1, "move-first", 3)).toBe(0);
    expect(nextListIndex(-1, "move-last", 3)).toBe(2);
  });

  it("the first move from no focus lands on the first item", () => {
    expect(nextListIndex(-1, "move-next", 3)).toBe(0);
    expect(nextListIndex(-1, "move-previous", 3)).toBe(0);
  });

  it("move-next / move-previous step and clamp at the bounds", () => {
    expect(nextListIndex(1, "move-next", 3)).toBe(2);
    expect(nextListIndex(1, "move-previous", 3)).toBe(0);
    expect(nextListIndex(2, "move-next", 3)).toBe(2);
    expect(nextListIndex(0, "move-previous", 3)).toBe(0);
  });

  it("g latches, then a second g jumps to the first item and clears the chord", () => {
    const first = resolveListIntent(key("g"), MONITORING, IDLE);
    expect(first).toBe("g-prefix");
    expect(nextGPending(first)).toBe(true);
    expect(nextListIndex(2, first, 3)).toBe(2); // no move yet
    const second = resolveListIntent(key("g"), MONITORING, G_PENDING);
    expect(second).toBe("move-first");
    expect(nextListIndex(2, second, 3)).toBe(0);
    expect(nextGPending(second)).toBe(false);
  });

  it("a non-g key while pending clears the chord", () => {
    expect(nextGPending(resolveListIntent(key("x"), MONITORING, G_PENDING))).toBe(false);
  });

  it("lands nowhere when the list is empty", () => {
    expect(nextListIndex(-1, "move-first", 0)).toBe(-1);
    expect(nextListIndex(-1, "move-last", 0)).toBe(-1);
  });

  it("keeps a focused id that survives a list change", () => {
    expect(nearestSurvivor(["a", "b", "c"], "b", ["a", "b", "c"])).toBe("b");
  });

  it("drops focus when the focused id was never in the list", () => {
    expect(nearestSurvivor(["a", "b"], "gone", ["a", "b"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// drift-and-coverage (drift-keyboard.test.tsx, keyboard sections)
// ---------------------------------------------------------------------------

describe("ported: drift keys (vim, search, Escape)", () => {
  const expectations: ReadonlyArray<[ListNavKeyEvent, ListNavIntent]> = [
    [key("/"), "focus-search"],
    [key("k", { ctrl: true }), "focus-search"],
    [key("k", { meta: true }), "focus-search"],
    [key("K", { meta: true }), "focus-search"],
    [key("Escape"), "clear"],
    [key("ArrowDown"), "move-next"],
    [key("j"), "move-next"],
    [key("ArrowUp"), "move-previous"],
    [key("k"), "move-previous"],
    [key("Home"), "move-first"],
    [key("End"), "move-last"],
    [key("G"), "move-last"],
    [key("g"), "g-prefix"],
    [key("Enter"), "activate"],
    [key("x"), "none"],
    [key("a", { ctrl: true }), "none"],
    [key("j", { meta: true }), "none"],
  ];
  for (const [event, intent] of expectations) {
    it(`maps ${JSON.stringify(event)} to ${intent}`, () => {
      expect(resolveListIntent(event, DRIFT)).toBe(intent);
    });
  }

  it("claims every handled intent but not none", () => {
    expect(isHandledIntent("none")).toBe(false);
    for (const intent of ALL_INTENTS.filter((i) => i !== "none")) {
      expect(isHandledIntent(intent)).toBe(true);
    }
  });

  it("leaves Tab and other unclaimed keys (including Space) unhandled", () => {
    for (const k of ["Tab", "PageDown", "PageUp", "Backspace", "1", " "]) {
      expect(resolveListIntent(key(k), DRIFT)).toBe("none");
    }
  });

  it("only claims Ctrl/Cmd-K among modifier chords", () => {
    expect(resolveListIntent(key("k", { ctrl: true }), DRIFT)).toBe("focus-search");
    expect(resolveListIntent(key("K", { ctrl: true }), DRIFT)).toBe("focus-search");
    expect(resolveListIntent(key("Enter", { ctrl: true }), DRIFT)).toBe("none");
    expect(resolveListIntent(key("g", { meta: true }), DRIFT)).toBe("none");
  });

  it("lets Escape through from the search field but nothing else", () => {
    expect(resolveListIntent(key("Escape"), DRIFT, SEARCHING)).toBe("clear");
    expect(resolveListIntent(key("Enter"), DRIFT, SEARCHING)).toBe("none");
    expect(resolveListIntent(key("j"), DRIFT, SEARCHING)).toBe("none");
  });

  describe("nearest surviving result", () => {
    const previous = ["r-1", "r-2", "r-3", "r-4"];

    it("keeps focus when the focused id survives", () => {
      expect(nearestSurvivor(["r-1", "r-2", "r-3"], "r-2", ["r-1", "r-2", "r-3"])).toBe("r-2");
      expect(nearestSurvivor(previous, "r-3", ["r-1", "r-3", "r-4"])).toBe("r-3");
    });

    it("chooses the nearest following row when the focused id is removed", () => {
      expect(nearestSurvivor(previous, "r-2", ["r-1", "r-3", "r-4"])).toBe("r-3");
    });

    it("falls back to the final preceding row when the tail is removed", () => {
      expect(nearestSurvivor(previous, "r-4", ["r-1", "r-2"])).toBe("r-2");
    });

    it("returns null when no rows remain", () => {
      expect(nearestSurvivor(previous, "r-2", [])).toBeNull();
      expect(nearestSurvivor(["r-1"], "r-1", [])).toBeNull();
    });

    it("returns null when the focused id was not previously visible, or nothing was focused", () => {
      expect(nearestSurvivor(previous, "unknown", ["r-1"])).toBeNull();
      expect(nearestSurvivor(previous, null, ["r-1"])).toBeNull();
      expect(nearestSurvivor<string>([], null, [])).toBeNull();
    });

    it("keeps the focused id when the list is unchanged", () => {
      expect(nearestSurvivor(previous, "r-2", previous)).toBe("r-2");
    });
  });
});

// ---------------------------------------------------------------------------
// hosts-and-services (inventory-keyboard.test.tsx, pure sections)
// ---------------------------------------------------------------------------

describe("ported: inventory table keys (vim, search, Enter-from-search)", () => {
  it("maps Ctrl/Cmd-K to focus-search from any state and ignores other modified keys", () => {
    expect(resolveListIntent(key("k", { ctrl: true }), INVENTORY, IDLE)).toBe("focus-search");
    expect(resolveListIntent(key("K", { meta: true }), INVENTORY, SEARCHING)).toBe("focus-search");
    expect(resolveListIntent(key("k", { meta: true }), INVENTORY, IDLE)).toBe("focus-search");
    expect(resolveListIntent(key("a", { ctrl: true }), INVENTORY, IDLE)).toBe("none");
    expect(resolveListIntent(key("s", { meta: true }), INVENTORY, IDLE)).toBe("none");
  });

  it("routes search-field keys so text entry keeps working", () => {
    expect(resolveListIntent(key("Escape"), INVENTORY, SEARCHING)).toBe("clear");
    expect(resolveListIntent(key("Enter"), INVENTORY, SEARCHING)).toBe("activate-first");
    for (const k of ["a", "j", "k", "/", "g", "G", "ArrowDown", "Home", "End"]) {
      expect(resolveListIntent(key(k), INVENTORY, SEARCHING)).toBe("none");
    }
  });

  it("maps table navigation keys when the search field is not focused", () => {
    expect(resolveListIntent(key("/"), INVENTORY)).toBe("focus-search");
    expect(resolveListIntent(key("ArrowUp"), INVENTORY)).toBe("move-previous");
    expect(resolveListIntent(key("k"), INVENTORY)).toBe("move-previous");
    expect(resolveListIntent(key("ArrowDown"), INVENTORY)).toBe("move-next");
    expect(resolveListIntent(key("j"), INVENTORY)).toBe("move-next");
    expect(resolveListIntent(key("Home"), INVENTORY)).toBe("move-first");
    expect(resolveListIntent(key("End"), INVENTORY)).toBe("move-last");
    expect(resolveListIntent(key("G"), INVENTORY)).toBe("move-last");
    expect(resolveListIntent(key("Enter"), INVENTORY)).toBe("activate");
    expect(resolveListIntent(key("x"), INVENTORY)).toBe("none");
  });

  it("implements the gg prefix", () => {
    expect(resolveListIntent(key("g"), INVENTORY, IDLE)).toBe("g-prefix");
    expect(resolveListIntent(key("g"), INVENTORY, G_PENDING)).toBe("move-first");
  });

  it("focuses index 0 on the first movement from -1", () => {
    expect(nextListIndex(-1, "move-next", 5)).toBe(0);
    expect(nextListIndex(-1, "move-previous", 5)).toBe(0);
    expect(nextListIndex(-1, "move-first", 5)).toBe(0);
    expect(nextListIndex(-1, "move-last", 5)).toBe(4);
  });

  it("clamps movement without wrapping", () => {
    expect(nextListIndex(0, "move-previous", 5)).toBe(0);
    expect(nextListIndex(4, "move-next", 5)).toBe(4);
    expect(nextListIndex(2, "move-next", 5)).toBe(3);
    expect(nextListIndex(2, "move-previous", 5)).toBe(1);
  });

  it("returns -1 for every movement over an empty set", () => {
    for (const intent of ["move-next", "move-previous", "move-first", "move-last"] as const) {
      expect(nextListIndex(-1, intent, 0)).toBe(-1);
    }
  });

  it("sets the g chord and every other intent clears it", () => {
    expect(nextGPending("g-prefix")).toBe(true);
    for (const intent of ALL_INTENTS.filter((i) => i !== "g-prefix")) {
      expect(nextGPending(intent)).toBe(false);
    }
  });

  it("leaves the index unchanged for activation, search and none intents", () => {
    for (const intent of ["activate", "activate-first", "focus-search", "clear", "none"] as const) {
      expect(nextListIndex(2, intent, 5)).toBe(2);
    }
  });

  it("treats a negative count as empty", () => {
    expect(nextListIndex(-1, "move-next", -3)).toBe(-1);
  });

  it("drops focus when no rows remain, and keeps a surviving row", () => {
    expect(nearestSurvivor(["a", "b", "c", "d", "e"], "e", [])).toBeNull();
    expect(nearestSurvivor(["a", "b", "c", "d", "e"], "c", ["a", "b", "c", "d", "e"])).toBe("c");
  });

  it("moves focus to the surviving row when filtering removes the focused one", () => {
    // Hosts list: charlie focused, filter leaves only alpha → alpha.
    expect(nearestSurvivor(["alpha", "bravo", "charlie"], "charlie", ["alpha"])).toBe("alpha");
  });

  it("claims every handled intent except none", () => {
    for (const intent of [
      "focus-search",
      "move-previous",
      "move-next",
      "move-first",
      "move-last",
      "g-prefix",
      "activate",
      "activate-first",
      "clear",
    ] as const) {
      expect(isHandledIntent(intent)).toBe(true);
    }
    expect(isHandledIntent("none")).toBe(false);
  });

  it("walks arrows, j/k, Home, End and gg/G end to end", () => {
    expect(run(INVENTORY, ["ArrowDown"], 3)).toBe(0);
    expect(run(INVENTORY, ["ArrowDown", "j"], 3)).toBe(1);
    expect(run(INVENTORY, ["ArrowDown", "j", "ArrowUp"], 3)).toBe(0);
    expect(run(INVENTORY, ["End"], 3)).toBe(2);
    expect(run(INVENTORY, ["End", "Home"], 3)).toBe(0);
    expect(run(INVENTORY, ["G"], 3)).toBe(2);
    expect(run(INVENTORY, ["G", "g", "g"], 3)).toBe(0);
    expect(run(INVENTORY, ["G", "g", "x", "g"], 3)).toBe(2); // chord broken by x
  });
});

// ---------------------------------------------------------------------------
// portal (portal/keyboard.ts; its keys are exercised by portal-page.test.tsx)
// ---------------------------------------------------------------------------

describe("ported: portal card grid (vim + grid)", () => {
  it("maps h/l and ←/→ to movement within a row", () => {
    expect(resolveListIntent(key("h"), PORTAL)).toBe("move-left");
    expect(resolveListIntent(key("ArrowLeft"), PORTAL)).toBe("move-left");
    expect(resolveListIntent(key("l"), PORTAL)).toBe("move-right");
    expect(resolveListIntent(key("ArrowRight"), PORTAL)).toBe("move-right");
    expect(resolveListIntent(key("ArrowUp"), PORTAL)).toBe("move-previous");
    expect(resolveListIntent(key("ArrowDown"), PORTAL)).toBe("move-next");
  });

  it("moves left/right linearly and clamps at the ends", () => {
    expect(nextListIndex(3, "move-left", 7, 3)).toBe(2);
    expect(nextListIndex(2, "move-right", 7, 3)).toBe(3);
    expect(nextListIndex(0, "move-left", 7, 3)).toBe(0);
    expect(nextListIndex(6, "move-right", 7, 3)).toBe(6);
    expect(nextListIndex(-1, "move-right", 7, 3)).toBe(0);
  });

  it("moves up/down by a whole row and stays put rather than leave the grid", () => {
    expect(nextListIndex(1, "move-next", 7, 3)).toBe(4);
    expect(nextListIndex(4, "move-previous", 7, 3)).toBe(1);
    expect(nextListIndex(4, "move-next", 7, 3)).toBe(4); // 7 is past the end
    expect(nextListIndex(1, "move-previous", 7, 3)).toBe(1);
    expect(nextListIndex(-1, "move-next", 7, 3)).toBe(0);
  });

  it("keeps vim h/l out of a list without a grid", () => {
    expect(resolveListIntent(key("h"), INVENTORY)).toBe("none");
    expect(resolveListIntent(key("l"), INVENTORY)).toBe("none");
    expect(resolveListIntent(key("ArrowLeft"), INVENTORY)).toBe("none");
  });

  it("routes search keys: Escape clears, Enter opens the first card, typing stays in the field", () => {
    expect(resolveListIntent(key("Escape"), PORTAL, SEARCHING)).toBe("clear");
    expect(resolveListIntent(key("Enter"), PORTAL, SEARCHING)).toBe("activate-first");
    expect(resolveListIntent(key("h"), PORTAL, SEARCHING)).toBe("none");
    expect(resolveListIntent(key("k", { ctrl: true }), PORTAL, SEARCHING)).toBe("focus-search");
  });

  it("walks Home, ↓, j, ↑, k like the mounted portal test (one column)", () => {
    expect(run(PORTAL, ["Home"], 5)).toBe(0);
    expect(run(PORTAL, ["Home", "ArrowDown"], 5)).toBe(1);
    expect(run(PORTAL, ["Home", "ArrowDown", "j"], 5)).toBe(2);
    expect(run(PORTAL, ["Home", "ArrowDown", "j", "ArrowUp"], 5)).toBe(1);
    expect(run(PORTAL, ["Home", "ArrowDown", "j", "ArrowUp", "k"], 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shared contract beyond the legacy suites.
// ---------------------------------------------------------------------------

describe("shared guards", () => {
  it("ignores every key from an editable control other than the search field", () => {
    for (const config of [PORTAL, INVENTORY, DRIFT, MONITORING, SOURCES]) {
      for (const k of ["j", "ArrowDown", "Enter", "Escape", " ", "/", "g", "Home"]) {
        expect(resolveListIntent(key(k), config, EDITING)).toBe("none");
      }
      expect(resolveListIntent(key("k", { ctrl: true }), config, EDITING)).toBe("none");
    }
  });

  it("passes Alt chords through", () => {
    expect(resolveListIntent(key("j", { alt: true }), DRIFT)).toBe("none");
    expect(resolveListIntent(key("ArrowDown", { alt: true }), SOURCES)).toBe("none");
  });

  it("arrows preset: Space activates when nothing expands; g/G are not claimed", () => {
    const list: ListNavConfig = { keys: "arrows" };
    expect(resolveListIntent(key(" "), list)).toBe("activate");
    expect(resolveListIntent(key("ArrowRight"), list)).toBe("none");
    expect(resolveListIntent(key("g"), list)).toBe("none");
    expect(resolveListIntent(key("G"), list)).toBe("none");
  });
});
