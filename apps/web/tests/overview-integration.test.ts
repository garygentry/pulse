// apps/web/tests/overview-integration.test.ts — DOM integration of the real OverviewView composition
// (08-testing-strategy.md §§4.3, 4.7, 4.8; 03 §§6–7; 04 §5; 05 §§3, 9; 06 §§2, 7).
//
// Every case mounts the real `OverviewComposition` (the ViewProps wrapper plus injected storage,
// history transport, reload callback and kiosk clock) over a real `createAppStore()` and commits
// deterministic fixture cycles through the store signals exactly as live-state would.
//
// Render isolation is counted through the grid render observer: the grid's inner
// `HostCellView`/`ServiceChipView` components report each render with their canonical target id, and
// a test installs the observer around the cycles it measures. No production prop is involved.
//
// Timers: the change-marker hook reads `globalThis.setTimeout` at call time and happy-dom's window
// timers throw in this registration, so a manual timer queue is installed around every test. Kiosk
// paging runs on an injected inert clock. Nothing sleeps on the wall clock.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { batch } from "@preact/signals-core";
import { createElement } from "react";
import type { ReactElement } from "react";
import { act } from "./react-render.js";

import type {
  CycleObservation,
  HostStatus,
  OverviewSnapshotV2,
  ServiceStatus,
  SourceId,
  SourceObservation,
  TargetStatus,
  ViewDeliveryState,
} from "@pulse/web-data/wire";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import type { ConnectionState } from "../src/client/store/types.js";
import { OVERVIEW_LOADING_MESSAGE } from "../src/client/views/overview/freshness.js";
import { RETRY_LIVENESS_HISTORY_LABEL } from "../src/client/views/overview/drawer/LivenessSparkline.js";
import { CLOSE_TARGET_DETAILS_LABEL } from "../src/client/views/overview/drawer/TargetDrawer.js";
import type { KioskPagingClock } from "../src/client/views/overview/kiosk/useKioskPaging.js";
import { OVERVIEW_PREFERENCES_KEY } from "../src/client/views/overview/model.js";
import type { HistoryFetch, OverviewPreferenceStorage } from "../src/client/views/overview/model.js";
import { OVERVIEW_UNAVAILABLE_TITLE, RELOAD_OVERVIEW_LABEL } from "../src/client/views/overview/stats/SurfaceNotice.js";
import { OVERVIEW_PAGE_TITLE, OverviewComposition } from "../src/client/views/overview/view.js";
import { TZ_FALLBACK_MARKER } from "../src/client/format.js";
import { FIXTURE_IDS } from "./fixtures/overview/expected.js";
import { cycleInstant, makeOverviewSnapshot, withTargetStatus } from "./fixtures/overview/factory.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, renderWithStore } from "./dom.js";
import type { RenderResult } from "./dom.js";
import { installUiStubs } from "./rtl.js";
import { setGridRenderObserver } from "../src/client/views/overview/grid/render-probe.js";

// Restore globalThis after this file so later non-DOM suites never see the closed happy-dom window.
isolateDomGlobals();

const TARGETS = "[data-overview-target]";
const MARKED = "[data-changed]";

// ---------------------------------------------------------------------------------------------
// Store / connection helpers (mirror what live-state publishes; see overview-freshness.test.ts)
// ---------------------------------------------------------------------------------------------

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];

const epoch = (cycle: number): number => Date.parse(cycleInstant(cycle));

function observation(seq: number): CycleObservation {
  const at = cycleInstant(seq);
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) sources[id] = { state: "current", lastAttemptAt: at, lastSuccess: at };
  return { generation: "11111111-1111-4111-8111-111111111111", seq, observedAt: at, appVersion: "0.0.0-dev", sources };
}

const delivery = (phase: ViewDeliveryState["phase"], identity: string): ViewDeliveryState => ({
  phase,
  identity: `sha256:${identity}` as ViewDeliveryState["identity"],
  failure: null,
});

function storeWith(query: Readonly<Record<string, string>> = {}): AppStore {
  const store = createAppStore({ storage: null, initialQuery: query });
  store.route.value = { path: "/overview", view: "overview", params: {}, query };
  return store;
}

function connectionWith(
  store: AppStore,
  over: Partial<Omit<ConnectionState, "views">>,
  overview?: ViewDeliveryState,
): ConnectionState {
  const prev = store.connection.peek();
  return { ...prev, ...over, views: overview === undefined ? prev.views : { ...prev.views, overview } };
}

/** Accept `snapshot` as a current live delivery for `cycle` (one atomic store commit). */
async function commitCurrent(store: AppStore, snapshot: OverviewSnapshotV2, cycle: number): Promise<void> {
  await act(async () => {
    batch(() => {
      store.snapshot.value = snapshot;
      store.connection.value = connectionWith(
        store,
        { phase: "live", lastGoodAt: epoch(cycle), seq: cycle, failingSince: null, observation: observation(cycle) },
        delivery("current", `cycle${cycle}`),
      );
    });
  });
}

/** A failed delivery: the store retains the accepted snapshot and marks delivery stale. */
async function commitFailedDelivery(store: AppStore, failingSinceCycle: number): Promise<void> {
  await act(async () => {
    const prev = store.connection.peek();
    store.connection.value = connectionWith(
      store,
      { phase: "stale", failingSince: epoch(failingSinceCycle) },
      delivery("stale", prev.views.overview.identity ?? "none"),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------------------------

/** A history transport that never settles: the drawer stays loading, no network. */
const pendingFetch: HistoryFetch = () => new Promise<never>(() => {});
/** A history transport that always rejects: the drawer shows its retry control. */
const failingFetch: HistoryFetch = () => Promise.reject(new Error("network down"));

/** Injected paging clock that never fires on its own. */
function inertClock(): KioskPagingClock {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => undefined };
}

function memoryStorage(initial: Record<string, string> = {}): OverviewPreferenceStorage & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
  };
}

function persisted(storage: { readonly data: Map<string, string> }): Record<string, unknown> {
  const raw = storage.data.get(OVERVIEW_PREFERENCES_KEY);
  if (raw === undefined) throw new Error("no persisted overview preferences");
  return JSON.parse(raw) as Record<string, unknown>;
}

function preferenceRecord(over: Record<string, unknown>): Record<string, string> {
  return {
    [OVERVIEW_PREFERENCES_KEY]: JSON.stringify({
      version: 1,
      groupBy: "class",
      sortBy: "status",
      collapsedGroupIds: [],
      selectedTargetId: null,
      ...over,
    }),
  };
}

interface MountOptions {
  readonly storage?: OverviewPreferenceStorage | null;
  readonly historyFetch?: HistoryFetch;
  readonly onReload?: () => void;
}

const mounted: RenderResult[] = [];

async function mountView(store: AppStore, opts: MountOptions = {}): Promise<RenderResult> {
  let result: RenderResult | undefined;
  await act(async () => {
    result = await renderWithStore(
      (props) =>
        createElement(OverviewComposition, {
          ...props,
          storage: opts.storage ?? null,
          historyFetch: opts.historyFetch ?? pendingFetch,
          onReload: opts.onReload ?? (() => {}),
          kioskClock: inertClock(),
        }) as unknown as ReactElement,
      { store },
    );
  });
  mounted.push(result!);
  return result!;
}

async function unmountView(result: RenderResult): Promise<void> {
  await act(async () => {
    result.unmount();
  });
}

// ---------------------------------------------------------------------------------------------
// DOM queries
// ---------------------------------------------------------------------------------------------

function trigger(root: ParentNode, drilldownId: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`${TARGETS}[data-target-id="${drilldownId}"]`);
  if (el === null) throw new Error(`no target trigger for ${drilldownId}`);
  return el;
}

function drawerTargetId(doc: Document): string | null {
  return doc.querySelector<HTMLElement>("[data-drawer-target]")?.dataset["drawerTarget"] ?? null;
}

/** Stat header count for one kind/status (leading integer of the chip label). */
function statCount(root: ParentNode, kind: "hosts" | "services", status: TargetStatus): number {
  const text = root.querySelector(`[data-stat="${kind}"] [data-stat-status="${status}"]`)?.textContent ?? "";
  const match = /\d[\d,]*/.exec(text);
  if (match === null) throw new Error(`no ${kind}/${status} count in "${text}"`);
  return Number(match[0].replace(/,/g, ""));
}

/** Grid count of rendered targets of one kind carrying `status`. */
function gridCount(root: ParentNode, kind: "host" | "service", status: TargetStatus): number {
  return root.querySelectorAll(`${TARGETS}[data-target-kind="${kind}"][data-status="${status}"]`).length;
}

/** The page root holds exactly one h1, the PageHeader title, and returns it. */
function expectOnePageHeading(root: HTMLElement): HTMLElement {
  const page = root.querySelector<HTMLElement>('[data-slot="overview-page"]');
  expect(page).not.toBeNull();
  const headings = root.ownerDocument.querySelectorAll("h1");
  expect(headings).toHaveLength(1);
  expect(page!.contains(headings[0]!)).toBe(true);
  expect(headings[0]!.closest('[data-slot="page-header"]')).not.toBeNull();
  expect(headings[0]!.textContent).toBe(OVERVIEW_PAGE_TITLE);
  return page!;
}

const STATUSES: readonly TargetStatus[] = ["ok", "warning", "critical", "unknown", "suppressed"];

/** Header counts and grid surfaces describe the same accepted cycle. */
function expectCoherent(root: HTMLElement, snapshot: OverviewSnapshotV2): void {
  expect(root.querySelectorAll(`${TARGETS}[data-target-kind="host"]`).length).toBe(snapshot.hosts.length);
  expect(root.querySelectorAll(`${TARGETS}[data-target-kind="service"]`).length).toBe(
    snapshot.hosts.reduce((n, host) => n + host.services.length, 0),
  );
  for (const status of STATUSES) {
    expect(statCount(root, "hosts", status)).toBe(gridCount(root, "host", status));
    expect(statCount(root, "services", status)).toBe(gridCount(root, "service", status));
  }
  // The ribbon renders exactly the snapshot's firing summaries, in server order.
  const ribbon = Array.from(root.querySelectorAll<HTMLElement>("[data-ribbon] li[data-fingerprint]")).map((el) => el.dataset["fingerprint"]);
  expect(ribbon).toEqual(snapshot.alerts.map((alert) => alert.fingerprint));
}

function markedIds(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>(MARKED)).map((el) => el.dataset["targetId"] ?? "");
}

function statusOf(root: ParentNode, drilldownId: string): string | undefined {
  return trigger(root, drilldownId).dataset["status"];
}

function pressEscape(el: Element): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

const MODE_LABEL: Readonly<Record<string, string>> = { class: "Class", status: "Status", name: "Name" };

/** The radios of a layout control (`data-control` = group-by | sort-by). */
function modeRadios(root: ParentNode, control: "group-by" | "sort-by"): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-control='${control}'] [role='radiogroup'] [role='radio']`));
}

/** Click the layout control's option for `value`, as a user would. */
function chooseMode(root: ParentNode, control: "group-by" | "sort-by", value: string): void {
  const radio = modeRadios(root, control).find((el) => el.textContent === MODE_LABEL[value]);
  if (radio === undefined) throw new Error(`no ${control} option ${value}`);
  radio.click();
}

/** The checked option of a layout control, as its mode value. */
function chosenMode(root: ParentNode, control: "group-by" | "sort-by"): string | undefined {
  const checked = modeRadios(root, control).filter((el) => el.getAttribute("aria-checked") === "true");
  expect(checked.length).toBe(1);
  return Object.keys(MODE_LABEL).find((mode) => MODE_LABEL[mode] === checked[0]!.textContent);
}

/** Accessible name of a control: aria-label, else aria-labelledby text, else its text content. */
function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text !== "") return text;
  }
  const wrapping = el.closest("label");
  if (wrapping !== null && wrapping !== el) return (wrapping.textContent ?? "").trim();
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------------------------
// Test-side render counters (grid render observer; see header)
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Manual timers (change-marker window) and reduced-motion media stub
// ---------------------------------------------------------------------------------------------

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

let timers: ReturnType<typeof installFakeTimers> | null = null;

beforeEach(() => {
  timers = installFakeTimers();
});

afterEach(async () => {
  while (mounted.length > 0) {
    const result = mounted.pop()!;
    await act(async () => {
      result.unmount();
    });
  }
  timers?.restore();
  timers = null;
});

// ---------------------------------------------------------------------------------------------

describeDom("overview integration — real OverviewView over store commits", (dom) => {
  // The drawer is a portalled Radix Sheet: stub its layout effect/rAF gaps before any mount.
  let restoreUi: (() => void) | null = null;
  beforeAll(() => {
    restoreUi = installUiStubs();
  });
  afterAll(() => restoreUi?.());

  describe("§4.7 snapshot refresh / degradation sequence", () => {
    test("cycle 1 → one-target change → failed/stale retained → recovered stays coherent and never silently green", async () => {
      const store = storeWith();
      const cycle1 = makeOverviewSnapshot({ alerts: true, cycle: 1 });
      await commitCurrent(store, cycle1, 1);
      const view = await mountView(store);
      const root = view.container;
      const doc = root.ownerDocument;

      // Cycle 1: current, coherent, no marker on first observation.
      expect(root.querySelector('[data-slot="overview-page"]')?.getAttribute("data-surface")).toBe("ready");
      expect(root.querySelector('section[aria-label="Estate statistics"]')?.getAttribute("data-surface")).toBe("ready");
      expect(root.querySelector("[data-feed]")).toBeNull();
      expectCoherent(root, cycle1);
      expect(markedIds(root)).toEqual([]);

      // Open a drawer on an unrelated target: it must survive every later commit.
      const drawerId = FIXTURE_IDS.okHost;
      await act(async () => {
        trigger(root, drawerId).click();
      });
      expect(drawerTargetId(doc)).toBe(drawerId);

      const unrelatedId = FIXTURE_IDS.warningHost;
      const unrelatedHostEl = trigger(root, unrelatedId);
      const unrelatedChipEl = trigger(root, FIXTURE_IDS.okServiceNoBoard);

      // Cycle 2: exactly one target changes (a service whose host rollup stays critical).
      const changedId = FIXTURE_IDS.suppressedService;
      const cycle2 = withTargetStatus(makeOverviewSnapshot({ alerts: true, cycle: 2 }), changedId, "warning", 2);
      await commitCurrent(store, cycle2, 2);
      expectCoherent(root, cycle2);
      expect(statusOf(root, changedId)).toBe("warning");
      expect(markedIds(root)).toEqual([changedId]);
      expect(drawerTargetId(doc)).toBe(drawerId);
      // Unrelated identities are stable DOM nodes.
      expect(trigger(root, unrelatedId)).toBe(unrelatedHostEl);
      expect(trigger(root, FIXTURE_IDS.okServiceNoBoard)).toBe(unrelatedChipEl);
      const statusesAtCycle2 = new Map(
        Array.from(root.querySelectorAll<HTMLElement>(TARGETS)).map((el) => [el.dataset["targetId"], el.dataset["status"]]),
      );
      timers!.advance(5_000);
      expect(markedIds(root)).toEqual([]);

      // Failed delivery: the cycle-2 snapshot is retained and marked stale with its last-good time.
      await commitFailedDelivery(store, 3);
      expect(root.querySelector('[data-slot="overview-page"]')?.getAttribute("data-surface")).toBe("stale");
      // Live/Stale + last-good time is the shell indicator's; the view repeats no feed line.
      expect(root.querySelector('section[aria-label="Estate statistics"]')?.getAttribute("data-surface")).toBe("stale");
      expect(root.querySelector("[data-feed]")).toBeNull();
      expect(root.querySelector("[data-ribbon]")?.getAttribute("data-alerts-current")).toBe("false");
      expectCoherent(root, cycle2);
      // No silent-green: every target keeps its cycle-2 status, nothing is marked, nothing is promoted.
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(TARGETS))) {
        expect(el.dataset["status"]).toBe(statusesAtCycle2.get(el.dataset["targetId"])!);
      }
      expect(markedIds(root)).toEqual([]);
      expect(drawerTargetId(doc)).toBe(drawerId);
      expect(trigger(root, unrelatedId)).toBe(unrelatedHostEl);

      // Cycle 3 recovers: current again, same statuses, no spurious marker, drawer still open.
      const cycle3 = withTargetStatus(makeOverviewSnapshot({ alerts: true, cycle: 3 }), changedId, "warning", 3);
      await commitCurrent(store, cycle3, 3);
      expect(root.querySelector('[data-slot="overview-page"]')?.getAttribute("data-surface")).toBe("ready");
      expect(root.querySelector('section[aria-label="Estate statistics"]')?.getAttribute("data-surface")).toBe("ready");
      expect(root.querySelector("[data-ribbon]")?.getAttribute("data-alerts-current")).toBe("true");
      expectCoherent(root, cycle3);
      expect(statusOf(root, changedId)).toBe("warning");
      expect(markedIds(root)).toEqual([]);
      expect(drawerTargetId(doc)).toBe(drawerId);
      expect(trigger(root, unrelatedId)).toBe(unrelatedHostEl);
      expect(trigger(root, FIXTURE_IDS.okServiceNoBoard)).toBe(unrelatedChipEl);
    });

    test("no first snapshot: explicit loading/NOT_READY → unavailable with injected reload → recovery", async () => {
      const store = storeWith();
      const reloads: number[] = [];
      const win = dom.win as unknown as Window;
      const hrefBefore = win.location.href;
      const view = await mountView(store, { onReload: () => reloads.push(1) });
      const root = view.container;

      // Initial: explicit loading, never a blank or synthesized-healthy grid.
      const section = (): HTMLElement => root.querySelector<HTMLElement>('[data-slot="overview-page"]')!;
      expect(section().getAttribute("data-surface")).toBe("loading");
      // Loading still renders inside the page frame: one h1, the page labelled by it, no zone yet.
      expect(expectOnePageHeading(root)).toBe(section());
      expect(section().getAttribute("aria-labelledby")).toBe(root.ownerDocument.querySelector("h1")!.id);
      expect(root.querySelector("[data-zone]")).toBeNull();
      expect(root.querySelector("[data-surface='loading'][aria-busy='true']")).not.toBeNull();
      expect(root.textContent).toContain(OVERVIEW_LOADING_MESSAGE);
      expect(root.querySelector("[role='grid']")).toBeNull();
      expect(root.querySelector("[data-status]")).toBeNull();

      // NOT_READY responses (failing, never contacted) remain loading.
      await act(async () => {
        store.connection.value = connectionWith(store, { failingSince: epoch(1) });
      });
      expect(section().getAttribute("data-surface")).toBe("loading");
      expect(root.querySelector("[role='grid']")).toBeNull();
      expect(root.querySelector("[data-status='ok']")).toBeNull();

      // Delivery failure past the stale window: shared EmptyState with a page-level reload action.
      await act(async () => {
        store.connection.value = connectionWith(
          store,
          { phase: "stale", lastGoodAt: epoch(1), failingSince: epoch(1) },
          delivery("stale", "none"),
        );
      });
      expect(section().getAttribute("data-surface")).toBe("unavailable");
      expect(expectOnePageHeading(root)).toBe(section());
      const empty = root.querySelector<HTMLElement>("[data-surface='unavailable'] [data-slot='empty-state']");
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toContain(OVERVIEW_UNAVAILABLE_TITLE);
      const reload = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => accessibleName(button) === RELOAD_OVERVIEW_LABEL,
      );
      expect(reload).toBeDefined();
      expect(root.querySelector("[role='grid']")).toBeNull();
      expect(root.querySelector("[data-status]")).toBeNull();
      await act(async () => {
        reload!.click();
      });
      expect(reloads).toEqual([1]);
      expect(win.location.href).toBe(hrefBefore);
      // The surface does not recover by itself on click — recovery stays live-state owned.
      expect(section().getAttribute("data-surface")).toBe("unavailable");

      // Recovery: the first accepted snapshot renders the ready grid.
      const snapshot = makeOverviewSnapshot({ cycle: 2 });
      await commitCurrent(store, snapshot, 2);
      expect(section().getAttribute("data-surface")).toBe("ready");
      expect(root.querySelector("[role='grid']")).not.toBeNull();
      expect(root.querySelector("[data-slot='empty-state']")).toBeNull();
      expectCoherent(root, snapshot);
    });
  });

  describe("§4.3 render isolation at the component seam", () => {
    test("a no-op commit renders no HostCell/ServiceChip; one service change renders only its host and chip", async () => {
      const store = storeWith();
      const snapshot = makeOverviewSnapshot({ hostCount: 8, cycle: 1 });
      await commitCurrent(store, snapshot, 1);
      const view = await mountView(store);
      const counts = countRenders();
      try {
        // An identical cycle delivered as fresh objects (same content, new references).
        await act(async () => {
          store.snapshot.value = structuredClone(snapshot);
        });
        expect(counts.hosts.size).toBe(0);
        expect(counts.services.size).toBe(0);

        const changedId = FIXTURE_IDS.okService;
        await act(async () => {
          store.snapshot.value = withTargetStatus(snapshot, changedId, "critical", 1);
        });
        const owner = snapshot.hosts.find((host) => host.services.some((service) => service.drilldownId === changedId))!;
        expect([...counts.hosts.keys()]).toEqual([owner.drilldownId]);
        expect([...counts.services.keys()]).toEqual([changedId]);
        // Unchanged siblings on the same host kept their prior render count (zero increments).
        for (const sibling of owner.services.filter((service) => service.drilldownId !== changedId)) {
          expect(counts.services.get(sibling.drilldownId) ?? 0).toBe(0);
        }
        expect(statusOf(view.container, changedId)).toBe("critical");
      } finally {
        counts.stop();
      }
    });

    test("a service change under a host whose status holds renders that host once (only the chip re-renders for its marker)", async () => {
      const store = storeWith();
      const snapshot = makeOverviewSnapshot({ hostCount: 8, cycle: 1 });
      await commitCurrent(store, snapshot, 1);
      await mountView(store);
      const counts = countRenders();
      try {
        // host-003 is critical; its suppressed `cache` service turning warning leaves the host critical.
        await act(async () => {
          store.snapshot.value = withTargetStatus(snapshot, FIXTURE_IDS.suppressedService, "warning", 1);
        });
        expect(counts.hosts.get(FIXTURE_IDS.criticalHost)).toBe(1);
        expect([...counts.hosts.keys()]).toEqual([FIXTURE_IDS.criticalHost]);
        // The changed chip renders for the commit and once more for its change marker.
        expect(counts.services.get(FIXTURE_IDS.suppressedService)).toBe(2);
      } finally {
        counts.stop();
      }
    });
  });

  describe("§4.3 read-only guard", () => {
    test("the complete view (controls, ribbon, grid, open drawer with history error) exposes no mutation control", async () => {
      const store = storeWith();
      await commitCurrent(store, makeOverviewSnapshot({ alerts: true, grafana: true, cycle: 1 }), 1);
      const view = await mountView(store, { historyFetch: failingFetch });
      const root = view.container;
      const doc = root.ownerDocument;

      await act(async () => {
        trigger(root, FIXTURE_IDS.okService).click();
      });
      // The drawer renders its sections a frame after its Sheet frame paints (rAF, then a task).
      await act(async () => {
        timers!.advance(16);
        timers!.advance(1);
      });
      expect(doc.querySelector('[data-drawer-body="ready"]')).not.toBeNull();
      // Let the rejected history request settle into its error state.
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(doc.querySelector('[data-history-state="error"]')).not.toBeNull();
      expect(drawerTargetId(doc)).toBe(FIXTURE_IDS.okService);

      const controls = Array.from(
        doc.querySelectorAll<HTMLElement>(
          "button, a[href], select, input, textarea, form, [role='button'], [role='link'], [role='radio'], [role='combobox'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio']",
        ),
      );
      expect(controls.length).toBeGreaterThan(0);
      const forbidden = /\b(silence|silences|acknowledge|ack|edit|delete|remove|mutate|post|put|patch|capability|capabilities)\b/i;
      const names: string[] = [];
      const allowed: string[] = [];
      for (const el of controls) {
        const name = accessibleName(el);
        names.push(name);
        expect(name).not.toMatch(forbidden);
        expect(el.tagName).not.toBe("FORM");
        expect(el.tagName).not.toBe("TEXTAREA");
        expect(el.tagName).not.toBe("INPUT");
        expect(el.getAttribute("formmethod")).toBeNull();

        // Allowlist: every control is navigation, grouping, sorting, collapse, close, or history retry.
        const category =
          el.matches(TARGETS) ? "navigation:target"
          : el.matches("[data-ribbon-action]") ? "navigation:triage"
          : el.matches("a[href][target='_blank']") ? "navigation:grafana"
          : el.matches("[data-control='group-by'] [role='radio']") ? "grouping"
          : el.matches("[data-control='sort-by'] [role='radio']") ? "sorting"
          : el.matches("[data-group-toggle]") ? "collapse"
          : name === CLOSE_TARGET_DETAILS_LABEL ? "close"
          : name === RETRY_LIVENESS_HISTORY_LABEL ? "retry"
          : `UNLISTED:${el.tagName}:${name}`;
        allowed.push(category);
      }
      expect(allowed.filter((category) => category.startsWith("UNLISTED"))).toEqual([]);
      // The only retry control is exactly the liveness-history retry.
      expect(names.filter((name) => /retry/i.test(name))).toEqual([RETRY_LIVENESS_HISTORY_LABEL]);
      for (const category of ["navigation:target", "navigation:triage", "grouping", "sorting", "collapse", "close", "retry"]) {
        expect(allowed).toContain(category);
      }
    });
  });

  describe("§4.8 kiosk DOM composition", () => {
    let savedMatchMedia: unknown;
    beforeEach(() => {
      savedMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    });
    afterEach(() => {
      (globalThis as { matchMedia?: unknown }).matchMedia = savedMatchMedia;
    });

    function stubReducedMotion(reduce: boolean): void {
      (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
        matches: reduce && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      });
    }

    test("?kiosk=1 implies wallboard, suppresses controls/drawer, keeps freshness and shows '1 / P'", async () => {
      stubReducedMotion(false);
      const store = storeWith({ kiosk: "1" });
      const snapshot = makeOverviewSnapshot({ hostCount: 3, alerts: true, cycle: 1 });
      await commitCurrent(store, snapshot, 1);
      const storage = memoryStorage(preferenceRecord({ selectedTargetId: FIXTURE_IDS.okHost }));
      const view = await mountView(store, { storage });
      const root = view.container;
      const doc = root.ownerDocument;

      // Wallboard: the store's effective density is forced, the grid is the kiosk page grid.
      expect(store.density.value).toBe("wallboard");
      expect(root.querySelector('[data-slot="overview-page"]')?.getAttribute("data-kiosk")).toBe("true");
      expect(root.querySelector('[data-slot="overview-kiosk-page"] [data-slot="overview-grid"][data-layout="kiosk"]')).not.toBeNull();

      // No grouping/sorting controls, no drawer (even with a persisted selection), no selection.
      expect(root.querySelector("[data-control]")).toBeNull();
      expect(root.querySelector("[role='group'][aria-label='Overview layout']")).toBeNull();
      expect(root.querySelector("[role='radiogroup']")).toBeNull();
      expect(doc.querySelector("[role='dialog']")).toBeNull();
      const first = root.querySelector<HTMLElement>(`[data-slot="overview-kiosk-page"] ${TARGETS}`)!;
      await act(async () => {
        first.click();
      });
      expect(doc.querySelector("[role='dialog']")).toBeNull();
      expect(store.selection.value).toBeNull();

      // The stat header stays (freshness itself is the shell's top-bar pill, shown in kiosk too);
      // the ribbon is the text-only summary.
      expect(root.querySelector('section[aria-label="Estate statistics"]')?.getAttribute("data-surface")).toBe("ready");
      expect(root.querySelector("[data-feed]")).toBeNull();
      const kioskRibbon = root.querySelector<HTMLElement>("[data-ribbon='kiosk'][data-kiosk='true']")!;
      expect(kioskRibbon).not.toBeNull();
      expect(kioskRibbon.getAttribute("aria-label")).toBe("Firing alerts summary");
      expect(kioskRibbon.querySelectorAll("button, a, [role='button'], [tabindex], [href]").length).toBe(0);

      // Page indicator: visible "1 / P" text, accessible name "Page 1 of P" (happy-dom lays out
      // nothing, so capacity clamps to one host per page → P = host count).
      const pages = snapshot.hosts.length;
      const indicator = root.querySelector<HTMLElement>('[data-slot="overview-kiosk-indicator"]')!;
      expect(indicator).not.toBeNull();
      expect(indicator.textContent).toBe(`1 / ${pages}`);
      expect(accessibleName(indicator)).toBe(`Page 1 of ${pages}`);

      // Normal motion uses the animated page swap.
      expect(root.querySelector('[data-slot="overview-kiosk-page"]')!.getAttribute("data-fade")).toBe("true");

      // A later cycle in kiosk still keeps freshness and never opens a drawer.
      await commitFailedDelivery(store, 2);
      expect(root.querySelector('section[aria-label="Estate statistics"]')?.getAttribute("data-surface")).toBe("stale");
      expect(doc.querySelector("[role='dialog']")).toBeNull();
    });

    test("reduced motion swaps kiosk pages without the fade", async () => {
      stubReducedMotion(true);
      const store = storeWith({ kiosk: "1" });
      await commitCurrent(store, makeOverviewSnapshot({ hostCount: 3, cycle: 1 }), 1);
      const view = await mountView(store);
      const page = view.container.querySelector<HTMLElement>('[data-slot="overview-kiosk-page"]')!;
      expect(page).not.toBeNull();
      expect(page.getAttribute("data-fade")).toBe("false");
      expect(view.container.querySelector('[data-fade="true"], [data-changed="animated"]')).toBeNull();
    });
  });

  describe("Escape and focus return", () => {
    test("Escape closes the drawer and returns focus to the invoking trigger", async () => {
      const store = storeWith();
      await commitCurrent(store, makeOverviewSnapshot({ cycle: 1 }), 1);
      const storage = memoryStorage();
      const view = await mountView(store, { storage });
      const root = view.container;
      const doc = root.ownerDocument;

      const invoker = trigger(root, FIXTURE_IDS.warningHost);
      await act(async () => {
        invoker.focus();
        invoker.click();
      });
      const dialog = doc.querySelector<HTMLElement>("[role='dialog'][aria-modal='true']")!;
      expect(dialog).not.toBeNull();
      // The portalled Sheet is named by the target title.
      const hostName = invoker.closest("[data-target-id]")?.querySelector("[data-slot='overview-host-name']")?.textContent ?? "";
      expect(hostName).not.toBe("");
      expect(doc.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(hostName);
      expect(dialog.contains(doc.activeElement)).toBe(true);

      await act(async () => {
        pressEscape(doc.activeElement ?? dialog);
      });
      expect(doc.querySelector("[role='dialog']")).toBeNull();
      expect(doc.activeElement).toBe(invoker);
      // Radix releases its focus scope on a later timer; the return to the invoker must stick.
      timers!.advance(1);
      expect(doc.activeElement).toBe(invoker);
      expect(persisted(storage)["selectedTargetId"]).toBeNull();
      expect(store.selection.value).toBeNull();
    });

    test("Escape after the invoking trigger disappeared lands focus in the grid", async () => {
      const store = storeWith();
      await commitCurrent(store, makeOverviewSnapshot({ cycle: 1 }), 1);
      const view = await mountView(store);
      const root = view.container;
      const doc = root.ownerDocument;
      const region = root.querySelector<HTMLElement>('[data-slot="overview-grid-region"]')!;

      const invoker = trigger(root, FIXTURE_IDS.warningHost);
      await act(async () => {
        invoker.focus();
        invoker.click();
      });
      expect(drawerTargetId(doc)).toBe(FIXTURE_IDS.warningHost);

      // Regroup while the drawer is open: the target survives but its trigger node is replaced.
      await act(async () => {
        chooseMode(root, "group-by", "status");
      });
      expect(drawerTargetId(doc)).toBe(FIXTURE_IDS.warningHost);
      expect(invoker.isConnected).toBe(false);

      await act(async () => {
        pressEscape(doc.querySelector("[role='dialog']")!);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(doc.querySelector("[role='dialog']")).toBeNull();
      timers!.advance(1);
      const active = doc.activeElement as HTMLElement | null;
      expect(active).not.toBeNull();
      expect(active!.isConnected).toBe(true);
      expect(active === region || (region.contains(active) && active!.matches(TARGETS))).toBe(true);
    });
  });

  describe("selected-target disappearance and persisted selection", () => {
    test("a committed cycle without the selected target closes the drawer, clears selection and rescues focus", async () => {
      const store = storeWith();
      await commitCurrent(store, makeOverviewSnapshot({ cycle: 1 }), 1);
      const storage = memoryStorage();
      const view = await mountView(store, { storage });
      const root = view.container;
      const doc = root.ownerDocument;
      const region = root.querySelector<HTMLElement>('[data-slot="overview-grid-region"]')!;

      const goneId = FIXTURE_IDS.unknownHost; // host-004 — absent from a 3-host cycle
      await act(async () => {
        const el = trigger(root, goneId);
        el.focus();
        el.click();
      });
      expect(drawerTargetId(doc)).toBe(goneId);
      expect(persisted(storage)["selectedTargetId"]).toBe(goneId);

      await commitCurrent(store, makeOverviewSnapshot({ hostCount: 3, cycle: 2 }), 2);
      await act(async () => {
        await Promise.resolve();
      });

      expect(doc.querySelector("[role='dialog']")).toBeNull();
      expect(root.querySelector(`[data-target-id="${goneId}"]`)).toBeNull();
      expect(persisted(storage)["selectedTargetId"]).toBeNull();
      expect(store.selection.value).toBeNull();
      const active = doc.activeElement as HTMLElement | null;
      expect(active).not.toBeNull();
      expect(active!.isConnected).toBe(true);
      expect(active === region || (region.contains(active) && active!.matches(TARGETS))).toBe(true);
    });

    test("a remount reopens a persisted selection that still exists (desk) and drops one that does not", async () => {
      const store = storeWith();
      await commitCurrent(store, makeOverviewSnapshot({ cycle: 1 }), 1);

      const keeps = memoryStorage(preferenceRecord({ selectedTargetId: FIXTURE_IDS.okService }));
      const first = await mountView(store, { storage: keeps });
      const doc = first.container.ownerDocument;
      expect(drawerTargetId(doc)).toBe(FIXTURE_IDS.okService);
      expect(persisted(keeps)["selectedTargetId"]).toBe(FIXTURE_IDS.okService);
      await unmountView(first);

      const drops = memoryStorage(preferenceRecord({ selectedTargetId: "host:host-999" }));
      await mountView(store, { storage: drops });
      expect(doc.querySelector("[role='dialog']")).toBeNull();
      expect(persisted(drops)["selectedTargetId"]).toBeNull();
      expect(store.selection.value).toBeNull();
    });
  });

  describe("grouping, sorting and collapse preferences", () => {
    test("group-by/sort/collapse re-render and are restored after remount with the same storage", async () => {
      const store = storeWith();
      const snapshot = makeOverviewSnapshot({ hostCount: 8, cycle: 1 });
      await commitCurrent(store, snapshot, 1);
      const storage = memoryStorage();
      const first = await mountView(store, { storage });
      const root = first.container;

      const groupIds = (container: ParentNode): string[] =>
        Array.from(container.querySelectorAll<HTMLElement>("[role='rowgroup'][data-group-id]")).map((el) => el.dataset["groupId"]!);
      const hostOrder = (container: ParentNode): string[] =>
        Array.from(container.querySelectorAll<HTMLElement>(`${TARGETS}[data-target-kind="host"]`)).map((el) => el.dataset["targetId"]!);

      expect(groupIds(root).every((id) => id.startsWith("class:"))).toBe(true);

      await act(async () => {
        chooseMode(root, "group-by", "status");
      });
      const statusGroups = groupIds(root);
      expect(statusGroups.length).toBeGreaterThan(1);
      expect(statusGroups.every((id) => id.startsWith("status:"))).toBe(true);

      await act(async () => {
        chooseMode(root, "sort-by", "name");
      });
      // Within every status group, hosts are now in name order.
      for (const group of Array.from(root.querySelectorAll<HTMLElement>("[role='rowgroup'][data-group-id]"))) {
        const names = Array.from(group.querySelectorAll<HTMLElement>('[data-slot="overview-host-name"]')).map((el) => el.textContent ?? "");
        expect(names).toEqual([...names].sort());
      }

      const collapsedId = statusGroups[0]!;
      const toggle = root.querySelector<HTMLButtonElement>(`[data-group-id="${collapsedId}"] [data-group-toggle]`)!;
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      await act(async () => {
        toggle.click();
      });
      const collapsedToggle = root.querySelector<HTMLButtonElement>(`[data-group-id="${collapsedId}"] [data-group-toggle]`)!;
      expect(collapsedToggle.getAttribute("aria-expanded")).toBe("false");
      expect(root.querySelector<HTMLElement>(`[data-group-id="${collapsedId}"] [data-layout="desk"]`)!.hidden).toBe(true);

      const sortedOrder = hostOrder(root);
      expect(sortedOrder.length).toBeGreaterThan(0);
      expect(persisted(storage)).toMatchObject({ groupBy: "status", sortBy: "name", collapsedGroupIds: [collapsedId] });
      await unmountView(first);

      const second = await mountView(store, { storage });
      const again = second.container;
      expect(chosenMode(again, "group-by")).toBe("status");
      expect(chosenMode(again, "sort-by")).toBe("name");
      expect(groupIds(again)).toEqual(statusGroups);
      expect(hostOrder(again)).toEqual(sortedOrder);
      expect(
        again.querySelector<HTMLButtonElement>(`[data-group-id="${collapsedId}"] [data-group-toggle]`)!.getAttribute("aria-expanded"),
      ).toBe("false");
      expect(again.querySelector<HTMLElement>(`[data-group-id="${collapsedId}"] [data-layout="desk"]`)!.hidden).toBe(true);
    });
  });

  describe("page frame", () => {
    test("desk: one PageHeader h1, the estate-named page region and the zone meta", async () => {
      const store = storeWith();
      const snapshot = makeOverviewSnapshot({ alerts: true, cycle: 1 });
      await commitCurrent(store, snapshot, 1);
      const root = (await mountView(store)).container;
      const page = expectOnePageHeading(root);
      expect(page.tagName).toBe("SECTION");
      expect(page.getAttribute("aria-label")).toBe(`${snapshot.estate.name} overview`);
      expect(page.getAttribute("data-kiosk")).toBe("false");
      expect(page.getAttribute("style")).toBeNull();
      const zone = page.querySelector('[data-slot="page-header-meta"] [data-zone]');
      expect(zone?.textContent).toBe(`Times in ${snapshot.estate.timezone}`);
      expect(root.querySelector("[data-tz-fallback]")).toBeNull();
      // Regions in order: header, stat header, ribbon, layout controls, grid region.
      const order = [
        '[data-slot="page-header"]',
        'section[aria-label="Estate statistics"]',
        "[data-ribbon='desk']",
        "[role='group'][aria-label='Overview layout']",
        '[data-slot="overview-grid-region"]',
      ].map((sel) => page.querySelector(sel));
      for (const el of order) expect(el).not.toBeNull();
      for (let i = 1; i < order.length; i += 1) {
        expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      const region = page.querySelector<HTMLElement>('[data-slot="overview-grid-region"]')!;
      expect(region.tabIndex).toBe(-1);
      expect(region.querySelector("[role='grid']")).not.toBeNull();
    });

    test("the UTC fallback marker sits in the page header meta, not in the stat header", async () => {
      const store = storeWith();
      const base = makeOverviewSnapshot({ cycle: 1 });
      const snapshot: OverviewSnapshotV2 = { ...base, estate: { ...base.estate, timezone: "UTC", tzFallback: true } };
      await commitCurrent(store, snapshot, 1);
      const root = (await mountView(store)).container;
      const marker = root.querySelectorAll("[data-tz-fallback]");
      expect(marker).toHaveLength(1);
      expect(marker[0]!.textContent).toBe(TZ_FALLBACK_MARKER);
      expect(marker[0]!.closest('[data-slot="page-header-meta"] [data-zone]')).not.toBeNull();
      expect(root.querySelector('section[aria-label="Estate statistics"] [data-tz-fallback]')).toBeNull();
    });

    test("kiosk: still exactly one h1, and the root height is fitted below the chrome", async () => {
      const store = storeWith({ kiosk: "1" });
      await commitCurrent(store, makeOverviewSnapshot({ hostCount: 3, cycle: 1 }), 1);
      const root = (await mountView(store)).container;
      const page = expectOnePageHeading(root);
      expect(page.getAttribute("data-kiosk")).toBe("true");
      expect(page.querySelector("[data-zone]")).not.toBeNull();
      // The measured offset is exposed as a custom property the height calc reads.
      expect(page.style.getPropertyValue("--overview-kiosk-top")).toMatch(/^\d+px$/);
      expect(page.querySelector('[data-slot="overview-grid-region"] [data-slot="overview-kiosk"]')).not.toBeNull();
    });
  });
});
