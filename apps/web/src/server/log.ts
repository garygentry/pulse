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
    /** The manifest's build-time inline-script hashes are missing or differ from the served shell's:
     *  `{ ok: false, recorded: n | null, served: n, enforcing: "recorded" | "served" }`. Production
     *  enforces the recorded hashes (an edited inline script is blocked); dev the served ones. */
    | "assets_csp_hash_drift"
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
    | "ack_store_corrupt"
    /** Push bootstrap finished (state ≠ disabled only): `{ ok: state === "configured", state, webhook: "on"|"off",
     *  admin: "on"|"off", devices }`. Disabled push logs nothing. */
    | "push_started"
    /** Pairing lifecycle: `{ ok, pairingEvent: PushPairingEvent, source?: "web"|"cli", deviceId?, displayName? }`.
     *  The field is `pairingEvent` because `event` is this union's discriminant. `displayName` appears only when
     *  pairingEvent is `redeemed`, after DISPLAY_NAME_PATTERN validation. Never the token or link. */
    | "push_pairing"
    /** The redemption limiter tripped and voided outstanding tokens: `{ ok: false }`. Once per trip. */
    | "push_pairing_rate_limited"
    /** A device left the registry: `{ ok: true, deviceId, reason: DeviceRemovalReason }`.
     *  Emitted only by the device store, after the removal is committed. */
    | "push_device_removed"
    /** A notification failed permanently or transiently: `{ ok: false, deviceId, kind, classification,
     *  status: number|null, reason }`. Rate-limited to one line per device per 60 s. Never the APNs token. */
    | "push_delivery_failed"
    /** A queued notification was dropped: `{ ok: false, deviceId, kind, cause: "deadline"|"overflow" }`.
     *  Shares push_delivery_failed's per-device limit. */
    | "push_delivery_dropped"
    /** APNs refused the provider token (key id, team id or key mismatch): `{ ok: false, status, reason }`.
     *  Edge-triggered: logged on the first refusal after a success or start-up. */
    | "push_apns_auth_failed"
    /** devices.json failed to parse or validate, and was preserved untouched: `{ ok: false, path: "devices.json" }`. */
    | "push_registry_corrupt"
    /** An atomic registry write failed: `{ ok: false, step, code }` from AtomicWriteResult. */
    | "push_registry_write_failed"
    /** Registry writes entered the sticky-failure state, and the push capability is withdrawn: `{ ok: false }`. Edge. */
    | "push_registry_degraded"
    /** Registry writes recovered, and the capability is restored: `{ ok: true }`. Edge. */
    | "push_registry_recovered"
    /** A valid webhook call was accepted: `{ ok: true, alerts, truncatedAlerts, devices }`. Counts only, no labels. */
    | "push_webhook_received"
    /** An unexpected exception in push code: `{ ok: false, route }`. On a request path `route` is the template
     *  label (pushRouteLabel). On a background path it is one of "bootstrap" | "intake" | "dispatch" | "apns" |
     *  "sweep" | "registry.onRemoved". No message and no stack: a push error text could contain request data. */
    | "push_internal_error";
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

/**
 * Allows at most one emission per key per `intervalMs`, measured from the last allowed emission. The push
 * queue uses it for push_delivery_failed and push_delivery_dropped, keyed by deviceId. Both events share one
 * limiter, so a device produces at most one such line per interval whatever mix of failures and drops it has.
 * Suppression affects only the log line; counters are incremented for every item.
 */
export interface KeyedLogLimiter {
  /** True when a line for `key` may be written now. Records the emission when it returns true. */
  allow(key: string): boolean;
  /** Forget a key (called when a device is removed). */
  forget(key: string): void;
  /** Keys currently tracked (tests). */
  size(): number;
}

/**
 * Create a per-key log limiter.
 * - `allow(k)` is true when `k` is untracked or `now − last[k] ≥ intervalMs`, and then sets `last[k] = now`;
 *   otherwise it is false and changes nothing, so suppressed calls do not extend the window.
 * - A clock that steps backwards (now < last) is allowed, so a frozen clock cannot silence a key forever.
 * @param intervalMs - Minimum spacing per key. Must be a positive finite number; otherwise RangeError.
 * @param nowMs - Injectable clock, default Date.now.
 * @param maxKeys - Tracking bound, default 1024. When full, entries older than intervalMs are pruned first; if
 *   it is still full, the oldest entry is evicted, so memory stays bounded whatever the key source.
 * @returns The limiter.
 */
export function createKeyedLogLimiter(
  intervalMs: number,
  nowMs: () => number = Date.now,
  maxKeys: number = 1024,
): KeyedLogLimiter {
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive finite number");
  }
  if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
    throw new RangeError("maxKeys must be a positive integer");
  }
  // Insertion order = order of last allowed emission (a re-allowed key is re-inserted at the end).
  const last = new Map<string, number>();

  function makeRoom(now: number): void {
    if (last.size < maxKeys) return;
    for (const [k, t] of last) {
      if (now < t || now - t >= intervalMs) last.delete(k);
    }
    while (last.size >= maxKeys) {
      const oldest = last.keys().next();
      if (oldest.done === true) break;
      last.delete(oldest.value);
    }
  }

  return {
    allow(key: string): boolean {
      const now = nowMs();
      const prev = last.get(key);
      if (prev !== undefined && now >= prev && now - prev < intervalMs) return false;
      if (prev !== undefined) last.delete(key);
      else makeRoom(now);
      last.set(key, now);
      return true;
    },
    forget(key: string): void {
      last.delete(key);
    },
    size(): number {
      return last.size;
    },
  };
}
