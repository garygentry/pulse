// apps/web/tests/overview-kiosk-tiles.test.ts — the kiosk tile wall (GitHub #6): the flat
// worst-first order, the read-only KioskTile content and a11y contract (a labelled list, no focusable
// or interactive descendant, status as icon + text), the "i / P" indicator, the empty state, change
// markers and the "only changed tiles re-render" contract. Paging timing lives in
// overview-kiosk.test.ts; real layout in browser/overview-motion-layout.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import { act, render } from "./react-render.js";

import type { HostStatus, OverviewSnapshotV2 } from "@pulse/web-data/wire";
import { TARGET_STATUS } from "@/ui";
import { OVERVIEW_STATUS_ORDER, DEFAULT_OVERVIEW_PREFERENCES, type OverviewModel } from "../src/client/views/overview/model.js";
import { effectiveStatus } from "../src/client/views/overview/freshness.js";
import { STATUS_CHANGE_MARKER_WINDOW_MS, createChangeTracker } from "../src/client/views/overview/grid/change-marker.js";
import { NO_HOSTS_TITLE } from "../src/client/views/overview/grid/OverviewGrid.js";
import { setGridRenderObserver } from "../src/client/views/overview/grid/render-probe.js";
import { KioskOverviewGrid, type KioskOverviewGridProps } from "../src/client/views/overview/kiosk/KioskOverviewGrid.js";
import { KIOSK_TILE_CHIP_LIMIT } from "../src/client/views/overview/kiosk/KioskTile.js";
import type { KioskPagingClock } from "../src/client/views/overview/kiosk/useKioskPaging.js";
import { deriveKioskHosts, deriveOverviewModel } from "../src/client/views/overview/selectors.js";
import { FIXTURE_IDS } from "./fixtures/overview/expected.js";
import { makeEnvelopeOverviewSnapshot, makeOverviewSnapshot, withTargetStatus } from "./fixtures/overview/factory.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, renderWithStore } from "./dom.js";
import { within } from "./rtl.js";

isolateDomGlobals();

function modelOf(snapshot: OverviewSnapshotV2, previous?: OverviewModel): OverviewModel {
  return previous === undefined
    ? deriveOverviewModel(snapshot, DEFAULT_OVERVIEW_PREFERENCES)
    : deriveOverviewModel(snapshot, DEFAULT_OVERVIEW_PREFERENCES, previous);
}

function rank(host: HostStatus): number {
  return OVERVIEW_STATUS_ORDER.indexOf(effectiveStatus(host.rollupEvidence));
}

describe("deriveKioskHosts — one flat worst-first list", () => {
  test("every host once, worst effective status first, then class, then name, whatever the desk grouping", () => {
    const snapshot = makeEnvelopeOverviewSnapshot();
    for (const groupBy of ["class", "status", "name"] as const) {
      const model = deriveOverviewModel(snapshot, { ...DEFAULT_OVERVIEW_PREFERENCES, groupBy, sortBy: "name" });
      const hosts = deriveKioskHosts(model.groups);
      expect(hosts).toHaveLength(snapshot.hosts.length);
      expect(new Set(hosts.map((h) => h.drilldownId)).size).toBe(snapshot.hosts.length);
      for (let i = 1; i < hosts.length; i++) {
        const [a, b] = [hosts[i - 1]!, hosts[i]!];
        expect(rank(a) <= rank(b)).toBe(true);
        if (rank(a) === rank(b) && a.collectionClass === b.collectionClass) expect(a.name <= b.name).toBe(true);
      }
      expect(effectiveStatus(hosts[0]!.rollupEvidence)).toBe("critical");
    }
  });

  test("an unchanged order with the same host references returns the previous list itself", () => {
    const model = modelOf(makeOverviewSnapshot({ hostCount: 6 }));
    const first = deriveKioskHosts(model.groups);
    expect(deriveKioskHosts(model.groups, first)).toBe(first);
    const reordered = deriveKioskHosts([...model.groups].reverse(), first);
    expect(reordered).toBe(first);
  });
});

/** Injected paging clock that never fires on its own. */
function inertClock(): KioskPagingClock {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => undefined };
}

interface MountedKiosk {
  readonly container: HTMLElement;
  rerender(next: Partial<KioskOverviewGridProps>): void;
  unmount(): void;
}

describeDom("kiosk tile wall", () => {
  const mounted: MountedKiosk[] = [];
  afterEach(() => {
    for (const m of mounted.splice(0)) m.unmount();
  });

  async function mountKiosk(model: OverviewModel, overrides: Partial<KioskOverviewGridProps> = {}): Promise<MountedKiosk> {
    let props: KioskOverviewGridProps = {
      model,
      changeTracker: createChangeTracker(),
      reducedMotion: false,
      rotation: null,
      clock: inertClock(),
      ...overrides,
    };
    let result!: Awaited<ReturnType<typeof renderWithStore>>;
    await act(async () => {
      result = await renderWithStore(createElement(KioskOverviewGrid, props) as unknown as ReactElement);
    });
    const m: MountedKiosk = {
      container: result.container,
      rerender(next) {
        props = { ...props, ...next };
        act(() => {
          render(createElement(KioskOverviewGrid, props), result.container);
        });
      },
      unmount: () => result.unmount(),
    };
    mounted.push(m);
    return m;
  }

  test("a labelled list of read-only tiles: no grid role, no button, no tab stop", async () => {
    // happy-dom lays nothing out, so measured capacity falls back to one tile per page.
    const snapshot = makeOverviewSnapshot({ hostCount: 3 });
    const m = await mountKiosk(modelOf(snapshot));
    const q = within(m.container);
    const list = q.getByRole("list", { name: "Overview hosts, page 1 of 3" });
    expect(q.getAllByRole("listitem")).toHaveLength(1);
    expect(q.queryByRole("grid")).toBeNull();
    expect(q.queryAllByRole("button")).toHaveLength(0);
    expect(m.container.querySelectorAll("[tabindex], button, a, input, [data-overview-target]").length).toBe(0);
    expect(list.closest('[data-slot="overview-kiosk-page"]')).not.toBeNull();

    // The worst host leads.
    const tile = list.querySelector<HTMLElement>('[data-slot="overview-kiosk-tile"]')!;
    expect(tile.dataset["targetId"]).toBe(FIXTURE_IDS.criticalHost);

    // The "i / P" indicator: visible text, accessible name "Page i of P", never focusable.
    const indicator = q.getByRole("note", { name: "Page 1 of 3" });
    expect(indicator.textContent).toBe("1 / 3");
    expect(indicator.getAttribute("data-slot")).toBe("overview-kiosk-indicator");
  });

  test("a tile shows name, class, status and alert count as icon + text, one worst non-OK chip, +N more and N OK", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 4 });
    const model = modelOf(snapshot);
    const m = await mountKiosk(model);
    const tile = m.container.querySelector<HTMLElement>('[data-slot="overview-kiosk-tile"]')!;
    const host = snapshot.hosts.find((h) => h.drilldownId === tile.dataset["targetId"])!;
    const status = effectiveStatus(host.rollupEvidence);
    expect(tile.dataset["status"]).toBe(status);
    expect(tile.querySelector('[data-slot="overview-host-name"]')!.textContent).toBe(host.name);
    expect(tile.querySelector('[data-slot="overview-kiosk-class"]')!.textContent).toBe(host.collectionClass);

    // Every status/severity badge carries an icon and a text label.
    const badges = Array.from(tile.querySelectorAll<HTMLElement>('[data-slot="status-badge"]'));
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.querySelector("svg")).not.toBeNull();
      expect((badge.textContent ?? "").trim()).not.toBe("");
    }
    const statusBadge = tile.querySelector<HTMLElement>(`[data-slot="status-badge"][data-status="${status}"]`)!;
    expect(statusBadge.textContent).toContain(status === "critical" ? "Critical" : "");

    const alertBadge = tile.querySelector<HTMLElement>("[data-alert-count]");
    if (host.activeAlerts.length > 0) {
      expect(alertBadge!.dataset["alertCount"]).toBe(String(host.activeAlerts.length));
      expect(alertBadge!.textContent!.replace(/\s+/g, " ")).toContain("firing");
    }

    const statuses = host.services.map((s) => effectiveStatus(s.statusEvidence));
    const flagged = statuses.filter((s) => s !== "ok").length;
    const ok = statuses.length - flagged;
    const chips = Array.from(tile.querySelectorAll<HTMLElement>('[data-slot="overview-kiosk-chip"]'));
    expect(chips).toHaveLength(Math.min(flagged, KIOSK_TILE_CHIP_LIMIT));
    const worst = Math.min(...statuses.filter((s) => s !== "ok").map((s) => OVERVIEW_STATUS_ORDER.indexOf(s)));
    expect(OVERVIEW_STATUS_ORDER.indexOf(chips[0]!.dataset["status"] as never)).toBe(worst);
    // The chip's status word is its own text element, apart from the (truncatable) service name.
    const chipStatus = chips[0]!.dataset["status"] as keyof typeof TARGET_STATUS;
    const chipService = host.services.find((svc) => svc.drilldownId === chips[0]!.dataset["targetId"])!;
    const word = within(chips[0]!).getByText(TARGET_STATUS[chipStatus].label, { exact: true });
    const name = within(chips[0]!).getByText(chipService.name, { exact: true });
    expect(word).not.toBe(name);
    expect(word.contains(name) || name.contains(word)).toBe(false);
    const more = tile.querySelector('[data-slot="overview-kiosk-more"]');
    if (flagged > KIOSK_TILE_CHIP_LIMIT) expect(more!.textContent).toBe(`+${flagged - KIOSK_TILE_CHIP_LIMIT} more`);
    else expect(more).toBeNull();
    const okLine = tile.querySelector('[data-slot="overview-kiosk-ok"]');
    if (ok > 0) expect(okLine!.textContent).toBe(`${ok} OK`);
    else expect(okLine).toBeNull();
  });

  test("a single page shows no indicator and an unpaged list name", async () => {
    const m = await mountKiosk(modelOf(makeOverviewSnapshot({ hostCount: 1 })));
    expect(within(m.container).getByRole("list", { name: "Overview hosts" })).not.toBeNull();
    expect(m.container.querySelector('[data-slot="overview-kiosk-indicator"]')).toBeNull();
  });

  test("zero hosts render the shared EmptyState", async () => {
    const m = await mountKiosk(modelOf(makeOverviewSnapshot({ hostCount: 0 })));
    expect(m.container.querySelector('[data-slot="overview-grid-empty"] [data-slot="empty-state"]')!.textContent).toContain(NO_HOSTS_TITLE);
    expect(m.container.querySelector('[role="list"]')).toBeNull();
  });

  describe("render isolation and change markers", () => {
    let realSet: typeof setTimeout;
    let realClear: typeof clearTimeout;
    let queue: Map<number, { readonly fn: () => void; readonly ms: number }>;
    beforeEach(() => {
      realSet = globalThis.setTimeout;
      realClear = globalThis.clearTimeout;
      queue = new Map();
      let id = 0;
      globalThis.setTimeout = ((fn: () => void, ms = 0) => {
        queue.set(++id, { fn, ms });
        return id;
      }) as unknown as typeof setTimeout;
      globalThis.clearTimeout = ((handle: number) => queue.delete(handle)) as unknown as typeof clearTimeout;
    });
    afterEach(() => {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    });

    test("a no-op commit re-renders no tile; one service change re-renders only its host's tile", async () => {
      // Capacity is one tile per page in happy-dom; the critical host (worst first) is on page 1.
      const snapshot = makeOverviewSnapshot({ hostCount: 8 });
      const model = modelOf(snapshot);
      const m = await mountKiosk(model);
      const renders = new Map<string, number>();
      const previous = setGridRenderObserver((kind, id) => {
        if (kind === "tile") renders.set(id, (renders.get(id) ?? 0) + 1);
      });
      try {
        const same = modelOf(structuredClone(snapshot), model);
        expect(same).toBe(model);
        m.rerender({ model: same });
        expect(renders.size).toBe(0);

        // A service on the visible critical host turns warning: its rollup stays critical, so the
        // order holds and only that tile re-renders.
        const changedId = FIXTURE_IDS.suppressedService;
        const next = modelOf(withTargetStatus(snapshot, changedId, "warning", 2), model);
        m.rerender({ model: next });
        expect([...renders.keys()]).toEqual([FIXTURE_IDS.criticalHost]);
        expect(renders.get(FIXTURE_IDS.criticalHost)).toBe(1);
      } finally {
        setGridRenderObserver(previous);
      }
    });

    for (const reducedMotion of [false, true]) {
      test(`a host status change marks its tile (${reducedMotion ? "static 'Changed' text under reduced motion" : "animated"})`, async () => {
        // One all-OK host: its first service turning warning turns the host rollup warning.
        const snapshot = makeOverviewSnapshot({ hostCount: 1 });
        const model = modelOf(snapshot);
        const m = await mountKiosk(model, { reducedMotion });
        expect(m.container.querySelectorAll("[data-changed]").length).toBe(0);
        m.rerender({ model: modelOf(withTargetStatus(snapshot, FIXTURE_IDS.okService, "warning", 2), model) });
        const marked = Array.from(m.container.querySelectorAll<HTMLElement>("[data-changed]"));
        expect(marked.map((el) => el.dataset["targetId"])).toEqual([FIXTURE_IDS.okHost]);
        expect(marked[0]!.dataset["changed"]).toBe(reducedMotion ? "static" : "animated");
        expect(marked[0]!.dataset["status"]).toBe("warning");
        const text = m.container.querySelector('[data-slot="overview-target-changed"]');
        if (reducedMotion) expect(text!.textContent).toBe("Changed");
        else expect(text).toBeNull();

        // The marker clears after its bounded window.
        expect([...queue.values()].some((timer) => timer.ms === STATUS_CHANGE_MARKER_WINDOW_MS)).toBe(true);
        act(() => {
          for (const [handle, timer] of [...queue]) {
            queue.delete(handle);
            timer.fn();
          }
        });
        expect(m.container.querySelectorAll("[data-changed]").length).toBe(0);
      });
    }
  });
});
