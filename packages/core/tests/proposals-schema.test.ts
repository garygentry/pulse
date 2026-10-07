/** proposals-schema.test.ts — the browser-safe proposal format (`src/proposals/`).
 *
 *  Asserts: the allowlist rows and their applicability per entity kind and host class
 *  (REQ-PROP-03); per-field value schemas incl. nullability (REQ-PROP-04); the kind-dependent
 *  change checks (unique fields, unchanged values); payload bounds on changes, rationale and
 *  target (REQ-PROP-02, REQ-SEC-07); that the payload schema has no transforms; and the result
 *  sidecar schema. */

import { describe, expect, test } from "bun:test";

import {
  PROPOSABLE_FIELDS,
  PROPOSABLE_FIELD_NAMES,
  PROPOSAL_CHANGES_MAX,
  PROPOSAL_TARGET_ID_MAX_BYTES,
  checkProposalChanges,
  fieldApplies,
  fieldSpec,
  fieldValueSchema,
  proposalFileSchema,
  proposalPayloadSchema,
  proposalResultSchema,
  readCoreValue,
  storedRationaleSchema,
} from "../src/proposals/index.js";
import type { ProposableField, ProposalChange, ProposalPayload } from "../src/proposals/index.js";
import type { Host, Service, Suppression } from "../src/model/index.js";

const RATIONALE = "Host churns nightly by design.";

function payload(over: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    id: "p-20260928T140307Z-deadbeef",
    createdAt: "2026-09-28T14:03:07.512Z",
    requestId: "0b7c2f6e-1d7a-4c1e-9b8a-2f4d5e6a7b8c",
    proposer: { subject: "alice", displayName: "Alice Example" },
    target: { kind: "host", id: "host:nas01", name: "nas01" },
    changes: [{ field: "expectedChurn", seen: false, proposed: true }],
    rationale: RATIONALE,
    ...over,
  };
}

function issuePaths(p: unknown): string[] {
  const r = proposalPayloadSchema.safeParse(p);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

describe("allowlist rows (REQ-PROP-03)", () => {
  test("PROPOSABLE_FIELDS has exactly the five rows of the allowlist table", () => {
    expect(PROPOSABLE_FIELDS).toEqual([
      { field: "expectedChurn", yamlKey: "expected_churn", kinds: ["host"], hostClasses: null, nullable: { host: false, service: false }, valueKind: "boolean" },
      { field: "scrapeIntervalClass", yamlKey: "scrape_interval_class", kinds: ["host"], hostClasses: null, nullable: { host: true, service: false }, valueKind: "string" },
      { field: "cadvisor", yamlKey: "cadvisor", kinds: ["host"], hostClasses: ["managed-linux"], nullable: { host: false, service: false }, valueKind: "boolean" },
      { field: "heartbeat", yamlKey: "heartbeat", kinds: ["host"], hostClasses: ["managed-linux"], nullable: { host: false, service: false }, valueKind: "boolean" },
      { field: "suppressed", yamlKey: "suppressed", kinds: ["host", "service"], hostClasses: ["excluded"], nullable: { host: false, service: true }, valueKind: "suppression" },
    ]);
    expect(Object.isFrozen(PROPOSABLE_FIELDS)).toBe(true);
  });

  test("PROPOSABLE_FIELD_NAMES is in table order", () => {
    expect([...PROPOSABLE_FIELD_NAMES]).toEqual(PROPOSABLE_FIELDS.map((s) => s.field));
  });

  test("fieldSpec throws TypeError off-list", () => {
    expect(fieldSpec("cadvisor").yamlKey).toBe("cadvisor");
    expect(() => fieldSpec("hostname" as ProposableField)).toThrow(TypeError);
  });
});

describe("fieldApplies per kind and host class (REQ-PROP-03)", () => {
  const CLASSES = ["managed-linux", "probe-only", "excluded", "appliance", null] as const;

  test("expectedChurn and scrapeIntervalClass apply to every host class and no service", () => {
    for (const f of ["expectedChurn", "scrapeIntervalClass"] as const) {
      for (const c of CLASSES) expect(fieldApplies(f, "host", c)).toBe(true);
      expect(fieldApplies(f, "service", null)).toBe(false);
    }
  });

  test("cadvisor/heartbeat apply only on managed-linux hosts", () => {
    for (const f of ["cadvisor", "heartbeat"] as const) {
      for (const c of CLASSES) expect(fieldApplies(f, "host", c)).toBe(c === "managed-linux");
      expect(fieldApplies(f, "service", null)).toBe(false);
    }
  });

  test("suppressed applies only on excluded hosts and on any service", () => {
    for (const c of CLASSES) expect(fieldApplies("suppressed", "host", c)).toBe(c === "excluded");
    expect(fieldApplies("suppressed", "service", null)).toBe(true);
    // hostClass is ignored for services.
    expect(fieldApplies("suppressed", "service", "managed-linux")).toBe(true);
  });
});

describe("fieldValueSchema per field and kind (REQ-PROP-04, REQ-SEC-07)", () => {
  const mark = { class: "excluded", rationale: "Decommissioned hardware." } as const;

  test("suppressed on a host refuses null (clearing an excluded host's mark)", () => {
    expect(fieldValueSchema("suppressed", "host").safeParse(null).success).toBe(false);
    expect(fieldValueSchema("suppressed", "host").safeParse(mark).success).toBe(true);
  });

  test("suppressed on a service accepts set and null", () => {
    expect(fieldValueSchema("suppressed", "service").safeParse(mark).success).toBe(true);
    expect(fieldValueSchema("suppressed", "service").safeParse(null).success).toBe(true);
  });

  test("a suppression mark with an empty, control-bearing or unknown-key rationale is refused", () => {
    const s = fieldValueSchema("suppressed", "service");
    expect(s.safeParse({ class: "excluded", rationale: "   " }).success).toBe(false);
    expect(s.safeParse({ class: "excluded", rationale: "a\u0007b" }).success).toBe(false);
    expect(s.safeParse({ class: "excluded", rationale: "line one\nline two" }).success).toBe(true);
    expect(s.safeParse({ ...mark, extra: 1 }).success).toBe(false);
  });

  test("scrapeIntervalClass: host nullable, tightened string bounds", () => {
    const s = fieldValueSchema("scrapeIntervalClass", "host");
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse("fast").success).toBe(true);
    expect(s.safeParse("").success).toBe(false);
    expect(s.safeParse(" fast").success).toBe(false);
    expect(s.safeParse("fa\nst").success).toBe(false);
    expect(s.safeParse("x".repeat(129)).success).toBe(false);
  });

  test("boolean fields refuse null and strings", () => {
    for (const f of ["expectedChurn", "cadvisor", "heartbeat"] as const) {
      const s = fieldValueSchema(f, "host");
      expect(s.safeParse(true).success).toBe(true);
      expect(s.safeParse(null).success).toBe(false);
      expect(s.safeParse("true").success).toBe(false);
    }
  });
});

describe("checkProposalChanges (REQ-PROP-02, REQ-PROP-04)", () => {
  test("a duplicate field yields an issue on the second occurrence", () => {
    const changes: ProposalChange[] = [
      { field: "expectedChurn", seen: false, proposed: true },
      { field: "expectedChurn", seen: true, proposed: false },
    ];
    expect(checkProposalChanges("host", changes)).toContainEqual({ path: [1, "field"], message: "duplicate field" });
  });

  test("proposed deep-equal to seen → 'unchanged' (key order irrelevant)", () => {
    const issues = checkProposalChanges("service", [{
      field: "suppressed",
      seen: { class: "known-expected", rationale: "Batch job window." },
      proposed: { rationale: "Batch job window.", class: "known-expected" },
    }]);
    expect(issues).toEqual([{ path: [0, "proposed"], message: "unchanged" }]);
  });

  test("a host-only field on a service is refused", () => {
    expect(checkProposalChanges("service", [{ field: "cadvisor", seen: false, proposed: true }]))
      .toEqual([{ path: [0, "field"], message: "field not proposable for this kind" }]);
  });

  test("a proposed value failing the field schema and an invalid seen are reported", () => {
    const issues = checkProposalChanges("host", [{ field: "suppressed", seen: 3 as unknown as boolean, proposed: null }]);
    expect(issues).toContainEqual({ path: [0, "proposed"], message: "invalid value" });
    expect(issues).toContainEqual({ path: [0, "seen"], message: "invalid value" });
  });

  test("a valid change yields no issues", () => {
    expect(checkProposalChanges("host", [{ field: "scrapeIntervalClass", seen: "fast", proposed: null }])).toEqual([]);
  });
});

describe("proposalPayloadSchema bounds (REQ-PROP-02, REQ-SEC-07)", () => {
  const FIVE: ProposalChange[] = [
    { field: "expectedChurn", seen: false, proposed: true },
    { field: "scrapeIntervalClass", seen: null, proposed: "slow" },
    { field: "cadvisor", seen: false, proposed: true },
    { field: "heartbeat", seen: true, proposed: false },
    { field: "suppressed", seen: { class: "excluded", rationale: "Old." }, proposed: { class: "excluded", rationale: "Retired rack." } },
  ];

  test("0 and 6 changes are refused; 1 and 5 are accepted", () => {
    expect(PROPOSAL_CHANGES_MAX).toBe(5);
    expect(proposalPayloadSchema.safeParse(payload({ changes: [] })).success).toBe(false);
    expect(proposalPayloadSchema.safeParse(payload({ changes: [...FIVE, { field: "expectedChurn", seen: true, proposed: false }] })).success).toBe(false);
    expect(proposalPayloadSchema.safeParse(payload()).success).toBe(true);
    expect(proposalPayloadSchema.safeParse(payload({ changes: FIVE })).success).toBe(true);
  });

  test("a duplicate field in a payload is an issue at changes.<i>.field", () => {
    const changes: ProposalChange[] = [
      { field: "expectedChurn", seen: false, proposed: true },
      { field: "expectedChurn", seen: false, proposed: true },
    ];
    expect(issuePaths(payload({ changes }))).toContain("changes.1.field");
  });

  test("proposed equal to seen is refused at changes.<i>.proposed", () => {
    expect(issuePaths(payload({ changes: [{ field: "expectedChurn", seen: true, proposed: true }] }))).toEqual(["changes.0.proposed"]);
  });

  test("rationale <10, >500, untrimmed or containing a control char is refused; LF is allowed", () => {
    expect(issuePaths(payload({ rationale: "123456789" }))).toEqual(["rationale"]);
    expect(proposalPayloadSchema.safeParse(payload({ rationale: "1234567890" })).success).toBe(true);
    expect(proposalPayloadSchema.safeParse(payload({ rationale: "x".repeat(500) })).success).toBe(true);
    expect(issuePaths(payload({ rationale: "x".repeat(501) }))).toEqual(["rationale"]);
    expect(issuePaths(payload({ rationale: ` ${RATIONALE}` }))).toEqual(["rationale"]);
    expect(issuePaths(payload({ rationale: `${RATIONALE}\n` }))).toEqual(["rationale"]);
    expect(issuePaths(payload({ rationale: `${RATIONALE}\u0007x` }))).toEqual(["rationale"]);
    expect(issuePaths(payload({ rationale: "Host churns\u0085nightly." }))).toEqual(["rationale"]);
    expect(issuePaths(payload({ rationale: "tab\tseparated text" }))).toEqual(["rationale"]);
    expect(proposalPayloadSchema.safeParse(payload({ rationale: "line one\nline two" })).success).toBe(true);
    expect(storedRationaleSchema.safeParse("line one\r\nline two").success).toBe(false);
    expect(storedRationaleSchema.safeParse("😀".repeat(500)).success).toBe(true); // code points, not UTF-16 units
    expect(storedRationaleSchema.safeParse("😀".repeat(5)).success).toBe(false);
  });

  test("target id/name mismatch is refused (host and service)", () => {
    expect(issuePaths(payload({ target: { kind: "host", id: "host:nas02", name: "nas01" } }))).toEqual(["target.id"]);
    expect(issuePaths(payload({ target: { kind: "host", id: "svc:nas01/web", name: "web" } }))).toEqual(["target.id"]);
    const svc = { changes: [{ field: "suppressed" as const, seen: null, proposed: { class: "known-expected" as const, rationale: "Noisy by design." } }] };
    expect(proposalPayloadSchema.safeParse(payload({ ...svc, target: { kind: "service", id: "svc:nas01/web", name: "web" } })).success).toBe(true);
    expect(issuePaths(payload({ ...svc, target: { kind: "service", id: "svc:nas01/api", name: "web" } }))).toEqual(["target.id"]);
    expect(issuePaths(payload({ ...svc, target: { kind: "service", id: "svc:/web", name: "web" } }))).toEqual(["target.id"]);
    expect(issuePaths(payload({ ...svc, target: { kind: "service", id: "host:nas01/web", name: "web" } }))).toEqual(["target.id"]);
  });

  test("a target id of 248 UTF-8 bytes is refused; 247 bytes passes", () => {
    expect(PROPOSAL_TARGET_ID_MAX_BYTES).toBe(247);
    // "é" is 2 UTF-8 bytes: 121 × 2 + 1 = 243 bytes of name + "host:" (5) = 248 bytes, 127 chars.
    const long = `${"é".repeat(121)}a`;
    expect(new TextEncoder().encode(`host:${long}`).byteLength).toBe(248);
    expect(issuePaths(payload({ target: { kind: "host", id: `host:${long}`, name: long } }))).toContain("target.id");
    const ok = "é".repeat(121);
    expect(new TextEncoder().encode(`host:${ok}`).byteLength).toBe(247);
    expect(proposalPayloadSchema.safeParse(payload({ target: { kind: "host", id: `host:${ok}`, name: ok } })).success).toBe(true);
  });

  test("an unknown key anywhere is refused (strict)", () => {
    expect(proposalPayloadSchema.safeParse({ ...payload(), extra: 1 }).success).toBe(false);
    expect(proposalPayloadSchema.safeParse(payload({ proposer: { subject: "a", displayName: "A", source: "x" } as ProposalPayload["proposer"] })).success).toBe(false);
    expect(proposalPayloadSchema.safeParse(payload({ changes: [{ field: "expectedChurn", seen: false, proposed: true, note: "x" } as ProposalChange] })).success).toBe(false);
  });

  test("a malformed id, a non-UTC createdAt and a control char in displayName are refused", () => {
    expect(issuePaths(payload({ id: "../x" }))).toEqual(["id"]);
    expect(issuePaths(payload({ createdAt: "2026-09-28T14:03:07+02:00" }))).toEqual(["createdAt"]);
    expect(issuePaths(payload({ proposer: { subject: "alice", displayName: "Al\u001bice" } }))).toEqual(["proposer.displayName"]);
  });
});

describe("no transforms: parse output deep-equals input (REQ-PROP-04)", () => {
  test("a valid payload parses and its output deep-equals its input", () => {
    const input = payload({
      changes: [
        { field: "expectedChurn", seen: false, proposed: true },
        { field: "scrapeIntervalClass", seen: "fast", proposed: null },
      ],
      rationale: "Line one of the rationale.\nLine two.",
    });
    const r = proposalPayloadSchema.safeParse(input);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toStrictEqual({ ...input, changes: [...input.changes] });
  });

  test("a valid proposal file parses to an identical value", () => {
    const file = { format: "pulse-proposal/v1", payload: payload(), signature: { alg: "HMAC-SHA256", value: "A".repeat(43) } };
    const r = proposalFileSchema.safeParse(file);
    expect(r.success).toBe(true);
    // Round-trip check: the readonly ProposalPayload input vs the schema's mutable output.
    if (r.success) expect<unknown>(r.data).toStrictEqual(file);
    expect(proposalFileSchema.safeParse({ ...file, signature: { alg: "HMAC-SHA512", value: "A".repeat(43) } }).success).toBe(false);
    expect(proposalFileSchema.safeParse({ ...file, signature: { alg: "HMAC-SHA256", value: "A".repeat(44) } }).success).toBe(false);
    expect(proposalFileSchema.safeParse({ ...file, format: "pulse-proposal/v2" }).success).toBe(false);
  });
});

describe("proposalResultSchema (REQ-PROP-06, REQ-SEC-07)", () => {
  const base = { format: "pulse-proposal-result/v1" as const, id: "p-20260928T140307Z-deadbeef", at: "2026-09-29T09:00:00Z", by: "Operator" };

  test("accepts applied with a 40-hex commit (and a 64-hex SHA-256 commit)", () => {
    const applied = { ...base, state: "applied" as const, commit: "0123456789abcdef0123456789abcdef01234567" };
    const r = proposalResultSchema.safeParse(applied);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toStrictEqual(applied);
    expect(proposalResultSchema.safeParse({ ...applied, commit: "a".repeat(64) }).success).toBe(true);
    expect(proposalResultSchema.safeParse({ ...applied, commit: "A".repeat(40) }).success).toBe(false);
    expect(proposalResultSchema.safeParse({ ...applied, commit: "a".repeat(39) }).success).toBe(false);
  });

  test("accepts rejected with a reason of 10–500 chars; refuses out-of-range or control-bearing reasons", () => {
    const rejected = { ...base, state: "rejected", reason: "Not needed." };
    expect(proposalResultSchema.safeParse(rejected).success).toBe(true);
    expect(proposalResultSchema.safeParse({ ...rejected, reason: "1234567890" }).success).toBe(true);
    expect(proposalResultSchema.safeParse({ ...rejected, reason: "x".repeat(500) }).success).toBe(true);
    expect(proposalResultSchema.safeParse({ ...rejected, reason: "123456789" }).success).toBe(false);
    expect(proposalResultSchema.safeParse({ ...rejected, reason: "x".repeat(501) }).success).toBe(false);
    expect(proposalResultSchema.safeParse({ ...rejected, reason: "Bad\u0007reason text" }).success).toBe(false);
    // Code points, as the CLI's --reason check counts: 500 emoji (1000 UTF-16 units) are valid, 9 are not.
    expect(proposalResultSchema.safeParse({ ...rejected, reason: "😀".repeat(500) }).success).toBe(true);
    expect(proposalResultSchema.safeParse({ ...rejected, reason: "😀".repeat(9) }).success).toBe(false);
  });

  test("refuses mixed variants and unknown keys", () => {
    expect(proposalResultSchema.safeParse({ ...base, state: "applied", reason: "Not needed at all." }).success).toBe(false);
    expect(proposalResultSchema.safeParse({ ...base, state: "rejected", reason: "Not needed.", commit: "a".repeat(40) }).success).toBe(false);
    expect(proposalResultSchema.safeParse({ ...base, state: "pending" }).success).toBe(false);
  });
});

describe("readCoreValue (07 §6.1, REQ-PROP-08)", () => {
  const prov = { file: "estate.yaml", path: "hosts[0]", line: 1, col: 1 };
  const managed: Host = {
    name: "app01", addresses: ["10.0.0.1"], provenance: prov,
    collectionClass: "managed-linux", exporterPorts: [9100], cadvisor: false, heartbeat: true,
    deliveryForm: "compose", commandSignals: [],
  };
  const probeOnly: Host = {
    name: "edge01", addresses: ["10.0.0.2"], provenance: prov, scrapeIntervalClass: "slow",
    expectedChurn: true, collectionClass: "probe-only", probe: { kind: "icmp", target: "10.0.0.2" },
  };
  const excluded: Host = {
    name: "lab01", addresses: ["10.0.0.3"], provenance: prov,
    collectionClass: "excluded", suppressed: { class: "excluded", rationale: "Lab box, not monitored." },
  };
  const svc = (over: Partial<Service> = {}): Service => ({
    name: "web", host: "app01", kind: "http", managed: true, provenance: prov, ...over,
  });
  const standalone = (target: string): Suppression => ({
    class: "known-expected", rationale: "Expected to flap.", target, provenance: prov,
  });

  test("a managed-linux host with defaults reads cadvisor false, heartbeat true, expectedChurn false", () => {
    expect(readCoreValue(managed, "cadvisor")).toEqual({ applicable: true, value: false });
    expect(readCoreValue(managed, "heartbeat")).toEqual({ applicable: true, value: true });
    expect(readCoreValue(managed, "expectedChurn")).toEqual({ applicable: true, value: false });
    expect(readCoreValue(managed, "suppressed")).toEqual({ applicable: false });
  });

  test("a missing scrapeIntervalClass reads null; a declared one reads its value", () => {
    expect(readCoreValue(managed, "scrapeIntervalClass")).toEqual({ applicable: true, value: null });
    expect(readCoreValue(probeOnly, "scrapeIntervalClass")).toEqual({ applicable: true, value: "slow" });
    expect(readCoreValue(probeOnly, "expectedChurn")).toEqual({ applicable: true, value: true });
  });

  test("cadvisor/heartbeat on a probe-only host are not applicable", () => {
    expect(readCoreValue(probeOnly, "cadvisor")).toEqual({ applicable: false });
    expect(readCoreValue(probeOnly, "heartbeat")).toEqual({ applicable: false });
    expect(readCoreValue(probeOnly, "suppressed")).toEqual({ applicable: false });
  });

  test("suppressed on an excluded host reads a {class, rationale} copy of the mark", () => {
    const r = readCoreValue(excluded, "suppressed");
    expect(r).toEqual({ applicable: true, value: { class: "excluded", rationale: "Lab box, not monitored." } });
    if (r.applicable && excluded.collectionClass === "excluded") expect(r.value).not.toBe(excluded.suppressed);
  });

  test("service suppressed reads the mark when set and null when absent; other fields not applicable", () => {
    const marked = svc({ suppressed: { class: "expected-churn", rationale: "Redeployed hourly." } });
    expect(readCoreValue(marked, "suppressed")).toEqual({
      applicable: true, value: { class: "expected-churn", rationale: "Redeployed hourly." },
    });
    expect(readCoreValue(svc(), "suppressed")).toEqual({ applicable: true, value: null });
    const fields: ProposableField[] = ["expectedChurn", "scrapeIntervalClass", "cadvisor", "heartbeat"];
    for (const f of fields) expect(readCoreValue(svc(), f)).toEqual({ applicable: false });
  });

  test("a service covered by a standalone suppression (either target form) is not applicable", () => {
    for (const target of ["app01/web", "web"]) {
      expect(readCoreValue(svc(), "suppressed", [standalone(target)])).toEqual({ applicable: false });
    }
    expect(readCoreValue(svc(), "suppressed", [standalone("app02/web")])).toEqual({ applicable: true, value: null });
    expect(readCoreValue(svc(), "suppressed")).toEqual({ applicable: true, value: null });
    expect(readCoreValue(svc(), "suppressed", [])).toEqual({ applicable: true, value: null });
  });
});
