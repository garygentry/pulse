/** wire-history-live-session.test.ts — evidence for item 008 (01-core-definitions.md
 *  §§5–8, 11). Covers the history/live/session wire contracts and the strict wire
 *  validation helpers:
 *   - history contracts carry all request/result metadata, bounded attributed lanes,
 *     Gatus provenance, explicit stale state, and null semantics (criterion 1);
 *   - `LiveTick` is exactly the observation plus five view identities and
 *     `ViewDeliveryState.phase` is the exact initial/current/stale union (criterion 2);
 *   - `SessionPayload` capabilities reference `SessionCapabilities` whose members are
 *     `boolean` (widened by mutation-foundation 00 §5.2; was literal `false` in M1) and
 *     `Identity` is exactly subject/displayName/source (criterion 3);
 *   - `validateCycleObservation` rejects incomplete/extra/malformed/oversized metadata
 *     without exposing raw values, and never throws (criterion 4).
 *
 *  Package tests are not typechecked, so every claim is made at runtime — either via the
 *  installed TypeScript compiler AST over the source declarations, or via the exported
 *  runtime validators. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

import { OBSERVATION_HEADER_MAX_BYTES } from "../src/wire/common.js";
import {
  validateCycleObservation,
  validateHashId,
  validateLiveTick,
  validateSourceObservation,
} from "../src/wire/validate.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function parseFile(rel: string): ts.SourceFile {
  const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
}

function findInterface(sf: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const found = sf.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
  );
  if (!found) throw new Error(`interface ${name} not found in ${sf.fileName}`);
  return found;
}

function propNames(iface: ts.InterfaceDeclaration): string[] {
  return iface.members
    .filter((m): m is ts.PropertySignature => ts.isPropertySignature(m))
    .map((m) => m.name.getText(iface.getSourceFile()))
    .sort();
}

function propType(iface: ts.InterfaceDeclaration, name: string): string {
  const sf = iface.getSourceFile();
  const m = iface.members.find(
    (m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.name.getText(sf) === name,
  );
  return m?.type ? m.type.getText(sf).replace(/\s+/g, " ") : "";
}

// A minimal valid observation with all ten fixed source ids present.
const SOURCE_IDS = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
] as const;
const VIEW_IDS = ["overview", "alerts", "estate", "engine", "timeline"] as const;
const HASH = `sha256:${"a".repeat(64)}` as const;

function validObservation(): Record<string, unknown> {
  const sources: Record<string, unknown> = {};
  for (const id of SOURCE_IDS) {
    sources[id] = { state: "current", lastAttemptAt: "2026-09-16T00:00:00.000Z", lastSuccess: "2026-09-16T00:00:00.000Z" };
  }
  return { generation: "gen-1", seq: 1, observedAt: "2026-09-16T00:00:00.000Z", appVersion: "1.0.0", sources };
}

function validTick(): Record<string, unknown> {
  const identities: Record<string, unknown> = {};
  for (const view of VIEW_IDS) identities[view] = HASH;
  return { observation: validObservation(), identities };
}

// ---------------------------------------------------------------------------
// Criterion 1 — history contracts
// ---------------------------------------------------------------------------

describe("history wire contracts (criterion 1)", () => {
  const sf = parseFile("packages/web-data/src/wire/history.ts");

  test("HistoryPayload carries all request/result metadata and explicit stale state", () => {
    expect(propNames(findInterface(sf, "HistoryPayload"))).toEqual(
      ["effectiveStepSeconds", "fetchedAt", "queryId", "range", "series", "stale", "target", "unit"].sort(),
    );
  });

  test("HistorySeries points use explicit null-value gap semantics", () => {
    const t = propType(findInterface(sf, "HistorySeries"), "points");
    expect(t).toContain("number | null");
  });

  test("AlertHistoryLane exposes the five canonical minimized labels and vmalert provenance", () => {
    const lane = findInterface(sf, "AlertHistoryLane");
    const labels = propType(lane, "labels");
    for (const key of ["alertname", "severity", "host", "service", "instance"]) {
      expect(labels).toContain(key);
    }
    expect(labels).toContain("string | null");
    expect(propType(lane, "provenance")).toBe('"vmalert"');
    // Attributed target is nullable when unmatched.
    expect(propType(lane, "target")).toContain("| null");
  });

  test("EndpointHistoryPayload has gatus provenance, stale state, and irregular-step null semantics", () => {
    const p = findInterface(sf, "EndpointHistoryPayload");
    expect(propType(p, "provenance")).toBe('"gatus"');
    expect(propType(p, "stale")).toBe("boolean");
    expect(propType(p, "effectiveStepSeconds")).toContain("number | null");
    expect(propNames(p)).toContain("incidents");
  });

  test("IntervalHistoryPayload is the alert-intervals operation with bounded lanes", () => {
    const p = findInterface(sf, "IntervalHistoryPayload");
    expect(propType(p, "operation")).toBe('"alert-intervals"');
    expect(propType(p, "unit")).toBe('"state"');
    expect(propNames(p)).toContain("lanes");
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — LiveTick and view delivery state
// ---------------------------------------------------------------------------

describe("live wire contracts (criterion 2)", () => {
  const sf = parseFile("packages/web-data/src/wire/live.ts");

  test("LiveTick has exactly the observation and view identities", () => {
    expect(propNames(findInterface(sf, "LiveTick"))).toEqual(["identities", "observation"]);
  });

  test("ViewDeliveryState carries the phase and bounded per-view failure cause", () => {
    const state = findInterface(sf, "ViewDeliveryState");
    expect(propType(state, "phase")).toBe('"initial" | "current" | "stale"');
    expect(propType(state, "failure")).toBe("ViewDeliveryFailure | null");
    const failure = findInterface(sf, "ViewDeliveryFailure");
    expect(propNames(failure)).toEqual(["code", "message", "status"]);
    expect(propType(failure, "code")).toBe("ApiErrorCode");
  });

  test("validateLiveTick accepts a tick with all five view identities", () => {
    const tick = validateLiveTick(validTick());
    expect(tick).not.toBeNull();
    expect(Object.keys(tick!.identities).sort()).toEqual([...VIEW_IDS].sort());
  });

  test("validateLiveTick rejects a missing or extra view identity", () => {
    const missing = validTick();
    delete (missing.identities as Record<string, unknown>).timeline;
    expect(validateLiveTick(missing)).toBeNull();

    const extra = validTick();
    (extra.identities as Record<string, unknown>).bogus = HASH;
    expect(validateLiveTick(extra)).toBeNull();
  });

  test("validateLiveTick rejects a malformed identity value", () => {
    const bad = validTick();
    (bad.identities as Record<string, unknown>).overview = "not-a-hash";
    expect(validateLiveTick(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — session identity and boolean capabilities (widened by mutation-foundation 00 §5.2)
// ---------------------------------------------------------------------------

describe("session and identity contracts (criterion 3)", () => {
  test("Identity has exactly subject, displayName, and source", () => {
    const sf = parseFile("packages/web-data/src/identity/resolve.ts");
    expect(propNames(findInterface(sf, "Identity"))).toEqual(["displayName", "source", "subject"]);
    expect(propType(findInterface(sf, "Identity"), "source")).toBe('"proxy-header"');
  });

  test("SessionPayload capabilities reference SessionCapabilities with boolean members (REQ-AUTHZ-02, REQ-COMPAT-01)", () => {
    const sf = parseFile("packages/web-data/src/wire/session.ts");
    const capabilities = findInterface(sf, "SessionPayload").members.find(
      (m): m is ts.PropertySignature =>
        ts.isPropertySignature(m) && m.name.getText(sf) === "capabilities",
    );
    expect(capabilities?.type && ts.isTypeReferenceNode(capabilities.type)).toBe(true);
    expect((capabilities!.type as ts.TypeReferenceNode).typeName.getText(sf)).toBe("SessionCapabilities");
    const caps: Record<string, string> = {};
    for (const member of findInterface(sf, "SessionCapabilities").members) {
      if (ts.isPropertySignature(member) && member.type) {
        caps[member.name.getText(sf)] = member.type.getText(sf);
      }
    }
    expect(caps).toEqual({ silence: "boolean", ack: "boolean", proposeEstateEdit: "boolean" });
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — strict observation validation
// ---------------------------------------------------------------------------

describe("strict wire validation (criterion 4)", () => {
  test("accepts a complete valid observation and returns a fresh minimized value", () => {
    const observation = validateCycleObservation(validObservation());
    expect(observation).not.toBeNull();
    expect(Object.keys(observation!.sources).sort()).toEqual([...SOURCE_IDS].sort());
    expect(observation!.seq).toBe(1);
  });

  test("rejects incomplete metadata (missing top-level field)", () => {
    const incomplete = validObservation();
    delete incomplete.appVersion;
    expect(validateCycleObservation(incomplete)).toBeNull();
  });

  test("rejects incomplete metadata (missing a source entry)", () => {
    const incomplete = validObservation();
    delete (incomplete.sources as Record<string, unknown>)["grafana-health"];
    expect(validateCycleObservation(incomplete)).toBeNull();
  });

  test("rejects extra top-level and extra source fields", () => {
    const extraTop = validObservation();
    (extraTop as Record<string, unknown>).unexpected = "x";
    expect(validateCycleObservation(extraTop)).toBeNull();

    const extraSource = validObservation();
    (extraSource.sources as Record<string, unknown>)["surprise-source"] = {
      state: "current", lastAttemptAt: null, lastSuccess: null,
    };
    expect(validateCycleObservation(extraSource)).toBeNull();
  });

  test("rejects malformed types (seq must be a positive safe integer, state must be closed)", () => {
    const badSeq = validObservation();
    badSeq.seq = -1;
    expect(validateCycleObservation(badSeq)).toBeNull();
    badSeq.seq = 1.5;
    expect(validateCycleObservation(badSeq)).toBeNull();

    const badState = validObservation();
    (badState.sources as Record<string, Record<string, unknown>>)["vmalert-rules"]!.state = "green";
    expect(validateCycleObservation(badState)).toBeNull();
  });

  test("rejects oversized observation metadata beyond the header byte bound", () => {
    const oversized = validObservation();
    oversized.appVersion = "v".repeat(OBSERVATION_HEADER_MAX_BYTES + 1);
    expect(validateCycleObservation(oversized)).toBeNull();
  });

  test("never throws and never exposes raw values (returns null) for hostile input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateCycleObservation(cyclic)).not.toThrow();
    expect(validateCycleObservation(cyclic)).toBeNull();
    for (const hostile of [null, undefined, 42, "str", [], () => 0, { seq: 10n }]) {
      expect(validateCycleObservation(hostile)).toBeNull();
    }
  });

  test("validateHashId accepts only sha256 + 64 lowercase hex", () => {
    expect(validateHashId(HASH)).toBe(HASH);
    expect(validateHashId(`sha256:${"A".repeat(64)}`)).toBeNull();
    expect(validateHashId(`sha256:${"a".repeat(63)}`)).toBeNull();
    expect(validateHashId("md5:abc")).toBeNull();
    expect(validateHashId(123)).toBeNull();
  });

  test("validateSourceObservation enforces exact fields and closed state", () => {
    expect(validateSourceObservation({ state: "stale", lastAttemptAt: null, lastSuccess: null })).not.toBeNull();
    expect(validateSourceObservation({ state: "stale", lastAttemptAt: null })).toBeNull();
    expect(validateSourceObservation({ state: "current", lastAttemptAt: null, lastSuccess: null, extra: 1 })).toBeNull();
  });
});
