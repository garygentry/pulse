// apps/web/tests/app.test.ts — the app shell (08-view-seam-and-shell.md §4). Uses `renderWithStore`
// (`tests/dom.ts`) inside `describeDom` so happy-dom is registered per file (no bunfig.toml preload).
// Asserts the shell renders the estate name + an always-visible live/staleness pill (REQ-LIVE-02,
// REQ-GRID-05) AND — distinctly — a prominent stale-data warning that names the failing source +
// last-good-data time on refresh failure / source unreachability (REQ-LIVE-03). AppProps v2:
// { store, router, views, reloadOnce, buildId }.

import { expect, test } from "bun:test";

import { createEstateClock } from "../src/client/format.js";
import { VIEWS } from "../src/client/views/registry.js";
import type { ViewDefinition } from "../src/shared/registry.js";
import { createAppStore } from "../src/client/store/index.js";
import { createPathRouter, routesFromViews } from "../src/client/router.js";
import { describeDom, renderWithStore } from "./dom.js";
import { NOW, overviewSnapshot } from "./factories.js";
import type { OverviewSnapshot } from "../src/shared/snapshot.js";
import type { ConnectionState } from "../src/client/store/types.js";
import type { CycleObservation, SourceId, SourceObservation } from "@pulse/web-data/wire";

// Freshness now flows through `connection.observation` (08 §10): the live/staleness pill shows
// `observedAt` and the StaleDataWarning reads per-source `observation.sources`, not `snapshot.sources`.
const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];

/** A per-source observation; defaults to a fresh success at NOW. */
function srcObs(over: Partial<SourceObservation> = {}): SourceObservation {
  return { state: "current", lastAttemptAt: NOW, lastSuccess: NOW, ...over };
}

/** A cycle observation with all ten sources current at NOW, plus any per-source overrides. */
function observation(over: { sources?: Partial<Record<SourceId, SourceObservation>> } = {}): CycleObservation {
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) sources[id] = srcObs();
  for (const [id, obs] of Object.entries(over.sources ?? {})) sources[id as SourceId] = obs as SourceObservation;
  return {
    generation: "11111111-1111-4111-8111-111111111111",
    seq: 1,
    observedAt: NOW,
    appVersion: "0.0.0-dev",
    sources,
  };
}

interface ShellSeed {
  snapshot?: OverviewSnapshot | null;
  connection?: Partial<ConnectionState>;
}

async function renderShell(seed: ShellSeed = {}): Promise<HTMLElement> {
  const { App } = await import("../src/client/app.js");
  const { createElement: h } = await import("react");
  const store = createAppStore({ storage: null, initialQuery: {} });
  const win = (globalThis as { window?: Window }).window;
  const router = createPathRouter({
    routes: routesFromViews(VIEWS),
    fallback: "/overview",
    ...(win !== undefined ? { win } : {}),
  });
  store.route.value = router.current();
  if (seed.snapshot === undefined) {
    store.snapshot.value = overviewSnapshot();
  } else {
    store.snapshot.value = seed.snapshot;
  }
  if (seed.connection !== undefined) {
    store.connection.value = { ...store.connection.peek(), ...seed.connection };
  }
  const vnode = h(App, {
    store,
    router,
    views: VIEWS,
    reloadOnce: () => {},
    buildId: null,
  }) as unknown as import("react").ReactElement;
  const rendered = await renderWithStore(vnode, { store, router });
  return rendered.container;
}

describeDom("views/registry", (_dom) => {
  test("exports VIEWS: ViewDefinition[] with the overview view", () => {
    expect(Array.isArray(VIEWS)).toBe(true);
    const overview: ViewDefinition | undefined = VIEWS.find((v) => v.id === "overview");
    expect(overview).toBeDefined();
    expect(typeof overview!.load).toBe("function");
    expect(overview!.label).toBe("Overview");
  });
});

describeDom("App shell", (_dom) => {
  test("renders the estate name and an always-visible live/staleness pill (REQ-GRID-05/REQ-LIVE-02)", async () => {
    // Currentness is the cycle observation's observedAt (08 §10), not the payload's generatedAt.
    const container = await renderShell({ connection: { observation: observation() } });

    const heading = container.querySelector('[data-slot="estate-name"]');
    expect(heading?.textContent).toBe("home-estate");

    const staleness = container.querySelector('[data-slot="staleness-indicator"]');
    expect(staleness).not.toBeNull();
    expect(staleness!.textContent).toContain("07:00:00");
    expect(staleness!.textContent).toContain("CDT");
  });

  test("renders no stale-data warning when all sources are healthy", async () => {
    const container = await renderShell();
    expect(container.querySelector("[data-stale-warning]")).toBeNull();
  });

  test("renders a prominent stale-data warning naming the failing source + last-good time (REQ-LIVE-03)", async () => {
    // Alertmanager governs the "alerts" group; its stale observation drives the warning (08 §10).
    const container = await renderShell({
      connection: {
        observation: observation({
          sources: { "alertmanager-alerts": srcObs({ state: "stale", lastSuccess: NOW }) },
        }),
      },
    });

    const warning = container.querySelector("[data-stale-warning]");
    expect(warning).not.toBeNull();
    expect(warning!.getAttribute("role")).toBe("alert");

    const clock = createEstateClock(overviewSnapshot().estate);
    const lastGood = clock.format(NOW);
    expect(warning!.textContent).toContain("alerts");
    expect(warning!.textContent).toContain(lastGood);

    const staleness = container.querySelector('[data-slot="staleness-indicator"]');
    expect(staleness).not.toBeNull();
    expect(staleness).not.toBe(warning);
    expect(staleness!.contains(warning)).toBe(false);
    expect(staleness!.textContent).not.toContain("unreachable");
  });

  test("names 'never' as the last-good time when a source has never succeeded", async () => {
    // VictoriaMetrics governs "metrics"; unavailable with no prior success → "never".
    const container = await renderShell({
      connection: {
        observation: observation({
          sources: { "victoriametrics-signals": srcObs({ state: "unavailable", lastSuccess: null }) },
        }),
      },
    });

    const warning = container.querySelector('[data-stale-warning] [data-source="metrics"]');
    expect(warning).not.toBeNull();
    expect(warning!.textContent).toContain("metrics");
    expect(warning!.textContent).toContain("never");
  });

  test("raises the stale-data warning on app-server refresh failure (connection.phase='stale')", async () => {
    const container = await renderShell({
      connection: { phase: "stale", lastGoodAt: Date.parse(NOW) },
    });

    const appLine = container.querySelector('[data-stale-warning] [data-source="app"]');
    expect(appLine).not.toBeNull();
    expect(appLine!.textContent).toContain("app server unreachable");
    expect(appLine!.textContent).toContain("07:00:00");
  });
});
