// agent/tests/golden/scenarios.ts
//
// Shared hermetic golden scenarios for the authoritative prober suite (item 015;
// 06-testing-strategy.md §3, §8). Both the deliberate golden-update helper
// (`agent/tests/golden-update.ts`) and the golden compare in `agent/tests/prober.test.ts`
// import `SCENARIOS` + `renderScenario` from here, so the committed `*.exposition.txt`
// goldens are, by construction, exactly what the test asserts — the renderer's
// reviewable golden workflow (packages/renderer/tests/golden-update.ts), applied to
// prober exposition text.
//
// Every scenario drives the REAL pipeline end to end:
//   loadProberConfig(<golden config.yaml>)  →  runCycle(probes, { fetch: stub, env })
//     →  pin the clock on the outcomes  →  MetricStore.record  →  store.render()
// The `fetch`/`env` seams are injected (ProbeOptions, 02 §4.1) and the clock is pinned at
// the outcome boundary, so the output is fully deterministic and NO real network or ambient
// env read ever happens. A scenario may fold MULTIPLE cycles into one store (the last-good
// retention case) — the golden is the final render.

import { resolve } from "node:path";

import { loadProberConfig } from "../../prober/src/config.js";
import { runCycle } from "../../prober/src/probe.js";
import type { ProbeOutcome } from "../../prober/src/probe-outcome.js";
import { MetricStore } from "../../prober/src/metrics.js";

/** Directory holding the committed golden `*.config.yaml` inputs + `*.exposition.txt` goldens. */
export const GOLDEN_DIR = import.meta.dir;

/** A canned stub-`fetch` response for one probe target within one cycle. */
export type ResponseSpec =
  | { kind: "json"; body: unknown; status?: number } // 200 (or `status`) with a JSON body
  | { kind: "bad-json" } // 200 whose body is not JSON → reason "bad-json"
  | { kind: "unreachable" } // transport rejection → reason "unreachable"
  | { kind: "timeout" }; // never resolves; rejects on abort → reason "timeout"

/** One probe cycle: a URL → response routing table for the stub `fetch`. */
export interface CycleSpec {
  responses: Record<string, ResponseSpec>;
}

/** A committed golden scenario: a config input, an ordered set of cycles, and the expected
 *  exposition text after all cycles are folded into a single {@link MetricStore}. */
export interface Scenario {
  /** Stable case name; also the `<name>.config.yaml` / `<name>.exposition.txt` stem. */
  name: string;
  /** One-line description surfaced by the golden-update helper. */
  description: string;
  /** Env map for credential resolution (test seam); omitted for unauthenticated scenarios. */
  env?: Record<string, string | undefined>;
  /** The fixed Unix-seconds timestamp pinned onto every successful outcome (clock seam). */
  fixedScrapedAt: number;
  /** Per-probe timeout override (ms) — only relevant to scenarios exercising a timeout. */
  timeoutMs?: number;
  /** The cycles to fold, in order. */
  cycles: CycleSpec[];
}

/** The committed golden config path for a scenario. */
export function scenarioConfigPath(s: Scenario): string {
  return resolve(GOLDEN_DIR, `${s.name}.config.yaml`);
}

/** The committed golden exposition path for a scenario. */
export function scenarioExpositionPath(s: Scenario): string {
  return resolve(GOLDEN_DIR, `${s.name}.exposition.txt`);
}

/** Build a hermetic stub `fetch` that routes by URL to a {@link ResponseSpec}. An unrouted URL
 *  rejects (a stub gap surfaces as a probe failure, never a silent success). */
function buildFetch(responses: Record<string, ResponseSpec>): typeof fetch {
  return ((input: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
    const url = String(input);
    const spec = responses[url];
    if (spec === undefined) {
      return Promise.reject(new TypeError(`no stub response for ${url}`));
    }
    switch (spec.kind) {
      case "json":
        return Promise.resolve(
          new Response(JSON.stringify(spec.body), {
            status: spec.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        );
      case "bad-json":
        return Promise.resolve(
          new Response("<html>not json</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      case "unreachable":
        return Promise.reject(new TypeError("connect ECONNREFUSED"));
      case "timeout":
        // Never resolve on its own; reject with the abort reason when the bounded
        // AbortSignal.timeout fires — mirroring how the runtime aborts a hung request.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
    }
  }) as unknown as typeof fetch;
}

/** Pin every successful outcome's clock to `fixedScrapedAt` so the exposition is byte-stable
 *  (the clock seam — `runProbe` stamps `Math.floor(Date.now()/1000)`, non-deterministic). */
function pinClock(outcomes: ProbeOutcome[], fixedScrapedAt: number): ProbeOutcome[] {
  return outcomes.map((o) => (o.ok ? { ...o, scrapedAt: fixedScrapedAt } : o));
}

/**
 * Drive a scenario through the real prober pipeline and return the deterministic exposition
 * text. Reads the committed golden config, runs each cycle under the injected stub `fetch`
 * (and `env`), pins the clock at the outcome boundary, folds the pinned outcomes into a single
 * {@link MetricStore}, and returns `store.render()`.
 */
export async function renderScenario(s: Scenario): Promise<string> {
  const probes = await loadProberConfig(scenarioConfigPath(s));
  const store = new MetricStore();
  for (const cycle of s.cycles) {
    const options: Parameters<typeof runCycle>[1] = {
      fetch: buildFetch(cycle.responses),
      ...(s.env !== undefined ? { env: s.env } : {}),
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
    };
    const outcomes = await runCycle(probes, options);
    store.record(pinClock(outcomes, s.fixedScrapedAt));
  }
  return store.render();
}

/** A stable pinned timestamp for the golden exposition (matches the tech-spec §4.2 example). */
const FIXED_SCRAPED_AT = 1734300000;

/** The authoritative golden registry. Each entry has a committed `<name>.config.yaml` input
 *  and a committed `<name>.exposition.txt` golden regenerated by `golden-update.ts`. */
export const SCENARIOS: Scenario[] = [
  {
    name: "healthy",
    description:
      "healthy JSON mapping across two hosts/services, multi-metric ordering, numeric-string coercion, non-deep-health kinds ignored",
    fixedScrapedAt: FIXED_SCRAPED_AT,
    cycles: [
      {
        responses: {
          "http://web01:5000/api/health": { kind: "json", body: { cameras: { recording: 4 } } },
          // grafana: db_connections arrives as a numeric STRING ("12") → coerced to 12.
          "http://app02:3000/api/health": {
            kind: "json",
            body: { database: { connections: "12" }, dashboards: { count: 3 } },
          },
        },
      },
    ],
  },
  {
    name: "authed",
    description:
      "authenticated ${ENV} Bearer probe — resolved sample lands, raw ref + resolved token never enter exposition",
    env: { NVR_TOKEN: "s3cr3t-token-value" },
    fixedScrapedAt: FIXED_SCRAPED_AT,
    cycles: [
      {
        responses: {
          "http://nvr01:8080/health": { kind: "json", body: { status: { cameras_online: 6 } } },
        },
      },
    ],
  },
  {
    name: "retention",
    description:
      "one-success-then-failure: _up flips to 0 while the last-good value + timestamp are retained (not refreshed)",
    fixedScrapedAt: FIXED_SCRAPED_AT,
    cycles: [
      // Cycle 1 — success: camera_count → 4, up=1, timestamp pinned.
      {
        responses: {
          "http://web01:5000/api/health": { kind: "json", body: { cameras: { recording: 4 } } },
        },
      },
      // Cycle 2 — unreachable: up flips to 0; value + timestamp are NOT refreshed.
      {
        responses: {
          "http://web01:5000/api/health": { kind: "unreachable" },
        },
      },
    ],
  },
];
