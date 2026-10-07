// apps/web/tests/mutations-envelope.test.ts — the single mutation status/code policy and every mutation
// Response builder (00 §5.3, 03 §5; REQ-SEAM-06, REQ-SEC-06).
//
// Pins: REFUSAL_POLICY/FAILED_POLICY reproduce the 00 §5.3 tables; every refusal body equals the
// `errorFor(code, status, details)` body; mutation headers are exactly cache-control, x-request-id,
// content-type (+ idempotency-replayed when replayed) and never carry identity or peer; resolveFailedPolicy
// maps upstream/failed/unknown reasons; outcomeToStored + storedResponse render success and failure;
// refuse() emits exactly one log line and one metric increment while refusalResponse() emits neither.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  FAILED_POLICY,
  REFUSAL_POLICY,
  emitRefusal,
  mutationHeaders,
  outcomeToStored,
  refusalBody,
  refusalResponse,
  refuse,
  resolveFailedPolicy,
  storedResponse,
  type FailedReason,
  type NormalizedOutcome,
  type RefusalReason,
  type ResponseContext,
} from "../src/server/mutations/refusal.js";
import { errorFor } from "../src/server/routes/respond.js";
import { __resetMetricsForTest, renderMetrics } from "../src/server/routes/metrics.js";
import { getRuntimeStatus } from "../src/server/refresh.js";
import type { MutationReason, UpstreamReason } from "../src/shared/mutations.js";

const REQUEST_ID = "5b2f3c1e-8f0a-4d7e-9a3b-2c1d0e9f8a7b";
const RC: ResponseContext = { action: "ack.set", requestId: REQUEST_ID };
/** Values that must never leak into a mutation response (identity header value, peer). */
const IDENTITY_VALUE = "alice@example.test";
const PEER_IP = "10.0.0.5";

const REFUSAL_REASONS = Object.keys(REFUSAL_POLICY) as RefusalReason[];

function headerNames(res: Response): string[] {
  return [...res.headers.keys()].sort();
}

async function bodyOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

function metricsText(): string {
  return renderMetrics(getRuntimeStatus(), Date.now());
}

afterEach(() => {
  __resetMetricsForTest();
});

describe("mutation policy tables reproduce 00 §5.3 (REQ-SEAM-06)", () => {
  test("REFUSAL_POLICY rows are exactly the 00 §5.3 refusal table", () => {
    const row = (status: number, code: string, degrades: string | null = null) =>
      ({ status, code, audited: false, stored: false, degrades });
    expect(REFUSAL_POLICY).toEqual({
      "untrusted-identity": row(403, "INVALID_REQUEST"),
      "cross-origin": row(403, "INVALID_REQUEST"),
      "capability-false": row(403, "INVALID_REQUEST"),
      "write-path-degraded": row(503, "SOURCE_UNAVAILABLE"),
      "invalid-body": row(400, "INVALID_REQUEST"),
      "missing-idempotency-key": row(400, "INVALID_REQUEST"),
      "body-too-large": row(413, "INVALID_REQUEST"),
      "idempotency-conflict": row(409, "INVALID_REQUEST"),
      "audit-unavailable": row(503, "SOURCE_UNAVAILABLE", "audit"),
      internal: row(500, "INTERNAL_ERROR"),
    } as unknown as typeof REFUSAL_POLICY);
    expect(REFUSAL_POLICY.internal.degrades).toBeNull();
    expect(REFUSAL_POLICY["audit-unavailable"].degrades).toBe("audit");
  });

  test("FAILED_POLICY rows are exactly the 00 §5.3 failed table", () => {
    const row = (status: number, code: string) => ({ status, code, audited: true, stored: true, degrades: null });
    expect(FAILED_POLICY).toEqual({
      "alert-not-firing": row(404, "TARGET_NOT_FOUND"),
      "silence-gone": row(404, "TARGET_NOT_FOUND"),
      "entity-not-found": row(404, "TARGET_NOT_FOUND"),
      "stale-proposal": row(409, "INVALID_REQUEST"),
      "write-failed": row(500, "INTERNAL_ERROR"),
      internal: row(500, "INTERNAL_ERROR"),
      upstreamTimeout: row(504, "SOURCE_TIMEOUT"),
      upstreamOther: row(502, "SOURCE_UNAVAILABLE"),
    } as unknown as typeof FAILED_POLICY);
  });
});

describe("refusal envelope equals the errorFor body for every RefusalReason (REQ-SEAM-06)", () => {
  test("covers all ten refusal reasons", () => {
    expect(REFUSAL_REASONS).toHaveLength(10);
  });

  for (const reason of REFUSAL_REASONS) {
    test(`${reason}: status/code match REFUSAL_POLICY and body deep-equals errorFor (REQ-SEAM-06)`, async () => {
      const policy = REFUSAL_POLICY[reason];
      const res = refusalResponse(reason, RC);
      expect(res.status).toBe(policy.status);
      const expected = await bodyOf(errorFor(policy.code, policy.status, { reason, requestId: REQUEST_ID }));
      const actual = (await bodyOf(res)) as { code: string; details: Record<string, unknown> };
      expect(actual as unknown).toEqual(expected);
      expect(actual.code).toBe(policy.code);
      expect("fields" in actual.details).toBe(false);
    });
  }

  test("fields is present only when given, and the body still equals errorFor (REQ-SEAM-06)", async () => {
    const res = refusalResponse("invalid-body", RC, "$,target.id");
    const expected = await bodyOf(
      errorFor("INVALID_REQUEST", 400, { reason: "invalid-body", requestId: REQUEST_ID, fields: "$,target.id" }),
    );
    expect(await bodyOf(res)).toEqual(expected);
    expect(refusalBody("INVALID_REQUEST", "invalid-body", REQUEST_ID)).toEqual({
      code: "INVALID_REQUEST",
      message: expect.any(String),
      details: { reason: "invalid-body", requestId: REQUEST_ID },
    });
    expect(Object.keys(refusalBody("INVALID_REQUEST", "invalid-body", REQUEST_ID).details)).not.toContain("fields");
  });
});

describe("mutation response headers (REQ-SEAM-06, REQ-SEC-06)", () => {
  test("mutationHeaders: cache-control + x-request-id; idempotency-replayed only when replayed", () => {
    expect(mutationHeaders(REQUEST_ID, false)).toEqual({
      "cache-control": "private, no-store",
      "x-request-id": REQUEST_ID,
    });
    expect(mutationHeaders(REQUEST_ID, true)).toEqual({
      "cache-control": "private, no-store",
      "x-request-id": REQUEST_ID,
      "idempotency-replayed": "true",
    });
  });

  test("refusal responses carry exactly cache-control, content-type, x-request-id (REQ-SEAM-06, REQ-SEC-06)", () => {
    for (const reason of REFUSAL_REASONS) {
      const res = refusalResponse(reason, RC);
      expect(headerNames(res)).toEqual(["cache-control", "content-type", "x-request-id"]);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-request-id")).toBe(REQUEST_ID);
      expect(res.headers.get("idempotency-replayed")).toBeNull();
    }
  });

  test("stored responses add idempotency-replayed: true only when replayed (REQ-SEAM-06)", () => {
    const stored = outcomeToStored(
      { outcome: "succeeded", status: 200, result: { fingerprint: "abc", at: "2026-09-29T00:00:00.000Z" }, details: {} },
      REQUEST_ID,
    );
    const fresh = storedResponse(stored, false);
    const replay = storedResponse(stored, true);
    expect(headerNames(fresh)).toEqual(["cache-control", "content-type", "x-request-id"]);
    expect(headerNames(replay)).toEqual(["cache-control", "content-type", "idempotency-replayed", "x-request-id"]);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
  });

  test("no identity header value or peer appears in any header or body (REQ-SEC-06)", async () => {
    const responses: Response[] = [
      ...REFUSAL_REASONS.map((r) => refusalResponse(r, RC, "$")),
      storedResponse(
        outcomeToStored({ outcome: "succeeded", status: 201, result: { silenceId: "s-1" }, details: {} }, REQUEST_ID),
        true,
      ),
      storedResponse(
        outcomeToStored(
          { outcome: "failed", reason: "write-failed", policy: FAILED_POLICY["write-failed"], details: {} },
          REQUEST_ID,
        ),
        false,
      ),
    ];
    for (const res of responses) {
      const headerText = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
      const body = await res.text();
      for (const secret of [IDENTITY_VALUE, PEER_IP, "remote-user", "x-forwarded-for"]) {
        expect(headerText.toLowerCase()).not.toContain(secret);
        expect(body).not.toContain(secret);
      }
    }
  });
});

describe("resolveFailedPolicy (REQ-SEAM-06)", () => {
  const FAILED_KEYS = ["alert-not-firing", "silence-gone", "entity-not-found", "stale-proposal", "write-failed", "internal"] as const;

  for (const key of FAILED_KEYS) {
    test(`${key} → its FAILED_POLICY row`, () => {
      expect(resolveFailedPolicy(key)).toEqual({ reason: key, policy: FAILED_POLICY[key] });
    });
  }

  test("upstream-timeout → 504 SOURCE_TIMEOUT", () => {
    const r = resolveFailedPolicy("upstream-timeout");
    expect(r.reason).toBe("upstream-timeout");
    expect(r.policy).toBe(FAILED_POLICY.upstreamTimeout);
    expect(r.policy.status).toBe(504);
    expect(r.policy.code).toBe("SOURCE_TIMEOUT");
  });

  test("other upstream-* → 502 SOURCE_UNAVAILABLE", () => {
    for (const reason of ["upstream-transport", "upstream-upstream-status"] as const satisfies readonly UpstreamReason[]) {
      const r = resolveFailedPolicy(reason);
      expect(r.reason).toBe(reason);
      expect(r.policy).toBe(FAILED_POLICY.upstreamOther);
      expect(r.policy.status).toBe(502);
      expect(r.policy.code).toBe("SOURCE_UNAVAILABLE");
    }
  });

  test("a refusal-only reason collapses to internal", () => {
    for (const reason of ["invalid-body", "cross-origin", "idempotency-conflict"] as const satisfies readonly MutationReason[]) {
      expect(resolveFailedPolicy(reason)).toEqual({ reason: "internal", policy: FAILED_POLICY.internal });
    }
  });
});

describe("outcomeToStored + storedResponse (REQ-SEAM-06)", () => {
  test("success 201 renders {outcome, requestId, result}", async () => {
    const outcome: NormalizedOutcome = {
      outcome: "succeeded",
      status: 201,
      result: { silenceId: "s-1", endsAt: "2026-09-29T02:00:00.000Z" },
      details: { silenceId: "s-1" },
    };
    const stored = outcomeToStored(outcome, REQUEST_ID);
    expect(stored).toEqual({
      status: 201,
      requestId: REQUEST_ID,
      body: { outcome: "succeeded", requestId: REQUEST_ID, result: { silenceId: "s-1", endsAt: "2026-09-29T02:00:00.000Z" } },
    });
    const res = storedResponse(stored, false);
    expect(res.status).toBe(201);
    expect(await bodyOf(res)).toEqual(stored.body);
  });

  test("success 200 renders {outcome, requestId, result}", async () => {
    const stored = outcomeToStored({ outcome: "succeeded", status: 200, result: { removed: true }, details: {} }, REQUEST_ID);
    const res = storedResponse(stored, true);
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ outcome: "succeeded", requestId: REQUEST_ID, result: { removed: true } });
  });

  test("failure renders the errorFor body at the policy status", async () => {
    const resolved = resolveFailedPolicy("stale-proposal");
    const stored = outcomeToStored(
      { outcome: "failed", reason: resolved.reason, policy: resolved.policy, details: { staleField: "expectedChurn" } },
      REQUEST_ID,
    );
    expect(stored.status).toBe(409);
    const res = storedResponse(stored, false);
    expect(res.status).toBe(409);
    const expected = await bodyOf(errorFor("INVALID_REQUEST", 409, { reason: "stale-proposal", requestId: REQUEST_ID }));
    expect(await bodyOf(res)).toEqual(expected);
  });

  test("upstream failure renders 504 SOURCE_TIMEOUT with the upstream reason", async () => {
    const resolved = resolveFailedPolicy("upstream-timeout");
    const reason: FailedReason = resolved.reason;
    const stored = outcomeToStored({ outcome: "failed", reason, policy: resolved.policy, details: {} }, REQUEST_ID);
    const res = storedResponse(stored, false);
    expect(res.status).toBe(504);
    expect(await bodyOf(res)).toEqual(
      await bodyOf(errorFor("SOURCE_TIMEOUT", 504, { reason: "upstream-timeout", requestId: REQUEST_ID })),
    );
  });
});

describe("refuse emits one log line and one metric; refusalResponse emits neither (REQ-SEAM-06, REQ-SEC-06)", () => {
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  const refusalLine = 'pulse_web_mutation_refusals_total{action="ack.set",reason="cross-origin"}';

  test("refuse() → exactly one mutation_refused line with requestId/action/reason and +1 metric", () => {
    const res = refuse("cross-origin", RC);
    expect(res.status).toBe(403);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(logSpy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      event: "mutation_refused",
      ok: false,
      requestId: REQUEST_ID,
      action: "ack.set",
      reason: "cross-origin",
    });
    const text = JSON.stringify(line);
    expect(text).not.toContain(IDENTITY_VALUE);
    expect(text).not.toContain(PEER_IP);
    expect(metricsText()).toContain(`${refusalLine} 1`);
  });

  test("emitRefusal twice → metric 2, two log lines", () => {
    emitRefusal("cross-origin", RC);
    emitRefusal("cross-origin", RC);
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(metricsText()).toContain(`${refusalLine} 2`);
  });

  test("refusalResponse() is pure: no log, no metric", () => {
    refusalResponse("cross-origin", RC);
    refusalResponse("invalid-body", RC, "$");
    expect(logSpy).not.toHaveBeenCalled();
    expect(metricsText()).not.toContain("pulse_web_mutation_refusals_total{");
  });
});
