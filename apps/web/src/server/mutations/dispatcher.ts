// apps/web/src/server/mutations/dispatcher.ts — the 13-step mutation pipeline (steps numbered (1)–(13)
// in the handler below).
//
// Proxy-header mode only (built by buildWriteRuntime). Unregistered paths and non-POST methods
// return null so the router's M1 405 stands (REQ-COMPAT-03); every other request gets a Response with
// `cache-control: private, no-store` and `X-Request-Id`. The dispatcher never rejects.
import { resolveIdentity, type Identity, type IdentityConfig } from "@pulse/web-data/identity";
import type { AuditAppendResult, AuditEvent, AuditWriter } from "@pulse/web-data/audit";
import type { MutationDispatchContext, MutationDispatcher } from "../router.js";
import type { ServerRuntime } from "../refresh.js";
import type { ServerContext } from "../../shared/registry.js";
import { log } from "../log.js";
import { recordAuditWriteFailure, recordMutation } from "../routes/metrics.js";
import { computeCapabilities } from "./capabilities.js";
import { MUTATION_BODY_MAX_BYTES } from "./constants.js";
import {
  checkContentType, checkSameOrigin, formatInvalidFields, parseIdempotencyKey, parseStrictBody, readBoundedJson,
} from "./guards.js";
import { canonicalBodyHash, type IdempotencyScope, type IdempotencyStore, type StoredOutcome } from "./idempotency.js";
import { buildAuditEvent, encodeAuditDetails, isWriterValidEvent } from "./audit.js";
import {
  REFUSAL_POLICY, emitRefusal, outcomeToStored, refuse, refusalResponse, resolveFailedPolicy, storedResponse,
  type NormalizedOutcome, type RefusalReason, type ResponseContext,
} from "./refusal.js";
import { newRequestId } from "./request-id.js";
import type {
  AuditDetails, MutationDefinition, MutationHandlerMeta, MutationOutcome, MutationRegistry,
} from "./registry.js";
import type { WritePath } from "./write-path.js";

/** Dependencies closed over by the dispatcher. Built by buildWriteRuntime. */
export interface MutationDispatcherDeps {
  /** Identity config (config.identity) for step 3 and the capability mode; static, known before the runtime exists. */
  readonly identityConfig: IdentityConfig;
  /**
   * Late-bound runtime accessor (set through the write runtime's `attachRuntime`): the runtime is
   * constructed after the write runtime, because `createServerRuntime` needs `RuntimeDeps.ackStore`.
   * `null` at request time is impossible in `main()` (Bun.serve starts after attach); if it happens, the
   * request is refused `internal` (phase "dispatch").
   */
  readonly getRuntime: () => ServerRuntime | null;
  /** Registry (exists only in proxy-header mode). */
  readonly registry: MutationRegistry;
  /** Durable JSONL audit writer (createJsonlAuditWriter). */
  readonly audit: AuditWriter;
  /** Live write-path health: snapshot() at step 5; markFailed("audit", …) at steps 10/12. */
  readonly writePath: WritePath;
  /** In-process idempotency store (createIdempotencyStore). */
  readonly idempotency: IdempotencyStore;
  /** Clock seam for audit `at`, validate(now) and handler meta.now; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** What an in-flight waiter must emit when it receives the settled template (step 9, idempotency lookup). */
type WaiterMeta =
  | { readonly kind: "refusal"; readonly reason: RefusalReason; readonly requestId: string }
  | { readonly kind: "outcome"; readonly stored: StoredOutcome };

/** Log-safe error text; the stack appears only in mutation_internal_error, never in other log events. */
function errorText(err: unknown): { readonly error: string; readonly stack?: string } {
  return err instanceof Error ? { error: err.message, ...(err.stack ? { stack: err.stack } : {}) } : { error: "non-error thrown" };
}

/** writer.append never rejects (types.ts); a rejection is still mapped to an explicit write failure. */
async function safeAppend(writer: AuditWriter, event: AuditEvent): Promise<AuditAppendResult> {
  try {
    return await writer.append(event);
  } catch {
    return { ok: false, error: { kind: "write", message: "audit append rejected" } };
  }
}

/**
 * Build the real mutation dispatcher, passed as the 3rd argument of createFetchHandler (proxy-header mode only). For an
 * unregistered path or a non-POST method it returns null, so the router's M1 405 is unchanged
 * (REQ-COMPAT-03). Otherwise it ALWAYS returns a Response carrying `cache-control: private, no-store` and
 * `X-Request-Id`. It never rejects.
 */
export function createMutationDispatcher(deps: MutationDispatcherDeps): MutationDispatcher {
  const now = deps.now ?? ((): Date => new Date());
  const waiterMeta = new WeakMap<Response, WaiterMeta>();

  const logInternal = (rc: ResponseContext, phase: "encode" | "handler" | "validate" | "dispatch", err: unknown): void =>
    log({ event: "mutation_internal_error", ok: false, requestId: rc.requestId, action: rc.action, phase, ...errorText(err) });

  const logOutcome = (action: ResponseContext["action"], stored: StoredOutcome, replayed: boolean): void => {
    const extra = replayed ? { replayed: true } : {};
    if ("outcome" in stored.body) {
      log({ event: "mutation_succeeded", ok: true, requestId: stored.requestId, action, status: stored.status, ...extra });
    } else {
      log({ event: "mutation_failed", ok: false, requestId: stored.requestId, action, status: stored.status, reason: stored.body.details.reason, ...extra });
    }
  };

  /** Step 9 hit: replay without effect or audit (REQ-IDEM-03). */
  const replay = (stored: StoredOutcome, action: ResponseContext["action"]): Response => {
    recordMutation(action, "replayed");
    logOutcome(action, stored, true);
    return storedResponse(stored, true);
  };

  /** A concurrent duplicate: answer with a clone of the settled template (never the template itself). */
  const answerWaiter = (template: Response, action: ResponseContext["action"]): Response => {
    const meta = waiterMeta.get(template);
    if (meta?.kind === "refusal") emitRefusal(meta.reason, { action, requestId: meta.requestId });
    else if (meta?.kind === "outcome") { recordMutation(action, "replayed"); logOutcome(action, meta.stored, true); }
    return template.clone();
  };

  /** Step 11 + normalization via FAILED_POLICY (the policy tables alone choose a mutation status). */
  const runHandler = async (
    def: MutationDefinition<unknown, unknown>, body: unknown, ctx: ServerContext, actor: Identity,
    meta: MutationHandlerMeta, rc: ResponseContext,
  ): Promise<NormalizedOutcome> => {
    let outcome: MutationOutcome<unknown>;
    try {
      outcome = await def.handler(body, ctx, actor, meta);
    } catch (err) {
      logInternal(rc, "handler", err);
      return { outcome: "failed", reason: "internal", policy: resolveFailedPolicy("internal").policy, details: {} };
    }
    if (outcome.outcome === "succeeded") {
      return { outcome: "succeeded", status: outcome.status, result: outcome.result, details: outcome.details ?? {} };
    }
    const resolved = resolveFailedPolicy(outcome.reason);
    if (resolved.reason !== outcome.reason || resolved.policy.status !== outcome.status || resolved.policy.code !== outcome.code) {
      logInternal(rc, "handler", new Error("handler failed-outcome disagrees with FAILED_POLICY; policy applied"));
    }
    return { outcome: "failed", reason: resolved.reason, policy: resolved.policy, details: outcome.details ?? {} };
  };

  /** Step 12: finalize record. Never changes the response (REQ-AUD-03). */
  const finalize = async (
    def: MutationDefinition<unknown, unknown>, identity: Identity, target: string, attemptedDetails: AuditDetails,
    outcome: NormalizedOutcome, rc: ResponseContext,
  ): Promise<void> => {
    // The dispatcher (not the handler) adds `reason` on failure; it overrides any handler-supplied key.
    const extra: AuditDetails = outcome.outcome === "failed" ? { ...outcome.details, reason: outcome.reason } : outcome.details;
    const base = { actor: identity, action: def.action, capability: def.capability, target, outcome: outcome.outcome, requestId: rc.requestId };
    const enc = encodeAuditDetails(extra);
    let event: AuditEvent | null = null;
    try {
      event = enc.ok ? buildAuditEvent({ ...base, at: now(), details: { ...attemptedDetails, ...enc.details } }) : null;
      if (event === null || !isWriterValidEvent(event)) {
        logInternal(rc, "encode", new Error(enc.ok ? "finalize event invalid" : `finalize details defect: ${enc.defect}`));
        // Fallback: attempted details (known valid) + reason only; outcome details are dropped.
        const minimal: AuditDetails = outcome.outcome === "failed" ? { ...attemptedDetails, reason: outcome.reason } : attemptedDetails;
        event = buildAuditEvent({ ...base, at: now(), details: minimal });
      }
    } catch (err) {
      logInternal(rc, "encode", err);
      event = null;
    }
    if (event === null || !isWriterValidEvent(event)) {
      recordAuditWriteFailure("finalize");
      log({ event: "audit_write_failed", ok: false, requestId: rc.requestId, action: rc.action, phase: "finalize", kind: "invalid" });
      return; // not an I/O failure → no degrade (an encoder defect never degrades the write path)
    }
    const res = await safeAppend(deps.audit, event);
    if (!res.ok) {
      recordAuditWriteFailure("finalize");
      log({ event: "audit_write_failed", ok: false, requestId: rc.requestId, action: rc.action, phase: "finalize", kind: res.error.kind });
      deps.writePath.markFailed("audit", "write-failed");
    }
  };

  async function pipeline(def: MutationDefinition<unknown, unknown>, context: MutationDispatchContext, rc: ResponseContext): Promise<Response> {
    const { request } = context;
    const headers = request.headers;

    // (3) Identity: trusted proxy peer + header (REQ-SEAM-03a, REQ-SEC-01).
    const identity = resolveIdentity(request, context.peerIp, deps.identityConfig);
    if (identity === null) return refuse("untrusted-identity", rc);

    // (4) Same-origin (REQ-SEAM-03c, REQ-SEC-02).
    if (!checkSameOrigin(headers).ok) return refuse("cross-origin", rc);

    // (5) Capability, re-evaluated per request (REQ-AUTHZ-03). Store denial → 503, else 403.
    const { denials } = computeCapabilities(identity, deps.identityConfig.mode, deps.writePath.snapshot());
    const denial = denials[def.capability];
    if (denial !== null) return refuse(denial.kind === "store" ? "write-path-degraded" : "capability-false", rc);

    // (6) Content type, then bounded read (REQ-SEC-03).
    const contentType = checkContentType(headers);
    if (!contentType.ok) return refuse(contentType.reason, rc);
    const bytes = await readBoundedJson(request, MUTATION_BODY_MAX_BYTES);
    if (!bytes.ok) return refuse(bytes.reason, rc);

    // (7) Idempotency key (REQ-IDEM-01).
    const key = parseIdempotencyKey(headers);
    if (!key.ok) return refuse(key.reason, rc);

    // (8a) JSON + strict schema.
    const parsed = parseStrictBody(def.body, bytes.value);
    if (!parsed.ok) return refuse(parsed.reason, rc, parsed.fields);
    const body = parsed.value;
    // (8b) Context-dependent pure validation (the definition's `validate`): not audited, not stored.
    const runtime = deps.getRuntime();
    if (runtime === null) {
      logInternal(rc, "dispatch", new Error("runtime not attached"));
      return refuse("internal", rc);
    }
    const ctx = runtime.getContext(identity);
    const requestNow = now(); // shared by validate and handler meta.now
    if (def.validate !== undefined) {
      let verdict: ReturnType<NonNullable<typeof def.validate>>;
      try {
        verdict = def.validate(body, ctx, requestNow);
      } catch (err) {
        logInternal(rc, "validate", err);
        return refuse("internal", rc);
      }
      if (!verdict.ok) return refuse("invalid-body", rc, formatInvalidFields(verdict.fields));
    }

    // (9) Idempotency lookup (REQ-IDEM-02..04).
    const bodyHash = canonicalBodyHash(body);
    if (bodyHash === null) {
      logInternal(rc, "encode", new Error("validated body is not canonicalizable"));
      return refuse("internal", rc);
    }
    const scope: IdempotencyScope = { subject: identity.subject, action: def.action, key: key.value };
    const found = deps.idempotency.lookup(scope, bodyHash);
    if (found.kind === "replay") return replay(found.outcome, def.action);
    if (found.kind === "conflict") return refuse("idempotency-conflict", rc);
    if (found.kind === "in-flight") return answerWaiter(await found.pending, def.action);

    const inflight = Promise.withResolvers<Response>(); // never rejects
    deps.idempotency.begin(scope, bodyHash, inflight.promise);
    let settled = false;
    const settle = (template: Response, meta: WaiterMeta): void => {
      waiterMeta.set(template, meta);
      settled = true;
      inflight.resolve(template);
    };
    /** A step-10 refusal while in flight: drop the entry, hand waiters the same refusal, degrade per policy. */
    const refuseInFlight = (reason: RefusalReason): Response => {
      deps.idempotency.abandon(scope);
      const degrade = REFUSAL_POLICY[reason].degrades;
      if (degrade !== null) deps.writePath.markFailed(degrade, "write-failed");
      settle(refusalResponse(reason, rc), { kind: "refusal", reason, requestId: rc.requestId });
      return refuse(reason, rc);
    };

    try {
      // (10) Audit `attempted`, fail-closed (REQ-SEAM-04, REQ-AUD-02).
      let target: string;
      let attemptedDetails: AuditDetails;
      let attempted: AuditEvent;
      try {
        target = def.auditTarget(body);
        const enc = encodeAuditDetails(def.auditDetails(body));
        if (!enc.ok) throw new Error(`attempted details defect: ${enc.defect} (${enc.key})`);
        attemptedDetails = enc.details;
        attempted = buildAuditEvent({
          at: now(), actor: identity, action: def.action, capability: def.capability, target,
          outcome: "attempted", requestId: rc.requestId, details: attemptedDetails,
        });
        if (!isWriterValidEvent(attempted)) throw new Error("attempted event fails writer bounds");
      } catch (err) {
        logInternal(rc, "encode", err); // encoder defect → internal refusal; NO degrade
        return refuseInFlight("internal");
      }
      const appended = await safeAppend(deps.audit, attempted);
      if (!appended.ok) {
        recordAuditWriteFailure("attempted");
        log({ event: "audit_write_failed", ok: false, requestId: rc.requestId, action: rc.action, phase: "attempted", kind: appended.error.kind });
        return refuseInFlight("audit-unavailable"); // markFailed("audit","write-failed") via policy.degrades
      }

      // (11) Handler: the only effectful step. Same requestId as the attempted record; same `now` as validate.
      const meta: MutationHandlerMeta = { requestId: rc.requestId, now: requestNow };
      const outcome = await runHandler(def, body, ctx, identity, meta, rc);

      // (12) Audit finalize, same requestId (REQ-SEAM-04, REQ-AUD-03).
      await finalize(def, identity, target, attemptedDetails, outcome, rc);

      // (13) Record, emit, respond.
      const stored = outcomeToStored(outcome, rc.requestId);
      deps.idempotency.complete(scope, stored);
      recordMutation(def.action, outcome.outcome);
      logOutcome(def.action, stored, false);
      settle(storedResponse(stored, true), { kind: "outcome", stored });
      return storedResponse(stored, false);
    } finally {
      if (!settled) {
        // Defensive: an unexpected throw after begin(). Never leave waiters hanging or the key locked.
        deps.idempotency.abandon(scope);
        settle(refusalResponse("internal", rc), { kind: "refusal", reason: "internal", requestId: rc.requestId });
      }
    }
  }

  return async (context: MutationDispatchContext): Promise<Response | null> => {
    // (1) Match: exact path; non-POST → null → M1 405 (REQ-COMPAT-03).
    const def = deps.registry.match(context.pathname);
    if (def === undefined || context.request.method !== "POST") return null;
    // (2) Request id; every response from here carries X-Request-Id + cache-control.
    const rc: ResponseContext = { action: def.action, requestId: newRequestId() };
    try {
      return await pipeline(def, context, rc);
    } catch (err) {
      logInternal(rc, "dispatch", err);
      return refuse("internal", rc);
    }
  };
}
