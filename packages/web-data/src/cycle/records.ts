// packages/web-data/src/cycle/records.ts — the keyed fold-input records and shared
// source-record helpers (01-core-definitions.md §5, 04-cycle-and-current-view-folds.md
// §§1, 4, 12). This module lands the §5 records deferred by `wire/live.ts`: it is the
// first fold item (020) to compose a cycle, so `CycleSourceRecords`/`CurrentViewValues`
// become authoritative here and every later fold item (022, 024, 039) imports them
// rather than redeclaring a competing shape.
//
// `CycleSourceRecords` binds each closed `SourceId` to the exact concrete payload its
// client produces, preventing mis-indexing. `grafana-health` is `null` when Grafana is
// not configured (there is no attempt), distinct from a configured-but-failed record.
//
// The record helpers implement the §12 failure/recovery truth table once, so every fold
// applies never-silent-green identically: a current success is `current`; a failure with
// last-good retains a `stale` value; a failure with no last-good is `unavailable`.
//
// This is a `/cycle` (server-side) module; every import below is type-only and erased,
// so it adds no runtime dependency and cannot reach `/wire`.

import type { DataAvailability, SourceId } from "../wire/common.js";
import type { CycleBuildFailure } from "./types.js";
import type { SourceHealthCompat } from "../wire/overview.js";
import type { AlertsPayload } from "../wire/alerts.js";
import type { OverviewSnapshotV2 } from "../wire/overview.js";
import type { EstatePayload } from "../wire/estate.js";
import type { EnginePayload } from "../wire/engine.js";
import type { TimelinePayload } from "../wire/timeline.js";
import type { SourceRecord } from "../sources/types.js";
import type { ScrapeTargetState } from "../sources/types.js";
import type { MetricSample, VmBuildInfo } from "../sources/vm.js";
import type {
  AlertmanagerAlert,
  AlertmanagerReceiver,
  AlertmanagerSilence,
  AlertmanagerStatus,
} from "../sources/alertmanager.js";
import type { VmalertRuleGroup } from "../sources/vmalert.js";
import type { GatusEndpointState } from "../sources/gatus.js";
import type { GrafanaHealth } from "../sources/grafana.js";
import type {
  WebCoverageArtifact,
  WebEstateModelV2,
  WebFindingsArtifact,
} from "@pulse/renderer";

/**
 * The keyed source records for one cycle: every fixed `SourceId` bound to a
 * {@link SourceRecord} of its exact concrete payload. `grafana-health` is `null` when
 * Grafana is not configured (no attempt is ever made), distinct from a configured record
 * whose latest attempt failed.
 */
export interface CycleSourceRecords {
  /** VictoriaMetrics fixed instant status/engine union samples. */
  readonly "victoriametrics-signals": SourceRecord<readonly MetricSample[]>;
  /** VictoriaMetrics scrape-target discovery. */
  readonly "victoriametrics-targets": SourceRecord<readonly ScrapeTargetState[]>;
  /** VictoriaMetrics build identity (slow tier). */
  readonly "victoriametrics-buildinfo": SourceRecord<VmBuildInfo>;
  /** Alertmanager firing/silenced/inhibited alerts. */
  readonly "alertmanager-alerts": SourceRecord<readonly AlertmanagerAlert[]>;
  /** Alertmanager silences. */
  readonly "alertmanager-silences": SourceRecord<readonly AlertmanagerSilence[]>;
  /** Alertmanager status/cluster summary (slow tier). */
  readonly "alertmanager-status": SourceRecord<AlertmanagerStatus>;
  /** Alertmanager receivers (slow tier). */
  readonly "alertmanager-receivers": SourceRecord<readonly AlertmanagerReceiver[]>;
  /** vmalert rule groups. */
  readonly "vmalert-rules": SourceRecord<readonly VmalertRuleGroup[]>;
  /** Gatus endpoint statuses. */
  readonly "gatus-statuses": SourceRecord<readonly GatusEndpointState[]>;
  /** Grafana health (slow, optional); `null` when not configured. */
  readonly "grafana-health": SourceRecord<GrafanaHealth> | null;
}

/** The five unencoded current-view values produced by the pure folds, keyed by `ViewId`. */
export interface CurrentViewValues {
  /** The overview snapshot. */ readonly overview: OverviewSnapshotV2;
  /** The alerts payload. */ readonly alerts: AlertsPayload;
  /** The estate payload. */ readonly estate: EstatePayload;
  /** The engine payload. */ readonly engine: EnginePayload;
  /** The timeline payload. */ readonly timeline: TimelinePayload;
}

/**
 * Presentation configuration threaded into the overview fold. The pure fold cannot read
 * app config, so the runtime supplies the Grafana origin used to resolve dashboard deep
 * links and the Gatus evaluation-freshness threshold. Both have safe defaults so the fold
 * stays callable with only the required inputs.
 */
export interface OverviewFoldConfig {
  /** Grafana origin (no trailing slash), or `null` when deep links are disabled. */
  readonly grafanaOrigin: string | null;
  /** Gatus evaluation-freshness threshold in seconds. */
  readonly gatusStaleSeconds: number;
}

/**
 * Publication-cycle metadata threaded into the engine fold. The pure fold cannot read the
 * app scheduler state, so the runtime supplies the current published sequence, the most
 * recent cycle duration, and the last non-source materialization failure (item 039). Safe
 * defaults apply so the fold stays callable with only the required inputs; `degraded` is
 * derived from the records inside the fold and is never supplied here.
 */
export interface EngineFoldConfig {
  /** Latest published sequence (0 before the first successful publication). */
  readonly sequence: number;
  /** Most recent cycle duration in milliseconds (0 when unknown). */
  readonly durationMs: number;
  /** Last non-source materialization failure, or null when none. */
  readonly buildFailure: CycleBuildFailure | null;
}

/**
 * One app-local acknowledgement projected for the fold. The runtime supplies a
 * read-only view keyed by alert fingerprint; `by` is the display name only — the stable
 * subject never reaches the fold or the wire (REQ-SEC-06).
 */
export interface AckFoldRecord {
  /** Display name of the acknowledging operator. */ readonly by: string;
  /** Acknowledgement time, ISO-8601 UTC. */ readonly at: string;
  /** Optional operator note, or null when none was given. */ readonly note: string | null;
}

/**
 * The pure fold input tuple (04 §1). The runtime captures one immutable rendered bundle,
 * the concrete source records, and stamping metadata, then invokes each fold with no
 * access to app state. `overview` and `engine` presentation/cycle config are optional and
 * safe defaults are used when absent.
 */
export interface FoldInputs {
  /** The captured immutable rendered estate model. */ readonly model: WebEstateModelV2;
  /** The captured coverage artifact, or null when absent. */ readonly coverage: WebCoverageArtifact | null;
  /** The captured findings artifact, or null when absent. */ readonly findings: WebFindingsArtifact | null;
  /** The concrete keyed source records for this cycle. */ readonly records: CycleSourceRecords;
  /** Application/build version for the reload-once guard. */ readonly appVersion: string;
  /** Body materialization time in UTC (the cycle `observedAt`). */ readonly observedAt: string;
  /** Optional overview presentation config; safe defaults apply when omitted. */
  readonly overview?: OverviewFoldConfig;
  /** Optional engine publication-cycle metadata; safe defaults apply when omitted. */
  readonly engine?: EngineFoldConfig;
  /** App-local ack state keyed by alert fingerprint (REQ-ACK-06); omitted ⇒ no acks joined. */
  readonly acks?: ReadonlyMap<string, AckFoldRecord>;
}

/** Default Gatus evaluation-freshness threshold in seconds when config is omitted. */
export const DEFAULT_GATUS_STALE_SECONDS = 300 as const;

/** Default engine publication-cycle metadata when config is omitted. */
export const DEFAULT_ENGINE_CONFIG: EngineFoldConfig = {
  sequence: 0,
  durationMs: 0,
  buildFailure: null,
};

/**
 * The effective value for a source record under the §12 truth table: the current success,
 * else the retained last-good marked `stale`, else `null` when no evidence exists. A fold
 * uses the returned value to retain last-good body context while a separate availability
 * governs status.
 *
 * @param record - The source record to resolve.
 * @returns `{ data, stale }` with the effective value, or `null` when there is no evidence.
 */
export function effectiveData<T>(
  record: SourceRecord<T>,
): { readonly data: T; readonly stale: boolean } | null {
  if (record.latest.result.ok) return { data: record.latest.result.data, stale: false };
  if (record.lastGood !== null) return { data: record.lastGood.data, stale: true };
  return null;
}

/**
 * Build the {@link DataAvailability} governing a source record (§12). A current success is
 * `current`; a failure with last-good is `stale` and carries the bounded diagnostic; a
 * failure with no last-good is `unavailable`. `lastGoodAt` is always the stable last
 * success time (never advanced by a failed attempt).
 *
 * @param record - The source record to describe.
 * @param source - The governing source identity or `"rendered-estate"`.
 * @returns The availability describing the record's currentness.
 */
export function sourceAvailability(
  record: SourceRecord<unknown>,
  source: DataAvailability["source"],
): DataAvailability {
  if (record.latest.result.ok) {
    return {
      state: "current",
      source,
      lastGoodAt: record.lastGood?.at ?? record.latest.attemptedAt,
      message: null,
    };
  }
  const message = record.latest.result.error.message;
  if (record.lastGood !== null) {
    return { state: "stale", source, lastGoodAt: record.lastGood.at, message };
  }
  return { state: "unavailable", source, lastGoodAt: null, message };
}

/**
 * Project a source record into the overview compatibility health fields (§7). `ok`
 * reflects the latest attempt only; `lastSuccess` is the stable last-good time; `error`
 * carries the bounded diagnostic when the latest attempt failed.
 *
 * @param record - The source record to project.
 * @returns The compatibility health for the overview body.
 */
export function sourceHealthCompat(record: SourceRecord<unknown>): SourceHealthCompat {
  const ok = record.latest.result.ok;
  return {
    ok,
    lastSuccess: record.lastGood?.at ?? null,
    error: ok ? null : record.latest.result.error.message,
  };
}
