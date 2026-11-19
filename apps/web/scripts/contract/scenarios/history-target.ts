// Target-scoped curated history fixtures: hand-built `HistoryPayload` bodies and the history error envelopes.

import { RANGE_SECONDS } from "@pulse/web-data/queries";
import type { HistoryPayload } from "@pulse/web-data/wire";

import { jsonFixture } from "./common.js";
import {
  ENDPOINT_TARGET,
  FETCHED_OFFSET_SECONDS,
  HOST_TARGET,
  SERVICE_TARGET,
  historyErrorFixtures,
  historyPayload,
  pointRun,
  pointsAtCap,
  seriesAtCap,
  stepSecondsFor,
} from "./history-common.js";
import type { ScenarioModule } from "./index.js";

export const historyTargetScenarios: ScenarioModule = {
  group: "history-target",
  operation: "GET /api/history/target/:drilldownId/:queryId",
  async build(ctx) {
    // A full one-hour window of CPU percentages (20.0 to 59.9) with one explicit gap in the middle.
    const cpuStep = stepSecondsFor("host.cpu.utilization", "1h");
    const cpuCount = RANGE_SECONDS["1h"] / cpuStep + 1;
    const cpuValues = Array.from({ length: cpuCount }, (_, i) =>
      i === Math.floor(cpuCount / 2) ? null : (200 + ((i * 37) % 400)) / 10,
    );
    const typical = historyPayload(ctx, {
      queryId: "host.cpu.utilization",
      target: HOST_TARGET,
      range: "1h",
      series: [{ labels: {}, points: pointRun(ctx, FETCHED_OFFSET_SECONDS, cpuStep, cpuValues) }],
    }) satisfies HistoryPayload;

    const empty = historyPayload(ctx, {
      queryId: "endpoint.check.latency",
      target: ENDPOINT_TARGET,
      range: "1h",
      series: [],
    }) satisfies HistoryPayload;

    // Backup age in seconds, growing by one step per sample: no gaps.
    const backupStep = stepSecondsFor("service.backup-age", "6h");
    const backupAges = Array.from({ length: 6 }, (_, i) => 3600 + i * backupStep);
    const allOptional = historyPayload(ctx, {
      queryId: "service.backup-age",
      target: SERVICE_TARGET,
      range: "6h",
      series: [{ labels: {}, points: pointRun(ctx, FETCHED_OFFSET_SECONDS, backupStep, backupAges) }],
    }) satisfies HistoryPayload;

    const maxSizeSeries = historyPayload(ctx, {
      queryId: "host.cpu.utilization",
      target: HOST_TARGET,
      range: "1h",
      series: seriesAtCap(ctx),
    }) satisfies HistoryPayload;

    const maxSizePoints = historyPayload(ctx, {
      queryId: "host.cpu.utilization",
      target: HOST_TARGET,
      range: "7d",
      series: [pointsAtCap(ctx, "7d")],
    }) satisfies HistoryPayload;

    return [
      jsonFixture(this, "typical", "response", 200, typical),
      jsonFixture(this, "empty", "response", 200, empty),
      jsonFixture(this, "all-optional", "response", 200, allOptional),
      jsonFixture(this, "max-size-series", "response", 200, maxSizeSeries),
      jsonFixture(this, "max-size-points", "response", 200, maxSizePoints),
      ...(await historyErrorFixtures(this)),
    ];
  },
};
