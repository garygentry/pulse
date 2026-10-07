// apps/web/tests/fixtures/overview/expected.ts — small precomputed expectations for the
// deterministic overview fixtures in ./factory.ts (08-testing-strategy.md §3). Values are
// literal (never recomputed from the factory) so suites can assert against them directly;
// apps/web/tests/overview-fixtures.test.ts pins them against the factory output.

import type { TargetStatus } from "@pulse/web-data/wire";

/** Per-status count record. */
export type StatusCountRecord = Readonly<Record<TargetStatus, number>>;

/** Envelope (`makeEnvelopeOverviewSnapshot()`) host own-status counts. */
export const ENVELOPE_HOST_STATUS_COUNTS: StatusCountRecord = { ok: 20, warning: 20, critical: 20, unknown: 20, suppressed: 20 };
/** Envelope host rollup counts; every generated host's rollup equals its own status. */
export const ENVELOPE_HOST_ROLLUP_COUNTS: StatusCountRecord = { ok: 20, warning: 20, critical: 20, unknown: 20, suppressed: 20 };
/** Envelope service status counts. */
export const ENVELOPE_SERVICE_STATUS_COUNTS: StatusCountRecord = { ok: 80, warning: 40, critical: 20, unknown: 60, suppressed: 100 };
/** Envelope firing alerts: one per warning/critical target plus one unattributed info alert. */
export const ENVELOPE_ALERT_COUNTS = { firing: 101, critical: 40, warning: 60, info: 1, unattributed: 1 } as const;
/** Envelope live-signal count (one per host and one per service). */
export const ENVELOPE_SIGNAL_COUNT = 400 as const;
/** Envelope recent-check summaries (two per first service plus one unattributed). */
export const ENVELOPE_RECENT_CHECK_COUNT = 201 as const;
/** Envelope coverage summary. */
export const ENVELOPE_COVERAGE = { covered: 398, gaps: 2, extras: 1 } as const;

/** Default (`makeOverviewSnapshot()`) shape: 4 hosts × 3 services. */
export const DEFAULT_HOST_COUNT = 4 as const;
export const DEFAULT_SERVICE_COUNT = 12 as const;
/** Default host own-status (= rollup) counts. */
export const DEFAULT_HOST_STATUS_COUNTS: StatusCountRecord = { ok: 1, warning: 1, critical: 1, unknown: 1, suppressed: 0 };
/** Default service status counts. */
export const DEFAULT_SERVICE_STATUS_COUNTS: StatusCountRecord = { ok: 4, warning: 2, critical: 1, unknown: 3, suppressed: 2 };
/** Default firing alert count (5 attributed + 1 info). */
export const DEFAULT_FIRING_COUNT = 6 as const;

/** Stable identities used by later suites. */
export const FIXTURE_IDS = {
  /** First host (status ok). */ okHost: "host:host-001",
  /** Second host (status warning). */ warningHost: "host:host-002",
  /** Third host (status critical). */ criticalHost: "host:host-003",
  /** Fourth host (status unknown). */ unknownHost: "host:host-004",
  /** Fifth envelope host (status suppressed). */ suppressedHost: "host:host-005",
  /** First service on the first host (status ok, has a check and Grafana board). */ okService: "svc:host-001/api",
  /** Second service on the first host (status ok, no Grafana board). */ okServiceNoBoard: "svc:host-001/db",
  /** Third service on the third host (status suppressed). */ suppressedService: "svc:host-003/cache",
} as const;
