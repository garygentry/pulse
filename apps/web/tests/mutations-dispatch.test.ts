// apps/web/tests/mutations-dispatch.test.ts — the 13-step mutation pipeline (03 §7) driven directly.
//
// Uses TEST-LOCAL fake MutationDefinitions (recording handler, configurable validate/auditDetails), a fake
// WritePath, a recording/failing AuditWriter and a stub runtime `getContext`. The five real mutations are
// covered at the end through the REAL dispatcher built by buildWriteRuntime (writeRuntimeFor). Metrics are read from `renderMetrics` text and reset in
// afterEach; logs are captured with a console.log spy. Proves REQ-COMPAT-03, REQ-SEAM-03/04, REQ-AUD-02/03/06,
// REQ-IDEM-03, REQ-SEC-01/06, REQ-AUTHZ-03 and REQ-OBS-03.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createJsonlAuditWriter, type AuditAppendResult, type AuditEvent, type AuditWriter } from "@pulse/web-data/audit";
import type { Identity } from "@pulse/web-data/identity";
import type { CycleState } from "@pulse/web-data/cycle";
import { loadAndValidate } from "@pulse/core";
import { buildWebEstateModel } from "@pulse/renderer";
import { createMutationDispatcher, type MutationDispatcherDeps } from "../src/server/mutations/dispatcher.js";
import { IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS, MUTATION_BODY_MAX_BYTES } from "../src/server/mutations/constants.js";
import { createIdempotencyStore, type IdempotencyStore } from "../src/server/mutations/idempotency.js";
import { REFUSAL_POLICY, type RefusalReason } from "../src/server/mutations/refusal.js";
import {
  createMutationRegistry,
  type MutationDefinition,
  type MutationHandlerMeta,
  type MutationOutcome,
} from "../src/server/mutations/registry.js";
import type { WritePath, WritePathSnapshot, WritePathStore } from "../src/server/mutations/write-path.js";
import type { ServerRuntime } from "../src/server/refresh.js";
import { getRuntimeStatus } from "../src/server/refresh.js";
import type { MutationDispatchContext } from "../src/server/router.js";
import { __resetMetricsForTest, renderMetrics } from "../src/server/routes/metrics.js";
import type { ServerContext } from "../src/shared/registry.js";
import {
  IDENTITY_VALUE,
  TRUSTED_IDENTITY_CONFIG,
  TRUSTED_PEER_IP,
  UNTRUSTED_PEER_IP,
  fakeClock,
  tempDataDir,
  trustedRequest,
  type FakeClock,
  type TempDataDir,
  type TrustedRequestOptions,
  fakeAlertmanagerFetch,
  writeRuntimeFor,
  type WriteRuntimeHarness,
} from "./mutations-fixtures.js";
import { makeAlertsPayload } from "./alerts-fixtures.js";

// ── Fakes ───────────────────────────────────────────────────────────────────────────────────────────

const ACK_PATH = "/api/mutations/test-ack";
const SILENCE_PATH = "/api/mutations/test-silence";

type TestBody = { readonly fp: string; readonly n?: number };
type TestResult = { readonly fp: string };

const testBodySchema: z.ZodType<TestBody, z.ZodTypeDef, unknown> = z
  .object({ fp: z.string().min(1).max(64), n: z.number().int().optional() })
  .strict()
  .transform((b) => (b.n === undefined ? { fp: b.fp } : { fp: b.fp, n: b.n }));

/** Mutable knobs shared by the fake definitions of one harness. */
interface Knobs {
  validate: ((body: TestBody, ctx: ServerContext, now: Date) => { ok: true } | { ok: false; fields: readonly string[] }) | null;
  auditDetails: (body: TestBody) => Readonly<Record<string, string | number | boolean | null>>;
  handler: (body: TestBody) => Promise<MutationOutcome<TestResult>> | MutationOutcome<TestResult>;
  /** Awaited inside the handler before it answers (concurrency tests). */
  gate: Promise<void> | null;
}

/** One recorded handler call. */
interface HandlerCall {
  readonly body: TestBody;
  readonly ctx: ServerContext;
  readonly actor: Identity;
  readonly meta: MutationHandlerMeta;
  /** Audit records already appended when the handler ran. */
  readonly auditAtCall: readonly AuditEvent[];
}

/** A recording AuditWriter whose appends can be made to fail per phase and held on a gate. */
class RecordingAudit implements AuditWriter {
  readonly events: AuditEvent[] = [];
  failAttempted = false;
  failFinalize = false;
  rejectAppend = false;
  gate: Promise<void> | null = null;
  async append(event: AuditEvent): Promise<AuditAppendResult> {
    if (this.gate !== null) await this.gate;
    if (this.rejectAppend) throw new Error("boom");
    const fail = event.outcome === "attempted" ? this.failAttempted : this.failFinalize;
    if (fail) return { ok: false, error: { kind: "write", message: "fake write failure" } };
    this.events.push(event);
    return { ok: true };
  }
  async close(): Promise<AuditAppendResult> {
    return { ok: true };
  }
}

const OK = Object.freeze({ ok: true, reason: null });
function healthySnapshot(): WritePathSnapshot {
  return Object.freeze({ audit: OK, acks: OK, proposals: OK, secret: OK, alertmanager: OK });
}

/** A fake WritePath: a mutable snapshot plus recorded markFailed calls (which degrade the snapshot). */
class FakeWritePath implements WritePath {
  snap: WritePathSnapshot = healthySnapshot();
  readonly marks: Array<{ store: string; reason: string }> = [];
  snapshot(): WritePathSnapshot {
    return this.snap;
  }
  markFailed(store: "audit" | "acks" | "proposals", reason: "write-failed" | "unwritable" | "corrupt"): void {
    this.marks.push({ store, reason });
    this.snap = Object.freeze({ ...this.snap, [store]: Object.freeze({ ok: false, reason }) });
  }
  async probe(): Promise<WritePathSnapshot> {
    return this.snap;
  }
  degrade(store: WritePathStore, reason: "unwritable" | "not-configured" | "unreachable" | "write-failed"): void {
    this.snap = Object.freeze({ ...this.snap, [store]: Object.freeze({ ok: false, reason }) });
  }
  heal(): void {
    this.snap = healthySnapshot();
  }
}

interface Harness {
  readonly dispatch: (ctx: MutationDispatchContext) => Promise<Response | null>;
  readonly knobs: Knobs;
  readonly calls: HandlerCall[];
  readonly validateNows: Date[];
  readonly audit: AuditWriter;
  readonly recording: RecordingAudit;
  readonly writePath: FakeWritePath;
  readonly idempotency: IdempotencyStore;
  readonly clock: FakeClock;
  readonly contextCalls: Array<Identity | null>;
  runtime: ServerRuntime | null;
}

function makeHarness(opts: { audit?: AuditWriter } = {}): Harness {
  const clock = fakeClock();
  const recording = new RecordingAudit();
  const audit = opts.audit ?? recording;
  const writePath = new FakeWritePath();
  const idempotency = createIdempotencyStore({ ttlMs: IDEMPOTENCY_TTL_MS, maxEntries: IDEMPOTENCY_MAX_ENTRIES, now: clock.nowMs });
  const calls: HandlerCall[] = [];
  const validateNows: Date[] = [];
  const contextCalls: Array<Identity | null> = [];
  const knobs: Knobs = {
    validate: null,
    auditDetails: (b) => ({ fp: b.fp }),
    handler: (b) => ({ outcome: "succeeded", status: 200, result: { fp: b.fp }, details: { done: true } }),
    gate: null,
  };
  const stubRuntime = {
    getContext(identity: Identity | null): ServerContext {
      contextCalls.push(identity);
      return Object.freeze({ identity }) as unknown as ServerContext;
    },
  } as unknown as ServerRuntime;

  const define = (path: `/api/mutations/${string}`, action: "ack.set" | "silence.create", capability: "ack" | "silence"): MutationDefinition<TestBody, TestResult> => ({
    method: "POST",
    path,
    capability,
    action,
    body: testBodySchema,
    validate(body, ctx, now) {
      validateNows.push(now);
      return knobs.validate === null ? { ok: true } : knobs.validate(body, ctx, now);
    },
    auditTarget: (b) => `alert:${b.fp}`,
    auditDetails: (b) => knobs.auditDetails(b),
    async handler(body, ctx, actor, meta) {
      calls.push({ body, ctx, actor, meta, auditAtCall: [...recording.events] });
      if (knobs.gate !== null) await knobs.gate;
      return await knobs.handler(body);
    },
  });

  const registry = createMutationRegistry("proxy-header");
  registry.register(define(ACK_PATH, "ack.set", "ack"));
  registry.register(define(SILENCE_PATH, "silence.create", "silence"));

  const harness: Harness = {
    dispatch: (ctx) => dispatcher(ctx),
    knobs,
    calls,
    validateNows,
    audit,
    recording,
    writePath,
    idempotency,
    clock,
    contextCalls,
    runtime: stubRuntime,
  };
  const deps: MutationDispatcherDeps = {
    identityConfig: TRUSTED_IDENTITY_CONFIG,
    getRuntime: () => harness.runtime,
    registry,
    audit,
    writePath,
    idempotency,
    now: clock.now,
  };
  const dispatcher = createMutationDispatcher(deps);
  return harness;
}

// ── Capture helpers ─────────────────────────────────────────────────────────────────────────────────

let logSpy: Mock<(...args: unknown[]) => void>;
let logLines: string[];

beforeEach(() => {
  logLines = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  __resetMetricsForTest();
});

/** Parsed structured log lines. */
function logs(): Array<Record<string, unknown>> {
  return logLines.map((l) => JSON.parse(l) as Record<string, unknown>);
}
function logsOf(event: string): Array<Record<string, unknown>> {
  return logs().filter((l) => l["event"] === event);
}

/** Non-comment metric sample lines whose name starts with `prefix`. */
function samples(prefix: string): string[] {
  return renderMetrics(getRuntimeStatus(), Date.now())
    .split("\n")
    .filter((l) => l.startsWith(prefix));
}
function sampleValue(line: string): number {
  const found = samples(line.split("{")[0]!).find((l) => l.startsWith(line));
  return found === undefined ? 0 : Number(found.slice(line.length).trim());
}
const refusalLine = (action: string, reason: string): string =>
  `pulse_web_mutation_refusals_total{action="${action}",reason="${reason}"}`;
const mutationLine = (action: string, outcome: string): string =>
  `pulse_web_mutations_total{action="${action}",outcome="${outcome}"}`;

interface Rendered {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: Record<string, unknown>;
}
async function render(res: Response | null): Promise<Rendered> {
  expect(res).not.toBeNull();
  const text = await res!.text();
  return { status: res!.status, headers: res!.headers, text, json: JSON.parse(text) as Record<string, unknown> };
}
function detailsOf(r: Rendered): Record<string, unknown> {
  return r.json["details"] as Record<string, unknown>;
}
function codeOf(r: Rendered): unknown {
  return r.json["code"];
}

const req = (body: unknown, opts: TrustedRequestOptions = {}, path = ACK_PATH): MutationDispatchContext =>
  trustedRequest(path, body, opts);

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────────

describe("dispatcher match (REQ-COMPAT-03)", () => {
  test("an unmatched path and a non-POST method return null and emit no metric or log", async () => {
    const h = makeHarness();
    expect(await h.dispatch(req({ fp: "a" }, {}, "/api/mutations/nope"))).toBeNull();
    expect(await h.dispatch(req({ fp: "a" }, {}, `${ACK_PATH}/`))).toBeNull();
    expect(await h.dispatch(req(null, { method: "GET" }))).toBeNull();
    expect(await h.dispatch(req({ fp: "a" }, { method: "PUT" }))).toBeNull();
    expect(logLines).toEqual([]);
    expect(samples("pulse_web_mutation")).toEqual([]);
    expect(samples("pulse_web_audit_write_failures_total")).toEqual([]);
    expect(h.calls.length).toBe(0);
    expect(h.recording.events.length).toBe(0);
  });
});

describe("dispatcher refusals (REQ-SEAM-03, REQ-SEC-01, REQ-AUD-06)", () => {
  /** Assert a refusal: status/code per policy, reason, 0 audit, no handler, exactly one refusal metric. */
  async function expectRefusal(
    h: Harness,
    res: Response | null,
    reason: RefusalReason,
    action = "ack.set",
  ): Promise<Rendered> {
    const r = await render(res);
    expect(r.status).toBe(REFUSAL_POLICY[reason].status);
    expect(codeOf(r)).toBe(REFUSAL_POLICY[reason].code);
    expect(detailsOf(r)["reason"]).toBe(reason);
    expect(detailsOf(r)["requestId"]).toBe(r.headers.get("x-request-id"));
    expect(h.recording.events.length).toBe(0);
    expect(h.calls.length).toBe(0);
    expect(samples("pulse_web_mutation_refusals_total")).toEqual([`${refusalLine(action, reason)} 1`]);
    expect(samples("pulse_web_mutations_total")).toEqual([]);
    const refused = logsOf("mutation_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ ok: false, requestId: r.headers.get("x-request-id"), action, reason });
    return r;
  }

  test("untrusted peer → 403 untrusted-identity (REQ-SEC-01)", async () => {
    const h = makeHarness();
    await expectRefusal(h, await h.dispatch(req({ fp: "a" }, { peerIp: UNTRUSTED_PEER_IP })), "untrusted-identity");
  });

  test("missing identity header → 403 untrusted-identity (REQ-SEC-01)", async () => {
    const h = makeHarness();
    await expectRefusal(h, await h.dispatch(req({ fp: "a" }, { identity: null })), "untrusted-identity");
  });

  test("no peer → 403 untrusted-identity", async () => {
    const h = makeHarness();
    await expectRefusal(h, await h.dispatch(req({ fp: "a" }, { peerIp: null })), "untrusted-identity");
  });

  test("cross-site Sec-Fetch-Site → 403 cross-origin", async () => {
    const h = makeHarness();
    await expectRefusal(h, await h.dispatch(req({ fp: "a" }, { secFetchSite: "cross-site" })), "cross-origin");
  });

  test("a degraded governing store → 503 write-path-degraded", async () => {
    const h = makeHarness();
    h.writePath.degrade("acks", "unwritable");
    await expectRefusal(h, await h.dispatch(req({ fp: "a" })), "write-path-degraded");
  });

  test("wrong content-type → 400 invalid-body", async () => {
    const h = makeHarness();
    const r = await expectRefusal(h, await h.dispatch(req({ fp: "a" }, { contentType: "text/plain" })), "invalid-body");
    expect("fields" in detailsOf(r)).toBe(false);
  });

  test("malformed JSON → 400 invalid-body without fields", async () => {
    const h = makeHarness();
    const r = await expectRefusal(h, await h.dispatch(req(null, { rawBody: "{not json" })), "invalid-body");
    expect("fields" in detailsOf(r)).toBe(false);
  });

  test("an unknown key → 400 invalid-body with fields `$`, never the key name", async () => {
    const h = makeHarness();
    const r = await expectRefusal(h, await h.dispatch(req({ fp: "a", secretKeyName: 1 })), "invalid-body");
    expect(detailsOf(r)["fields"]).toBe("$");
    expect(r.text).not.toContain("secretKeyName");
  });

  test("a body over 16 KiB → 413 body-too-large", async () => {
    const h = makeHarness();
    const big = JSON.stringify({ fp: "a".repeat(MUTATION_BODY_MAX_BYTES) });
    await expectRefusal(h, await h.dispatch(req(null, { rawBody: big })), "body-too-large");
  });

  test("a missing Idempotency-Key → 400 missing-idempotency-key", async () => {
    const h = makeHarness();
    await expectRefusal(h, await h.dispatch(req({ fp: "a" }, { idempotencyKey: null })), "missing-idempotency-key");
  });

  test("a malformed body without a key reports the key first", async () => {
    const h = makeHarness();
    await expectRefusal(
      h,
      await h.dispatch(req(null, { idempotencyKey: null, rawBody: "{not json" })),
      "missing-idempotency-key",
    );
  });

  test("a malformed key → 400 missing-idempotency-key", async () => {
    const h = makeHarness();
    await expectRefusal(h, await h.dispatch(req({ fp: "a" }, { idempotencyKey: "short" })), "missing-idempotency-key");
  });

  test("same key with a different body → 409 idempotency-conflict, no new audit (REQ-IDEM-03)", async () => {
    const h = makeHarness();
    expect((await render(await h.dispatch(req({ fp: "a" })))).status).toBe(200);
    expect(h.recording.events.length).toBe(2);
    __resetMetricsForTest();
    logLines.length = 0;
    const r = await render(await h.dispatch(req({ fp: "b" })));
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe(REFUSAL_POLICY["idempotency-conflict"].code);
    expect(detailsOf(r)["reason"]).toBe("idempotency-conflict");
    expect(h.recording.events.length).toBe(2);
    expect(h.calls.length).toBe(1);
    expect(samples("pulse_web_mutation_refusals_total")).toEqual([`${refusalLine("ack.set", "idempotency-conflict")} 1`]);
  });

  test("a validate failure → 400 invalid-body with its fields, 0 audit records, key reusable", async () => {
    const h = makeHarness();
    h.knobs.validate = () => ({ ok: false, fields: ["fp", "n"] });
    const r = await expectRefusal(h, await h.dispatch(req({ fp: "a" })), "invalid-body");
    expect(detailsOf(r)["fields"]).toBe("fp,n");
    expect(h.idempotency.size()).toBe(0);
    h.knobs.validate = null;
    const ok = await render(await h.dispatch(req({ fp: "a" })));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("idempotency-replayed")).toBeNull();
    expect(h.calls.length).toBe(1);
  });

  test("a validate throw → 500 internal refusal, logged with phase validate", async () => {
    const h = makeHarness();
    h.knobs.validate = () => {
      throw new Error("validate exploded");
    };
    await expectRefusal(h, await h.dispatch(req({ fp: "a" })), "internal");
    expect(logsOf("mutation_internal_error").map((l) => l["phase"])).toEqual(["validate"]);
    expect(h.idempotency.size()).toBe(0);
  });

  test("a null runtime → 500 internal refusal, logged with phase dispatch", async () => {
    const h = makeHarness();
    h.runtime = null;
    await expectRefusal(h, await h.dispatch(req({ fp: "a" })), "internal");
    expect(logsOf("mutation_internal_error").map((l) => l["phase"])).toEqual(["dispatch"]);
  });
});

describe("audit ordering and meta (REQ-SEAM-04, REQ-AUD-02, REQ-AUD-03, REQ-OBS-03)", () => {
  test("attempted is appended before the handler; meta.requestId matches both records and X-Request-Id; meta.now is the validate now", async () => {
    const h = makeHarness();
    const r = await render(await h.dispatch(req({ fp: "a" })));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ outcome: "succeeded", requestId: r.headers.get("x-request-id"), result: { fp: "a" } });

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.auditAtCall.map((e) => e.outcome)).toEqual(["attempted"]);
    expect(h.recording.events.map((e) => e.outcome)).toEqual(["attempted", "succeeded"]);

    const requestId = r.headers.get("x-request-id");
    expect(call.meta.requestId).toBe(requestId!);
    for (const e of h.recording.events) expect(e.requestId).toBe(requestId!);

    expect(h.validateNows).toHaveLength(1);
    expect(call.meta.now).toBe(h.validateNows[0]!);
    expect(call.meta.now.getTime()).toBe(h.clock.nowMs());
    expect(call.ctx).toBe(h.calls[0]!.ctx);
    expect(h.contextCalls).toHaveLength(1);
    expect(call.actor).toEqual({ subject: IDENTITY_VALUE, displayName: IDENTITY_VALUE, source: "proxy-header" });

    // Finalize details = attempted details + handler details; capability recorded.
    expect(h.recording.events[1]!.details).toEqual({ fp: "a", done: true });
    expect(h.recording.events[1]!.capability).toBe("ack");

    expect(sampleValue(mutationLine("ack.set", "succeeded"))).toBe(1);
    const ok = logsOf("mutation_succeeded");
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ ok: true, requestId, action: "ack.set", status: 200 });
  });

  test("a failed outcome is normalized by FAILED_POLICY and audited `failed` with the reason", async () => {
    const h = makeHarness();
    h.knobs.handler = () => ({ outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "alert-not-firing" });
    const r = await render(await h.dispatch(req({ fp: "a" })));
    expect(r.status).toBe(404);
    expect(codeOf(r)).toBe("TARGET_NOT_FOUND");
    expect(detailsOf(r)["reason"]).toBe("alert-not-firing");
    expect(h.recording.events.map((e) => e.outcome)).toEqual(["attempted", "failed"]);
    expect(h.recording.events[1]!.details["reason"]).toBe("alert-not-firing");
    expect(sampleValue(mutationLine("ack.set", "failed"))).toBe(1);
    expect(logsOf("mutation_failed")[0]).toMatchObject({ status: 404, reason: "alert-not-firing" });
  });
});

describe("fail-closed audit (REQ-SEAM-04, REQ-AUD-02, REQ-AUD-06)", () => {
  test("a failing attempted append → 503 audit-unavailable, 0 handler calls, counter +1, audit marked failed", async () => {
    const h = makeHarness();
    h.recording.failAttempted = true;
    const r = await render(await h.dispatch(req({ fp: "a" })));
    expect(r.status).toBe(503);
    expect(detailsOf(r)["reason"]).toBe("audit-unavailable");
    expect(h.calls.length).toBe(0);
    expect(h.recording.events.length).toBe(0);
    expect(sampleValue(`pulse_web_audit_write_failures_total{phase="attempted"}`)).toBe(1);
    expect(samples("pulse_web_audit_write_failures_total")).toHaveLength(1);
    expect(sampleValue(refusalLine("ack.set", "audit-unavailable"))).toBe(1);
    expect(h.writePath.marks).toEqual([{ store: "audit", reason: "write-failed" }]);
    expect(h.writePath.snapshot().audit.ok).toBe(false);
    expect(logsOf("audit_write_failed")[0]).toMatchObject({ phase: "attempted", kind: "write" });
    expect(h.idempotency.size()).toBe(0);
  });

  test("a rejecting append is treated as a write failure", async () => {
    const h = makeHarness();
    h.recording.rejectAppend = true;
    const r = await render(await h.dispatch(req({ fp: "a" })));
    expect(r.status).toBe(503);
    expect(h.calls.length).toBe(0);
  });

  test("encoder-invalid attempted details (300-byte plain value) → 500 internal, no handler, no markFailed", async () => {
    const h = makeHarness();
    h.knobs.auditDetails = () => ({ blob: "x".repeat(300) });
    const r = await render(await h.dispatch(req({ fp: "a" })));
    expect(r.status).toBe(500);
    expect(codeOf(r)).toBe("INTERNAL_ERROR");
    expect(detailsOf(r)["reason"]).toBe("internal");
    expect(h.calls.length).toBe(0);
    expect(h.recording.events.length).toBe(0);
    expect(h.writePath.marks).toEqual([]);
    expect(h.writePath.snapshot().audit.ok).toBe(true);
    expect(sampleValue(refusalLine("ack.set", "internal"))).toBe(1);
    expect(logsOf("mutation_internal_error").map((l) => l["phase"])).toEqual(["encode"]);
    expect(h.idempotency.size()).toBe(0);
  });

  test("a finalize append failure → real 2xx outcome, finalize counter +1, audit_write_failed log, audit marked failed", async () => {
    const h = makeHarness();
    h.recording.failFinalize = true;
    const r = await render(await h.dispatch(req({ fp: "a" })));
    expect(r.status).toBe(200);
    expect(r.json["outcome"]).toBe("succeeded");
    expect(h.recording.events.map((e) => e.outcome)).toEqual(["attempted"]);
    expect(sampleValue(`pulse_web_audit_write_failures_total{phase="finalize"}`)).toBe(1);
    expect(sampleValue(mutationLine("ack.set", "succeeded"))).toBe(1);
    const failed = logsOf("audit_write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ phase: "finalize", kind: "write", requestId: r.headers.get("x-request-id") });
    expect(h.writePath.marks).toEqual([{ store: "audit", reason: "write-failed" }]);
  });

  test("oversized finalize details fall back to the attempted details (response unchanged)", async () => {
    const h = makeHarness();
    h.knobs.handler = (b) => ({ outcome: "succeeded", status: 201, result: { fp: b.fp }, details: { blob: "y".repeat(300) } });
    const r = await render(await h.dispatch(req({ fp: "a" })));
    expect(r.status).toBe(201);
    expect(h.recording.events[1]!.details).toEqual({ fp: "a" });
    expect(logsOf("mutation_internal_error").map((l) => l["phase"])).toEqual(["encode"]);
    expect(h.writePath.marks).toEqual([]);
  });
});

describe("idempotency in the pipeline (REQ-IDEM-03)", () => {
  test("a replay returns identical status/body with Idempotency-Replayed: true and no new audit records", async () => {
    const h = makeHarness();
    const first = await render(await h.dispatch(req({ fp: "a" })));
    const second = await render(await h.dispatch(req({ fp: "a" })));
    expect(second.status).toBe(first.status);
    expect(second.text).toBe(first.text);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(first.headers.get("idempotency-replayed")).toBeNull();
    expect(second.headers.get("x-request-id")).toBe(first.headers.get("x-request-id"));
    expect(h.recording.events.length).toBe(2);
    expect(h.calls.length).toBe(1);
    expect(sampleValue(mutationLine("ack.set", "replayed"))).toBe(1);
    expect(sampleValue(mutationLine("ack.set", "succeeded"))).toBe(1);
    expect(logsOf("mutation_succeeded").map((l) => l["replayed"] ?? false)).toEqual([false, true]);
  });

  test("two concurrent identical requests → one handler call, one audit pair, same body", async () => {
    const h = makeHarness();
    const gate = Promise.withResolvers<void>();
    h.knobs.gate = gate.promise;
    const p1 = h.dispatch(req({ fp: "a" }));
    while (h.calls.length === 0) await Bun.sleep(1);
    const p2 = h.dispatch(req({ fp: "a" }));
    await Bun.sleep(5);
    gate.resolve();
    const [a, b] = await Promise.all([p1.then(render), p2.then(render)]);
    expect(h.calls.length).toBe(1);
    expect(h.recording.events.map((e) => e.outcome)).toEqual(["attempted", "succeeded"]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.text).toBe(a.text);
    expect(b.headers.get("idempotency-replayed")).toBe("true");
    expect(sampleValue(mutationLine("ack.set", "succeeded"))).toBe(1);
    expect(sampleValue(mutationLine("ack.set", "replayed"))).toBe(1);
  });

  test("concurrent requests with a failing attempted writer both get 503; the store is empty; a third request after the fix succeeds", async () => {
    const h = makeHarness();
    h.recording.failAttempted = true;
    const gate = Promise.withResolvers<void>();
    h.recording.gate = gate.promise;
    const p1 = h.dispatch(req({ fp: "a" }));
    while (h.idempotency.size() === 0) await Bun.sleep(1);
    const p2 = h.dispatch(req({ fp: "a" }));
    await Bun.sleep(5);
    gate.resolve();
    const [a, b] = await Promise.all([p1.then(render), p2.then(render)]);
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(detailsOf(a)["reason"]).toBe("audit-unavailable");
    expect(detailsOf(b)["reason"]).toBe("audit-unavailable");
    expect(h.calls.length).toBe(0);
    expect(h.idempotency.size()).toBe(0);
    expect(sampleValue(refusalLine("ack.set", "audit-unavailable"))).toBe(2);
    expect(sampleValue(`pulse_web_audit_write_failures_total{phase="attempted"}`)).toBe(1);

    h.recording.gate = null;
    h.recording.failAttempted = false;
    h.writePath.heal();
    const c = await render(await h.dispatch(req({ fp: "a" })));
    expect(c.status).toBe(200);
    expect(c.headers.get("idempotency-replayed")).toBeNull();
    expect(h.calls.length).toBe(1);
  });

  test("a handler throw → 500 failed, audited failed with reason internal, stored and replayed identically", async () => {
    const h = makeHarness();
    h.knobs.handler = () => {
      throw new Error("handler exploded");
    };
    const r = await render(await h.dispatch(req({ fp: "a" })));
    expect(r.status).toBe(500);
    expect(codeOf(r)).toBe("INTERNAL_ERROR");
    expect(detailsOf(r)["reason"]).toBe("internal");
    expect(h.recording.events.map((e) => e.outcome)).toEqual(["attempted", "failed"]);
    expect(h.recording.events[1]!.details["reason"]).toBe("internal");
    const internal = logsOf("mutation_internal_error");
    expect(internal).toHaveLength(1);
    expect(internal[0]).toMatchObject({ phase: "handler", error: "handler exploded", requestId: r.headers.get("x-request-id") });
    expect(sampleValue(mutationLine("ack.set", "failed"))).toBe(1);

    const replay = await render(await h.dispatch(req({ fp: "a" })));
    expect(replay.status).toBe(500);
    expect(replay.text).toBe(r.text);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(h.calls.length).toBe(1);
    expect(h.recording.events.length).toBe(2);
  });
});

describe("capability re-evaluated per request (REQ-AUTHZ-03)", () => {
  test("capability flips between requests via the fake WritePath snapshot", async () => {
    const h = makeHarness();
    const key = (n: number): TrustedRequestOptions => ({ idempotencyKey: `flip-key-${String(n).padStart(4, "0")}` });

    expect((await render(await h.dispatch(req({ fp: "a" }, key(1), SILENCE_PATH)))).status).toBe(200);

    h.writePath.degrade("alertmanager", "unreachable");
    const denied = await render(await h.dispatch(req({ fp: "a" }, key(2), SILENCE_PATH)));
    expect(denied.status).toBe(503);
    expect(detailsOf(denied)["reason"]).toBe("write-path-degraded");
    // The ack capability does not depend on alertmanager.
    expect((await render(await h.dispatch(req({ fp: "a" }, key(3))))).status).toBe(200);

    h.writePath.heal();
    expect((await render(await h.dispatch(req({ fp: "a" }, key(2), SILENCE_PATH)))).status).toBe(200);

    h.writePath.degrade("audit", "unwritable");
    expect((await render(await h.dispatch(req({ fp: "a" }, key(4))))).status).toBe(503);
    expect(sampleValue(refusalLine("silence.create", "write-path-degraded"))).toBe(1);
    expect(sampleValue(refusalLine("ack.set", "write-path-degraded"))).toBe(1);
  });
});

describe("response headers and non-disclosure (REQ-SEC-06, REQ-OBS-03)", () => {
  let dir: TempDataDir | null = null;
  let writer: AuditWriter | null = null;
  afterEach(async () => {
    await writer?.close();
    writer = null;
    await dir?.cleanup();
    dir = null;
  });

  test("every response after step 2 carries cache-control and x-request-id; identity header value and peerIp appear in no response, log line or JSONL audit file", async () => {
    dir = await tempDataDir();
    writer = createJsonlAuditWriter({ absolutePath: dir.auditPath });
    const h = makeHarness({ audit: writer });
    const responses: Rendered[] = [];
    const run = async (ctx: MutationDispatchContext): Promise<void> => {
      responses.push(await render(await h.dispatch(ctx)));
    };
    const k = (n: number): TrustedRequestOptions => ({ idempotencyKey: `leak-key-${String(n).padStart(4, "0")}` });

    await run(req({ fp: "a" }, k(1))); // success
    await run(req({ fp: "a" }, k(1))); // replay
    await run(req({ fp: "b" }, k(1))); // conflict
    await run(req({ fp: "a" }, { ...k(2), peerIp: UNTRUSTED_PEER_IP })); // untrusted-identity
    await run(req({ fp: "a" }, { ...k(3), secFetchSite: "cross-site" })); // cross-origin
    await run(req({ fp: "a" }, { ...k(4), contentType: "text/plain" })); // invalid-body
    await run(req(null, { ...k(5), rawBody: "x".repeat(MUTATION_BODY_MAX_BYTES + 1) })); // body-too-large
    await run(req({ fp: "a" }, { idempotencyKey: null })); // missing key
    h.knobs.handler = () => {
      throw new Error("handler exploded");
    };
    await run(req({ fp: "c" }, k(6))); // handler throw → audited failed
    h.knobs.handler = () => ({ outcome: "failed", status: 409, code: "INVALID_REQUEST", reason: "stale-proposal" });
    await run(req({ fp: "d" }, k(7))); // failed outcome
    h.writePath.degrade("acks", "unwritable");
    await run(req({ fp: "e" }, k(8))); // write-path-degraded

    expect(responses.map((r) => r.status)).toEqual([200, 200, 409, 403, 403, 400, 413, 400, 500, 409, 503]);
    for (const r of responses) {
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      const headerText = [...r.headers.entries()].map(([n, v]) => `${n}: ${v}`).join("\n");
      for (const secret of [IDENTITY_VALUE, TRUSTED_PEER_IP, UNTRUSTED_PEER_IP]) {
        expect(r.text).not.toContain(secret);
        expect(headerText).not.toContain(secret);
      }
    }

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).not.toContain(IDENTITY_VALUE);
      expect(line).not.toContain(TRUSTED_PEER_IP);
      expect(line).not.toContain(UNTRUSTED_PEER_IP);
      // Every mutation log line carries the requestId tying it to its audit pair (REQ-OBS-03).
      expect(typeof (JSON.parse(line) as Record<string, unknown>)["requestId"]).toBe("string");
    }

    // The audit file: the actor is exactly the 3-key Identity shape (the resolved identity is the one
    // permitted carrier); no other field carries the header value, and no field carries a peer.
    const text = await readFile(dir.auditPath, "utf8");
    expect(text).not.toContain(TRUSTED_PEER_IP);
    expect(text).not.toContain(UNTRUSTED_PEER_IP);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l["outcome"])).toEqual(["attempted", "succeeded", "attempted", "failed", "attempted", "failed"]);
    for (const line of lines) {
      expect(line["actor"]).toEqual({ subject: IDENTITY_VALUE, displayName: IDENTITY_VALUE, source: "proxy-header" });
      const { actor: _actor, ...rest } = line;
      expect(JSON.stringify(rest)).not.toContain(IDENTITY_VALUE);
    }
    // Audit pairs share the response request ids.
    const ids = [responses[0]!, responses[8]!, responses[9]!].map((r) => r.headers.get("x-request-id"));
    expect(lines.map((l) => l["requestId"])).toEqual([ids[0], ids[0], ids[1], ids[1], ids[2], ids[2]]);
  });
});

// ── The five real mutations through buildWriteRuntime (item 025) ────────────────────────────────────

const PARITY_FIXTURE = new URL("../../../packages/core/tests/fixtures/proposals-parity", import.meta.url).pathname;

function parityEstate(): ServerContext["estate"] {
  const loaded = loadAndValidate(PARITY_FIXTURE);
  if (!loaded.ok) throw new Error("parity fixture failed to load");
  const web = buildWebEstateModel(loaded.model);
  if (!web.ok) throw new Error("parity fixture tripped web safety");
  return { model: web.value } as unknown as ServerContext["estate"];
}

const AM_SILENCE_ID = "3f1c9a2e-0000-4000-8000-0000000000aa";

describe("real mutations through the buildWriteRuntime dispatcher (REQ-SEAM-01, REQ-SEAM-02, REQ-AUD-02)", () => {
  let h: WriteRuntimeHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  async function harness(): Promise<WriteRuntimeHarness> {
    h = await writeRuntimeFor({
      am: fakeAlertmanagerFetch([
        { kind: "json", status: 200, body: { silenceID: AM_SILENCE_ID } },
        { kind: "json", status: 200, body: {} },
      ]),
      context: {
        cycle: { alerts: { value: makeAlertsPayload({ scenario: "mixed" }) } } as unknown as CycleState,
        estate: parityEstate(),
      },
    });
    return h;
  }

  /** Status, parsed body and the attempted + final audit pair sharing the response's request id. */
  async function run(
    hh: WriteRuntimeHarness,
    path: string,
    body: unknown,
    key: string,
  ): Promise<{ status: number; body: Record<string, unknown>; pair: Array<Record<string, unknown>> }> {
    const res = await hh.dispatch(trustedRequest(path, body, { idempotencyKey: key }));
    const requestId = res.headers.get("x-request-id");
    const parsed = (await res.json()) as Record<string, unknown>;
    const pair = (await hh.auditEvents())
      .filter((e) => e.requestId === requestId)
      .map((e) => e as unknown as Record<string, unknown>);
    return { status: res.status, body: parsed, pair };
  }

  function expectPair(pair: Array<Record<string, unknown>>, action: string, capability: string, target: string): void {
    expect(pair.map((e) => e["outcome"])).toEqual(["attempted", "succeeded"]);
    for (const e of pair) {
      expect(e["action"]).toBe(action);
      expect(e["capability"]).toBe(capability);
      expect(e["target"]).toBe(target);
    }
  }

  test("the write path is fully healthy over a temp data dir with a secret and an AM URL", async () => {
    const hh = await harness();
    const snap = hh.write.writePath.snapshot();
    for (const store of ["audit", "acks", "proposals", "secret", "alertmanager"] as const) {
      expect(snap[store]).toEqual({ ok: true, reason: null });
    }
  });

  test("silence.create → 201 {silenceId, endsAt}, one AM POST, paired attempted + succeeded audit lines", async () => {
    const hh = await harness();
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    const out = await run(
      hh,
      "/api/mutations/silences",
      {
        fingerprint: "fp-host-down",
        matchers: [{ name: "alertname", value: "HostDown" }, { name: "host", value: "web-01" }],
        endsAt,
        rationale: "Planned maintenance on web-01",
      },
      "real-silence-create-01",
    );
    expect(out.status).toBe(201);
    expect(out.body["result"]).toEqual({ silenceId: AM_SILENCE_ID, endsAt });
    expect(hh.am.calls.map((c) => c.method)).toEqual(["POST"]);
    expectPair(out.pair, "silence.create", "silence", "alert:fp-host-down");
    expect(out.pair[1]!["details"]).toMatchObject({ "silenceId.1": AM_SILENCE_ID });
  });

  test("silence.expire → 200, one AM DELETE, paired audit lines", async () => {
    const hh = await harness();
    hh.am.calls.length = 0;
    const out = await run(hh, "/api/mutations/silences/expire", { silenceId: AM_SILENCE_ID }, "real-silence-expire-01");
    expect(out.status).toBe(200);
    expect(out.body["result"]).toEqual({ silenceId: AM_SILENCE_ID });
    expect(hh.am.calls.map((c) => c.method)).toEqual(["DELETE"]);
    expectPair(out.pair, "silence.expire", "silence", `silence:${AM_SILENCE_ID}`);
  });

  test("ack.set → 200 and persisted to acks.json; ack.remove → 200 {removed:true}; both audited in pairs, 0 AM calls", async () => {
    const hh = await harness();
    const set = await run(hh, "/api/mutations/acks", { fingerprint: "fp-host-down", note: "on it" }, "real-ack-set-0001");
    expect(set.status).toBe(200);
    expect((set.body["result"] as Record<string, unknown>)["fingerprint"]).toBe("fp-host-down");
    expectPair(set.pair, "ack.set", "ack", "alert:fp-host-down");
    const file = JSON.parse(await readFile(hh.dir.acksPath, "utf8")) as { acks: Record<string, unknown> };
    expect(Object.keys(file.acks)).toEqual(["fp-host-down"]);

    const remove = await run(hh, "/api/mutations/acks/remove", { fingerprint: "fp-host-down" }, "real-ack-remove-01");
    expect(remove.status).toBe(200);
    expect(remove.body["result"]).toEqual({ fingerprint: "fp-host-down", removed: true });
    expectPair(remove.pair, "ack.remove", "ack", "alert:fp-host-down");
    expect(hh.am.calls).toHaveLength(0);
  });

  test("proposal.create → 201 {proposalId}; the signed file exists; paired audit lines", async () => {
    const hh = await harness();
    const out = await run(
      hh,
      "/api/mutations/proposals",
      {
        target: { kind: "host", id: "host:app-01" },
        changes: [{ field: "cadvisor", seen: false, proposed: true }],
        rationale: "Container metrics are needed for the new stack.",
      },
      "real-proposal-create-01",
    );
    expect(out.status).toBe(201);
    const proposalId = (out.body["result"] as Record<string, unknown>)["proposalId"] as string;
    expect(proposalId).toMatch(/^p-/);
    await readFile(`${hh.dir.proposalsDir}/${proposalId}.proposal.json`, "utf8");
    expectPair(out.pair, "proposal.create", "proposeEstateEdit", "host:host:app-01");
  });
});
