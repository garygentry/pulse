// apps/web/tests/alerts-view-facets.test.ts — facets.ts predicate + <FacetBar> (FilterBar/FacetFilter).
// The FacetBar block is wrapped in describeDom (tests/dom.ts) so happy-dom is registered per file.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ActiveAlert, AlertsPayload } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { FACET_DEFS, matchesFacets } from "../src/client/views/alerts/facets.js";
import { facetValues, firingRows, UNGROUPED_FAMILY } from "../src/client/views/alerts/model.js";
import { FACET_KEYS, type FacetSelection } from "../src/client/views/alerts/url-state.js";
import { createAppStore } from "../src/client/store/index.js";
import type { PathRouter } from "../src/client/router.js";
import { describeDom } from "./dom.js";
import { installUiStubs } from "./rtl.js";
import {
  activeFilterChips,
  facetPopoverTrigger,
  facetToggles,
  facetToolbar,
  openFacetOptions,
} from "./alerts-dom-helpers.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload, makeHistoryPayload, withAck } from "./alerts-fixtures.js";

isolateDomGlobals();

const EMPTY: FacetSelection = {
  severity: [],
  state: [],
  group: [],
  hostService: [],
  ruleFamily: [],
  ack: [],
};

const payload: AlertsPayload = makeAlertsPayload({ scenario: "mixed" });

function byFp(fp: string): ActiveAlert {
  const a = firingRows(payload).find((x) => x.fingerprint === fp);
  if (a === undefined) throw new Error(`fixture alert ${fp} missing`);
  return a;
}

/** Fingerprints of the rows passing `sel`, in payload order. */
function passing(sel: FacetSelection): string[] {
  return firingRows(payload)
    .filter((a) => matchesFacets(payload, a, sel))
    .map((a) => a.fingerprint);
}

const F = FIXTURE_FINGERPRINTS;

describe("FACET_DEFS", () => {
  test("six defs (incl. ack, REQ-ACK-07c) in FACET_KEYS order with labels", () => {
    expect(FACET_DEFS.map((d) => d.key)).toEqual([...FACET_KEYS]);
    expect(FACET_DEFS.map((d) => d.label)).toEqual([
      "Severity",
      "State",
      "Group",
      "Host / Service",
      "Rule family",
      "Acknowledged",
    ]);
  });

  test("accessors read severity/state/group, hostServiceValue, and the rule-family join", () => {
    const get = (key: string, a: ActiveAlert): string | null =>
      FACET_DEFS.find((d) => d.key === key)!.valueOf(payload, a);
    const hostDown = byFp(F.hostDown);
    expect(get("severity", hostDown)).toBe("critical");
    expect(get("state", hostDown)).toBe("firing");
    expect(get("group", hostDown)).toBe("host-liveness");
    expect(get("hostService", hostDown)).toBe("host:web-01");
    expect(get("ruleFamily", hostDown)).toBe("host");
    const orphan = byFp(F.unattributed);
    expect(get("group", orphan)).toBeNull();
    expect(get("hostService", orphan)).toBeNull();
    expect(get("ruleFamily", orphan)).toBe(UNGROUPED_FAMILY);
  });
});

describe("matchesFacets", () => {
  test("empty selection passes every firing row (incl. silenced/inhibited)", () => {
    expect(passing(EMPTY)).toEqual(firingRows(payload).map((a) => a.fingerprint));
  });

  test("a single active facet is OR over its values", () => {
    expect(passing({ ...EMPTY, severity: ["critical"] })).toEqual([F.hostDown, F.unattributed]);
    expect(passing({ ...EMPTY, severity: ["critical", "info"] })).toEqual([
      F.hostDown,
      F.loadHigh,
      F.unattributed,
    ]);
    expect(passing({ ...EMPTY, state: ["silenced", "inhibited"] })).toEqual([F.backupAge, F.loadHigh]);
  });

  test("multiple active facets AND together", () => {
    expect(passing({ ...EMPTY, severity: ["critical"], hostService: ["host:web-01"] })).toEqual([
      F.hostDown,
    ]);
    expect(
      passing({ ...EMPTY, severity: ["warning", "info"], group: ["host-capacity"], state: ["firing"] }),
    ).toEqual([F.diskFull]);
    expect(passing({ ...EMPTY, severity: ["info"], state: ["firing"] })).toEqual([]);
  });

  test("a null accessor value never satisfies an active facet", () => {
    // unattributed has target null and group null; backupAge has group null.
    expect(passing({ ...EMPTY, hostService: ["null", ""] })).toEqual([]);
    expect(passing({ ...EMPTY, group: ["null", ""] })).toEqual([]);
    expect(passing({ ...EMPTY, severity: ["critical"], group: ["host-liveness"] })).toEqual([F.hostDown]);
  });

  test("an unknown selected value matches nothing and does not throw", () => {
    expect(passing({ ...EMPTY, ruleFamily: ["no-such-family"] })).toEqual([]);
    expect(passing({ ...EMPTY, ruleFamily: [UNGROUPED_FAMILY] })).toEqual([F.unattributed]);
  });
});

describe("module graph", () => {
  test("facets.ts imports url-state.ts type-only (no runtime cycle)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/client/views/alerts/facets.ts", import.meta.url)),
      "utf8",
    );
    const edges = src.split("\n").filter((l) => /from\s+"\.\/url-state\.js"/.test(l));
    expect(edges.length).toBeGreaterThan(0);
    for (const line of edges) expect(line).toMatch(/^import type /);
  });
});

describeDom("FacetBar", (dom) => {
  let restoreStubs: (() => void) | null = null;
  const live: (() => void)[] = [];
  beforeAll(() => {
    restoreStubs = installUiStubs();
  });
  afterAll(() => {
    restoreStubs?.();
  });
  afterEach(() => {
    while (live.length > 0) live.pop()!();
  });

  async function mountBar(
    selection: FacetSelection,
    onChange: (next: FacetSelection) => void,
    values = facetValues(payload),
    counts: { total: number; shown: number } = { total: 5, shown: 5 },
  ): Promise<HTMLElement> {
    const { createElement: h } = await import("react");
    const { FacetBar } = await import("../src/client/views/alerts/facet-bar.js");
    const { container, unmount } = await dom.mount(
      h(FacetBar, { values, selection, onChange, ...counts }) as unknown as ReactElement,
    );
    live.push(unmount);
    return container;
  }

  test("a labelled search landmark with one inline facet per non-empty facet, aria-pressed toggles", async () => {
    const container = await mountBar({ ...EMPTY, severity: ["warning"] }, () => {});
    expect(container.querySelector('[role="search"]')!.getAttribute("aria-label")).toBe("Alert filters");
    const titles = ["Severity", "State", "Group", "Host / Service", "Rule family", "Acknowledged"];
    for (const title of titles) expect(facetToolbar(container, title)).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="facet-filter"]')).toHaveLength(titles.length);
    const buttons = facetToggles(container, "Severity");
    expect(buttons.map((b) => b.textContent)).toEqual([...facetValues(payload).severity]);
    for (const b of buttons) expect(b.getAttribute("type")).toBe("button");
    const pressed = (label: string): string | null =>
      buttons.find((b) => b.textContent === label)!.getAttribute("aria-pressed");
    expect(pressed("warning")).toBe("true");
    expect(pressed("critical")).toBe("false");
  });

  test("omits the control for a facet with no values", async () => {
    const container = await mountBar(EMPTY, () => {}, { ...facetValues(payload), group: [] });
    expect(facetToolbar(container, "Group")).toBeNull();
    expect(container.querySelectorAll('[data-slot="facet-filter"]')).toHaveLength(5);
  });

  test("clicking a toggle emits ONE new full selection (add, then remove) without mutating the input", async () => {
    const emitted: FacetSelection[] = [];
    const selection: FacetSelection = { ...EMPTY, severity: ["warning"] };
    const container = await mountBar(selection, (next) => emitted.push(next));
    const btn = (label: string): HTMLButtonElement => facetToggles(container, "Severity").find((b) => b.textContent === label)!;

    btn("critical").click();
    expect(emitted).toEqual([{ ...EMPTY, severity: ["warning", "critical"] }]);
    btn("warning").click(); // the URL did not change (no re-render), so this removes from ["warning"]
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(EMPTY);
    expect(emitted[0]).not.toBe(selection);
    expect(selection.severity).toEqual(["warning"]);
    // Holds no selection state: the pressed toggles still mirror the props.
    expect(btn("warning").getAttribute("aria-pressed")).toBe("true");
    expect(btn("critical").getAttribute("aria-pressed")).toBe("false");
  });

  test("a facet with more than four options is a popover multi-select; each option toggles once", async () => {
    const values = { ...facetValues(payload), hostService: ["host:a", "host:b", "host:c", "host:d", "host:e"] };
    const emitted: FacetSelection[] = [];
    const container = await mountBar({ ...EMPTY, hostService: ["host:b"] }, (n) => emitted.push(n), values);
    expect(facetToolbar(container, "Host / Service")).toBeNull();
    const trigger = facetPopoverTrigger(container, "Host / Service")!;
    expect(trigger.textContent).toContain("1 selected");
    const options = await openFacetOptions(container, "Host / Service");
    expect(options.map((o) => o.textContent)).toEqual(["host:a", "host:b", "host:c", "host:d", "host:e"]);
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false", "false"]);
    expect(container.contains(options[0]!)).toBe(false); // portalled
    options[3]!.click();
    expect(emitted).toEqual([{ ...EMPTY, hostService: ["host:b", "host:d"] }]);
    const clear = trigger.ownerDocument.querySelector<HTMLElement>('[role="option"][data-value="__clear__"]')
      ?? [...trigger.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === "Clear Host / Service filter")!;
    clear.click();
    expect(emitted).toEqual([{ ...EMPTY, hostService: ["host:b", "host:d"] }, EMPTY]);
  });

  test("a selected value absent from the payload is still shown and removable (facet and chip)", async () => {
    const emitted: FacetSelection[] = [];
    const container = await mountBar({ ...EMPTY, group: ["ghost"] }, (n) => emitted.push(n));
    const ghost = facetToggles(container, "Group").find((b) => b.textContent === "ghost")!;
    expect(ghost.getAttribute("aria-pressed")).toBe("true");
    ghost.click();
    expect(emitted).toEqual([EMPTY]);
    const chip = activeFilterChips(container).find((b) => b.getAttribute("aria-label") === "Remove Group filter ghost")!;
    expect(chip.textContent).toContain("ghost");
    chip.click();
    expect(emitted).toEqual([EMPTY, EMPTY]);
  });

  test("ActiveFilters lists every active value; removing one or 'Clear all' emits one full selection", async () => {
    const emitted: FacetSelection[] = [];
    const selection: FacetSelection = { ...EMPTY, severity: ["critical", "warning"], ack: ["unacked"] };
    const container = await mountBar(selection, (n) => emitted.push(n), facetValues(payload), { total: 5, shown: 2 });
    const group = container.querySelector('[data-slot="active-filters"]')!;
    expect(group.getAttribute("role")).toBe("group");
    expect(activeFilterChips(container).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove Severity filter critical",
      "Remove Severity filter warning",
      "Remove Acknowledged filter Not acked",
    ]);
    activeFilterChips(container)[0]!.click();
    expect(emitted).toEqual([{ ...selection, severity: ["warning"] }]);
    const clearAll = [...group.querySelectorAll("button")].find((b) => b.textContent === "Clear all")!;
    clearAll.click();
    expect(emitted).toEqual([{ ...selection, severity: ["warning"] }, EMPTY]);
  });

  test("no active-filter chips without a selection", async () => {
    const container = await mountBar(EMPTY, () => {});
    expect(container.querySelector('[data-slot="active-filters"]')).toBeNull();
  });

  test("ResultCount shows shown of total firing alerts in a polite status region", async () => {
    const container = await mountBar({ ...EMPTY, severity: ["critical"] }, () => {}, facetValues(payload), {
      total: 5,
      shown: 2,
    });
    const count = container.querySelector('[data-slot="result-count"]')!;
    expect(count.getAttribute("role")).toBe("status");
    expect(count.getAttribute("aria-live")).toBe("polite");
    expect(count.textContent).toBe("Showing 2 of 5 firing alerts; 3 hidden by filters.");
  });
});

// ---------------------------------------------------------------------------
// Ack facet (09 §7.6, REQ-ACK-07c)
// ---------------------------------------------------------------------------

/** The mixed fixture with hostDown and backupAge (silenced) acknowledged. */
const acked: AlertsPayload = withAck(payload, [F.hostDown, F.backupAge]);

function passingAck(sel: FacetSelection): string[] {
  return firingRows(acked)
    .filter((a) => matchesFacets(acked, a, sel))
    .map((a) => a.fingerprint);
}

describe("ack facet filter (REQ-ACK-07c)", () => {
  test("the ack accessor yields 'acked' iff the alert carries ack (REQ-ACK-07c)", () => {
    const def = FACET_DEFS.find((d) => d.key === "ack")!;
    const get = (fp: string): string | null =>
      def.valueOf(acked, firingRows(acked).find((a) => a.fingerprint === fp)!);
    expect(get(F.hostDown)).toBe("acked");
    expect(get(F.backupAge)).toBe("acked");
    expect(get(F.diskFull)).toBe("unacked");
  });

  test("selecting 'acked' shows only acked alerts, 'unacked' only the rest (REQ-ACK-07c)", () => {
    expect(passingAck({ ...EMPTY, ack: ["acked"] })).toEqual([F.hostDown, F.backupAge]);
    expect(passingAck({ ...EMPTY, ack: ["unacked"] })).toEqual([F.diskFull, F.loadHigh, F.unattributed]);
    expect(passingAck({ ...EMPTY, ack: ["acked", "unacked"] })).toEqual(passingAck(EMPTY));
    expect(passingAck({ ...EMPTY, ack: ["acked"], severity: ["critical"] })).toEqual([F.hostDown]);
  });

  test("facetValues collects acked/unacked (REQ-ACK-07c)", () => {
    expect(facetValues(payload).ack).toEqual(["unacked"]);
    expect([...facetValues(acked).ack].sort()).toEqual(["acked", "unacked"]);
  });
});

describeDom("ack facet chips (REQ-ACK-07c)", (dom) => {
  let restoreStubs: (() => void) | null = null;
  beforeAll(() => {
    restoreStubs = installUiStubs();
  });
  afterAll(() => {
    restoreStubs?.();
  });
  const originalFetch = globalThis.fetch;
  const live: { unmount(): void; router: PathRouter }[] = [];

  afterEach(() => {
    for (const m of live.splice(0)) {
      m.unmount();
      m.router.stop();
    }
    globalThis.fetch = originalFetch;
  });

  function win(): Window {
    return (globalThis as unknown as { window: Window }).window;
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 10));
  }

  test("chips read 'Acked' / 'Not acked' while emitting acked|unacked (REQ-ACK-07c)", async () => {
    const { createElement: h } = await import("react");
    const { FacetBar } = await import("../src/client/views/alerts/facet-bar.js");
    const emitted: FacetSelection[] = [];
    const { container } = await dom.mount(
      h(FacetBar, {
        values: facetValues(acked),
        selection: EMPTY,
        onChange: (n: FacetSelection) => emitted.push(n),
        total: 5,
        shown: 5,
      }) as unknown as ReactElement,
    );
    const buttons = facetToggles(container, "Acknowledged");
    expect(buttons.map((b) => b.textContent).sort()).toEqual(["Acked", "Not acked"]);
    buttons.find((b) => b.textContent === "Acked")!.click();
    expect(emitted).toEqual([{ ...EMPTY, ack: ["acked"] }]);
  });

  test("deselecting the last ack chip removes ack= from the URL (REQ-ACK-07c)", async () => {
    globalThis.fetch = (() =>
      Promise.resolve({ json: () => Promise.resolve(makeHistoryPayload({ kind: "ready" })) })) as unknown as typeof fetch;
    const { createElement: h } = await import("react");
    const { createPathRouter } = await import("../src/client/router.js");
    const { default: AlertsView } = await import("../src/client/views/alerts/view.js");
    win().history.replaceState({}, "", "/alerts?ack=acked&kiosk=1");
    const router = createPathRouter({
      routes: [
        { pattern: "/alerts", view: "alerts" },
        { pattern: "/", view: "overview" },
      ],
      fallback: "/",
      win: win(),
    });
    const store = createAppStore({ storage: null, initialQuery: {} });
    store.alerts.value = acked;
    const { container, unmount } = await dom.mount(h(AlertsView, { store, router }) as unknown as ReactElement);
    live.push({ unmount, router });
    await flush();

    const rows = (): string[] =>
      [...container.querySelectorAll<HTMLElement>("[data-triage-table] [data-triage-open]")].map(
        (r) => r.getAttribute("data-triage-open")!,
      );
    expect(rows().sort()).toEqual([F.backupAge, F.hostDown].sort());

    const chip = facetToggles(container, "Acknowledged").find((b) => b.textContent === "Acked")!;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    chip.click();
    await flush();
    expect(router.current().query).toEqual({ kiosk: "1" });
    expect(rows()).toHaveLength(firingRows(acked).length);
  });
});
