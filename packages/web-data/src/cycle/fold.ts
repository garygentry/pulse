// packages/web-data/src/cycle/fold.ts — coordinator-neutral cycle composition
// (04-cycle-and-current-view-folds.md §§1, 5, 6). Three pure/async boundaries the app
// scheduler (apps/web/src/server/refresh.ts, item 039) drives:
//
//   - `foldCurrentViews`   runs the five pure view folds off the captured inputs.
//   - `materializeCycle`   materializes every view (reuse-or-rebuild) and assembles the
//                          immutable `CycleState`, classifying every construction failure
//                          as data (no expected failure rejects, §6.1).
//   - `buildCycleCandidate` composes both behind one boundary so the returned
//                          `CycleBuildResult` is the ONLY expected construction outcome at
//                          the app/package seam — a fold contract violation or a programmer
//                          bug is caught here and classified `kind:"fold"` (10 §4).
//
// Semantic identity excludes observation-only metadata: the per-view `generatedAt` (=
// observedAt) and every successful-attempt timestamp (`lastGoodAt`, `lastSuccess`) are
// nulled before hashing, so a sequence-only or success-timestamp-only cycle reuses the
// prior payload object, bytes, `generatedAt`, identity, and both ETags (§5). Degraded
// status/last-good STATE changes remain material because only the timestamps are stripped.
//
// App-local ack state rides on `FoldInputs.acks` and reaches the alerts/overview folds as is.
//
// This is a `/cycle` (server-side) module; it composes the folds and the canonical/hash
// helpers and never reaches `/wire`.

import { ERROR_MESSAGES } from "../wire/common.js";
import type { CycleObservation, SourceId } from "../wire/common.js";
import type { SourceRecord } from "../sources/types.js";
import { foldOverview } from "./fold-overview.js";
import { foldAlerts } from "./fold-alerts.js";
import { foldEstate } from "./fold-estate.js";
import { foldEngine } from "./fold-engine.js";
import { foldTimeline } from "./fold-timeline.js";
import { materializeView } from "./identity.js";
import type { CurrentViewValues, CycleSourceRecords, FoldInputs } from "./records.js";
import type { CycleBuildResult, CycleState } from "./types.js";

/** The five closed source ids that always carry a concrete record (Grafana is optional). */
const REQUIRED_SOURCE_IDS = [
  "victoriametrics-signals",
  "victoriametrics-targets",
  "victoriametrics-buildinfo",
  "alertmanager-alerts",
  "alertmanager-silences",
  "alertmanager-status",
  "alertmanager-receivers",
  "vmalert-rules",
  "gatus-statuses",
] as const;

/**
 * Run the five pure view folds against one captured input tuple, producing the unencoded
 * current-view values. Each fold is total over valid inputs (never-silent-green): a failed
 * governing source degrades that fold's status without throwing. This function performs no
 * I/O and reads no app state.
 *
 * @param inputs - The captured model/artifacts, concrete source records, and stamping metadata.
 * @returns The five unencoded view values keyed by `ViewId`.
 */
export function foldCurrentViews(inputs: FoldInputs): CurrentViewValues {
  return {
    overview: foldOverview(inputs),
    alerts: foldAlerts(inputs),
    estate: foldEstate(inputs),
    engine: foldEngine(inputs),
    timeline: foldTimeline(inputs),
  };
}

/**
 * Recursively rebuild `value` with every observation-only timestamp nulled, producing the
 * semantic material whose canonical hash is the view's reuse identity (§5 step 1). Only the
 * fixed injected timestamp fields (`generatedAt`, `lastGoodAt`, `lastSuccess`) are cleared;
 * data-derived timestamps and all status/state fields remain, so a genuine material change
 * still yields a distinct identity while a pure timestamp advance reuses the prior payload.
 */
function semanticMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticMaterial);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "generatedAt" || key === "lastGoodAt" || key === "lastSuccess") {
        out[key] = null;
      } else {
        out[key] = semanticMaterial(entry);
      }
    }
    return out;
  }
  return value;
}

/**
 * Assemble the retained source-record authority for `CycleState.sources` (04 §1). Grafana is
 * `null` when not configured; the map contract requires a record for every id, so a
 * not-configured Grafana is represented by a stable `disabled` record. The publication
 * observation (built by the coordinator) carries the authoritative `not-configured` source
 * state; this map only retains the concrete records for post-hoc inspection.
 */
function buildSourcesMap(
  records: CycleSourceRecords,
  observedAt: string,
): Readonly<Record<SourceId, SourceRecord<unknown>>> {
  const out: Record<SourceId, SourceRecord<unknown>> = {} as Record<SourceId, SourceRecord<unknown>>;
  for (const id of REQUIRED_SOURCE_IDS) {
    out[id] = records[id] as SourceRecord<unknown>;
  }
  out["grafana-health"] =
    records["grafana-health"] ??
    ({
      latest: {
        attemptedAt: observedAt,
        result: {
          ok: false,
          error: { kind: "disabled", message: ERROR_MESSAGES.CYCLE_BUILD_FAILED, status: null },
        },
      },
      lastGood: null,
    } as SourceRecord<unknown>);
  return out;
}

/**
 * Materialize all five current views and assemble the immutable {@link CycleState}. Each view
 * reuses the prior payload verbatim when its semantic identity is unchanged, otherwise
 * re-encodes canonical plain and deterministic gzip bytes with independent strong ETags. The
 * FIRST failing view short-circuits: canonicalization, hash, compression, and payload-limit
 * failures are returned as a classified {@link CycleBuildResult} and no partial cycle is built.
 *
 * @param previous    - The prior published cycle, or null before the first publication.
 * @param observation - The publication observation stamped by the coordinator.
 * @param records     - The concrete keyed source records retained on the cycle.
 * @param values      - The unencoded view values from {@link foldCurrentViews}.
 * @returns A complete immutable cycle, or a classified safe construction failure.
 */
export async function materializeCycle(
  previous: CycleState | null,
  observation: CycleObservation,
  records: CycleSourceRecords,
  values: CurrentViewValues,
): Promise<CycleBuildResult> {
  const overview = await materializeView(
    "overview",
    previous?.overview ?? null,
    values.overview,
    semanticMaterial(values.overview),
  );
  if (!overview.ok) return { ok: false, error: overview.error };

  const alerts = await materializeView(
    "alerts",
    previous?.alerts ?? null,
    values.alerts,
    semanticMaterial(values.alerts),
  );
  if (!alerts.ok) return { ok: false, error: alerts.error };

  const estate = await materializeView(
    "estate",
    previous?.estate ?? null,
    values.estate,
    semanticMaterial(values.estate),
  );
  if (!estate.ok) return { ok: false, error: estate.error };

  const engine = await materializeView(
    "engine",
    previous?.engine ?? null,
    values.engine,
    semanticMaterial(values.engine),
  );
  if (!engine.ok) return { ok: false, error: engine.error };

  const timeline = await materializeView(
    "timeline",
    previous?.timeline ?? null,
    values.timeline,
    semanticMaterial(values.timeline),
  );
  if (!timeline.ok) return { ok: false, error: timeline.error };

  const cycle: CycleState = {
    observation,
    sources: buildSourcesMap(records, observation.observedAt),
    overview: overview.payload,
    alerts: alerts.payload,
    estate: estate.payload,
    engine: engine.payload,
    timeline: timeline.payload,
  };
  return { ok: true, cycle };
}

/**
 * The single testable coordinator-neutral boundary that owns fold and materialization
 * classification (§6.1, 10 §4). It runs {@link foldCurrentViews} inside a guard so a fold
 * contract violation or a programmer bug outside the closed failure categories is caught and
 * mapped to `kind:"fold"` without raw exception text, then materializes the candidate. The
 * returned {@link CycleBuildResult} is the only expected construction outcome — no expected
 * construction failure rejects.
 *
 * @param previous    - The prior published cycle, or null before the first publication.
 * @param observation - The publication observation stamped by the coordinator.
 * @param inputs      - The captured fold inputs (model, artifacts, records, metadata).
 * @returns A complete immutable candidate, or a classified safe construction failure.
 */
export async function buildCycleCandidate(
  previous: CycleState | null,
  observation: CycleObservation,
  inputs: FoldInputs,
): Promise<CycleBuildResult> {
  let values: CurrentViewValues;
  try {
    values = foldCurrentViews(inputs);
  } catch {
    return {
      ok: false,
      error: { kind: "fold", view: null, message: ERROR_MESSAGES.CYCLE_BUILD_FAILED },
    };
  }
  return materializeCycle(previous, observation, inputs.records, values);
}
