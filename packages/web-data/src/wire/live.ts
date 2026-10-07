// packages/web-data/src/wire/live.ts — browser-safe live-tick and per-view delivery
// contracts (01-core-definitions.md §5). The SSE tick carries only the latest cycle
// observation and the semantic identity of every current view; it never embeds a view
// body, history, session, target list, identity, or secret. Every type import is erased
// under verbatimModuleSyntax, so `/wire` stays runtime-free.
//
// The keyed fold-input records `CycleSourceRecords` and `CurrentViewValues` (also grouped
// under §5) are deliberately deferred: they reference source-client value types
// (`MetricSample`, `VmBuildInfo`, `AlertmanagerStatus`, `AlertmanagerReceiver`,
// `VmalertRuleGroup`, `GatusEndpointState`, `GrafanaHealth`) that do not exist until the
// source-client items (010–018) land. They are added by the item that first composes a
// cycle once those source types exist, keeping this file additive so no later document
// redeclares a competing shape.

import type { ApiErrorCode, CycleObservation, HashId, ViewId } from "./common.js";

/**
 * Post-publication live tick published once per successful atomic cycle assignment.
 * Contains only the latest publication observation and the semantic identity of each
 * current view, so a stream consumer can decide which views to re-fetch conditionally.
 */
export interface LiveTick {
  /** Latest complete publication observation. */ readonly observation: CycleObservation;
  /** Semantic identity of every current view, keyed by the closed `ViewId` set. */
  readonly identities: Readonly<Record<ViewId, HashId>>;
}

/**
 * Per-view client delivery state tracked by the store. `phase` distinguishes a view that
 * has never been delivered (`initial`), one whose accepted identity matches the desired
 * cycle (`current`), and one showing retained stale context after the identity advanced
 * (`stale`).
 */
export interface ViewDeliveryFailure {
  /** Validated shared error-envelope code preserving the semantic failure cause. */
  readonly code: ApiErrorCode;
  /** HTTP status returned by the route, or 0 when no HTTP response was received. */
  readonly status: number;
  /** Bounded display-safe message from the shared error envelope. */
  readonly message: string;
}

export interface ViewDeliveryState {
  /** Whether this view is absent, valid for the desired identity, or retained stale context. */
  readonly phase: "initial" | "current" | "stale";
  /** Accepted semantic payload identity, or null before a payload is accepted. */
  readonly identity: HashId | null;
  /** Latest fetch failure for this view; cleared by the next successful contact or explicit retry. */
  readonly failure: ViewDeliveryFailure | null;
}

/**
 * Bounded telemetry event describing one SSE stream-registry lifecycle transition. Carries
 * no stream body, peer, or identity — only the categorical event, its outcome, and the
 * resulting open-stream count.
 */
export interface StreamRegistryEvent {
  /** Fixed lifecycle event. */ readonly event: "connected" | "displaced" | "write-failed" | "closed";
  /** Result category. */ readonly outcome: "success" | "failure";
  /** Stream count after the transition. */ readonly openStreams: number;
}
