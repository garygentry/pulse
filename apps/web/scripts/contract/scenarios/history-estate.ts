// Estate-wide curated history fixtures: hand-built `HistoryPayload` bodies and the history error envelopes.

import type { HistoryPayload, HistorySeries } from "@pulse/web-data/wire";

import { PLACEHOLDER, jsonFixture } from "./common.js";
import {
  FETCHED_OFFSET_SECONDS,
  HOST_TARGET,
  historyErrorFixtures,
  historyPayload,
  pointRun,
  pointsAtCap,
  seriesAtCap,
  stepSecondsFor,
} from "./history-common.js";
import type { ScenarioModule } from "./index.js";

export const historyEstateScenarios: ScenarioModule = {
  group: "history-estate",
  operation: "GET /api/history/estate/:queryId",
  async build(ctx) {
    // Firing-alert counts: a series exists only while its alert fires, so each run covers part of the window.
    const firingStep = stepSecondsFor("alerts.firing", "6h");
    const hostDown = {
      labels: {
        alertname: "HostDown",
        host: PLACEHOLDER.hostName(2),
        instance: `${PLACEHOLDER.ipv4(2)}:9100`,
        severity: "critical",
      },
      points: pointRun(ctx, FETCHED_OFFSET_SECONDS, firingStep, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    } satisfies HistorySeries;
    const serviceFailing = {
      labels: {
        alertname: "ServiceDeepHealthFailing",
        host: PLACEHOLDER.hostName(1),
        service: "web",
        severity: "warning",
      },
      // The null is an explicit gap.
      points: pointRun(ctx, FETCHED_OFFSET_SECONDS - 3600, firingStep, [1, 1, null, 1, 2, 2]),
    } satisfies HistorySeries;

    const typical = historyPayload(ctx, {
      queryId: "alerts.firing",
      target: null,
      range: "6h",
      series: [hostDown, serviceFailing],
    }) satisfies HistoryPayload;

    const empty = historyPayload(ctx, {
      queryId: "engine.notification-failures",
      target: null,
      range: "6h",
      series: [],
    }) satisfies HistoryPayload;

    // Target set and no gaps: liveness is the one estate-catalog query that carries a target.
    const allOptional = historyPayload(ctx, {
      queryId: "estate.liveness",
      target: HOST_TARGET,
      range: "1h",
      series: [
        {
          labels: {},
          points: pointRun(ctx, FETCHED_OFFSET_SECONDS, stepSecondsFor("estate.liveness", "1h"), [1, 1, 0, 0, 1, 1]),
        },
      ],
    }) satisfies HistoryPayload;

    const maxSizeSeries = historyPayload(ctx, {
      queryId: "alerts.firing",
      target: null,
      range: "6h",
      series: seriesAtCap(ctx),
    }) satisfies HistoryPayload;

    const maxSizePoints = historyPayload(ctx, {
      queryId: "alerts.firing",
      target: null,
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
