/** meta.test.ts — anti-rot guards (07 §4).
 *
 *  Two meta-tests protect the contract's public surface:
 *    1. FINDING_CODES coverage — every stable code in FINDING_CODES is exercised by at least
 *       one real case (fixture load or detector call). Fails if a code has no covering case.
 *       It asserts each code PATH is exercised, NOT message wording.
 *    2. Barrel-symbol import — every public symbol from 01 §3 is importable; the runtime value
 *       exports resolve and are exactly the authoritative set (nothing extra leaks, notably
 *       NOT checkVersion). */

import { expect, test, describe } from "bun:test";
import { join } from "node:path";

import * as barrel from "../src/index.js";
import { loadAndValidate, FINDING_CODES } from "../src/index.js";
import { FindingCollector } from "../src/findings/collect.js";
import { checkTimezone, checkEndpointAlertBinding } from "../src/validate/invariants.js";
import type { ProvenanceIndex } from "../src/loader/index.js";
import type { MergedInventory } from "../src/validate/index.js";
import type { Finding, FindingCode } from "../src/index.js";

// Public type surface (01 §3) — imported type-only to prove the barrel exposes each; used in
// the annotated `_typeSurface` block below so a typechecker over tests would catch a rename.
import type {
  LoadResult,
  LoadOptions,
  ConfigIoErrorCode,
  EstateModel,
  Estate,
  Host,
  CollectionClass,
  ProbeSpec,
  Service,
  DeepHealthProbe,
  BackupFreshness,
  Channel,
  ChannelKind,
  RoutingOverride,
  Suppression,
  SuppressionMark,
  SuppressionClass,
  SecretRef,
  Provenance,
  Severity,
} from "../src/index.js";

const FIXTURES = join(import.meta.dir, "fixtures");

// ── 1. FINDING_CODES coverage meta-test (07 §4) ──────────────────────────────

/** Collect the codes a load of `dir` produced. */
function codesFromLoad(dir: string): FindingCode[] {
  return loadAndValidate(join(FIXTURES, dir)).findings.map((f) => f.code);
}

/** Deterministic stub provenance for the detector-only case below. */
const stubProv: ProvenanceIndex = {
  lookup: (path: string) => ({ file: "estate.yaml", path, line: 1, col: 1 }),
};

/** MISSING_TIMEZONE is unreachable through the full pipeline (the Zod shape layer already
 *  requires a non-empty `estate.timezone`, so a missing zone short-circuits as a shape
 *  MISSING_FIELD before the semantic timezone check runs). Its covering case is a direct
 *  detector call — a legitimate "case across the suites" per 07 §4. */
function codesFromMissingTimezoneDetector(): FindingCode[] {
  const c = new FindingCollector();
  checkTimezone({ estate: { name: "e" } } as unknown as MergedInventory, stubProv, c);
  return c.drain().map((f) => f.code);
}

/** INERT_ALERT_BINDING (issue #15) fires when a service declares an `alerts:` binding but renders
 *  no Gatus endpoint (no ingress_url / suppressed). A direct detector call — a legitimate covering
 *  case per 07 §4 — over a service that binds alerts with no ingress_url. */
function codesFromInertAlertBindingDetector(): FindingCode[] {
  const c = new FindingCollector();
  checkEndpointAlertBinding(
    { services: [{ name: "svc", host: "h", alerts: [{ type: "custom" }] }] } as unknown as MergedInventory,
    stubProv,
    c,
  );
  return c.drain().map((f) => f.code);
}

describe("FINDING_CODES coverage (anti-rot guard, 07 §4)", () => {
  // Each covering case, using the real machinery. Together they must exercise every code.
  const CASES: Record<string, () => FindingCode[]> = {
    "broken-min (shape)": () => codesFromLoad("broken-min"),
    "broken-semantic (semantic)": () => codesFromLoad("broken-semantic"),
    "broken-nas-api (incomplete_nas_api)": () => codesFromLoad("broken-nas-api"),
    "broken-telegram (missing_chat_id)": () => codesFromLoad("broken-telegram"),
    "broken-command-signal (duplicate_command_signal/backup_command_host)": () =>
      codesFromLoad("broken-command-signal"),
    "broken-host-local-probe (host_local_probe_host)": () =>
      codesFromLoad("broken-host-local-probe"),
    "shape-bad (wrong_type/invalid_enum)": () => codesFromLoad("shape-bad"),
    "duplicate-estate": () => codesFromLoad("duplicate-estate"),
    "bad-layer (invalid_layer)": () => codesFromLoad("bad-layer"),
    "multi-file (duplicate_identity)": () => codesFromLoad("multi-file"),
    "malformed (malformed_yaml)": () => codesFromLoad("malformed"),
    "bad-version/unsupported": () => codesFromLoad("bad-version/unsupported"),
    "bad-version/missing": () => codesFromLoad("bad-version/missing"),
    "missing-timezone (detector)": () => codesFromMissingTimezoneDetector(),
    "inert-alert-binding (detector)": () => codesFromInertAlertBindingDetector(),
  };

  const covered = new Set<FindingCode>();
  for (const produce of Object.values(CASES)) for (const code of produce()) covered.add(code);

  const ALL_CODES = Object.values(FINDING_CODES) as FindingCode[];

  /** Web-projection codes (rendered-model-v2, 03 §3.1) are declared in the closed core
   *  vocabulary so every consumer shares one registry, but they are *produced by the
   *  @pulse/renderer web-safety layer*, never by the core loader/validator. Core therefore
   *  has no machinery to exercise them; their covering cases live in the renderer suite
   *  (packages/renderer/tests/rendered-model-v2-safety.test.ts, item 003). They are excluded
   *  here rather than faked with a non-core detector call. */
  const RENDERER_PRODUCED_CODES = new Set<FindingCode>([
    FINDING_CODES.WEB_URL_USERINFO_REMOVED,
    FINDING_CODES.WEB_SENSITIVE_CHANNEL_OPTION_OMITTED,
    FINDING_CODES.WEB_UNSAFE_PROVENANCE,
    FINDING_CODES.WEB_ARTIFACT_LEAK_DETECTED,
  ]);

  /** Estate-edit proposal codes (mutation-foundation 08 §1.1) are declared in the closed core
   *  vocabulary but are *produced by the `pulse proposals` CLI* (apps/cli), never by the core
   *  loader/validator. Their covering cases live in apps/cli/tests/proposals.test.ts; they are
   *  excluded here rather than faked with a non-core producer. */
  const CLI_PRODUCED_CODES = new Set<FindingCode>([
    FINDING_CODES.PROPOSAL_NOT_FOUND,
    FINDING_CODES.PROPOSAL_SIGNATURE_INVALID,
    FINDING_CODES.PROPOSAL_STALE,
    FINDING_CODES.PROPOSAL_DIRTY_TREE,
    FINDING_CODES.PROPOSAL_OVERLAY_AMBIGUOUS,
    FINDING_CODES.PROPOSAL_CANNOT_CLEAR_BASE,
    FINDING_CODES.PROPOSAL_INVALID_ESTATE,
    FINDING_CODES.PROPOSAL_ALREADY_DECIDED,
  ]);

  test("every core-produced FINDING_CODES value has a covering case", () => {
    const uncovered = ALL_CODES.filter(
      (code) => !covered.has(code) && !RENDERER_PRODUCED_CODES.has(code) && !CLI_PRODUCED_CODES.has(code),
    );
    expect(uncovered).toEqual([]);
  });

  test("the coverage cases produce only real, in-registry codes", () => {
    const registry = new Set<FindingCode>(ALL_CODES);
    for (const code of covered) expect(registry.has(code)).toBe(true);
  });
});

// ── 2. Barrel-symbol import meta-test (07 §4) ────────────────────────────────

describe("public barrel surface (01 §3)", () => {
  /** The authoritative RUNTIME value exports (types are erased, so they are not runtime keys).
   *  This is exactly 01 §3's value surface — no more, no less. */
  const VALUE_EXPORTS = [
    "loadAndValidate",
    "ConfigIoError",
    "FINDING_CODES",
    "formatFindings",
    "SUPPORTED_SCHEMA_MAJORS",
    "CURRENT_SCHEMA_MAJOR",
    "inventorySchema",
  ].sort();

  test("every public value symbol resolves and is the right kind", () => {
    expect(typeof barrel.loadAndValidate).toBe("function");
    expect(typeof barrel.ConfigIoError).toBe("function"); // the error class
    expect(typeof barrel.formatFindings).toBe("function");
    expect(typeof barrel.FINDING_CODES).toBe("object");
    expect(Array.isArray(barrel.SUPPORTED_SCHEMA_MAJORS)).toBe(true);
    expect(typeof barrel.CURRENT_SCHEMA_MAJOR).toBe("number");
    // inventorySchema is a Zod schema — it exposes safeParse.
    expect(typeof (barrel.inventorySchema as { safeParse?: unknown }).safeParse).toBe("function");
  });

  test("the barrel exports exactly the authoritative value set (checkVersion is NOT exported)", () => {
    expect(Object.keys(barrel).sort()).toEqual(VALUE_EXPORTS);
    expect((barrel as Record<string, unknown>).checkVersion).toBeUndefined();
  });

  test("every public TYPE symbol is importable and typed (01 §3)", () => {
    // Compile-time surface check: annotating a binding with each type forces the barrel to
    // export it. `bun test` erases these, but the source must compile under a typechecker.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _typeSurface = (): void => {
      const _load: LoadResult = { ok: false, findings: [] };
      const _opts: LoadOptions = {};
      const _errCode: ConfigIoErrorCode = "DIR_NOT_FOUND";
      const _sev: Severity = "error";
      const _finding: Finding = { severity: "error", code: FINDING_CODES.MISSING_FIELD, file: "", path: "", message: "", fix: "" };
      const _fc: FindingCode = FINDING_CODES.UNKNOWN_FIELD;
      const _cc: CollectionClass = "managed-linux";
      const _ck: ChannelKind = "chat";
      const _sc: SuppressionClass = "excluded";
      // Structural type references (never constructed — only their identity must resolve).
      type _M = EstateModel;
      type _E = Estate;
      type _H = Host;
      type _P = ProbeSpec;
      type _S = Service;
      type _D = DeepHealthProbe;
      type _B = BackupFreshness;
      type _Ch = Channel;
      type _R = RoutingOverride;
      type _Su = Suppression;
      type _SM = SuppressionMark;
      type _SR = SecretRef;
      type _Pr = Provenance;
      void [_load, _opts, _errCode, _sev, _finding, _fc, _cc, _ck, _sc];
    };
    // Runtime assertion just proves the block is wired up; the real value is compile-time.
    expect(typeof _typeSurface).toBe("function");
  });
});
