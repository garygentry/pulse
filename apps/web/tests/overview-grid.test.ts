// apps/web/tests/overview-grid.test.ts — grouped overview grid, host cells, service chips and the
// kiosk page wrapper (03 §§3–6, 8; 06 §7; 08 §4.2). Every case renders through describeDom +
// renderWithStore over the deterministic overview fixture factory and the real selectors.
//
// happy-dom does not synthesize a native button click for Enter/Space, so `pressNative` emulates the
// browser: it dispatches the keydown and, only when nothing consumed it, performs the single click
// the browser would. A second (non-native) activation handler would therefore show up as an extra
// selection.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { render } from "./react-render.js";
import type { ReactElement } from "react";
import { act } from "./react-render.js";

import type { DataAvailability, HostStatus, OverviewSnapshotV2, ServiceStatus, TargetStatus } from "@pulse/web-data/wire";
import { cellLabel, serviceLabel } from "../src/client/a11y/index.js";
import { TARGET_STATUS } from "@/ui";
import { effectiveStatus } from "../src/client/views/overview/freshness.js";
import { STATUS_CHANGE_MARKER_WINDOW_MS, createChangeTracker } from "../src/client/views/overview/grid/change-marker.js";
import { lastGoodText } from "../src/client/views/overview/grid/HostCell.js";
import {
  KioskOverviewGrid,
  NO_HOSTS_TITLE,
  OverviewGrid,
  type OverviewGridProps,
} from "../src/client/views/overview/grid/OverviewGrid.js";
import type { KioskPagingClock } from "../src/client/views/overview/kiosk/useKioskPaging.js";
import { DEFAULT_OVERVIEW_PREFERENCES, type OverviewModel } from "../src/client/views/overview/model.js";
import { deriveOverviewModel } from "../src/client/views/overview/selectors.js";
import { FIXTURE_IDS } from "./fixtures/overview/expected.js";
import { FIXTURE_ESTATE, makeOverviewSnapshot, withTargetStatus } from "./fixtures/overview/factory.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, renderWithStore } from "./dom.js";
import { setGridRenderObserver } from "../src/client/views/overview/grid/render-probe.js";

// Restore globalThis once this file finishes so a later non-DOM suite (store.test.ts) never sees
// the closed happy-dom window (readdir order puts this file early).
isolateDomGlobals();

const TARGETS = "[data-overview-target]";
const STALE_AT = "2026-09-01T11:40:00.000Z";

function modelOf(snapshot: OverviewSnapshotV2, previous?: OverviewModel): OverviewModel {
  return previous === undefined
    ? deriveOverviewModel(snapshot, DEFAULT_OVERVIEW_PREFERENCES)
    : deriveOverviewModel(snapshot, DEFAULT_OVERVIEW_PREFERENCES, previous);
}

function stale(source: DataAvailability["source"], lastGoodAt: string | null, message: string | null = null): DataAvailability {
  return { state: "stale", source, lastGoodAt, message };
}

interface Mounted {
  readonly container: HTMLElement;
  readonly selected: string[];
  readonly toggled: string[];
  rerender(next: Partial<OverviewGridProps>): void;
  unmount(): void;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
});

async function mountGrid(model: OverviewModel, overrides: Partial<OverviewGridProps> = {}): Promise<Mounted> {
  const selected: string[] = [];
  const toggled: string[] = [];
  let props: OverviewGridProps = {
    model,
    estateName: FIXTURE_ESTATE.name,
    collapsedGroupIds: new Set<string>(),
    selectedTargetId: null,
    wallboard: false,
    changeTracker: createChangeTracker(),
    reducedMotion: false,
    onToggleGroup: (id) => toggled.push(id),
    onSelect: (id) => selected.push(id),
    ...overrides,
  };
  let result!: Awaited<ReturnType<typeof renderWithStore>>;
  await act(async () => {
    result = await renderWithStore(createElement(OverviewGrid, props) as unknown as ReactElement);
  });
  const m: Mounted = {
    container: result.container,
    selected,
    toggled,
    rerender(next) {
      props = { ...props, ...next };
      act(() => {
        render(createElement(OverviewGrid, props), result.container);
      });
    },
    unmount: () => result.unmount(),
  };
  mounted.push(m);
  return m;
}

function targets(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(TARGETS));
}

function target(root: ParentNode, id: string): HTMLButtonElement {
  const el = root.querySelector<HTMLButtonElement>(`${TARGETS}[data-target-id="${id}"]`);
  if (el === null) throw new Error(`no target ${id}`);
  return el;
}

function allHosts(snapshot: OverviewSnapshotV2): readonly HostStatus[] {
  return snapshot.hosts;
}

function allServices(snapshot: OverviewSnapshotV2): readonly ServiceStatus[] {
  return snapshot.hosts.flatMap((host) => host.services);
}

/** Dispatch a key like a browser would on a native button (see header). */
function pressNative(button: HTMLElement, key: "Enter" | " "): void {
  const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  button.dispatchEvent(down);
  if (!down.defaultPrevented) button.click();
}

describeDom("overview grid", () => {
describe("OverviewGrid — grouped semantic grid", () => {
  test("renders one labelled grid with a rowgroup, visible heading and expanded toggle per group", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 8 });
    const model = modelOf(snapshot);
    const { container } = await mountGrid(model);

    const grids = container.querySelectorAll('[role="grid"]');
    expect(grids.length).toBe(1);
    expect(grids[0]!.getAttribute("aria-label")).toContain(FIXTURE_ESTATE.name);

    const groups = Array.from(container.querySelectorAll<HTMLElement>('[role="rowgroup"]'));
    expect(groups.map((g) => g.dataset["groupId"])).toEqual(model.groups.map((g) => g.id));
    expect(model.groups.length).toBeGreaterThan(1);

    groups.forEach((group, i) => {
      const heading = group.querySelector('[role="columnheader"] h2');
      expect(heading).not.toBeNull();
      expect(heading!.textContent).toContain(model.groups[i]!.label);
      expect(group.getAttribute("aria-labelledby")).toBe(heading!.id);
      const toggle = heading!.querySelector("button")!;
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const controlled = container.querySelector(`[id="${toggle.getAttribute("aria-controls")}"]`)!;
      expect(controlled).not.toBeNull();
      // Every host of the group renders as one row inside the controlled region, in model order.
      const rows = Array.from(controlled.querySelectorAll<HTMLElement>('[role="row"][data-slot="overview-host"]'));
      expect(rows.map((r) => r.dataset["targetId"])).toEqual(model.groups[i]!.hosts.map((host) => host.drilldownId));
    });
    // The collapse control is not a roving target.
    expect(container.querySelectorAll(`[data-group-toggle]${TARGETS}`).length).toBe(0);
  });

  test("a collapsed group exposes aria-expanded=false, hides its hosts and toggles by id", async () => {
    const model = modelOf(makeOverviewSnapshot({ hostCount: 8 }));
    const first = model.groups[0]!;
    const m = await mountGrid(model, { collapsedGroupIds: new Set([first.id]) });

    const group = m.container.querySelector<HTMLElement>(`[role="rowgroup"][data-group-id="${first.id}"]`)!;
    const toggle = group.querySelector<HTMLButtonElement>("[data-group-toggle]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const region = m.container.querySelector<HTMLElement>(`[id="${toggle.getAttribute("aria-controls")}"]`)!;
    expect(region.hidden).toBe(true);
    expect(targets(region).length).toBe(0);
    for (const host of first.hosts) {
      expect(m.container.querySelector(`${TARGETS}[data-target-id="${host.drilldownId}"]`)).toBeNull();
    }

    toggle.click();
    expect(m.toggled).toEqual([first.id]);
    expect(m.selected).toEqual([]);

    m.rerender({ collapsedGroupIds: new Set() });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(target(m.container, first.hosts[0]!.drilldownId)).toBeDefined();
  });

  test("exactly one target trigger is the roving tab stop", async () => {
    const { container } = await mountGrid(modelOf(makeOverviewSnapshot({ hostCount: 6 })));
    const stops = targets(container).filter((el) => el.tabIndex === 0);
    expect(stops.length).toBe(1);
    expect(targets(container).filter((el) => el.getAttribute("tabindex") === "-1").length).toBe(targets(container).length - 1);
  });

  test("zero hosts render the shared EmptyState and no grid", async () => {
    const { container } = await mountGrid(modelOf(makeOverviewSnapshot({ hostCount: 0 })));
    const empty = container.querySelector('[data-slot="overview-grid-empty"] [data-slot="empty-state"]');
    expect(empty).not.toBeNull();
    expect(empty!.getAttribute("role")).toBe("status");
    expect(empty!.textContent).toContain(NO_HOSTS_TITLE);
    expect(container.querySelector('[role="grid"]')).toBeNull();
    expect(targets(container).length).toBe(0);
  });
});

describe("HostCell / ServiceChip — content and status semantics", () => {
  test("host trigger content is limited to name, rollup, liveness and alert count", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 5 });
    const { container } = await mountGrid(modelOf(snapshot));
    // Each trigger child is exactly one of the allowed parts, identified by its data hook.
    const allowed = [
      '[data-slot="overview-host-name"]',
      '[data-slot="status-badge"][data-status]',
      "[data-live]",
      "[data-alert-count]",
      '[data-slot="overview-target-evidence"]',
      '[data-slot="overview-target-changed"]',
    ];

    for (const host of allHosts(snapshot)) {
      const trigger = target(container, host.drilldownId);
      for (const child of Array.from(trigger.children)) {
        const known = allowed.filter((selector) => child.matches(selector));
        expect(known.length).toBe(1);
      }
      expect(trigger.querySelector('[data-slot="overview-host-name"]')!.textContent).toBe(host.name);
      const status = effectiveStatus(host.rollupEvidence);
      expect(trigger.querySelector(`[data-slot="status-badge"][data-status="${status}"]`)!.textContent).toBe(TARGET_STATUS[status].label);
      const live = trigger.querySelector("[data-live]")!.textContent;
      expect(live).toBe(host.live === null ? "Liveness unknown" : host.live ? "Live" : "Not live");
      const badge = trigger.querySelector("[data-alert-count]");
      if (host.activeAlerts.length === 0) expect(badge).toBeNull();
      else expect(badge!.textContent).toContain(String(host.activeAlerts.length));

      // The card holds only the host trigger and (optionally) the chip collection.
      const card = trigger.parentElement!;
      const extra = Array.from(card.children).filter((c) => c !== trigger && !c.matches('[data-slot="overview-host-services"]'));
      expect(extra).toEqual([]);
    }
  });

  test("the alert-count badge takes its tone from the most severe alert; info-only never colours", async () => {
    const base = makeOverviewSnapshot({ hostCount: 3 });
    const sample = allHosts(base).flatMap((host) => host.activeAlerts)[0] ?? base.alerts[0];
    expect(sample).toBeDefined();
    const severities = [["info"], ["info", "warning"], ["warning", "critical", "info"]] as const;
    const expected = ["info", "warning", "critical"] as const;
    const hosts = base.hosts.map((host, i) => ({
      ...host,
      activeAlerts: (severities[i] ?? []).map((severity, j) => ({ ...sample!, fingerprint: `${host.drilldownId}-${j}`, severity })),
    }));
    const { container } = await mountGrid(modelOf({ ...base, hosts }));
    hosts.forEach((host, i) => {
      const badge = target(container, host.drilldownId).querySelector("[data-alert-count]")!;
      expect(badge.getAttribute("data-severity")).toBe(expected[i]!);
      // Only critical/warning use a status badge (tone + icon); info is a plain outline badge.
      expect(badge.matches('[data-slot="status-badge"]')).toBe(expected[i] !== "info");
      expect(badge.textContent).toContain(String(host.activeAlerts.length));
    });
  });

  test("no deep-health, backup age, command signal, check or sparkline leaks into the grid", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 5 });
    const { container } = await mountGrid(modelOf(snapshot));
    const text = container.textContent ?? "";
    for (const signal of snapshot.signals) expect(text).not.toContain(signal.label);
    for (const check of snapshot.recentChecks) expect(text).not.toContain(check.endpoint);
    for (const word of ["backup", "Backup", "deep", "Deep", "command"]) expect(text).not.toContain(word);
    // Status badge icons are the only SVG: no sparkline or chart.
    expect(container.querySelectorAll('svg:not([data-slot="icon"]), canvas, [data-sparkline]').length).toBe(0);
  });

  test("every host/service surface carries effective data-status, the shared icon and a shared-helper label (all five statuses)", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 5 });
    const { container } = await mountGrid(modelOf(snapshot));
    const seen = new Set<TargetStatus>();
    // The TARGET_STATUS badge: its tone, an icon and the status word.
    const expectBadge = (el: HTMLElement, status: TargetStatus): void => {
      const badge = el.querySelector(`[data-slot="status-badge"][data-status="${status}"]`)!;
      expect(badge.getAttribute("data-tone")).toBe(TARGET_STATUS[status].tone);
      expect(badge.querySelector('svg[data-slot="icon"]')).not.toBeNull();
      expect(badge.textContent).toBe(TARGET_STATUS[status].label);
    };

    for (const host of allHosts(snapshot)) {
      const status = effectiveStatus(host.rollupEvidence);
      seen.add(status);
      const trigger = target(container, host.drilldownId);
      expect(trigger.tagName).toBe("BUTTON");
      expect(trigger.getAttribute("role")).toBe("gridcell");
      expect(trigger.dataset["status"]).toBe(status);
      expectBadge(trigger, status);
      expect(trigger.getAttribute("aria-label")!.startsWith(cellLabel({ ...host, rollup: status }))).toBe(true);
    }
    for (const service of allServices(snapshot)) {
      const status = effectiveStatus(service.statusEvidence);
      seen.add(status);
      const chip = target(container, service.drilldownId);
      expect(chip.tagName).toBe("BUTTON");
      expect(chip.getAttribute("role")).toBe("gridcell");
      expect(chip.dataset["status"]).toBe(status);
      expectBadge(chip, status);
      expect(chip.getAttribute("aria-label")!.startsWith(serviceLabel({ ...service, status }))).toBe(true);
      expect(chip.querySelector('[data-slot="overview-chip-name"]')!.textContent).toBe(service.name);
    }
    expect([...seen].sort()).toEqual(["critical", "ok", "suppressed", "unknown", "warning"]);
  });

  test("grid modules keep no local status-label map", async () => {
    const dir = new URL("../src/client/views/overview/grid/", import.meta.url);
    for (const file of ["OverviewGrid.tsx", "HostCell.tsx", "ServiceChip.tsx", "evidence.ts", "target-classes.ts"]) {
      const source = await Bun.file(new URL(file, dir)).text();
      expect(source).not.toMatch(/["']?critical["']?\s*:\s*["']/);
      expect(source).not.toMatch(/STATUS_GLYPH/);
      expect(source).not.toMatch(/["']OK["']|["']Warning["']|["']Suppressed["']/);
    }
  });

  test("a host without services omits the chip collection but stays selectable", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 3, zeroServiceHosts: 1 });
    const hostOnly = snapshot.hosts.find((host) => host.services.length === 0)!;
    const m = await mountGrid(modelOf(snapshot));
    const trigger = target(m.container, hostOnly.drilldownId);
    expect(trigger.parentElement!.querySelector('[data-slot="overview-host-services"]')).toBeNull();
    const withServices = snapshot.hosts.find((host) => host.services.length > 0)!;
    expect(target(m.container, withServices.drilldownId).parentElement!.querySelector('[data-slot="overview-host-services"]')).not.toBeNull();
    trigger.click();
    expect(m.selected).toEqual([hostOnly.drilldownId]);
  });
});

describe("status evidence — unknown vs suppressed and target-local degradation", () => {
  test("unknown and suppressed are distinct; unknown exposes last-good, suppressed keeps its rationale", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 5 });
    const { container } = await mountGrid(modelOf(snapshot));
    const unknown = target(container, FIXTURE_IDS.unknownHost);
    const suppressed = target(container, FIXTURE_IDS.suppressedHost);

    expect(unknown.dataset["status"]).toBe("unknown");
    expect(suppressed.dataset["status"]).toBe("suppressed");
    const glyph = (el: Element): string => el.querySelector('[data-slot="status-badge"] svg[data-slot="icon"]')!.innerHTML;
    expect(glyph(unknown)).not.toBe(glyph(suppressed));

    const host = snapshot.hosts.find((h) => h.drilldownId === FIXTURE_IDS.unknownHost)!;
    const expected = lastGoodText(host.rollupEvidence.availability);
    expect(unknown.querySelector('[data-slot="overview-target-evidence"]')!.textContent).toBe(expected);
    expect(unknown.getAttribute("aria-label")).toContain(expected);

    expect(suppressed.querySelector('[data-slot="overview-target-evidence"]')).toBeNull();
    expect(suppressed.getAttribute("aria-label")).toContain("deliberately suppressed");
  });

  test("stale evidence renders unknown with the exact target lastGoodAt; null renders 'No successful observation'", async () => {
    const snapshot = makeOverviewSnapshot({
      hostCount: 4,
      targetAvailability: {
        [FIXTURE_IDS.okService]: stale("victoriametrics-targets", STALE_AT, "scrape timed out"),
        [FIXTURE_IDS.okServiceNoBoard]: stale("victoriametrics-targets", null),
      },
    });
    const { container } = await mountGrid(modelOf(snapshot));

    const withLastGood = target(container, FIXTURE_IDS.okService);
    expect(withLastGood.dataset["status"]).toBe("unknown");
    const evidence = withLastGood.querySelector('[data-slot="overview-target-evidence"]')!;
    expect(evidence.textContent).toContain(`Last good observation: ${STALE_AT}`);
    // The source message follows the bounded text and is plain text, never HTML.
    expect(evidence.textContent).toContain("scrape timed out");
    expect(withLastGood.getAttribute("aria-label")).toContain(`Last good observation: ${STALE_AT}`);

    const never = target(container, FIXTURE_IDS.okServiceNoBoard);
    expect(never.dataset["status"]).toBe("unknown");
    expect(never.querySelector('[data-slot="overview-target-evidence"]')!.textContent).toBe("No successful observation");
  });

  test("one stale source degrades only its governed targets; everything else keeps its true status, undimmed", async () => {
    const base = makeOverviewSnapshot({ hostCount: 8 });
    const degraded = makeOverviewSnapshot({
      hostCount: 8,
      targetAvailability: { [FIXTURE_IDS.okService]: stale("victoriametrics-targets", STALE_AT) },
    });
    const baseline = await mountGrid(modelOf(base));
    const before = new Map(targets(baseline.container).map((el) => [el.dataset["targetId"]!, el.dataset["status"]!]));
    baseline.unmount();

    const { container } = await mountGrid(modelOf(degraded));
    // The degraded service and the host whose rollup evidence it governs are the only unknowns.
    const owningHost = degraded.hosts.find((h) => h.services.some((s) => s.drilldownId === FIXTURE_IDS.okService))!;
    const governed = new Set([FIXTURE_IDS.okService, owningHost.drilldownId]);
    for (const el of targets(container)) {
      const id = el.dataset["targetId"]!;
      if (governed.has(id)) expect(el.dataset["status"]).toBe("unknown");
      else expect(el.dataset["status"]).toBe(before.get(id)!);
      expect(el.disabled).toBe(false);
    }
    expect(before.get(FIXTURE_IDS.okService)).toBe("ok");

    // No blanket dimmer, overlay, busy or inert state on the grid or any group.
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('[role="grid"], [role="rowgroup"], [data-layout]'))) {
      expect(el.className).not.toMatch(/dim|overlay|loading|degraded|stale/);
      expect(el.hasAttribute("aria-busy")).toBe(false);
      expect(el.hasAttribute("inert")).toBe(false);
      expect(el.getAttribute("style") ?? "").not.toContain("opacity");
    }
    expect(container.querySelectorAll('[class*="overlay"], [class*="dim"]').length).toBe(0);
  });
});

describe("selection — exact canonical id, suppressed in wallboard/kiosk", () => {
  test("click, Enter and Space select the exact drilldownId once each", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 4 });
    const m = await mountGrid(modelOf(snapshot));
    const hostId = FIXTURE_IDS.warningHost;
    const serviceId = FIXTURE_IDS.okService;

    target(m.container, hostId).click();
    expect(m.selected).toEqual([hostId]);

    pressNative(target(m.container, serviceId), "Enter");
    expect(m.selected).toEqual([hostId, serviceId]);

    pressNative(target(m.container, hostId), " ");
    expect(m.selected).toEqual([hostId, serviceId, hostId]);

    // Same-named services on other hosts are distinct canonical targets.
    const sibling = snapshot.hosts[1]!.services.find((s) => s.name === "api")!;
    target(m.container, sibling.drilldownId).click();
    expect(m.selected.at(-1)).toBe(sibling.drilldownId);
    expect(sibling.drilldownId).not.toBe(serviceId);

    // Pointer selection moves the roving tab stop to the chosen trigger.
    expect(target(m.container, sibling.drilldownId).tabIndex).toBe(0);
  });

  test("arrow keys move focus but never select", async () => {
    const m = await mountGrid(modelOf(makeOverviewSnapshot({ hostCount: 4 })));
    const first = targets(m.container)[0]!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(m.selected).toEqual([]);
  });

  test("aria-selected marks exactly the selected canonical target", async () => {
    const m = await mountGrid(modelOf(makeOverviewSnapshot({ hostCount: 4 })), { selectedTargetId: FIXTURE_IDS.okService });
    const marked = targets(m.container).filter((el) => el.getAttribute("aria-selected") === "true");
    expect(marked.map((el) => el.dataset["targetId"])).toEqual([FIXTURE_IDS.okService]);
    m.rerender({ selectedTargetId: FIXTURE_IDS.okHost });
    const next = targets(m.container).filter((el) => el.getAttribute("aria-selected") === "true");
    expect(next.map((el) => el.dataset["targetId"])).toEqual([FIXTURE_IDS.okHost]);
  });

  test("wallboard suppresses click/Enter/Space selection", async () => {
    const m = await mountGrid(modelOf(makeOverviewSnapshot({ hostCount: 4 })), { wallboard: true });
    target(m.container, FIXTURE_IDS.okHost).click();
    pressNative(target(m.container, FIXTURE_IDS.okService), "Enter");
    pressNative(target(m.container, FIXTURE_IDS.okService), " ");
    expect(m.selected).toEqual([]);
  });
});

/** Injected paging clock that never fires on its own. */
function inertClock(): KioskPagingClock {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => undefined };
}

async function mountKiosk(model: OverviewModel, selected: string[]): Promise<HTMLElement> {
  let result!: Awaited<ReturnType<typeof renderWithStore>>;
  await act(async () => {
    result = await renderWithStore(
      createElement(KioskOverviewGrid, {
        model,
        estateName: FIXTURE_ESTATE.name,
        collapsedGroupIds: new Set<string>(),
        selectedTargetId: null,
        wallboard: true,
        changeTracker: createChangeTracker(),
        reducedMotion: true,
        onToggleGroup: () => undefined,
        onSelect: (id: string) => selected.push(id),
        rotation: null,
        clock: inertClock(),
      }) as unknown as ReactElement,
    );
  });
  mounted.push({ container: result.container, selected, toggled: [], rerender: () => undefined, unmount: () => result.unmount() });
  return result.container;
}

describe("KioskOverviewGrid / KioskPageView", () => {
  test("renders the active page with repeated headings and a 'i / P' indicator named 'Page i of P'", async () => {
    // happy-dom lays nothing out, so measured capacity falls back to one host per page.
    const snapshot = makeOverviewSnapshot({ hostCount: 3 });
    const model = modelOf(snapshot);
    const selected: string[] = [];
    const container = await mountKiosk(model, selected);

    const page = container.querySelector<HTMLElement>('[data-slot="overview-kiosk-page"]')!;
    expect(page).not.toBeNull();
    const grid = page.querySelector('[role="grid"]')!;
    expect(grid.getAttribute("aria-label")).toBe("Overview hosts, page 1 of 3");
    const indicator = page.querySelector('[data-slot="overview-kiosk-indicator"]')!;
    expect(indicator.textContent).toBe("1 / 3");
    expect(indicator.getAttribute("aria-label")).toBe("Page 1 of 3");
    expect(indicator.querySelectorAll("button, a, [tabindex]").length).toBe(0);

    // The page's group segment is headed and labelled by that heading.
    const segment = grid.querySelector<HTMLElement>('[role="rowgroup"]')!;
    const heading = segment.querySelector("h2")!;
    expect(segment.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.textContent).toBe(model.groups[0]!.label);
    expect(targets(grid)[0]!.dataset["targetId"]).toBe(model.groups[0]!.hosts[0]!.drilldownId);

    // Kiosk never selects.
    targets(grid)[0]!.click();
    expect(selected).toEqual([]);

    // The measurement probe is hidden, inert and outside the roving grid.
    const probe = container.querySelector<HTMLElement>('[data-slot="overview-kiosk-probe"]')!;
    expect(probe.getAttribute("aria-hidden")).toBe("true");
    expect(probe.hasAttribute("inert")).toBe(true);
    expect(grid.contains(probe)).toBe(false);
  });

  test("a single page shows no indicator", async () => {
    const container = await mountKiosk(modelOf(makeOverviewSnapshot({ hostCount: 1 })), []);
    expect(container.querySelector('[data-slot="overview-kiosk-page"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="overview-kiosk-indicator"]')).toBeNull();
  });

  test("zero hosts render the shared EmptyState in kiosk too", async () => {
    const container = await mountKiosk(modelOf(makeOverviewSnapshot({ hostCount: 0 })), []);
    expect(container.querySelector('[data-slot="overview-grid-empty"] [data-slot="empty-state"]')!.textContent).toContain(NO_HOSTS_TITLE);
    expect(container.querySelector('[role="grid"]')).toBeNull();
  });
});

/** Count renders of the grid's inner target components through the grid render observer. */
function countRenders(): { readonly hosts: Map<string, number>; readonly services: Map<string, number>; stop(): void } {
  const hosts = new Map<string, number>();
  const services = new Map<string, number>();
  const previous = setGridRenderObserver((kind, id) => {
    const counts = kind === "host" ? hosts : services;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  return {
    hosts,
    services,
    stop() {
      setGridRenderObserver(previous);
    },
  };
}

/** Swap a manual timer queue onto globalThis (the marker hook reads timers at call time). */
function installFakeTimers(): { advance(ms: number): void; restore(): void } {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    const id = nextId++;
    queue.set(id, { at: now + ms, fn });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    queue.delete(id);
  }) as unknown as typeof clearTimeout;
  return {
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...queue]) {
        if (timer.at > now) continue;
        queue.delete(id);
        act(() => timer.fn());
      }
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

describe("render isolation and change markers", () => {
  let timers: ReturnType<typeof installFakeTimers> | null = null;
  beforeEach(() => {
    timers = installFakeTimers();
  });
  afterEach(() => {
    timers?.restore();
    timers = null;
  });

  test("a no-op commit rerenders no target; one service change rerenders only its host and that chip", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 8 });
    const model = modelOf(snapshot);
    const m = await mountGrid(model);
    const counts = countRenders();
    try {
      // No material change: a structurally shared model from an identical cycle.
      const same = modelOf(structuredClone(snapshot), model);
      expect(same).toBe(model);
      m.rerender({ model: same, onSelect: () => undefined });
      expect(counts.hosts.size).toBe(0);
      expect(counts.services.size).toBe(0);

      const changedId = FIXTURE_IDS.okService;
      const next = modelOf(withTargetStatus(snapshot, changedId, "critical", 2), model);
      m.rerender({ model: next });
      const owner = snapshot.hosts.find((h) => h.services.some((s) => s.drilldownId === changedId))!;
      expect([...counts.hosts.keys()]).toEqual([owner.drilldownId]);
      expect([...counts.services.keys()]).toEqual([changedId]);
      expect(target(m.container, changedId).dataset["status"]).toBe("critical");
    } finally {
      counts.stop();
    }
  });

  test("an accepted status change marks only the changed target; reduced motion uses the static marker", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 4 });
    const model = modelOf(snapshot);
    const m = await mountGrid(model);
    expect(m.container.querySelectorAll("[data-changed]").length).toBe(0);

    // A service on the critical host: its host rollup stays critical, so only the chip transitions.
    const changedId = FIXTURE_IDS.suppressedService;
    m.rerender({ model: modelOf(withTargetStatus(snapshot, changedId, "warning", 2), model) });
    const marked = Array.from(m.container.querySelectorAll<HTMLElement>('[data-changed="animated"]'));
    expect(marked.map((el) => el.dataset["targetId"])).toEqual([changedId]);

    const quiet = makeOverviewSnapshot({ hostCount: 4 });
    const quietModel = modelOf(quiet);
    const r = await mountGrid(quietModel, { reducedMotion: true });
    r.rerender({ model: modelOf(withTargetStatus(quiet, changedId, "warning", 2), quietModel) });
    const statics = Array.from(r.container.querySelectorAll<HTMLElement>('[data-changed="static"]'));
    expect(statics.map((el) => el.dataset["targetId"])).toEqual([changedId]);
    expect(statics[0]!.textContent).toContain("Changed");
    expect(r.container.querySelectorAll('[data-changed="animated"]').length).toBe(0);

    // Both markers clear after the bounded window.
    timers!.advance(STATUS_CHANGE_MARKER_WINDOW_MS);
    for (const root of [m.container, r.container]) {
      expect(root.querySelectorAll("[data-changed]").length).toBe(0);
    }
  });

  test("reordering (collapse/expand remount) with unchanged statuses marks nothing", async () => {
    const model = modelOf(makeOverviewSnapshot({ hostCount: 8 }));
    const m = await mountGrid(model);
    m.rerender({ collapsedGroupIds: new Set([model.groups[0]!.id]) });
    m.rerender({ collapsedGroupIds: new Set() });
    expect(m.container.querySelectorAll("[data-changed]").length).toBe(0);
  });
});
});
