// src/server/log.ts — structured JSON-line logging (REQ-OBS-02).
//
// One JSON object per line to stdout — machine-parseable, agent-first (charter invariant 11). No
// request-access logging by default (kiosk polling would flood it). Secret-free by
// construction: the proposal secret is held only in a closure and is never passed to `log`
// (REQ-SEC-02, REQ-SEC-04). A stable ISO-8601 UTC `ts` is stamped on every line.

/** A structured log event. `event` is the discriminant; `ok` marks success/failure at a glance.
 *  Additional fields are event-specific (see the §7 table). Secret-free by construction. */
export interface LogEvent {
  event:
    | "server_started"
    | "config_warning"
    | "source_unreachable"
    | "source_recovered"
    | "bundle_loaded"
    | "bundle_reloaded"
    | "bundle_error"
    | "bundle_recovered"
    | "version_assert_failed"
    | "cycle_error"
    /** A cycle candidate failed construction (non-source): `{ ok: false, kind, view }` (04 §6.1). */
    | "cycle_build_failed"
    /** A later cycle published after a build failure cleared: `{ ok: true, seq }` (04 §6.1). */
    | "cycle_recovered"
    /** Edge into a degraded publication — a governing configured source failed: `{ ok: false, seq,
     *  generation, degradedSources }` (10 §7). Emitted only on the healthy→degraded transition. */
    | "cycle_degraded"
    /** Edge back to a fully-healthy publication: `{ ok: true, seq, generation, degradedSources: 0 }`
     *  (10 §7). Emitted only on the degraded→healthy transition. */
    | "cycle_healthy"
    /** The oldest SSE stream was displaced to admit a new one: `{ ok: true, openStreams }` (10 §7). */
    | "sse_stream_displaced"
    /** An SSE stream was removed after a write failure: `{ ok: false, openStreams }` (10 §7). */
    | "sse_stream_write_failed"
    /** A history request exceeded its deadline: `{ ok: false, query, code }` (10 §7). */
    | "history_timeout"
    /** A history request was rejected because the service was overloaded: `{ ok: false, query, code }`. */
    | "history_overloaded"
    /** A history request observed a model invalidation mid-flight: `{ ok: false, query, code }` (10 §7). */
    | "history_model_invalidated"
    | "request_error"
    /** Manifest parsed at load (or re-load in dev): `{ ok: true, buildId, entries: n, chunks: n }`. */
    | "assets_manifest_loaded"
    /** Directory-scan fallback engaged: `{ ok: false, reason: ManifestFallbackReason, dir }`. Once per loader. */
    | "assets_manifest_fallback"
    /** Dev composition root bound (`DevServerListeningEvent`). */
    | "dev_server_listening"
    /** Write-path store entered degraded or changed reason (edge, and start-up baseline): `{ ok: false, store, reason }`. */
    | "write_path_degraded"
    /** Write-path store recovered (edge): `{ ok: true, store }`. */
    | "write_path_recovered"
    /** Mutation succeeded (step 13) or was replayed: `{ ok: true, requestId, action, status, replayed? }` — ties to the audit record by requestId. */
    | "mutation_succeeded"
    /** Mutation failed after the attempted record (step 13): `{ ok: false, requestId, action, status, reason, replayed? }`. */
    | "mutation_failed"
    /** A refusal (steps 3–10): `{ ok: false, requestId?, action, reason }`; never audited (REQ-AUD-06). */
    | "mutation_refused"
    /** Internal defect: `{ ok: false, requestId, action, phase: "encode"|"validate"|"handler"|"dispatch", error, stack? }` — the ONLY event that may carry `stack`. */
    | "mutation_internal_error"
    /** Audit append returned `{ok:false}`: `{ ok: false, requestId, action, phase: "attempted"|"finalize", kind }` (kind = AuditFailure.kind, including `"invalid"`). */
    | "audit_write_failed"
    /** Ack auto-clear reconcile removed acks this cycle (count > 0 only): `{ ok: true, count }`. */
    | "ack_auto_cleared"
    /** acks.json failed to parse/validate at load; file preserved: `{ ok: false, path }`. */
    | "ack_store_corrupt";
  /** True for success/steady events, false for failures/warnings. */
  ok?: boolean;
  /** Any additional structured context (source key, path, error text, version, …). */
  [key: string]: unknown;
}

/**
 * Emit one structured JSON line to stdout (REQ-OBS-02). A stable `ts` (ISO-8601 UTC) is stamped on
 * every line. Never logs request bodies, engine URLs' credentials (there are none), or secrets.
 * @param evt - The event to emit.
 */
export function log(evt: LogEvent): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...evt }));
}
