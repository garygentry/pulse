// apps/web/tests/browser/fixtures/alerts-perf.tsx — browser fixture page for the triage-table mount
// cost (tests/browser/alerts-perf.test.ts). Bundled by _harness.buildFixturePage.
//
// Exposes `window.__alertsPerf = { mount(n), unmount() }`: mount renders the TriageTable (the @/ui
// DataTable, virtualized) over n synthetic firing rows and resolves with the ms from just before the render to the second requestAnimationFrame
// after the (synchronous) commit, read with performance.now().
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";

import { createRef } from "react";
import { signal } from "@preact/signals-core";

import type { ActiveAlert } from "@pulse/web-data/wire";
import { TriageTable } from "../../../src/client/views/alerts/table/TriageTable.js";
import { makeAlertsPayload } from "../../alerts-fixtures.js";
import { render } from "../../react-render.js";

export interface AlertsPerfApi {
  mount(n: number): Promise<number>;
  unmount(): void;
}

const SEED: readonly ActiveAlert[] = makeAlertsPayload({ scenario: "mixed" }).alerts;

/** n firing rows cloned round-robin from the `mixed` scenario, each with a unique fingerprint/name. */
function syntheticAlerts(n: number): ActiveAlert[] {
  return Array.from({ length: n }, (_, i): ActiveAlert => {
    const base = SEED[i % SEED.length]!;
    return { ...base, fingerprint: `${base.fingerprint}-${i}`, name: `${base.name}-${i}` };
  });
}

const app = document.getElementById("app");
if (app === null) throw new Error("[alerts-perf fixture] #app mount node missing");
const main = document.createElement("main");
app.appendChild(main);

/** Render `node` and resolve with the ms until the second animation frame after the commit. */
function timeMount(node: Parameters<typeof render>[0]): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    render(node, main);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
  });
}

const api: AlertsPerfApi = {
  mount(n) {
    const rows = syntheticAlerts(n);
    return timeMount(
      <TriageTable
        rows={rows}
        selectedIndex={signal(0)}
        onOpenAlert={() => undefined}
        sourcesCurrent
        containerRef={createRef<HTMLDivElement>()}
      />,
    );
  },
  unmount() {
    render(null, main);
  },
};

(window as Window & { __alertsPerf?: AlertsPerfApi }).__alertsPerf = api;
document.documentElement.dataset["fixtureReady"] = "1";
