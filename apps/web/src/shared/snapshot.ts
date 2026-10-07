// src/shared/snapshot.ts — compatibility re-export of the overview wire contracts.
//
// The authoritative overview shapes now live in `@pulse/web-data/wire`
// (01-core-definitions.md §9). This module preserves every historical name and meaning
// the app tiers already import so no consumer receives a second overview type:
//
//   SourceHealth  = wire SourceHealthCompat   (per-source body-materialization health)
//   ActiveAlert   = wire OverviewAlertSummary  (host/service-attributed overview alert)
//   CheckResult   = wire OverviewCheckResult   (supporting Gatus check result)
//   TargetStatus / ServiceStatus / HostStatus  (unchanged field names and meanings)
//   OverviewSnapshot = wire OverviewSnapshotV2 (one complete snapshot authority)
//
// `OverviewSnapshotV2` includes attributed live signals, multiple recent checks, engine evidence,
// alert counts, and coverage; both server and client consume that complete shape. All timestamps are
// ISO-8601 UTC; the client formats absolute times into the estate timezone.
//
// `generatedAt` is body MATERIALIZATION time — when this payload's bytes were produced — NOT the
// latest cycle observation. Shell freshness (the LiveStatusPill/StaleDataWarning consumers) now
// reads currentness from `connection.observation.observedAt` and per-source state from
// `connection.observation.sources` (08 §10), so `generatedAt` no longer drives any "updated"/"stale"
// display: it may appear only where explicitly labelled "content generated/materialized".

export type {
  /** The five visual target states (REQ-STATE-01, REQ-A11Y-01). */
  TargetStatus,
  /** Per-source body-materialization health (REQ-LIVE-04). */
  SourceHealthCompat as SourceHealth,
  /** One active overview alert attributed to a host/service (§3.6). */
  OverviewAlertSummary as ActiveAlert,
  /** One supporting Gatus check result (REQ-STATE-04). */
  OverviewCheckResult as CheckResult,
  /** One service indicator nested under its host cell. */
  ServiceStatus,
  /** One host cell — the grid's primary unit (REQ-GRID-02). */
  HostStatus,
} from "@pulse/web-data/wire";

import type { OverviewSnapshotV2, SourceHealthCompat } from "@pulse/web-data/wire";

/**
 * The whole-overview snapshot the server publishes and the client consumes. This compatibility
 * name aliases the complete authoritative `OverviewSnapshotV2` (§9), preserving historical
 * imports without introducing a narrower competing snapshot shape.
 */
export type OverviewSnapshot = OverviewSnapshotV2;

/** The `GET /healthz` body (REQ-OBS-01). Served whenever the process can respond;
 *  `degraded` = any source unreachable or the model not loaded. App-owned; not a wire contract. */
export interface HealthBody {
  /** Overall process health; `degraded` when any source is unreachable or the model is unloaded. */
  status: "ok" | "degraded";
  /** Build version. */
  version: string;
  /** Estate-model load state and format diagnostics. */
  estateModel: { loaded: boolean; formatVersion: number | null; error: string | null };
  /** Per-source body-materialization health for the three engine sources. */
  sources: { metrics: SourceHealthCompat; alerts: SourceHealthCompat; checks: SourceHealthCompat };
  /** Write-path status per capability; always emitted once mutations ship (auth-mode-none in none
   *  mode). Optional so existing HealthBody literals compile unedited. Never affects `status`. */
  writePath?: { silence: HealthWritePathEntry; ack: HealthWritePathEntry; proposeEstateEdit: HealthWritePathEntry };
}

/** Write-path reasons (the 8 literals of server/mutations/write-path.ts). Re-declared here because
 *  shared/ must not import server/; a type-level equality assertion in mutations-write-path.test.ts
 *  pins this union to server WRITE_PATH_REASONS. */
export type WritePathReason =
  | "not-configured"
  | "missing"
  | "unwritable"
  | "corrupt"
  | "secret-missing"
  | "secret-too-short"
  | "write-failed"
  | "auth-mode-none";

/** Per-capability write-path status on /healthz. */
export interface HealthWritePathEntry {
  /** Mirrors the capability's server-side availability for a trusted caller. */
  ok: boolean;
  /** First failing store's reason (CAPABILITY_STORES order), or null when ok. */
  reason: WritePathReason | null;
}
