// mutations-silences.test.ts — silence.create / silence.expire body schemas, window, request
// construction, upstream mapping, silence-gone detection and audit details (05-silence-mutations.md §10).
// Handlers are driven with the real AM write client over a scripted fake fetch; registration is item 025.

import { describe, expect, test } from "bun:test";
import type { Identity } from "@pulse/web-data/identity";
import {
  createAlertmanagerWriteClient,
  type AlertmanagerWriteClient,
  type SourceError,
  type SourceErrorKind,
} from "@pulse/web-data/sources";
import type { CycleState } from "@pulse/web-data/cycle";
import type { AlertsPayload } from "@pulse/web-data/wire";
import type { ServerContext } from "../src/shared/registry.js";
import {
  SILENCE_COMMENT_PREFIX,
  SILENCE_MAX_DURATION_MS,
  type CreateSilenceBody,
} from "../src/shared/mutations.js";
import {
  ISO_UTC_RE,
  SILENCE_LABEL_NAME_RE,
  SILENCE_MATCHER_NAME_MAX_BYTES,
  SILENCE_MATCHER_VALUE_MAX_BYTES,
  checkSilenceWindow,
  codePointLength,
  createAuditDetails,
  createSilenceBodySchema,
  createSilenceMutation,
  expireSilenceBodySchema,
  expireSilenceMutation,
  hasForbiddenControl,
  isSilenceGone,
  toCreateSilenceRequest,
  upstreamFailure,
  utf8ByteLength,
} from "../src/server/mutations/handlers/silences.js";
import { MUTATION_ID_MAX_BYTES } from "../src/server/mutations/constants.js";
import { FAILED_POLICY } from "../src/server/mutations/refusal.js";
import {
  AUDIT_MAX_ENTRIES,
  AUDIT_SENSITIVE_KEY_SUBSTRINGS,
  buildAuditEvent,
  encodeAuditDetails,
  isWriterValidEvent,
} from "../src/server/mutations/audit.js";
import type { AuditDetails, MutationHandlerMeta } from "../src/server/mutations/registry.js";
import { FIXTURE_SILENCE_IDS, makeAlertsPayload } from "./alerts-fixtures.js";
import { fakeAlertmanagerFetch, type FakeAmStep } from "./mutations-fixtures.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const ACTOR: Identity = { subject: "gary", displayName: "Gary G.", source: "proxy-header" };
const META: MutationHandlerMeta = { requestId: "req-1", now: NOW };
const AM_URL = "http://am.test:9093";
const SILENCE_UUID = "3f1c9a2e-0000-4000-8000-000000000001";

const ALL_KINDS: readonly SourceErrorKind[] = [
  "timeout",
  "transport",
  "upstream-status",
  "malformed-json",
  "invalid-shape",
  "incompatible",
  "overflow",
  "disabled",
];

function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: "a1b2c3d4e5f60718",
    matchers: [
      { name: "alertname", value: "HostDown" },
      { name: "host", value: "nas-01" },
    ],
    endsAt: "2026-09-28T14:00:00.000Z",
    rationale: "  Planned disk swap on nas-01  ",
    ...over,
  };
}

/** Issue paths as dot-joined strings (the dispatcher's `fields` shape, minus sanitization). */
function createFields(input: unknown): string[] | null {
  const r = createSilenceBodySchema.safeParse(input);
  return r.success ? null : r.error.issues.map((i) => i.path.join("."));
}
function expireFields(input: unknown): string[] | null {
  const r = expireSilenceBodySchema.safeParse(input);
  return r.success ? null : r.error.issues.map((i) => i.path.join("."));
}
function parseCreate(input: unknown): CreateSilenceBody {
  const r = createSilenceBodySchema.safeParse(input);
  if (!r.success) throw new Error(`expected create body to parse: ${JSON.stringify(r.error.issues)}`);
  return r.data;
}

function matchers(n: number, valueBytes = 4): { name: string; value: string }[] {
  return Array.from({ length: n }, (_, i) => ({ name: i === 0 ? "alertname" : `l${i}`, value: "v".repeat(valueBytes) }));
}

function writeClient(script: readonly FakeAmStep[], timeoutMs?: number) {
  const fake = fakeAlertmanagerFetch(script);
  const client = createAlertmanagerWriteClient(AM_URL, {
    fetchImpl: fake.fetch,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { fake, client };
}

function cycleWith(payload: AlertsPayload): CycleState {
  return { alerts: { value: payload } } as unknown as CycleState;
}
function ctxWith(cycle: CycleState | null): ServerContext {
  return { cycle } as unknown as ServerContext;
}
function sourceError(kind: SourceErrorKind, status: number | null = null): SourceError {
  return { kind, message: "x", status };
}
/** A write client whose every call fails with the given error (for kinds unreachable over fetch). */
function failingClient(error: SourceError): AlertmanagerWriteClient & { calls: number } {
  const c = {
    calls: 0,
    async createSilence() {
      c.calls += 1;
      return { ok: false as const, error };
    },
    async expireSilence() {
      c.calls += 1;
      return { ok: false as const, error };
    },
  };
  return c;
}

// ── Exports and helpers ───────────────────────────────────────────────────────────────────────────

describe("silence validation primitives (REQ-SEC-07, REQ-SIL-05)", () => {
  test("byte and code-point lengths count UTF-8 bytes and code points", () => {
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(codePointLength("😀a")).toBe(2);
  });

  test("hasForbiddenControl exempts only \\n and only when allowed", () => {
    expect(hasForbiddenControl("a\nb", true)).toBe(false);
    expect(hasForbiddenControl("a\nb", false)).toBe(true);
    for (const c of ["\r", "\t", "\u0000", "\u007f", "\u0085", "\u009f"]) expect(hasForbiddenControl(`a${c}`, true)).toBe(true);
    expect(hasForbiddenControl("plain é 😀", false)).toBe(false);
  });

  test("constants carry the 05 §2 bounds", () => {
    expect(SILENCE_MATCHER_NAME_MAX_BYTES).toBe(128);
    expect(SILENCE_MATCHER_VALUE_MAX_BYTES).toBe(256);
    expect(SILENCE_LABEL_NAME_RE.test("alertname")).toBe(true);
    expect(SILENCE_LABEL_NAME_RE.test("9bad")).toBe(false);
    expect(ISO_UTC_RE.test("2026-09-28T14:00:00.000Z")).toBe(true);
    expect(ISO_UTC_RE.test("2026-09-28T14:00:00+02:00")).toBe(false);
  });
});

describe("silence definitions (REQ-SIL-01, REQ-SIL-07)", () => {
  test("create and expire carry the 05 method, path, capability and action; only create has validate", () => {
    const deps = { writeClient: failingClient(sourceError("transport")), now: () => NOW };
    const create = createSilenceMutation(deps);
    const expire = expireSilenceMutation(deps);
    expect([create.method, create.path, create.capability, create.action]).toEqual([
      "POST",
      "/api/mutations/silences",
      "silence",
      "silence.create",
    ]);
    expect([expire.method, expire.path, expire.capability, expire.action]).toEqual([
      "POST",
      "/api/mutations/silences/expire",
      "silence",
      "silence.expire",
    ]);
    expect(create.body).toBe(createSilenceBodySchema);
    expect(expire.body).toBe(expireSilenceBodySchema);
    expect(typeof create.validate).toBe("function");
    expect("validate" in expire).toBe(false);
    const body = parseCreate(validBody());
    expect(create.auditTarget(body)).toBe("alert:a1b2c3d4e5f60718");
    expect(expire.auditTarget({ silenceId: SILENCE_UUID })).toBe(`silence:${SILENCE_UUID}`);
  });
});

// ── Create body schema ────────────────────────────────────────────────────────────────────────────

describe("createSilenceBodySchema (REQ-SIL-01, REQ-SIL-02, REQ-SEC-03)", () => {
  test("a valid body parses with the rationale trimmed", () => {
    const body = parseCreate(validBody());
    expect(body.rationale).toBe("Planned disk swap on nas-01");
    expect(body.matchers).toEqual([
      { name: "alertname", value: "HostDown" },
      { name: "host", value: "nas-01" },
    ]);
  });

  test("server-set keys isRegex/isEqual/createdBy/comment/startsAt and unknown keys are refused (REQ-SIL-02, REQ-SIL-06)", () => {
    for (const key of ["createdBy", "comment", "startsAt", "extra"]) {
      expect(createFields(validBody({ [key]: "x" }))).not.toBeNull();
    }
    for (const key of ["isRegex", "isEqual"]) {
      const body = validBody({ matchers: [{ name: "alertname", value: "HostDown", [key]: false }] });
      expect(createFields(body)).not.toBeNull();
    }
  });

  test("0 and 25 matchers are refused; 1 and 24 are accepted (REQ-SIL-02)", () => {
    expect(createFields(validBody({ matchers: [] }))).toContain("matchers");
    expect(createFields(validBody({ matchers: matchers(25) }))).toContain("matchers");
    expect(createFields(validBody({ matchers: matchers(1) }))).toBeNull();
    expect(createFields(validBody({ matchers: matchers(24) }))).toBeNull();
  });

  test("a missing alertname is refused on 'matchers' (REQ-SIL-02)", () => {
    expect(createFields(validBody({ matchers: [{ name: "host", value: "nas-01" }] }))).toEqual(["matchers"]);
  });

  test("a duplicate name is refused on 'matchers.<i>.name'", () => {
    const m = [
      { name: "alertname", value: "HostDown" },
      { name: "host", value: "a" },
      { name: "host", value: "b" },
    ];
    expect(createFields(validBody({ matchers: m }))).toEqual(["matchers.2.name"]);
  });

  test("a bad label name, an over-long name, an empty value and a 257-byte value are refused; 256 bytes accepted", () => {
    const withExtra = (name: string, value: string) =>
      validBody({ matchers: [{ name: "alertname", value: "HostDown" }, { name, value }] });
    expect(createFields(withExtra("bad-name", "x"))).toEqual(["matchers.1.name"]);
    expect(createFields(withExtra("1x", "x"))).toEqual(["matchers.1.name"]);
    expect(createFields(withExtra("n".repeat(129), "x"))).toEqual(["matchers.1.name"]);
    expect(createFields(withExtra("n".repeat(128), "x"))).toBeNull();
    expect(createFields(withExtra("host", ""))).toEqual(["matchers.1.value"]);
    expect(createFields(withExtra("host", "v".repeat(257)))).toEqual(["matchers.1.value"]);
    expect(createFields(withExtra("host", "é".repeat(129)))).toEqual(["matchers.1.value"]); // 258 bytes
    expect(createFields(withExtra("host", "v".repeat(256)))).toBeNull();
  });

  test("fingerprint: empty, 129 bytes or a control char refused; 128 bytes accepted (REQ-SEC-07)", () => {
    expect(createFields(validBody({ fingerprint: "" }))).toEqual(["fingerprint"]);
    expect(createFields(validBody({ fingerprint: "f".repeat(MUTATION_ID_MAX_BYTES + 1) }))).toEqual(["fingerprint"]);
    expect(createFields(validBody({ fingerprint: "fp\u0007" }))).toEqual(["fingerprint"]);
    expect(createFields(validBody({ fingerprint: "f".repeat(MUTATION_ID_MAX_BYTES) }))).toBeNull();
  });

  test("endsAt must be ISO-8601 UTC and parseable", () => {
    expect(createFields(validBody({ endsAt: "2026-09-28 14:00" }))).toEqual(["endsAt"]);
    expect(createFields(validBody({ endsAt: "2026-09-28T14:00:00+00:00" }))).toEqual(["endsAt"]);
    expect(createFields(validBody({ endsAt: "2026-13-45T99:00:00Z" }))).toEqual(["endsAt"]);
    expect(createFields(validBody({ endsAt: "2026-09-28T14:00:00Z" }))).toBeNull();
  });

  test("a base-shape error reports only first-stage paths (superRefine does not run)", () => {
    // An invalid_type aborts the object, so the missing-alertname superRefine issue is not reported.
    expect(createFields(validBody({ matchers: [{ name: "host", value: "a" }], fingerprint: 5 }))).toEqual(["fingerprint"]);
  });
});

describe("silence rationale bounds (REQ-SIL-05, REQ-SEC-07)", () => {
  test("9 code points after trim refused, 10 accepted, 500 ASCII accepted, 501 refused", () => {
    expect(createFields(validBody({ rationale: `  ${"a".repeat(9)}  ` }))).toEqual(["rationale"]);
    expect(createFields(validBody({ rationale: `  ${"a".repeat(10)}  ` }))).toBeNull();
    expect(createFields(validBody({ rationale: "a".repeat(500) }))).toBeNull();
    expect(createFields(validBody({ rationale: "a".repeat(501) }))).toEqual(["rationale"]);
  });

  test("a 505-byte multibyte rationale under 500 chars is refused on 'rationale'; 504 bytes accepted", () => {
    const r505 = "é".repeat(252) + "a";
    expect(utf8ByteLength(r505)).toBe(505);
    expect(codePointLength(r505)).toBeLessThan(500);
    expect(createFields(validBody({ rationale: r505 }))).toEqual(["rationale"]);
    const r504 = "é".repeat(252);
    expect(utf8ByteLength(SILENCE_COMMENT_PREFIX + r504)).toBe(512);
    expect(createFields(validBody({ rationale: r504 }))).toBeNull();
  });

  test("'\\n' accepted; '\\r', '\\t', U+0000, U+007F, U+0085 refused", () => {
    expect(createFields(validBody({ rationale: "line one\nline two" }))).toBeNull();
    for (const c of ["\r", "\t", "\u0000", "\u007f", "\u0085"]) {
      expect(createFields(validBody({ rationale: `bad ${c} rationale text` }))).toEqual(["rationale"]);
    }
  });

  test("the parsed rationale is trimmed and keeps interior newlines", () => {
    expect(parseCreate(validBody({ rationale: "\n  first line\nsecond line  \n" })).rationale).toBe("first line\nsecond line");
  });
});

// ── Expire body schema ────────────────────────────────────────────────────────────────────────────

describe("expireSilenceBodySchema (REQ-SIL-07, REQ-SEC-03)", () => {
  test("rationale is optional; empty or whitespace-only normalizes to absent", () => {
    const parse = (input: unknown) => {
      const r = expireSilenceBodySchema.safeParse(input);
      if (!r.success) throw new Error("expected expire body to parse");
      return r.data;
    };
    expect(parse({ silenceId: SILENCE_UUID })).toEqual({ silenceId: SILENCE_UUID });
    expect("rationale" in parse({ silenceId: SILENCE_UUID, rationale: "   " })).toBe(false);
    expect(parse({ silenceId: SILENCE_UUID, rationale: "  done  " })).toEqual({ silenceId: SILENCE_UUID, rationale: "done" });
  });

  test("unknown keys, bad ids and bad rationales are refused", () => {
    expect(expireFields({ silenceId: SILENCE_UUID, force: true })).not.toBeNull();
    expect(expireFields({ silenceId: "" })).toEqual(["silenceId"]);
    expect(expireFields({ silenceId: "s".repeat(129) })).toEqual(["silenceId"]);
    expect(expireFields({ silenceId: "s\u0085" })).toEqual(["silenceId"]);
    expect(expireFields({ silenceId: "s".repeat(128) })).toBeNull();
    expect(expireFields({ silenceId: SILENCE_UUID, rationale: "a".repeat(501) })).toEqual(["rationale"]);
    expect(expireFields({ silenceId: SILENCE_UUID, rationale: "tab\there" })).toEqual(["rationale"]);
  });
});

// ── Window ────────────────────────────────────────────────────────────────────────────────────────

describe("checkSilenceWindow (REQ-SIL-04)", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  test("now refused, now+1ms accepted, now+7d accepted, now+7d+1ms refused with fields ['endsAt']", () => {
    expect(checkSilenceWindow(at(0), NOW)).toEqual({ ok: false, fields: ["endsAt"] });
    expect(checkSilenceWindow(at(-60_000), NOW)).toEqual({ ok: false, fields: ["endsAt"] });
    expect(checkSilenceWindow(at(1), NOW)).toEqual({ ok: true });
    expect(checkSilenceWindow(at(SILENCE_MAX_DURATION_MS), NOW)).toEqual({ ok: true });
    expect(checkSilenceWindow(at(SILENCE_MAX_DURATION_MS + 1), NOW)).toEqual({ ok: false, fields: ["endsAt"] });
  });

  test("the create definition's validate applies the window with the dispatcher's now", () => {
    const def = createSilenceMutation({ writeClient: failingClient(sourceError("transport")), now: () => NOW });
    const body = parseCreate(validBody({ endsAt: at(SILENCE_MAX_DURATION_MS + 1) }));
    expect(def.validate?.(body, ctxWith(null), NOW)).toEqual({ ok: false, fields: ["endsAt"] });
    expect(def.validate?.(parseCreate(validBody()), ctxWith(null), NOW)).toEqual({ ok: true });
  });
});

// ── Request construction and create handler ──────────────────────────────────────────────────────

describe("toCreateSilenceRequest (REQ-SIL-01, REQ-SIL-05, REQ-SIL-06)", () => {
  test("exact-equality matchers, actor displayName as creator, '[pulse] ' + trimmed rationale with \\n preserved", () => {
    const body = parseCreate(validBody({ rationale: "  first line\nsecond line  ", endsAt: "2026-09-28T14:00:00Z" }));
    const req = toCreateSilenceRequest(body, ACTOR, NOW);
    expect(req.matchers).toEqual([
      { name: "alertname", value: "HostDown", isRegex: false, isEqual: true },
      { name: "host", value: "nas-01", isRegex: false, isEqual: true },
    ]);
    expect(req.createdBy).toBe(ACTOR.displayName);
    expect(req.comment).toBe("[pulse] first line\nsecond line");
    expect(req.startsAt).toBe(NOW.toISOString());
    expect(req.endsAt).toBe("2026-09-28T14:00:00.000Z");
  });
});

describe("silence.create handler (REQ-SIL-01, REQ-SIL-09)", () => {
  test("success → 201 {silenceId, endsAt} + details {silenceId}; exactly one AM POST with the built request", async () => {
    const { fake, client } = writeClient([{ kind: "json", status: 200, body: { silenceID: SILENCE_UUID } }]);
    const def = createSilenceMutation({ writeClient: client, now: () => NOW });
    const body = parseCreate(validBody());
    const out = await def.handler(body, ctxWith(null), ACTOR, META);
    expect(out).toEqual({
      outcome: "succeeded",
      status: 201,
      result: { silenceId: SILENCE_UUID, endsAt: "2026-09-28T14:00:00.000Z" },
      details: { silenceId: SILENCE_UUID },
    });
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.method).toBe("POST");
    expect(fake.calls[0]?.url).toBe(`${AM_URL}/api/v2/silences`);
    expect(JSON.parse(fake.calls[0]?.body ?? "null")).toEqual(toCreateSilenceRequest(body, ACTOR, NOW));
  });

  test("generated valid bodies (24 × 256-byte values, 504-byte rationale) all reach AM (no pre-flight invalid-shape)", async () => {
    const bodies = [
      validBody({ matchers: matchers(24, 256), rationale: "é".repeat(252) }),
      validBody({ matchers: matchers(1), fingerprint: "f".repeat(128), rationale: "a".repeat(500) }),
      validBody({ rationale: "multi\nline\nrationale" }),
    ];
    for (const raw of bodies) {
      const { fake, client } = writeClient([{ kind: "json", status: 200, body: { silenceID: SILENCE_UUID } }]);
      const out = await createSilenceMutation({ writeClient: client, now: () => NOW }).handler(parseCreate(raw), ctxWith(null), ACTOR, META);
      expect(out.outcome).toBe("succeeded");
      expect(fake.calls.length).toBe(1);
    }
  });

  test("AM timeout → 504 SOURCE_TIMEOUT upstream-timeout after exactly one request (no retry)", async () => {
    const { fake, client } = writeClient([{ kind: "timeout" }], 20);
    const out = await createSilenceMutation({ writeClient: client, now: () => NOW }).handler(parseCreate(validBody()), ctxWith(null), ACTOR, META);
    expect(out).toEqual({ outcome: "failed", status: 504, code: "SOURCE_TIMEOUT", reason: "upstream-timeout" });
    expect(fake.calls.length).toBe(1);
  });

  test("AM transport / 400 / malformed / bad shape → 502 upstream-<kind> after exactly one request", async () => {
    const cases: [FakeAmStep, string][] = [
      [{ kind: "transport" }, "upstream-transport"],
      [{ kind: "status", status: 400 }, "upstream-upstream-status"],
      [{ kind: "malformed" }, "upstream-malformed-json"],
      [{ kind: "json", status: 200, body: {} }, "upstream-invalid-shape"],
    ];
    for (const [step, reason] of cases) {
      const { fake, client } = writeClient([step]);
      const out = await createSilenceMutation({ writeClient: client, now: () => NOW }).handler(parseCreate(validBody()), ctxWith(null), ACTOR, META);
      expect(out).toEqual({ outcome: "failed", status: 502, code: "SOURCE_UNAVAILABLE", reason } as never);
      expect(fake.calls.length).toBe(1);
    }
  });
});

// ── Upstream mapping ──────────────────────────────────────────────────────────────────────────────

describe("upstream failure mapping (REQ-SIL-09)", () => {
  test("timeout → 504 SOURCE_TIMEOUT; each other SourceErrorKind → 502 SOURCE_UNAVAILABLE upstream-<kind>", () => {
    for (const kind of ALL_KINDS) {
      const out = upstreamFailure(sourceError(kind));
      if (kind === "timeout") {
        expect(out).toEqual({ outcome: "failed", status: 504, code: "SOURCE_TIMEOUT", reason: "upstream-timeout" });
      } else {
        expect(out).toEqual({ outcome: "failed", status: 502, code: "SOURCE_UNAVAILABLE", reason: `upstream-${kind}` } as never);
      }
    }
  });

  test("the literals equal FAILED_POLICY upstreamTimeout / upstreamOther / silence-gone", () => {
    const t = upstreamFailure(sourceError("timeout"));
    const o = upstreamFailure(sourceError("transport"));
    if (t.outcome !== "failed" || o.outcome !== "failed") throw new Error("expected failed outcomes");
    expect([t.status, t.code] as unknown[]).toEqual([FAILED_POLICY.upstreamTimeout.status, FAILED_POLICY.upstreamTimeout.code]);
    expect([o.status, o.code] as unknown[]).toEqual([FAILED_POLICY.upstreamOther.status, FAILED_POLICY.upstreamOther.code]);
    expect([404, "TARGET_NOT_FOUND"]).toEqual([FAILED_POLICY["silence-gone"].status, FAILED_POLICY["silence-gone"].code]);
  });

  test("every kind through both handlers maps identically with exactly one upstream call per mutation", async () => {
    for (const kind of ALL_KINDS) {
      const error = sourceError(kind, kind === "upstream-status" ? 503 : null);
      const expected = upstreamFailure(error);
      const create = failingClient(error);
      expect(await createSilenceMutation({ writeClient: create, now: () => NOW }).handler(parseCreate(validBody()), ctxWith(null), ACTOR, META)).toEqual(expected);
      expect(create.calls).toBe(1);
      const expire = failingClient(error);
      expect(await expireSilenceMutation({ writeClient: expire, now: () => NOW }).handler({ silenceId: SILENCE_UUID }, ctxWith(null), ACTOR, META)).toEqual(expected);
      expect(expire.calls).toBe(1);
    }
  });
});

// ── Expire handler and silence-gone ───────────────────────────────────────────────────────────────

describe("isSilenceGone (REQ-SIL-10)", () => {
  const current = cycleWith(makeAlertsPayload({ scenario: "mixed" }));
  const stale = cycleWith(makeAlertsPayload({ scenario: "stale" }));
  const amDown = cycleWith(makeAlertsPayload({ scenario: "am-down" }));
  const active = FIXTURE_SILENCE_IDS.backup;
  const pending = FIXTURE_SILENCE_IDS.regex;
  const gone = FIXTURE_SILENCE_IDS.missing;

  test("404 → true, whatever the cycle", () => {
    expect(isSilenceGone(sourceError("upstream-status", 404), active, null)).toBe(true);
    expect(isSilenceGone(sourceError("upstream-status", 404), active, current)).toBe(true);
  });

  test("500 with a current or stale cycle not listing the id → true", () => {
    expect(isSilenceGone(sourceError("upstream-status", 500), gone, current)).toBe(true);
    expect(isSilenceGone(sourceError("upstream-status", 500), gone, stale)).toBe(true);
  });

  test("500 with the id listed as active or pending → false", () => {
    expect(isSilenceGone(sourceError("upstream-status", 500), active, current)).toBe(false);
    expect(isSilenceGone(sourceError("upstream-status", 500), pending, current)).toBe(false);
  });

  test("500 with cycle null or alertmanager 'unavailable' → false", () => {
    expect(isSilenceGone(sourceError("upstream-status", 500), gone, null)).toBe(false);
    expect(isSilenceGone(sourceError("upstream-status", 500), gone, amDown)).toBe(false);
  });

  test("timeout and other non-status kinds → false", () => {
    for (const kind of ALL_KINDS.filter((k) => k !== "upstream-status")) {
      expect(isSilenceGone(sourceError(kind, 404), gone, current)).toBe(false);
    }
  });
});

describe("silence.expire handler (REQ-SIL-07, REQ-SIL-09, REQ-SIL-10)", () => {
  const current = ctxWith(cycleWith(makeAlertsPayload({ scenario: "mixed" })));

  test("expire accepts a silence created by another user without the '[pulse] ' marker (no creator check, REQ-SIL-07)", async () => {
    const payload = makeAlertsPayload({ scenario: "mixed" });
    const foreign = payload.silences.find((s) => s.id === FIXTURE_SILENCE_IDS.backup);
    expect(foreign?.createdBy).not.toBe(ACTOR.displayName);
    expect(foreign?.comment.startsWith(SILENCE_COMMENT_PREFIX)).toBe(false);
    const { fake, client } = writeClient([{ kind: "status", status: 200 }]);
    const out = await expireSilenceMutation({ writeClient: client, now: () => NOW }).handler(
      { silenceId: FIXTURE_SILENCE_IDS.backup },
      current,
      ACTOR,
      META,
    );
    expect(out).toEqual({ outcome: "succeeded", status: 200, result: { silenceId: FIXTURE_SILENCE_IDS.backup } });
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.method).toBe("DELETE");
    expect(fake.calls[0]?.url).toBe(`${AM_URL}/api/v2/silence/${FIXTURE_SILENCE_IDS.backup}`);
    expect(fake.calls[0]?.body).toBeNull(); // the rationale never goes upstream
  });

  test("AM 404 → 404 TARGET_NOT_FOUND silence-gone", async () => {
    const { fake, client } = writeClient([{ kind: "status", status: 404 }]);
    const out = await expireSilenceMutation({ writeClient: client, now: () => NOW }).handler({ silenceId: SILENCE_UUID }, ctxWith(null), ACTOR, META);
    expect(out).toEqual({ outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "silence-gone" });
    expect(fake.calls.length).toBe(1);
  });

  test("AM 500 for an id absent from the current cycle → silence-gone; for a listed id → upstream-upstream-status", async () => {
    const gone = writeClient([{ kind: "status", status: 500 }]);
    expect(
      await expireSilenceMutation({ writeClient: gone.client, now: () => NOW }).handler({ silenceId: FIXTURE_SILENCE_IDS.missing }, current, ACTOR, META),
    ).toEqual({ outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "silence-gone" });
    const listed = writeClient([{ kind: "status", status: 500 }]);
    expect(
      await expireSilenceMutation({ writeClient: listed.client, now: () => NOW }).handler({ silenceId: FIXTURE_SILENCE_IDS.backup }, current, ACTOR, META),
    ).toEqual({ outcome: "failed", status: 502, code: "SOURCE_UNAVAILABLE", reason: "upstream-upstream-status" });
    expect(gone.fake.calls.length + listed.fake.calls.length).toBe(2);
  });

  test("AM timeout on expire → 504 upstream-timeout, never silence-gone", async () => {
    const { fake, client } = writeClient([{ kind: "timeout" }], 20);
    const out = await expireSilenceMutation({ writeClient: client, now: () => NOW }).handler({ silenceId: FIXTURE_SILENCE_IDS.missing }, current, ACTOR, META);
    expect(out).toEqual({ outcome: "failed", status: 504, code: "SOURCE_TIMEOUT", reason: "upstream-timeout" });
    expect(fake.calls.length).toBe(1);
  });

  test("expire auditDetails carry the rationale only when present", () => {
    const def = expireSilenceMutation({ writeClient: failingClient(sourceError("transport")), now: () => NOW });
    expect(def.auditDetails({ silenceId: SILENCE_UUID })).toEqual({});
    expect(def.auditDetails({ silenceId: SILENCE_UUID, rationale: "done" })).toEqual({ rationale: "done" });
  });
});

// ── Audit details ─────────────────────────────────────────────────────────────────────────────────

describe("silence audit details (REQ-AUD-01, REQ-SEC-07)", () => {
  function eventFor(target: string, details: AuditDetails, outcome: "attempted" | "succeeded" | "failed" = "attempted") {
    const enc = encodeAuditDetails(details);
    if (!enc.ok) throw new Error(`encode defect ${enc.defect} on ${enc.key}`);
    return buildAuditEvent({
      at: NOW,
      actor: ACTOR,
      action: "silence.create",
      capability: "silence",
      target,
      outcome,
      requestId: "req-1",
      details: enc.details,
    });
  }

  test("createAuditDetails produces endsAt, durationSeconds, matcherCount, canonical matchers and rationale", () => {
    const body = parseCreate(validBody());
    expect(createAuditDetails(body, NOW)).toEqual({
      endsAt: "2026-09-28T14:00:00.000Z",
      durationSeconds: 7200,
      matcherCount: 2,
      matchers: "alertname=HostDown,host=nas-01",
      rationale: "Planned disk swap on nas-01",
    });
    const def = createSilenceMutation({ writeClient: failingClient(sourceError("transport")), now: () => NOW });
    expect(def.auditDetails(body)).toEqual(createAuditDetails(body, NOW));
  });

  test("worst case — 24 × 256-byte matchers, a 500-char multibyte multi-line rationale and a 128-byte fingerprint — is writer-valid", () => {
    const rat500 = Array.from({ length: 50 }, () => "😀".repeat(9)).join("\n") + "é";
    expect(codePointLength(rat500)).toBe(500);
    expect(rat500.includes("\n")).toBe(true);
    const body: CreateSilenceBody = {
      fingerprint: "f".repeat(128),
      matchers: matchers(24, 256),
      endsAt: new Date(NOW.getTime() + SILENCE_MAX_DURATION_MS).toISOString(),
      rationale: rat500,
    };
    const raw = createAuditDetails(body, NOW);
    const enc = encodeAuditDetails(raw);
    if (!enc.ok) throw new Error("expected encodable details");
    expect(enc.details.matchersTruncated).toBe(true);
    expect(typeof enc.details.matchersSha256).toBe("string");
    const attempted = eventFor(`alert:${body.fingerprint}`, raw);
    expect(Object.keys(attempted.details).length).toBeLessThanOrEqual(AUDIT_MAX_ENTRIES);
    expect(isWriterValidEvent(attempted)).toBe(true);
    // Worst-case finalize details: success silenceId (≤ 512 B → 2 chunks), failure reason.
    expect(isWriterValidEvent(eventFor(`alert:${body.fingerprint}`, { silenceId: "s".repeat(512) }, "succeeded"))).toBe(true);
    expect(isWriterValidEvent(eventFor(`alert:${body.fingerprint}`, { reason: "upstream-timeout" }, "failed"))).toBe(true);
    for (const key of Object.keys(attempted.details)) {
      for (const bad of AUDIT_SENSITIVE_KEY_SUBSTRINGS) expect(key.toLowerCase().includes(bad)).toBe(false);
    }
  });

  test("expire target for a 128-byte id is writer-valid and multi-line rationale is neutralized", () => {
    const e = eventFor(`silence:${"s".repeat(128)}`, { rationale: "line one\nline two" });
    expect(isWriterValidEvent(e)).toBe(true);
    expect(e.details["rationale.1"]).toBe("line one␤line two");
  });
});
