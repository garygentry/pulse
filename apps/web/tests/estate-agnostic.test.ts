// apps/web/tests/estate-agnostic.test.ts — the estate-agnostic proof (SC-8, REQ-GRID-04,
// 08-testing-strategy.md §9, REQ-PKG-03). Runs the FULL load → build → render path against two
// structurally different committed fixtures and asserts a correct result for BOTH with ZERO app-code
// changes: no estate name, host, or domain is baked into the app — the SAME code that renders the
// seeded home-estate renders these. No branch on estate identity exists anywhere in the path.
//
//   §9.1  alt-estate  — a different estate.name + a different collection-class mix (managed-linux +
//                       hypervisor-api + a deep-health service): every declared host/service appears,
//                       the shell shows the alt name, class-appropriate deep-links resolve.
//   §9.2  zero-hosts  — a valid model declaring zero hosts: the full path yields the explicit
//                       "no hosts declared" state (REQ-GRID-04), never an error or a blank grid.
//
// happy-dom is registered in THIS file's own beforeAll (no bunfig.toml under apps/web).

import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerHappyDom, unregisterHappyDom } from "./happy-dom.js";

import { loadEstateModel } from "../src/server/estate/load.js";
import { buildSnapshot, type SourceData } from "../src/server/snapshot/build.js";
import type { LiveSeries, RawActiveAlert, RawCheckStatus } from "../src/server/sources/types.js";
import type { OverviewSnapshot, SourceHealth } from "../src/shared/snapshot.js";
import type { WebEstateModel } from "@pulse/renderer";
import { NOW, ok } from "./factories.js";

// ── happy-dom registration (shared registrar — item 013) ─────────────────────────────────────────
// registerHappyDom/unregisterHappyDom snapshot Bun's true natives at module-load time and restore them
// in afterAll, so the fetch/Response-based suites (sources/poll/routes) never observe happy-dom's
// clobbered globals once this file's window is closed.
beforeAll(() => {
  registerHappyDom();
});

afterAll(async () => {
  await unregisterHappyDom();
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dir, "fixtures");

/** The config-derived scalars the pure build needs; Grafana origin set so deep-links resolve (§9.1). */
const CFG = {
  appVersion: "0.0.0-dev",
  timezone: "America/Chicago",
  tzFallback: false,
  grafanaOrigin: "https://grafana.example",
  gatusStaleSeconds: 300,
} as const;

/** Build the real `SourceData` bundle `buildSnapshot` consumes (NOT the factory `SourceDataFixture`,
 *  which is a different shape). All sources healthy unless overridden. */
function sourceData(over: {
  liveness?: LiveSeries[];
  alerts?: RawActiveAlert[];
  checks?: RawCheckStatus[];
  health?: Partial<{ metrics: SourceHealth; alerts: SourceHealth; checks: SourceHealth }>;
} = {}): SourceData {
  return {
    liveness: { series: over.liveness ?? [], health: over.health?.metrics ?? ok(NOW) },
    alerts: { active: over.alerts ?? [], health: over.health?.alerts ?? ok(NOW) },
    checks: { endpoints: over.checks ?? [], health: over.health?.checks ?? ok(NOW) },
  };
}

/** Load a committed fixture through the REAL load/validate path (never a hand-built model). */
async function loadFixture(name: string): Promise<WebEstateModel> {
  const result = await loadEstateModel(join(FIXTURES, name, "web-estate-model.json"));
  if (!result.ok) throw new Error(`fixture ${name} failed to load: ${result.error.message}`);
  return result.model;
}

/** Render the UNMODIFIED overview `OverviewGrid` over the built snapshot — the same grid the overview
 *  view mounts, driven through the pure `deriveOverviewModel` with default preferences. Direct-mount
 *  avoids the App shell's `useEffect` timers, which are flaky under shared-process happy-dom. Imports
 *  are lazy so happy-dom globals are installed first. */
async function renderGrid(snapshot: OverviewSnapshot): Promise<HTMLElement> {
  const { createElement: h } = await import("react");
  const { render } = await import("./react-render.js");
  const { OverviewGrid } = await import("../src/client/views/overview/grid/OverviewGrid.js");
  const { deriveOverviewModel } = await import("../src/client/views/overview/selectors.js");
  const { createChangeTracker } = await import("../src/client/views/overview/grid/change-marker.js");
  const { DEFAULT_OVERVIEW_PREFERENCES } = await import("../src/client/views/overview/model.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(
    h(OverviewGrid, {
      model: deriveOverviewModel(snapshot, DEFAULT_OVERVIEW_PREFERENCES),
      estateName: snapshot.estate.name,
      collapsedGroupIds: new Set<string>(),
      selectedTargetId: null,
      wallboard: false,
      changeTracker: createChangeTracker(),
      reducedMotion: false,
      onToggleGroup: () => {},
      onSelect: () => {},
    }),
    container as unknown as Element,
  );
  return container;
}

// ── §9.1 Structurally different estate (alt-estate) ────────────────────────────────────────────────

describe("estate-agnostic: alt-estate (SC-8, §9.1)", () => {
  // Observed liveness series so every host/service is affirmatively alive AND its deep-link resolves.
  const series: LiveSeries[] = [
    { name: "up", labels: { host: "builder", instance: "builder" }, value: 1 }, // managed-linux
    { name: "up", labels: { host: "hv1", instance: "hv1" }, value: 1 }, // hypervisor-api
    { name: "pulse_deep_health_up", labels: { host: "builder", service: "ci" }, value: 1 }, // deep-health svc
  ];

  test("build folds the alt estate with zero app-code change (name, hosts, service, deep-links)", async () => {
    const model = await loadFixture("alt-estate");
    const snap = buildSnapshot(model, sourceData({ liveness: series }), new Date(NOW), CFG);

    // Estate identity derives from the model, never from the app (REQ-GRID-05).
    expect(snap.estate.name).toBe("lab-estate");

    // Every declared host is present, in model order (REQ-GRID-01/02) — membership is the model.
    expect(snap.hosts.map((host) => host.name)).toEqual(["builder", "hv1"]);

    const builder = snap.hosts.find((host) => host.name === "builder")!;
    const hv1 = snap.hosts.find((host) => host.name === "hv1")!;

    // The declared service appears nested under its owning host.
    expect(builder.services.map((service) => service.name)).toEqual(["ci"]);

    // All affirmatively alive (no alerts) → ok.
    expect(builder.status).toBe("ok");
    expect(hv1.status).toBe("ok");
    expect(builder.services[0]!.status).toBe("ok");

    // Class-appropriate deep-links resolve from OBSERVED labels (REQ-DRILL-02/03), per class.
    expect(builder.grafana?.url).toBe("https://grafana.example/d/pulse-host?var-instance=builder");
    expect(hv1.grafana?.url).toBe("https://grafana.example/d/pulse-hypervisor?var-instance=hv1");
    expect(builder.services[0]!.grafana?.url).toBe(
      "https://grafana.example/d/pulse-deephealth?var-service=ci",
    );
  });

  test("the full client render path shows the alt estate name + every host/service, no app change", async () => {
    const model = await loadFixture("alt-estate");
    const snap = buildSnapshot(model, sourceData({ liveness: series }), new Date(NOW), CFG);
    const container = await renderGrid(snap);

    // The grid names the ALT estate (REQ-GRID-05) — nothing baked into the app.
    expect(container.querySelector('[role="grid"]')?.getAttribute("aria-label")).toContain("lab-estate");

    // Every declared host renders exactly one cell (grouped by class, so order follows the groups);
    // the declared service renders its indicator.
    const cellNames = Array.from(container.querySelectorAll('[data-slot="overview-host-name"]')).map((n) => n.textContent);
    expect([...cellNames].sort()).toEqual(["builder", "hv1"]);
    const svcNames = Array.from(container.querySelectorAll('[data-slot="overview-chip-name"]')).map((n) => n.textContent);
    expect(svcNames).toContain("ci");

    // A populated estate is NOT the zero-host state.
    expect(container.querySelector('[data-slot="overview-grid-empty"]')).toBeNull();
  });
});

// ── §9.2 Zero-host case (zero-hosts) ──────────────────────────────────────────────────────────────

describe("estate-agnostic: zero-hosts (REQ-GRID-04, SC-8 §9.2)", () => {
  test("a valid zero-host model builds an empty-hosts snapshot", async () => {
    const model = await loadFixture("zero-hosts");
    const snap = buildSnapshot(model, sourceData(), new Date(NOW), CFG);
    expect(snap.estate.name).toBe("empty-estate");
    expect(snap.hosts).toEqual([]);
    // The alerts strip / sources are still coherent — a zero-host estate is not an error.
    expect(snap.sources.metrics.ok).toBe(true);
  });

  test("the full render path yields the explicit no-hosts state — never a blank or errored grid", async () => {
    const model = await loadFixture("zero-hosts");
    const snap = buildSnapshot(model, sourceData(), new Date(NOW), CFG);
    const container = await renderGrid(snap);

    // The explicit zero-host state renders (shared EmptyState); no host cells, no grid frame.
    const empty = container.querySelector('[data-slot="overview-grid-empty"]');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("No hosts in this estate");
    expect(container.querySelectorAll('[data-slot="overview-host"]').length).toBe(0);
    expect(container.querySelector('[role="grid"]')).toBeNull();
  });
});
