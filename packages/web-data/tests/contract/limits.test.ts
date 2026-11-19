/** limits.test.ts — CONTRACT_LIMITS values and re-exports, the two trim helpers, and the overview validator's
 *  caps being read from CONTRACT_LIMITS rather than defined privately. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTRACT_LIMITS, capList, truncateUtf8, type OverviewLimits } from "../../src/contract/limits.js";
import {
  CURRENT_MAX_GZIP_BYTES, CURRENT_MAX_PLAIN_BYTES, GATUS_MAX_ENDPOINTS,
  HISTORY_MAX_BODY_BYTES, HISTORY_MAX_LABEL_KEY_BYTES, HISTORY_MAX_LABEL_VALUE_BYTES,
  HISTORY_MAX_LABELS, HISTORY_MAX_POINTS, HISTORY_MAX_SERIES,
  ENGINE_MAX_PROBLEMS, OVERVIEW_MAX_RECENT_CHECKS, validateOverviewSnapshotV2,
} from "../../src/wire/index.js";

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe("CONTRACT_LIMITS", () => {
  test("pins every trimmed-view cap", () => {
    expect(CONTRACT_LIMITS.overview).toEqual({
      hosts: 100, servicesTotal: 300, alerts: 1024, signals: 4096, recentChecks: 2048, targetChecks: 2048,
      hostAddresses: 64, engineProblems: 16, textBytes: 512, messageBytes: 1024,
    });
    expect(CONTRACT_LIMITS.alerts).toEqual({ alerts: 1024, rules: 2048, silences: 1024 });
    expect(CONTRACT_LIMITS.estate).toEqual({ liveTargets: 2048, findings: 1024, declaredVersusScraped: 4096 });
    expect(CONTRACT_LIMITS.timeline).toEqual({ targets: 2048, domains: 512, checkEndpoints: 511 });
    expect(CONTRACT_LIMITS.timeline.checkEndpoints).toBe(GATUS_MAX_ENDPOINTS);
  });

  test("history and body values are the existing wire constants", () => {
    expect(CONTRACT_LIMITS.history.series).toBe(HISTORY_MAX_SERIES);
    expect(CONTRACT_LIMITS.history.pointsPerSeries).toBe(HISTORY_MAX_POINTS);
    expect(CONTRACT_LIMITS.history.labels).toBe(HISTORY_MAX_LABELS);
    expect(CONTRACT_LIMITS.history.labelKeyBytes).toBe(HISTORY_MAX_LABEL_KEY_BYTES);
    expect(CONTRACT_LIMITS.history.labelValueBytes).toBe(HISTORY_MAX_LABEL_VALUE_BYTES);
    expect(CONTRACT_LIMITS.history.lanes).toBe(HISTORY_MAX_SERIES);
    expect(CONTRACT_LIMITS.history.intervalsPerLane).toBe(HISTORY_MAX_POINTS);
    expect(CONTRACT_LIMITS.history.endpointResults).toBe(HISTORY_MAX_POINTS);
    expect(CONTRACT_LIMITS.history.incidents).toBe(HISTORY_MAX_POINTS);
    expect(CONTRACT_LIMITS.history.bodyBytes).toBe(HISTORY_MAX_BODY_BYTES);
    expect(CONTRACT_LIMITS.body.plainBytes).toBe(CURRENT_MAX_PLAIN_BYTES);
    expect(CONTRACT_LIMITS.body.gzipBytes).toBe(CURRENT_MAX_GZIP_BYTES);
  });

  test("every value is a non-negative safe integer and the table is frozen", () => {
    expect(Object.isFrozen(CONTRACT_LIMITS)).toBe(true);
    for (const [section, caps] of Object.entries(CONTRACT_LIMITS)) {
      expect(Object.isFrozen(caps)).toBe(true);
      for (const [name, value] of Object.entries(caps)) {
        expect(`${section}.${name}:${Number.isSafeInteger(value) && value >= 0}`).toBe(`${section}.${name}:true`);
      }
    }
  });

  test("OverviewLimits accepts small caps for the same keys", () => {
    const small: OverviewLimits = { ...CONTRACT_LIMITS.overview, hosts: 1 };
    expect(Object.keys(small).sort()).toEqual(Object.keys(CONTRACT_LIMITS.overview).sort());
  });
});

describe("truncateUtf8", () => {
  test("returns the same string when it already fits", () => {
    expect(truncateUtf8("abc", 3)).toBe("abc");
    expect(truncateUtf8("abc", 100)).toBe("abc");
    expect(truncateUtf8("héllo", 6)).toBe("héllo");
    expect(truncateUtf8("", 0)).toBe("");
  });

  test("never splits a multi-byte sequence that straddles the cap", () => {
    expect(truncateUtf8("héllo", 2)).toBe("h");
    expect(truncateUtf8("héllo", 3)).toBe("hé");
    expect(truncateUtf8("€x", 3)).toBe("€");
    expect(truncateUtf8("€x", 2)).toBe("");
    expect(truncateUtf8("€x", 1)).toBe("");
  });

  test("never splits a surrogate pair", () => {
    expect(truncateUtf8("😀x", 3)).toBe("");
    expect(truncateUtf8("😀x", 4)).toBe("😀");
    expect(truncateUtf8("a😀", 4)).toBe("a");
    expect(truncateUtf8("a😀", 5)).toBe("a😀");
  });

  test("counts a lone surrogate as three bytes, like TextEncoder", () => {
    expect(bytes("\uD800")).toBe(3);
    expect(truncateUtf8("a\uD800b", 4)).toBe("a\uD800");
    expect(truncateUtf8("a\uD800b", 3)).toBe("a");
    expect(truncateUtf8("a\uDC00b", 5)).toBe("a\uDC00b");
  });

  test("cap 0 yields the empty string and no marker is ever appended", () => {
    expect(truncateUtf8("abc", 0)).toBe("");
    expect(truncateUtf8("abcdef", 3)).toBe("abc");
  });

  test("the result always fits the cap and is a prefix", () => {
    const samples = ["plain ascii text", "naïve café", "€€€€", "😀😀😀", "a\uD800b\uDC00c", "x€😀y"];
    for (const sample of samples) {
      for (let cap = 0; cap <= bytes(sample) + 1; cap += 1) {
        const out = truncateUtf8(sample, cap);
        expect(bytes(out)).toBeLessThanOrEqual(cap);
        expect(sample.startsWith(out)).toBe(true);
      }
    }
  });

  test("throws RangeError on a negative or non-integer cap, without echoing the value", () => {
    for (const cap of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => truncateUtf8("secret-text", cap)).toThrow(RangeError);
    }
    try {
      truncateUtf8("secret-text", -1);
    } catch (error) {
      expect((error as Error).message).toBe("truncateUtf8: maxBytes must be a non-negative integer");
    }
  });
});

describe("capList", () => {
  test("returns the same reference when within the cap", () => {
    const items = [1, 2, 3];
    expect(capList(items, 3)).toBe(items);
    expect(capList(items, 4)).toBe(items);
    const empty: number[] = [];
    expect(capList(empty, 0)).toBe(empty);
  });

  test("keeps the first max items, shares elements and does not mutate", () => {
    const a = { id: "a" };
    const items = [a, { id: "b" }, { id: "c" }];
    const out = capList(items, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    expect(out.map((item) => item.id)).toEqual(["a", "b"]);
    expect(items).toHaveLength(3);
    expect(capList(items, 0)).toEqual([]);
  });

  test("throws RangeError on a negative or non-integer cap", () => {
    for (const max of [-1, 0.5, Number.NaN]) expect(() => capList([1], max)).toThrow(RangeError);
  });
});

describe("overview validator caps are CONTRACT_LIMITS", () => {
  const NOW = "2026-09-23T00:00:00.000Z";
  const availability = { state: "current", source: "victoriametrics-signals", lastGoodAt: NOW, message: null };
  const host = (name: string, addresses: string[] = ["192.0.2.1"], drilldownId = `host:${name}`): Record<string, unknown> => ({
    name, collectionClass: "managed-linux", addresses, drilldownId, suppressed: null,
    status: "ok", statusEvidence: { status: "ok", availability }, rollup: "ok", rollupEvidence: { status: "ok", availability },
    live: true, activeAlerts: [], checks: [], grafana: null, services: [],
  });
  const overview = (hosts: Record<string, unknown>[]): Record<string, unknown> => ({
    appVersion: "test", generatedAt: NOW, estate: { name: "estate", timezone: "UTC", tzFallback: false },
    sources: {
      metrics: { ok: true, lastSuccess: NOW, error: null },
      alerts: { ok: true, lastSuccess: NOW, error: null },
      checks: { ok: true, lastSuccess: NOW, error: null },
    },
    hosts, alerts: [], signals: [], recentChecks: [],
    engine: { availability, value: { ok: true } },
    alertCounts: { firing: 0, silenced: 0, inhibited: 0 },
    coverage: { availability: { ...availability, source: "rendered-estate" }, value: { covered: 1, gaps: 0, extras: 0 } },
  });
  const hosts = (count: number): Record<string, unknown>[] => Array.from({ length: count }, (_, i) => host(`host-${i}`));
  const accepts = (body: Record<string, unknown>): boolean => validateOverviewSnapshotV2(body).ok;

  test("exported validator constants equal the contract values", () => {
    expect(OVERVIEW_MAX_RECENT_CHECKS).toBe(CONTRACT_LIMITS.overview.recentChecks);
    expect(ENGINE_MAX_PROBLEMS).toBe(CONTRACT_LIMITS.overview.engineProblems);
  });

  test("the hosts cap is CONTRACT_LIMITS.overview.hosts", () => {
    expect(accepts(overview(hosts(CONTRACT_LIMITS.overview.hosts)))).toBe(true);
    expect(accepts(overview(hosts(CONTRACT_LIMITS.overview.hosts + 1)))).toBe(false);
  });

  test("the per-host address cap is CONTRACT_LIMITS.overview.hostAddresses", () => {
    const addresses = (count: number): string[] => Array.from({ length: count }, (_, i) => `192.0.2.${i}`);
    expect(accepts(overview([host("host-a", addresses(CONTRACT_LIMITS.overview.hostAddresses))]))).toBe(true);
    expect(accepts(overview([host("host-a", addresses(CONTRACT_LIMITS.overview.hostAddresses + 1))]))).toBe(false);
  });

  test("the text byte cap is CONTRACT_LIMITS.overview.textBytes", () => {
    const named = (length: number): Record<string, unknown> => host("h".repeat(length), ["192.0.2.1"], "host:long-name");
    expect(accepts(overview([named(CONTRACT_LIMITS.overview.textBytes)]))).toBe(true);
    expect(accepts(overview([named(CONTRACT_LIMITS.overview.textBytes + 1)]))).toBe(false);
  });

  test("the wire modules define no private cap literal", () => {
    const wire = resolve(import.meta.dir, "../../src/wire");
    const overviewSource = readFileSync(resolve(wire, "overview.ts"), "utf8");
    const verdictSource = readFileSync(resolve(wire, "engine-verdict.ts"), "utf8");
    // No `const MAX_… = <digits>` and no numeric cap passed straight to arrayOf.
    expect(overviewSource.match(/^(?:export )?const \w*MAX\w* = \d.*$/gm) ?? []).toEqual([]);
    expect(overviewSource.match(/arrayOf\([^,]+, \d[^)]*\)/g) ?? []).toEqual([]);
    expect(overviewSource).toContain('from "../contract/limits.js"');
    expect(verdictSource.match(/^(?:export )?const \w*MAX\w*(?:: number)? = \d.*$/gm) ?? []).toEqual([]);
    expect(verdictSource).toContain("CONTRACT_LIMITS.overview.engineProblems");
  });
});
