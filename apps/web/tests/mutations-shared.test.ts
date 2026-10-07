// apps/web/tests/mutations-shared.test.ts — shared mutation wire types, the closed reason set, and the
// 00-core-definitions.md §13 constants (mutation-foundation 00 §3, §5.3, §13; 03 §1).
//
// Pure unit suite. Proves REQ-SEAM-03 (a closed, bounded reason set) and REQ-OBS-01 (every reason is a
// metric-label-safe literal), and pins the constants so drift fails here rather than in a consumer.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROPOSAL_RATIONALE_MAX_CHARS,
  PROPOSAL_RATIONALE_MIN_CHARS,
} from "@pulse/core/proposals";

import * as serverConstants from "../src/server/mutations/constants.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_RE,
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_REPLAYED_HEADER,
  IDEMPOTENCY_TTL_MS,
  INVALID_FIELDS_MAX_BYTES,
  MUTATION_BODY_MAX_BYTES,
  MUTATION_CACHE_CONTROL,
  MUTATION_ID_MAX_BYTES,
  MUTATION_PATH_PREFIX,
  PROPOSAL_LIST_MAX,
  REQUEST_ID_HEADER,
  WRITE_PATH_DEFAULTS,
  WRITE_PATH_ENV,
} from "../src/server/mutations/constants.js";
import {
  FAILED_POLICY,
  type FailedReason,
  REFUSAL_POLICY,
  type RefusalReason,
} from "../src/server/mutations/refusal.js";
import {
  ACK_NOTE_MAX_CHARS,
  ALERTNAME_LABEL,
  MUTATION_REASONS,
  type MutationReason,
  PENDING_STALE_MS,
  RATIONALE_MAX_CHARS,
  RATIONALE_MIN_CHARS,
  SILENCE_COMMENT_MAX_BYTES,
  SILENCE_COMMENT_PREFIX,
  SILENCE_DEFAULT_DURATION_MS,
  SILENCE_MATCHERS_MAX,
  SILENCE_MATCHERS_MIN,
  SILENCE_MAX_DURATION_MS,
  SILENCE_PRESETS_MS,
  type UpstreamReason,
} from "../src/shared/mutations.js";

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/**
 * Keyed by MutationReason: a literal added to or removed from the union without updating this record fails
 * typecheck (missing key / excess key). The runtime test then pins MUTATION_REASONS to exactly these keys.
 */
const EVERY_REASON: Record<MutationReason, true> = {
  "untrusted-identity": true, "cross-origin": true, "capability-false": true, "write-path-degraded": true,
  "invalid-body": true, "body-too-large": true, "missing-idempotency-key": true, "idempotency-conflict": true,
  "audit-unavailable": true, "alert-not-firing": true, "silence-gone": true, "entity-not-found": true,
  "stale-proposal": true, "write-failed": true, "internal": true,
  "upstream-timeout": true, "upstream-transport": true, "upstream-upstream-status": true,
  "upstream-malformed-json": true, "upstream-invalid-shape": true, "upstream-incompatible": true,
  "upstream-overflow": true, "upstream-disabled": true,
};

describe("MUTATION_REASONS is the closed, exhaustive MutationReason set (REQ-SEAM-03, REQ-OBS-01)", () => {
  test("type-level: element type equals MutationReason both directions; an extra literal is rejected", () => {
    const elementIsReason: Eq<(typeof MUTATION_REASONS)[number], MutationReason> = true;
    const recordKeysAreReason: Eq<keyof typeof EVERY_REASON, MutationReason> = true;
    // @ts-expect-error — "unmatched" is not a MutationReason (V-013: never a metric label value)
    const extra: MutationReason = "unmatched";
    // Refusal and failed reasons are both drawn from the closed set.
    const refusalSubset: RefusalReason extends MutationReason ? true : false = true;
    const failedSubset: FailedReason extends MutationReason ? true : false = true;
    const upstreamSubset: UpstreamReason extends MutationReason ? true : false = true;
    expect([elementIsReason, recordKeysAreReason, refusalSubset, failedSubset, upstreamSubset]).toEqual([
      true, true, true, true, true,
    ]);
    expect(extra as string).toBe("unmatched");
  });

  test("runtime: 23 unique values, exactly the MutationReason literals", () => {
    expect(MUTATION_REASONS).toHaveLength(23);
    expect(new Set(MUTATION_REASONS).size).toBe(MUTATION_REASONS.length);
    expect([...MUTATION_REASONS].sort() as string[]).toEqual(Object.keys(EVERY_REASON).sort());
  });

  test("runtime: the 00 §3.1 order is kept (15 named reasons, then the 8 upstream reasons)", () => {
    expect(MUTATION_REASONS.slice(0, 15)).toEqual([
      "untrusted-identity", "cross-origin", "capability-false", "write-path-degraded", "invalid-body",
      "body-too-large", "missing-idempotency-key", "idempotency-conflict", "audit-unavailable",
      "alert-not-firing", "silence-gone", "entity-not-found", "stale-proposal", "write-failed", "internal",
    ]);
    expect(MUTATION_REASONS.slice(15).every((r) => r.startsWith("upstream-"))).toBe(true);
  });

  test("every reason is metric-label safe (/^[a-z-]+$/)", () => {
    for (const reason of MUTATION_REASONS) expect(reason).toMatch(/^[a-z-]+$/);
  });

  test("every REFUSAL_POLICY key and every non-upstream FAILED_POLICY key is a listed reason", () => {
    const listed = new Set<string>(MUTATION_REASONS);
    for (const key of Object.keys(REFUSAL_POLICY)) expect(listed.has(key)).toBe(true);
    for (const key of Object.keys(FAILED_POLICY)) {
      if (key === "upstreamTimeout" || key === "upstreamOther") continue;
      expect(listed.has(key)).toBe(true);
    }
  });
});

describe("refusal policy block (00 §5.3)", () => {
  test("REFUSAL_POLICY: internal does not degrade; audit-unavailable degrades audit; refusals never audited or stored", () => {
    expect(REFUSAL_POLICY.internal).toEqual({ status: 500, code: "INTERNAL_ERROR", audited: false, stored: false, degrades: null });
    expect(REFUSAL_POLICY["audit-unavailable"].degrades).toBe("audit");
    expect(Object.keys(REFUSAL_POLICY)).toHaveLength(10);
    for (const p of Object.values(REFUSAL_POLICY)) {
      expect(p.audited).toBe(false);
      expect(p.stored).toBe(false);
    }
  });

  test("FAILED_POLICY: upstream timeout 504 / other 502; every failed row audited and stored", () => {
    expect(FAILED_POLICY.upstreamTimeout).toMatchObject({ status: 504, code: "SOURCE_TIMEOUT" });
    expect(FAILED_POLICY.upstreamOther).toMatchObject({ status: 502, code: "SOURCE_UNAVAILABLE" });
    expect(FAILED_POLICY["stale-proposal"]).toMatchObject({ status: 409, code: "INVALID_REQUEST" });
    for (const p of Object.values(FAILED_POLICY)) {
      expect(p.audited).toBe(true);
      expect(p.stored).toBe(true);
      expect(p.degrades).toBeNull();
    }
  });
});

describe("shared constants (00 §13)", () => {
  test("RATIONALE_* equal the @pulse/core/proposals values (pinned; the type-level pin is in the source)", () => {
    expect(RATIONALE_MIN_CHARS).toBe(PROPOSAL_RATIONALE_MIN_CHARS);
    expect(RATIONALE_MAX_CHARS).toBe(PROPOSAL_RATIONALE_MAX_CHARS);
    expect([RATIONALE_MIN_CHARS, RATIONALE_MAX_CHARS]).toEqual([10, 500]);
  });

  test("shared/mutations.ts has no runtime import of any @pulse/* package or server/ (browser bundle stays zod-free)", () => {
    const src = readFileSync(join(import.meta.dir, "../src/shared/mutations.ts"), "utf8");
    const valueImports = new Bun.Transpiler({ loader: "ts" }).scanImports(src).map((i) => i.path);
    expect(valueImports.filter((p) => p.startsWith("@pulse/") || p.includes("server/"))).toEqual([]);
    expect(src).not.toMatch(/from\s+["'][^"']*server\//);
  });

  test("silence, ack and pending constants", () => {
    expect(SILENCE_DEFAULT_DURATION_MS).toBe(7_200_000);
    expect(SILENCE_MAX_DURATION_MS).toBe(604_800_000);
    expect(SILENCE_PRESETS_MS).toEqual([3_600_000, 7_200_000, 14_400_000, 86_400_000, 604_800_000]);
    expect(SILENCE_PRESETS_MS).toContain(SILENCE_DEFAULT_DURATION_MS);
    expect(Math.max(...SILENCE_PRESETS_MS)).toBe(SILENCE_MAX_DURATION_MS);
    expect([SILENCE_MATCHERS_MIN, SILENCE_MATCHERS_MAX]).toEqual([1, 24]);
    expect(SILENCE_COMMENT_PREFIX).toBe("[pulse] ");
    expect(SILENCE_COMMENT_MAX_BYTES).toBe(512);
    expect(ACK_NOTE_MAX_CHARS).toBe(280);
    expect(PENDING_STALE_MS).toBe(30_000);
    expect(ALERTNAME_LABEL).toBe("alertname");
  });
});

describe("server constants (00 §13 server block, 03 §1)", () => {
  test("header names are lowercase and cache-control is private, no-store", () => {
    expect(MUTATION_PATH_PREFIX).toBe("/api/mutations/");
    expect(IDEMPOTENCY_KEY_HEADER).toBe("idempotency-key");
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
    expect(IDEMPOTENCY_REPLAYED_HEADER).toBe("idempotency-replayed");
    expect(MUTATION_CACHE_CONTROL).toBe("private, no-store");
  });

  test("bounds", () => {
    expect(MUTATION_ID_MAX_BYTES).toBe(128);
    expect(MUTATION_BODY_MAX_BYTES).toBe(16_384);
    expect(IDEMPOTENCY_TTL_MS).toBe(86_400_000);
    expect(IDEMPOTENCY_MAX_ENTRIES).toBe(10_000);
    expect(INVALID_FIELDS_MAX_BYTES).toBe(512);
    expect(PROPOSAL_LIST_MAX).toBe(50);
  });

  test("IDEMPOTENCY_KEY_RE accepts 8–128 base64url chars only", () => {
    expect(IDEMPOTENCY_KEY_RE.test("a".repeat(8))).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test("A-z_0".padEnd(128, "x"))).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test("a".repeat(7))).toBe(false);
    expect(IDEMPOTENCY_KEY_RE.test("a".repeat(129))).toBe(false);
    expect(IDEMPOTENCY_KEY_RE.test("abcdefg!")).toBe(false);
  });

  test("write-path env names and defaults", () => {
    expect(WRITE_PATH_ENV).toEqual({
      dataDir: "PULSE_WEB_DATA_DIR",
      auditPath: "PULSE_WEB_AUDIT_PATH",
      ackStorePath: "PULSE_WEB_ACK_STORE_PATH",
      proposalsDir: "PULSE_WEB_PROPOSALS_DIR",
      secret: "PULSE_PROPOSAL_SECRET",
    });
    expect(WRITE_PATH_DEFAULTS).toEqual({ audit: "audit/audit.jsonl", acks: "acks.json", proposals: "proposals" });
  });

  test("PROPOSAL_SECRET_MIN_BYTES is not defined here (single home: @pulse/core/proposals)", () => {
    expect("PROPOSAL_SECRET_MIN_BYTES" in serverConstants).toBe(false);
  });
});
