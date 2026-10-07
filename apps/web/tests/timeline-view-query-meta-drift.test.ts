// Keeps the timeline client's curated-query mirror (views/timeline/query-meta.ts) aligned with the
// web-data query catalog (05 §2.5). This is the ONLY place allowed to import @pulse/web-data/queries.

import { describe, expect, test } from "bun:test";

import {
  QUERY_CATALOG,
  RANGE_IDS,
  RANGE_SECONDS as SERVER_RANGE_SECONDS,
  effectiveStepSeconds,
} from "@pulse/web-data/queries";
import type { QueryId, RangeId } from "@pulse/web-data/wire";

import {
  ALERT_HISTORY_PREFERRED_STEP_S,
  CLIENT_QUERY_META,
  COVERAGE_QUERY,
  DEFAULT_RANGE,
  ENGINE_TREND_QUERIES,
  HOST_CHART_QUERIES,
  RANGE_SECONDS,
  SERVICE_CHART_QUERY,
  STEP_POINT_DENOMINATOR,
  TIMELINE_RANGES,
  rangeExceedsMax,
  timelineStepSeconds,
} from "../src/client/views/_shared/timeseries/query-meta.js";

const VIEWS_ROOT = `${import.meta.dir}/../src/client/views`;
const QUERY_META_PATH = `${VIEWS_ROOT}/_shared/timeseries/query-meta.ts`;

const mirroredIds = Object.keys(CLIENT_QUERY_META) as QueryId[];

describe("query-meta drift (05 §2.5)", () => {
  test("check 1: defaultRange/maxRange/unit of every mirrored id equal QUERY_CATALOG's", () => {
    expect(mirroredIds.length).toBe(10);
    for (const id of mirroredIds) {
      const meta = CLIENT_QUERY_META[id]!;
      const server = QUERY_CATALOG[id];
      expect({ id, defaultRange: meta.defaultRange, maxRange: meta.maxRange, unit: meta.unit }).toEqual({
        id, defaultRange: server.defaultRange, maxRange: server.maxRange, unit: server.unit,
      });
    }
  });

  test("check 2: RANGE_SECONDS deep-equals the server's and TIMELINE_RANGES equals RANGE_IDS", () => {
    expect({ ...RANGE_SECONDS }).toEqual({ ...SERVER_RANGE_SECONDS });
    expect(TIMELINE_RANGES.length).toBe(RANGE_IDS.length);
    TIMELINE_RANGES.forEach((r, i) => expect(r).toBe(RANGE_IDS[i]!));
    expect(DEFAULT_RANGE).toBe("24h");
  });

  test("check 3 (REQ-RANGE-01): timelineStepSeconds equals effectiveStepSeconds for alerts.firing", () => {
    expect(ALERT_HISTORY_PREFERRED_STEP_S).toBe(QUERY_CATALOG["alerts.firing"].preferredStepSeconds);
    for (const r of TIMELINE_RANGES) {
      expect(timelineStepSeconds(r)).toBe(
        effectiveStepSeconds(SERVER_RANGE_SECONDS[r], QUERY_CATALOG["alerts.firing"].preferredStepSeconds),
      );
    }
  });

  test("check 4: alerts.firing accepts every timeline range (maxRange 7d)", () => {
    expect(QUERY_CATALOG["alerts.firing"].maxRange).toBe("7d");
  });

  test("check 5: every trend/chart/coverage id is a CLIENT_QUERY_META key", () => {
    const used: readonly QueryId[] = [...ENGINE_TREND_QUERIES, ...HOST_CHART_QUERIES, SERVICE_CHART_QUERY, COVERAGE_QUERY];
    for (const id of used) expect(mirroredIds).toContain(id);
  });

  test("check 6 (REQ-SEC-01): no engine/timeline view module references @pulse/web-data/queries", async () => {
    const glob = new Bun.Glob("{engine,timeline}/**/*.{ts,tsx}");
    const offenders: string[] = [];
    for await (const rel of glob.scan({ cwd: VIEWS_ROOT })) {
      const text = await Bun.file(`${VIEWS_ROOT}/${rel}`).text();
      if (text.includes("@pulse/web-data/queries")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("query-meta values", () => {
  test("REQ-RANGE-01: timelineStepSeconds is 60, 60, 145, 1012 for 1h, 6h, 24h, 7d", () => {
    expect(STEP_POINT_DENOMINATOR).toBe(598);
    expect(TIMELINE_RANGES.map((r) => timelineStepSeconds(r))).toEqual([60, 60, 145, 1012]);
  });

  test("REQ-RANGE-02: rangeExceedsMax matches the 05 §2.3 truth table", () => {
    const table: ReadonlyArray<readonly [QueryId, readonly [boolean, boolean, boolean, boolean]]> = [
      ["host.cpu.utilization", [false, false, false, false]],
      ["host.memory.utilization", [false, false, false, false]],
      ["host.disk.utilization", [false, false, false, false]],
      ["host.load.1m", [false, false, false, true]],
      ["endpoint.check.latency", [false, false, false, true]],
      ["engine.ingestion-rate", [false, false, false, true]],
      ["engine.active-series", [false, false, false, false]],
    ];
    const ranges: readonly RangeId[] = ["1h", "6h", "24h", "7d"];
    for (const [id, row] of table) {
      expect({ id, cells: ranges.map((r) => rangeExceedsMax(id, r)) }).toEqual({ id, cells: [...row] });
    }
    expect(ranges.every((r) => !rangeExceedsMax(COVERAGE_QUERY, r))).toBe(true);
  });

  test("REQ-RANGE-02: rangeExceedsMax is true at every range for an id absent from the mirror", () => {
    for (const r of TIMELINE_RANGES) expect(rangeExceedsMax("service.backup-age", r)).toBe(true);
  });

  test("REQ-SEC-01: query-meta.ts never throws and imports only types from @pulse/web-data/wire", async () => {
    const text = await Bun.file(QUERY_META_PATH).text();
    expect(text).not.toContain("throw ");
    const imports = text.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(imports).toEqual(['import type { QueryId, RangeId } from "@pulse/web-data/wire";']);
  });
});
