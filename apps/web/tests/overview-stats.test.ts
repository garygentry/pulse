// apps/web/tests/overview-stats.test.ts — the estate stat header (no feed line: freshness is the
// shell's indicator) and the no-snapshot surface notice. Every case renders through describeDom +
// renderWithStore over the deterministic overview fixture factory and the real selectors.

import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { render } from "./react-render.js";
import type { ReactElement } from "react";
import { act } from "./react-render.js";

import type { CycleObservation, DataAvailability, OverviewSnapshotV2, SourceId, SourceObservation, TargetStatus, ViewDeliveryState } from "@pulse/web-data/wire";
import { ALERT_SEVERITY, TARGET_STATUS } from "@/ui";
import { createEstateClock, TZ_FALLBACK_MARKER } from "../src/client/format.js";
import type { EstateClock } from "../src/client/format.js";
import { createAppStore, type AppStore } from "../src/client/store/index.js";
import type { ConnectionState } from "../src/client/store/types.js";
import {
  deriveOverviewSurfaceState,
  OVERVIEW_LOADING_MESSAGE,
  OVERVIEW_UNAVAILABLE_MESSAGE,
} from "../src/client/views/overview/freshness.js";
import { createChangeTracker } from "../src/client/views/overview/grid/change-marker.js";
import { OverviewGrid } from "../src/client/views/overview/grid/OverviewGrid.js";
import {
  DEFAULT_OVERVIEW_PREFERENCES,
  OVERVIEW_STATUS_ORDER,
  type OverviewModel,
  type OverviewStats,
  type OverviewSurfaceState,
} from "../src/client/views/overview/model.js";
import { FiringRibbon } from "../src/client/views/overview/ribbon/FiringRibbon.js";
import { deriveOverviewModel, deriveOverviewStats } from "../src/client/views/overview/selectors.js";
import { STAT_UNAVAILABLE_TEXT } from "../src/client/views/overview/stats/format.js";
import { StatHeader } from "../src/client/views/overview/stats/StatHeader.js";
import {
  OVERVIEW_UNAVAILABLE_TITLE,
  OverviewSurfaceNotice,
  RELOAD_OVERVIEW_LABEL,
} from "../src/client/views/overview/stats/SurfaceNotice.js";
import { DEFAULT_HOST_STATUS_COUNTS, DEFAULT_SERVICE_STATUS_COUNTS, FIXTURE_IDS } from "./fixtures/overview/expected.js";
import { cycleInstant, FIXTURE_ESTATE, makeOverviewSnapshot, withTargetStatus } from "./fixtures/overview/factory.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, renderWithStore } from "./dom.js";

// Restore globalThis once this file finishes so a later non-DOM suite never sees the closed window.
isolateDomGlobals();

const CLOCK = createEstateClock(FIXTURE_ESTATE);
const STALE_AT = "2026-09-01T11:40:00.000Z";
const STALE_AT_TEXT = "2026-09-01 11:40:00 UTC";

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];

function observation(seq: number): CycleObservation {
  const at = cycleInstant(seq);
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) sources[id] = { state: "current", lastAttemptAt: at, lastSuccess: at };
  return { generation: "11111111-1111-4111-8111-111111111111", seq, observedAt: at, appVersion: "0.0.0-dev", sources };
}

function setConnection(store: AppStore, over: Partial<Omit<ConnectionState, "views">>, overview?: ViewDeliveryState): void {
  const prev = store.connection.peek();
  store.connection.value = { ...prev, ...over, views: overview === undefined ? prev.views : { ...prev.views, overview } };
}

const CURRENT: ViewDeliveryState = { phase: "current", identity: "sha256:aaaa" as ViewDeliveryState["identity"], failure: null };
const STALE: ViewDeliveryState = { phase: "stale", identity: "sha256:aaaa" as ViewDeliveryState["identity"], failure: null };

function ready(snapshot: OverviewSnapshotV2): OverviewSurfaceState {
  return { status: "ready", snapshot, stale: false };
}

function stale(source: DataAvailability["source"], lastGoodAt: string | null): DataAvailability {
  return { state: "stale", source, lastGoodAt, message: null };
}

const mounted: Array<{ unmount(): void }> = [];

afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
});

async function mountVNode(vnode: ReactElement): Promise<HTMLElement> {
  let result!: Awaited<ReturnType<typeof renderWithStore>>;
  await act(async () => {
    result = await renderWithStore(vnode);
  });
  mounted.push(result);
  return result.container;
}

async function mountHeader(stats: OverviewStats, surface: OverviewSurfaceState, clock: EstateClock = CLOCK): Promise<HTMLElement> {
  return mountVNode(createElement(StatHeader, { stats, surface, clock }) as unknown as ReactElement);
}

function text(root: ParentNode, selector: string): string {
  const el = root.querySelector(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function statusCountText(root: ParentNode, kind: "hosts" | "services", status: TargetStatus): string {
  return text(root, `[data-stat="${kind}"] [data-stat-status="${status}"]`);
}

describeDom("StatHeader — totals", () => {
  test("renders host and service counts for all five statuses with shared status chips", async () => {
    const snapshot = makeOverviewSnapshot();
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    for (const status of OVERVIEW_STATUS_ORDER) {
      expect(statusCountText(root, "hosts", status)).toContain(String(DEFAULT_HOST_STATUS_COUNTS[status]));
      expect(statusCountText(root, "services", status)).toContain(String(DEFAULT_SERVICE_STATUS_COUNTS[status]));
      const chip = root.querySelector(`[data-stat="hosts"] [data-stat-status="${status}"] [data-slot="status-badge"]`);
      expect(chip?.getAttribute("data-status")).toBe(status);
      expect(chip?.getAttribute("data-tone")).toBe(TARGET_STATUS[status].tone);
      // Icon + visible label: never colour alone.
      expect(chip?.querySelector("svg")).not.toBeNull();
      expect(chip?.textContent).toBe(`${DEFAULT_HOST_STATUS_COUNTS[status]} ${TARGET_STATUS[status].label}`);
    }
  });

  test("renders firing by severity, silenced and inhibited totals from the snapshot", async () => {
    const snapshot = makeOverviewSnapshot();
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    const bySeverity = (s: string) => snapshot.alerts.filter((a) => a.severity === s).length;
    expect(text(root, '[data-stat-severity="critical"]')).toBe(`Critical ${bySeverity("critical")}`);
    expect(text(root, '[data-stat-severity="warning"]')).toBe(`Warning ${bySeverity("warning")}`);
    expect(text(root, '[data-stat-severity="info"]')).toBe(`Info ${bySeverity("info")}`);
    expect(text(root, '[data-stat-severity="silenced"]')).toBe(`Silenced ${snapshot.alertCounts.silenced}`);
    expect(text(root, '[data-stat-severity="inhibited"]')).toBe(`Inhibited ${snapshot.alertCounts.inhibited}`);
    // Severity badges come from ALERT_SEVERITY; info keeps its own tone.
    for (const severity of ["critical", "warning", "info"] as const) {
      const badge = root.querySelector(`[data-stat-severity="${severity}"] [data-slot="status-badge"]`);
      expect(badge?.getAttribute("data-severity")).toBe(severity);
      expect(badge?.getAttribute("data-tone")).toBe(ALERT_SEVERITY[severity].tone);
    }
    expect(root.querySelector('[data-stat-severity="info"] [data-slot="status-badge"]')?.getAttribute("data-tone")).toBe("info");
  });

  test("renders current coverage gaps/covered/extras and Engine OK", async () => {
    const snapshot = makeOverviewSnapshot();
    const coverage = snapshot.coverage.value!;
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    const cov = text(root, '[data-stat="coverage"]');
    expect(cov).toContain(`Gaps ${coverage.gaps}`);
    expect(cov).toContain(`Covered ${coverage.covered} · Extras ${coverage.extras}`);
    expect(root.querySelector('[data-stat="coverage"]')?.getAttribute("data-availability")).toBe("current");
    expect(text(root, '[data-stat="engine"]')).toContain("Engine OK");
    expect(root.querySelector('[data-stat="engine"] [data-slot="status-badge"]')?.getAttribute("data-status")).toBe("ok");
  });

  test("malformed aggregate counts render Unavailable, never a clamped zero", async () => {
    const snapshot = makeOverviewSnapshot();
    const stats: OverviewStats = { ...deriveOverviewStats(snapshot), silenced: -1, inhibited: Number.NaN };
    const root = await mountHeader(stats, ready(snapshot));
    expect(text(root, '[data-stat-severity="silenced"]')).toBe(`Silenced ${STAT_UNAVAILABLE_TEXT}`);
    expect(text(root, '[data-stat-severity="inhibited"]')).toBe(`Inhibited ${STAT_UNAVAILABLE_TEXT}`);
  });
});

describeDom("StatHeader — unavailable coverage and engine", () => {
  test("missing coverage renders 'Coverage unavailable', never zero gaps", async () => {
    const snapshot = makeOverviewSnapshot({ includeCoverage: false });
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    const group = root.querySelector('[data-stat="coverage"]')!;
    expect(group.getAttribute("data-availability")).toBe("unavailable");
    const cov = text(root, '[data-stat="coverage"]');
    expect(cov).toContain("Coverage unavailable");
    expect(cov).not.toContain("Gaps");
    expect(cov).not.toMatch(/\b0\b/);
  });

  test("missing engine renders 'Engine unavailable', never OK", async () => {
    const snapshot = makeOverviewSnapshot({ engineAvailable: false });
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    const engine = text(root, '[data-stat="engine"]');
    expect(engine).toContain("Engine unavailable");
    expect(engine).not.toContain("Engine OK");
    expect(root.querySelector('[data-stat="engine"] [data-slot="status-badge"]')?.getAttribute("data-status")).toBe("unknown");
  });

  test("engine reporting not OK renders 'Engine not OK' with a non-OK status", async () => {
    const base = makeOverviewSnapshot();
    const snapshot: OverviewSnapshotV2 = { ...base, engine: { ...base.engine, value: { ok: false } } };
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    expect(text(root, '[data-stat="engine"]')).toContain("Engine not OK");
    expect(root.querySelector('[data-stat="engine"] [data-slot="status-badge"]')?.getAttribute("data-status")).toBe("critical");
  });

  test("stale retained engine ok:true is unavailable with last-good time, never OK", async () => {
    const base = makeOverviewSnapshot();
    const snapshot: OverviewSnapshotV2 = {
      ...base,
      engine: { availability: stale("victoriametrics-buildinfo", STALE_AT), value: { ok: true } },
    };
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    const engine = text(root, '[data-stat="engine"]');
    expect(engine).toContain("Engine unavailable");
    expect(engine).not.toContain("Engine OK");
    expect(engine).toContain(`Last good ${STALE_AT_TEXT}`);
  });

  test("not-configured engine says so and is not OK", async () => {
    const base = makeOverviewSnapshot();
    const snapshot: OverviewSnapshotV2 = {
      ...base,
      engine: { availability: { state: "not-configured", source: "victoriametrics-buildinfo", lastGoodAt: null, message: null }, value: null },
    };
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    expect(text(root, '[data-stat="engine"]')).toContain("Engine not configured");
  });

  test("retained stale coverage keeps counts with a stale qualifier and last-good time", async () => {
    const base = makeOverviewSnapshot();
    const snapshot: OverviewSnapshotV2 = {
      ...base,
      coverage: { availability: stale("rendered-estate", STALE_AT), value: { covered: 10, gaps: 0, extras: 0 } },
    };
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    expect(root.querySelector('[data-stat="coverage"]')?.getAttribute("data-availability")).toBe("retained");
    const cov = text(root, '[data-stat="coverage"]');
    expect(cov).toContain("Gaps 0");
    expect(cov).toContain(`Stale — Last good ${STALE_AT_TEXT}`);
  });
});

describeDom("StatHeader — surface and timezone", () => {
  test("ready exposes data-surface and renders no feed line (the shell's indicator owns freshness)", async () => {
    const snapshot = makeOverviewSnapshot();
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    const header = root.querySelector('section[aria-label="Estate statistics"]')!;
    expect(header.getAttribute("data-surface")).toBe("ready");
    expect(root.querySelector("[data-feed]")).toBeNull();
    expect(root.querySelector("[role='status']")).toBeNull();
    expect(root.textContent).not.toContain("Updated");
    expect(root.textContent).not.toContain("Live");
  });

  test("stale exposes data-surface=stale and keeps counts unchanged without a feed line", async () => {
    const snapshot = makeOverviewSnapshot();
    const stats = deriveOverviewStats(snapshot);
    const surface: OverviewSurfaceState = { status: "stale", snapshot, stale: true, lastGoodAt: Date.parse(STALE_AT) };
    const root = await mountHeader(stats, surface);
    expect(root.querySelector('section[aria-label="Estate statistics"]')?.getAttribute("data-surface")).toBe("stale");
    expect(root.querySelector("[data-feed]")).toBeNull();
    // Stale is historical context: nothing is promoted to OK.
    expect(statusCountText(root, "hosts", "ok")).toContain(String(DEFAULT_HOST_STATUS_COUNTS.ok));
    expect(statusCountText(root, "hosts", "unknown")).toContain(String(DEFAULT_HOST_STATUS_COUNTS.unknown));
  });

  test("the stat header never repeats the UTC fallback marker (the page header meta owns it)", async () => {
    const snapshot = makeOverviewSnapshot();
    const clock = createEstateClock({ name: "x", timezone: "UTC", tzFallback: true });
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot), clock);
    expect(root.querySelector("[data-tz-fallback]")).toBeNull();
    expect(root.textContent).not.toContain(TZ_FALLBACK_MARKER);
  });

  test("every stat group is a named group", async () => {
    const snapshot = makeOverviewSnapshot();
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    const groups = Array.from(root.querySelectorAll("[role='group']")).map((g) => [g.getAttribute("data-stat"), g.getAttribute("aria-label")]);
    expect(groups).toEqual([
      ["hosts", "Hosts"], ["services", "Services"], ["firing", "Firing alerts"], ["coverage", "Coverage"], ["engine", "Engine"],
    ]);
  });

  test("the header exposes no mutation control", async () => {
    const snapshot = makeOverviewSnapshot();
    const root = await mountHeader(deriveOverviewStats(snapshot), ready(snapshot));
    expect(root.querySelectorAll("button, a, [role='button'], form, input").length).toBe(0);
  });
});

describeDom("OverviewSurfaceNotice — no accepted snapshot", () => {
  test("loading renders the explicit not-ready copy with no grid and no reload action", async () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const surface = deriveOverviewSurfaceState(store);
    expect(surface.status).toBe("loading");
    if (surface.status !== "loading") return;
    const reloads: number[] = [];
    const root = await mountVNode(createElement(OverviewSurfaceNotice, { surface, onReload: () => reloads.push(1) }) as unknown as ReactElement);
    expect(root.querySelector("[data-surface='loading']")?.getAttribute("aria-busy")).toBe("true");
    const status = root.querySelector("[data-surface='loading'] [role='status'][aria-busy='true']");
    expect(status?.textContent).toContain(OVERVIEW_LOADING_MESSAGE);
    expect(root.querySelector("[data-overview-target]")).toBeNull();
    expect(root.querySelector("button")).toBeNull();
  });

  test("unavailable renders the shared EmptyState with a Reload action calling the injected callback", async () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    setConnection(store, { phase: "stale", failingSince: Date.parse(STALE_AT) });
    const surface = deriveOverviewSurfaceState(store);
    expect(surface.status).toBe("unavailable");
    if (surface.status !== "unavailable") return;
    const reloads: number[] = [];
    const root = await mountVNode(createElement(OverviewSurfaceNotice, { surface, onReload: () => reloads.push(1) }) as unknown as ReactElement);
    const empty = root.querySelector("[data-surface='unavailable'] [data-slot='empty-state']");
    expect(empty).not.toBeNull();
    expect(empty?.getAttribute("role")).toBe("status");
    expect(empty?.querySelector("p")?.textContent).toBe(OVERVIEW_UNAVAILABLE_TITLE);
    expect(root.textContent).toContain(OVERVIEW_UNAVAILABLE_MESSAGE);
    const buttons = Array.from(root.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual([RELOAD_OVERVIEW_LABEL]);
    act(() => {
      buttons[0]!.click();
    });
    expect(reloads).toEqual([1]);
  });
});

// ── Coherence: header, ribbon and grid over one store commit ────────────────────────────────────

interface HarnessProps {
  readonly store: AppStore;
  readonly holder: { model: OverviewModel | undefined };
}

const TRACKER = createChangeTracker();

/** Test-side composition mirroring the view: one surface, one model, three consumers. */
function Harness(props: HarnessProps): ReactElement | null {
  const surface = deriveOverviewSurfaceState(props.store);
  if (surface.status !== "ready" && surface.status !== "stale") return null;
  const snapshot = surface.snapshot;
  const previous = props.holder.model;
  const model = previous === undefined
    ? deriveOverviewModel(snapshot, DEFAULT_OVERVIEW_PREFERENCES)
    : deriveOverviewModel(snapshot, DEFAULT_OVERVIEW_PREFERENCES, previous);
  props.holder.model = model;
  const router = { navigate() {}, current() { throw new Error("unused"); }, subscribe: () => () => {}, stop() {} };
  return createElement("div", null,
    createElement(StatHeader, { stats: model.stats, surface, clock: CLOCK }),
    createElement(FiringRibbon, {
      alerts: model.firing, router, clock: CLOCK, kiosk: false,
      alertsCurrent: snapshot.sources.alerts.ok, alertsLastGoodAt: snapshot.sources.alerts.lastSuccess,
    }),
    createElement(OverviewGrid, {
      model, estateName: FIXTURE_ESTATE.name, collapsedGroupIds: new Set<string>(), selectedTargetId: null,
      wallboard: false, changeTracker: TRACKER, reducedMotion: true, onToggleGroup() {}, onSelect() {},
    }),
  ) as unknown as ReactElement;
}

function gridStatusCount(root: ParentNode, kind: "host" | "service", status: TargetStatus): number {
  return root.querySelectorAll(`[data-overview-target][data-target-kind="${kind}"][data-status="${status}"]`).length;
}

function assertCoherent(root: ParentNode, snapshot: OverviewSnapshotV2): void {
  const stats = deriveOverviewStats(snapshot);
  for (const status of OVERVIEW_STATUS_ORDER) {
    expect(statusCountText(root, "hosts", status)).toContain(String(stats.hosts[status]));
    expect(gridStatusCount(root, "host", status)).toBe(stats.hosts[status]);
    expect(statusCountText(root, "services", status)).toContain(String(stats.services[status]));
    expect(gridStatusCount(root, "service", status)).toBe(stats.services[status]);
  }
  const fingerprints = Array.from(root.querySelectorAll("[data-ribbon] li[data-fingerprint]")).map((li) => li.getAttribute("data-fingerprint"));
  expect(fingerprints).toEqual(snapshot.alerts.map((a) => a.fingerprint));
}

describeDom("StatHeader — coherence with grid and ribbon", () => {
  test("header, ribbon and grid show the same cycle after each store commit", async () => {
    // The change-marker timer uses globalThis.setTimeout; keep it inert (no wall-clock waits).
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;
    try {
      const store = createAppStore({ storage: null, initialQuery: {} });
      const holder: HarnessProps["holder"] = { model: undefined };
      const cycle1 = makeOverviewSnapshot();
      store.snapshot.value = cycle1;
      setConnection(store, { phase: "live", lastGoodAt: Date.parse(cycleInstant(1)), observation: observation(1) }, CURRENT);
      const root = await mountVNode(createElement(Harness, { store, holder }) as unknown as ReactElement);
      expect(root.querySelector('section[aria-label="Estate statistics"]')?.getAttribute("data-surface")).toBe("ready");
      assertCoherent(root, cycle1);

      // Cycle 2: one service goes critical in a single commit.
      const cycle2 = withTargetStatus(cycle1, FIXTURE_IDS.okService, "critical", 2);
      act(() => {
        store.snapshot.value = cycle2;
        setConnection(store, { lastGoodAt: Date.parse(cycleInstant(2)), observation: observation(2) });
        render(createElement(Harness, { store, holder }), root);
      });
      assertCoherent(root, cycle2);
      expect(statusCountText(root, "services", "critical")).toContain(String(DEFAULT_SERVICE_STATUS_COUNTS.critical + 1));

      // Failed refresh: the retained cycle stays coherent and stale; nothing is promoted.
      act(() => {
        setConnection(store, { phase: "stale" }, STALE);
        render(createElement(Harness, { store, holder }), root);
      });
      expect(root.querySelector('section[aria-label="Estate statistics"]')?.getAttribute("data-surface")).toBe("stale");
      expect(root.querySelector("[data-feed]")).toBeNull();
      assertCoherent(root, cycle2);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test("one source's stale evidence changes only the governed target's bucket", async () => {
    const base = makeOverviewSnapshot();
    const degraded = makeOverviewSnapshot({
      targetAvailability: { [FIXTURE_IDS.okService]: stale("victoriametrics-targets", STALE_AT) },
    });
    const a = deriveOverviewStats(base);
    const b = deriveOverviewStats(degraded);
    // The stale ok service (and its owning host rollup) move ok → unknown; nothing else changes.
    expect(b.services).toEqual({ ...a.services, ok: a.services.ok - 1, unknown: a.services.unknown + 1 });
    expect(b.hosts).toEqual({ ...a.hosts, ok: a.hosts.ok - 1, unknown: a.hosts.unknown + 1 });
    const root = await mountHeader(b, ready(degraded));
    expect(statusCountText(root, "services", "unknown")).toContain(String(a.services.unknown + 1));
    expect(text(root, '[data-stat="engine"]')).toContain("Engine OK");
    expect(text(root, '[data-stat="coverage"]')).toContain(`Gaps ${degraded.coverage.value!.gaps}`);
  });
});
