// packages/web-data/tests/envelope.test.ts — envelope, cardinality, and body-budget evidence for
// item 058 (04-cycle-and-current-view-folds.md §13, 11-testing-strategy.md §§3, 4, 7, 10).
//
// Proves, from the deterministic sanitized fixture in fixtures/envelope/**:
//   - it contains exactly 100 hosts, 300 services, and drives the real Gatus client through a
//     standalone 511 success case and a 512 explicit-overflow case, printing seed/counts (AC1);
//   - tiny and envelope estates fold with identical fixed recurring source-call cardinality —
//     zero, because the folds are pure and never fan out per entity (AC2, package half);
//   - every current view serialized off the envelope cycle is ≤5 MiB plain and ≤1 MiB gzip, and
//     the Gatus 512 case rejects wholly with no subset salvage (AC3).
//
// Package test files are not typechecked, so mocks/fixtures use structural values freely.

import { describe, expect, test } from "bun:test";

import { buildCycleCandidate, foldCurrentViews } from "../src/cycle/fold.js";
import { createGatusClient } from "../src/sources/gatus.js";
import type { FetchLike } from "../src/sources/types.js";
import {
  CURRENT_MAX_GZIP_BYTES,
  CURRENT_MAX_PLAIN_BYTES,
  GATUS_MAX_ENDPOINTS,
  GATUS_STATUS_PAGE_SIZE,
} from "../src/wire/common.js";
import type { CycleObservation, SourceId, SourceObservation, ViewId } from "../src/wire/common.js";

import {
  ENVELOPE_HOST_COUNT,
  ENVELOPE_OBSERVED_AT,
  ENVELOPE_SERVICE_COUNT,
  describeEnvelope,
  envelopeCounts,
  envelopeInputs,
  envelopeModel,
  gatusExpected,
  gatusPage,
  tinyInputs,
} from "./fixtures/envelope/index.js";

const VIEW_IDS = ["overview", "alerts", "estate", "engine", "timeline"] as const satisfies readonly ViewId[];

const SOURCE_IDS = [
  "victoriametrics-signals",
  "victoriametrics-targets",
  "victoriametrics-buildinfo",
  "alertmanager-alerts",
  "alertmanager-silences",
  "alertmanager-status",
  "alertmanager-receivers",
  "vmalert-rules",
  "gatus-statuses",
  "grafana-health",
] as const satisfies readonly SourceId[];

function observation(seq: number, observedAt = ENVELOPE_OBSERVED_AT): CycleObservation {
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) {
    sources[id] = { state: "current", lastAttemptAt: ENVELOPE_OBSERVED_AT, lastSuccess: ENVELOPE_OBSERVED_AT };
  }
  return { generation: "gen-envelope-0001", seq, observedAt, appVersion: "1.2.3", sources };
}

const BASE = "http://gatus.internal:8080";

/** A fetch serving a raw JSON body, capturing the request URL and call count. */
function fetchReturning(body: string): { fetchImpl: FetchLike; url: () => string; calls: () => number } {
  let capturedUrl = "";
  let count = 0;
  const fetchImpl: FetchLike = (input) => {
    capturedUrl = input.toString();
    count += 1;
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  return { fetchImpl, url: () => capturedUrl, calls: () => count };
}

// ── AC1: deterministic sanitized fixture counts + 511/512 Gatus cases (printed seed/counts) ───────

describe("envelope fixture — deterministic counts and Gatus completeness cases (AC1)", () => {
  test("contains exactly 100 hosts and 300 services with printed seed/counts", () => {
    const model = envelopeModel();
    const counts = envelopeCounts();
    // Reproducibility line printed to the test log (no real estate data).
    // eslint-disable-next-line no-console
    console.log(`[envelope] ${describeEnvelope()}`);

    expect(model.hosts.length).toBe(ENVELOPE_HOST_COUNT);
    expect(model.hosts.length).toBe(100);
    expect(model.services.length).toBe(ENVELOPE_SERVICE_COUNT);
    expect(model.services.length).toBe(300);
    expect(counts.seed).toBe(20260917);

    // Deterministic: a second build is byte-identical.
    expect(JSON.stringify(envelopeModel())).toBe(JSON.stringify(model));

    // Host names/drilldownIds are unique and every service belongs to a declared host.
    const hostNames = new Set(model.hosts.map((h) => h.name));
    expect(hostNames.size).toBe(100);
    for (const s of model.services) expect(hostNames.has(s.host)).toBe(true);

    // Declared Gatus endpoint identities stay below the 512 cap ("representative kinds below 512").
    const endpoints = new Set(model.services.flatMap((s) => s.gatusEndpoints));
    expect(endpoints.size).toBeLessThan(GATUS_STATUS_PAGE_SIZE);
    expect(endpoints.size).toBe(300);
    // Contains no real estate data — only the synthetic example.com domain.
    expect(model.estate.domains).toEqual(["example.com"]);
  });

  test("the fixture is sanitized: no credentials/secret markers and only synthetic estate data", () => {
    // The whole fixture surface (model + coverage + findings + records) serialized once.
    const serialized = JSON.stringify(envelopeInputs());

    // No credential-bearing patterns anywhere. We scan for actual secret carriers (auth keys, URL
    // userinfo) rather than bare words like "secret"/"credential", because the findings fixture
    // legitimately uses those words in its sanitization *guidance* text (they are not real secrets).
    expect(serialized).not.toContain("@"); // no URL userinfo (user:pass@host)
    for (const marker of [/password/i, /authorization/i, /bearer/i, /api[_-]?key/i, /x-forwarded/i, /-----BEGIN/]) {
      expect(serialized).not.toMatch(marker);
    }

    const model = envelopeModel();
    // Every host address is RFC1918-private (synthetic), never a routable/real address.
    for (const h of model.hosts) {
      for (const addr of h.addresses) expect(addr).toMatch(/^10\./);
    }
    // Every declared service ingress host is under the synthetic `.example` domain; no real domain.
    for (const s of model.services) {
      expect(s.ingressUrl).toMatch(/^https:\/\/[a-z0-9-]+\.example$/);
    }
    // The only estate domain is the reserved example.com.
    expect(model.estate.domains).toEqual(["example.com"]);
  });

  test("the real Gatus client succeeds through a 511 expected-endpoint page", async () => {
    const page = gatusPage(GATUS_MAX_ENDPOINTS); // 511 rows
    const f = fetchReturning(page);
    const result = await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointStatuses(
      gatusExpected(GATUS_MAX_ENDPOINTS),
    );
    // eslint-disable-next-line no-console
    console.log(`[envelope] gatus 511-case rows=${GATUS_MAX_ENDPOINTS} ok=${result.ok}`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.length).toBe(511);
    expect(result.data.every((e) => e.expected)).toBe(true);
    expect(f.calls()).toBe(1); // exactly one page request
  });

  test("the real Gatus client rejects a saturated 512-row page wholly, with no subset salvage", async () => {
    const page = gatusPage(GATUS_STATUS_PAGE_SIZE); // 512 rows — saturated page ⇒ overflow
    const f = fetchReturning(page);
    const result = await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointStatuses([]);
    // eslint-disable-next-line no-console
    console.log(`[envelope] gatus 512-case rows=${GATUS_STATUS_PAGE_SIZE} ok=${result.ok}`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("overflow");
    // No truncation and no partial subset: the failure result carries no `data`.
    expect("data" in result).toBe(false);
    expect(f.calls()).toBe(1);
  });
});

// ── AC2 (package half): tiny vs envelope have identical fixed recurring source-call cardinality ──

describe("cardinality — folds are pure with zero recurring source calls (AC2)", () => {
  test("tiny and envelope estates fold with the same fixed call count: zero", () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: unknown[]) => {
      calls += 1;
      return (realFetch as unknown as (...a: unknown[]) => unknown)(...args);
    }) as unknown as typeof fetch;
    try {
      foldCurrentViews(tinyInputs());
      const afterTiny = calls;
      foldCurrentViews(envelopeInputs());
      const afterEnvelope = calls;
      expect(afterTiny).toBe(0); // tiny estate makes zero source calls
      expect(afterEnvelope - afterTiny).toBe(0); // envelope estate adds none — no per-entity fan-out
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("both estates produce the five current views deterministically", () => {
    const tiny = foldCurrentViews(tinyInputs());
    const env = foldCurrentViews(envelopeInputs());
    for (const v of VIEW_IDS) {
      expect(tiny[v]).toBeDefined();
      expect(env[v]).toBeDefined();
    }
    // Envelope estate carries all 100 hosts through the estate/overview folds (no truncation).
    expect(env.overview.hosts.length).toBe(100);
    expect(env.estate.liveTargets.length).toBeGreaterThanOrEqual(100);
    // Purity: a repeated fold is byte-identical.
    expect(JSON.stringify(foldCurrentViews(envelopeInputs()))).toBe(JSON.stringify(env));
  });
});

// ── AC3: every current route body ≤5 MiB plain and ≤1 MiB gzip (fail rather than truncate) ───────

describe("body budgets — every current view ≤5 MiB plain and ≤1 MiB gzip (AC3)", () => {
  test("the envelope cycle materializes all five views within budget", async () => {
    const result = await buildCycleCandidate(null, observation(1), envelopeInputs());
    // A successful build already proves each view is within the 5 MiB/1 MiB limits (buildCycleCandidate
    // classifies an over-budget view as a payload-limit failure rather than truncating), but assert and
    // print each size explicitly so the envelope headroom is on the record.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`envelope cycle failed to build: ${result.error.kind}/${result.error.view}`);

    for (const view of VIEW_IDS) {
      const p = result.cycle[view];
      // eslint-disable-next-line no-console
      console.log(
        `[envelope] view=${view} plain=${p.plain.bytes.byteLength}B gzip=${p.gzip.bytes.byteLength}B`,
      );
      expect(p.plain.bytes.byteLength).toBeLessThanOrEqual(CURRENT_MAX_PLAIN_BYTES);
      expect(p.gzip.bytes.byteLength).toBeLessThanOrEqual(CURRENT_MAX_GZIP_BYTES);
      expect(p.plain.bytes.byteLength).toBeGreaterThan(0);
      expect(p.plain.etag).not.toBe(p.gzip.etag); // distinct strong validators over exact bytes
    }
  });
});
