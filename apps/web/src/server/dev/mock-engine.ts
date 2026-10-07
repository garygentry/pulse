// src/server/dev/mock-engine.ts — the fetch-shaped mock engine for the dev loop.
//
// Given a loaded scenario, produces a `fetch`-shaped function the server runtime uses as its
// `deps.fetchImpl` seam. Routes requests by base URL origin + fixed path to the four source
// bodies from the scenario's current fold (`applyTimeline`); Gatus bodies are re-stamped to the
// current wall clock (`freshenGatus`) so a frozen fixture stays under the 300s staleness rule
// (spec 05 §2.3–§2.4). Never throws synchronously — an outage is a rejected promise shaped like a
// real connection failure, an unknown path is a 404 JSON response.

import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { FetchLike } from "../sources/types.js";
import { DEFAULT_SCENARIO_DIR, SCENARIO_FILES, loadScenario } from "./scenario.js";
import { applyTimeline, freshenGatus, type MockSource, type ScenarioState } from "./timeline.js";

/** The four fixed engine sources the dev loop routes (REQ-MOCK-02, 00 §3); re-exported here per
 *  spec 00 §3.1's home-file promise. Leaf value union lives in `./timeline.js` so item 013 could
 *  ship without 014. */
export type { MockSource } from "./timeline.js";

/** Placeholder base URLs the mock engine routes on (REQ-MOCK-08, 00 §3). RFC 2606 `.invalid` can
 *  never resolve, so a request that escapes the mock fails loudly instead of reaching a real host. */
export const MOCK_BASE_URLS = {
  vmUrl: "http://vm.mock.invalid",
  alertmanagerUrl: "http://alertmanager.mock.invalid",
  gatusUrl: "http://gatus.mock.invalid",
  vmalertUrl: "http://vmalert.mock.invalid",
} as const;

/** Env overlay that points `loadServerConfig` at the mock engine. Keys are the env-var names
 *  `config.ts` reads (`ENV` in `src/shared/constants.ts`). Merged OVER `process.env` in the
 *  dev root; `process.env` itself is never mutated. Includes `PULSE_VMALERT_URL` (00 §3). */
export const MOCK_ENV: Record<string, string> = {
  PULSE_VM_URL: MOCK_BASE_URLS.vmUrl,
  PULSE_ALERTMANAGER_URL: MOCK_BASE_URLS.alertmanagerUrl,
  PULSE_GATUS_URL: MOCK_BASE_URLS.gatusUrl,
  PULSE_VMALERT_URL: MOCK_BASE_URLS.vmalertUrl,
};

/** The exact request paths each source is served at. VM/Alertmanager/Gatus mirror the real client
 *  paths (`sources/vm.ts`, `sources/alertmanager.ts`, `sources/gatus.ts`); vmalert serves the
 *  `/api/v1/rules` catalog (00 §4.1). Query strings are ignored when matching. */
export const MOCK_PATHS: Record<MockSource, string> = {
  vm: "/api/v1/query",
  alertmanager: "/api/v2/alerts",
  gatus: "/api/v1/endpoints/statuses",
  vmalert: "/api/v1/rules",
};

/** The scenarios this member ships (REQ-MOCK-03). `listScenarios()` must return a superset. */
export const SCENARIO_NAMES = ["all-green", "degraded-mix", "source-outage"] as const;
/** `--mock` with no value (REQ-MOCK-03). */
export const DEFAULT_SCENARIO = "all-green" as const;

/** Options for `createMockEngine`. */
export interface MockEngineOptions {
  /** Named mock scenario to load. */ scenario: string;
  /** Override fixtures directory; defaults to the bundled engine fixtures. */ fixturesDir?: string;
  /** Injected process start epoch milliseconds. */ startedAt?: number;
  /** Injected epoch-ms clock for deterministic timelines. */ now?: () => number;
}

/** A running mock engine — a `fetch`-shaped function plus a peek at the current scenario fold. */
export interface MockEngine {
  /** Scenario name. */
  readonly scenario: string;
  /**
   * The injected fetch handed to `createServerRuntime` (spec 05 §2.3). Never throws
   * synchronously; an outage is a rejected promise (`TypeError("fetch failed: mock outage")`), an
   * unknown path a 404 JSON response.
   */
  readonly fetchImpl: FetchLike;
  /** Scenario state at the current clock — exposed for tests. */
  state(): ScenarioState;
}

const ORIGIN_TO_SOURCE: ReadonlyMap<string, MockSource> = new Map([
  [new URL(MOCK_BASE_URLS.vmUrl).origin, "vm"],
  [new URL(MOCK_BASE_URLS.alertmanagerUrl).origin, "alertmanager"],
  [new URL(MOCK_BASE_URLS.gatusUrl).origin, "gatus"],
  [new URL(MOCK_BASE_URLS.vmalertUrl).origin, "vmalert"],
]);

/**
 * Load a scenario and build its fetch-shaped engine.
 */
export async function createMockEngine(opts: MockEngineOptions): Promise<MockEngine> {
  const fixturesDir = opts.fixturesDir ?? DEFAULT_SCENARIO_DIR;
  const now = opts.now ?? Date.now;
  const scenario = await loadScenario(fixturesDir, opts.scenario);
  const startedAt = opts.startedAt ?? now();

  const state = (): ScenarioState =>
    applyTimeline(scenario.base, scenario.timeline, Math.max(0, now() - startedAt));

  const fetchImpl = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const signal = init?.signal;
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      throw reason instanceof Error
        ? reason
        : new DOMException("The operation was aborted.", "AbortError");
    }

    let url: URL;
    try {
      const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      url = new URL(target);
    } catch {
      return notFound();
    }

    const source = ORIGIN_TO_SOURCE.get(url.origin);
    if (source === undefined) return notFound();
    if (normalizePath(url.pathname) !== MOCK_PATHS[source]) return notFound();

    const current = state();
    if (current.outages.has(source)) {
      // Match `describeFetchError` (`sources/types.ts:85`) so the observable error string is
      // stable and short. `fetch failed:` prefix mirrors a real connection refusal.
      throw new TypeError("fetch failed: mock outage");
    }

    let body: unknown;
    switch (source) {
      case "vm":
        body = current.vm;
        break;
      case "alertmanager":
        body = current.alertmanager;
        break;
      case "gatus":
        body = freshenGatus(current.gatus, now());
        break;
      case "vmalert":
        body = current.vmalert;
        break;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    });
  };

  // `FetchLike = typeof fetch` demands Bun's `.preconnect` static; we don't need it here because
  // callers (`createVmClient` etc.) never touch it. Bolt it on as a no-op so the type holds.
  const fetch = Object.assign(fetchImpl, {
    preconnect: (_url: string | URL, _options?: { dnsCache?: boolean; tcpConnect?: boolean; http?: boolean; https?: boolean }): void => {},
  }) as unknown as FetchLike;

  return { scenario: scenario.name, fetchImpl: fetch, state };
}

/**
 * Directory names under `dir` (default `DEFAULT_SCENARIO_DIR`) that carry the four required
 * source files. Sorted ascending; missing/unreadable directory → `[]` (never throws).
 */
export async function listScenarios(dir?: string): Promise<string[]> {
  const fixturesDir = dir ?? DEFAULT_SCENARIO_DIR;
  let entries: string[];
  try {
    entries = (await readdir(fixturesDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    const required = [
      SCENARIO_FILES.vm,
      SCENARIO_FILES.alertmanager,
      SCENARIO_FILES.gatus,
      SCENARIO_FILES.vmalert,
    ];
    const ok = await Promise.all(
      required.map((f) => stat(resolve(fixturesDir, name, f)).then(() => true, () => false)),
    );
    if (ok.every(Boolean)) found.push(name);
  }
  return found.sort();
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function notFound(): Response {
  return new Response('{"error":"not found"}', {
    status: 404,
    statusText: "Not Found",
    headers: { "content-type": "application/json" },
  });
}
