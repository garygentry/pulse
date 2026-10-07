/** common-contracts.test.ts — evidence for item 005 / criteria 1–2 (01 §§2–5, 8).
 *
 *  Verifies that the authoritative common declarations landed by item 004 match
 *  `01-core-definitions.md` exactly:
 *    - every fixed limit constant equals its spec value (runtime);
 *    - the three message catalogs (`ERROR_MESSAGES`, `SOURCE_ERROR_MESSAGES`,
 *      `CONFIG_ERROR_MESSAGES`) have the exact key set and exact text (runtime);
 *    - every closed identifier/union is exactly the spec set (AST of the source, so
 *      the union stays closed even though these types are erased at runtime);
 *    - the result unions, observations, and cycle/materialized payload contracts
 *      declare the specified readonly fields (AST);
 *    - every exported interface/object-type property in the package is `readonly`
 *      (criterion 2's readonly clause; the JSDoc clause is public-api-docs.test.ts).
 *
 *  Values are imported from `src/**` (not the built package) so the evidence does not
 *  depend on `dist` existing when `bun test` runs before the typecheck build. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

import {
  CONFIG_ERROR_MESSAGES,
  CORE_CADENCE_MS,
  CURRENT_MAX_GZIP_BYTES,
  CURRENT_MAX_PLAIN_BYTES,
  ERROR_MESSAGES,
  GATUS_MAX_ENDPOINTS,
  GATUS_STATUS_PAGE_SIZE,
  HISTORY_DEADLINE_MS,
  HISTORY_MAX_ACTIVE,
  HISTORY_MAX_BODY_BYTES,
  HISTORY_MAX_CACHE_BYTES,
  HISTORY_MAX_CACHE_ENTRIES,
  HISTORY_MAX_LABEL_KEY_BYTES,
  HISTORY_MAX_LABEL_VALUE_BYTES,
  HISTORY_MAX_LABELS,
  HISTORY_MAX_POINTS,
  HISTORY_MAX_QUEUED,
  HISTORY_MAX_SERIES,
  HISTORY_MAX_WAITERS_GLOBAL,
  HISTORY_MAX_WAITERS_PER_KEY,
  HISTORY_TTL_MS,
  OBSERVATION_HEADER_MAX_BYTES,
  SLOW_CADENCE_MS,
  SOURCE_ERROR_MESSAGES,
  SOURCE_TIMEOUT_MS,
  SSE_HEARTBEAT_MS,
  SSE_MAX_STREAMS,
} from "../src/wire/common.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_TS = "packages/web-data/src/wire/common.ts";
const SOURCES_TS = "packages/web-data/src/sources/types.ts";
const CYCLE_TS = "packages/web-data/src/cycle/types.ts";

// --------------------------------------------------------------------------
// §2 Fixed limits — exact runtime values
// --------------------------------------------------------------------------

describe("fixed identifiers and limits (§2)", () => {
  test("every cadence/stream/history/body/label/waiter/observation limit is exact", () => {
    expect({
      CORE_CADENCE_MS,
      SLOW_CADENCE_MS,
      SOURCE_TIMEOUT_MS,
      GATUS_STATUS_PAGE_SIZE,
      GATUS_MAX_ENDPOINTS,
      SSE_HEARTBEAT_MS,
      SSE_MAX_STREAMS,
      HISTORY_TTL_MS,
      HISTORY_DEADLINE_MS,
      HISTORY_MAX_ACTIVE,
      HISTORY_MAX_QUEUED,
      HISTORY_MAX_POINTS,
      HISTORY_MAX_SERIES,
      HISTORY_MAX_BODY_BYTES,
      HISTORY_MAX_CACHE_ENTRIES,
      HISTORY_MAX_CACHE_BYTES,
      HISTORY_MAX_LABELS,
      HISTORY_MAX_LABEL_KEY_BYTES,
      HISTORY_MAX_LABEL_VALUE_BYTES,
      HISTORY_MAX_WAITERS_PER_KEY,
      HISTORY_MAX_WAITERS_GLOBAL,
      CURRENT_MAX_PLAIN_BYTES,
      CURRENT_MAX_GZIP_BYTES,
      OBSERVATION_HEADER_MAX_BYTES,
    }).toEqual({
      CORE_CADENCE_MS: 10_000,
      SLOW_CADENCE_MS: 60_000,
      SOURCE_TIMEOUT_MS: 5_000,
      GATUS_STATUS_PAGE_SIZE: 512,
      GATUS_MAX_ENDPOINTS: 511,
      SSE_HEARTBEAT_MS: 5_000,
      SSE_MAX_STREAMS: 64,
      HISTORY_TTL_MS: 60_000,
      HISTORY_DEADLINE_MS: 5_000,
      HISTORY_MAX_ACTIVE: 4,
      HISTORY_MAX_QUEUED: 32,
      HISTORY_MAX_POINTS: 600,
      HISTORY_MAX_SERIES: 1_024,
      HISTORY_MAX_BODY_BYTES: 32 * 1024 * 1024,
      HISTORY_MAX_CACHE_ENTRIES: 64,
      HISTORY_MAX_CACHE_BYTES: 64 * 1024 * 1024,
      HISTORY_MAX_LABELS: 32,
      HISTORY_MAX_LABEL_KEY_BYTES: 128,
      HISTORY_MAX_LABEL_VALUE_BYTES: 256,
      HISTORY_MAX_WAITERS_PER_KEY: 64,
      HISTORY_MAX_WAITERS_GLOBAL: 256,
      CURRENT_MAX_PLAIN_BYTES: 5 * 1024 * 1024,
      CURRENT_MAX_GZIP_BYTES: 1 * 1024 * 1024,
      OBSERVATION_HEADER_MAX_BYTES: 8 * 1024,
    });
  });

  test("the 600-point / 512-page / 511-endpoint boundary relationships hold", () => {
    // The step calculation reserves point 600, and the Gatus page always over-fetches by one
    // beyond the supported endpoint ceiling so 512 rows is an unambiguous overflow signal.
    expect<number>(GATUS_STATUS_PAGE_SIZE).toBe(GATUS_MAX_ENDPOINTS + 1);
    expect<number>(HISTORY_MAX_WAITERS_GLOBAL).toBe(HISTORY_MAX_WAITERS_PER_KEY * 4);
  });
});

// --------------------------------------------------------------------------
// §8 Exact message catalogs — runtime equality (keys + text)
// --------------------------------------------------------------------------

describe("exact message catalogs (§8)", () => {
  test("ERROR_MESSAGES matches the spec catalog exactly", () => {
    expect(ERROR_MESSAGES).toEqual({
      INVALID_REQUEST: "The request is invalid.",
      API_NOT_FOUND: "The requested API route does not exist.",
      METHOD_NOT_ALLOWED: "The request method is not allowed.",
      QUERY_NOT_FOUND: "The requested history query does not exist.",
      TARGET_NOT_FOUND: "The requested target does not exist.",
      QUERY_NOT_APPLICABLE: "The history query does not apply to this target.",
      RANGE_UNSUPPORTED: "The requested range is not supported for this query.",
      NOT_READY: "Current data is not ready yet.",
      HISTORY_OVERLOADED: "History capacity is temporarily exhausted.",
      SOURCE_UNAVAILABLE: "The required upstream source is unavailable.",
      SOURCE_TIMEOUT: "The history request exceeded its deadline.",
      HISTORY_LIMIT_EXCEEDED: "The history result exceeded a safety limit.",
      MODEL_CHANGED: "The rendered estate changed while history was loading.",
      HISTORY_CANCELLED: "The history request was cancelled.",
      CYCLE_BUILD_FAILED: "The latest current-data cycle could not be materialized.",
      ESTATE_BUNDLE_MISSING: "The rendered estate bundle is unavailable.",
      ESTATE_BUNDLE_UNREADABLE: "The rendered estate bundle is unavailable.",
      ESTATE_BUNDLE_UNPARSEABLE: "The rendered estate bundle is unavailable.",
      ESTATE_BUNDLE_VERSION: "The rendered estate bundle is incompatible.",
      ESTATE_BUNDLE_STRUCTURE: "The rendered estate bundle is invalid.",
      ESTATE_BUNDLE_INCOHERENT: "The rendered estate bundle is incoherent.",
      INTERNAL_ERROR: "An unexpected server error occurred.",
    });
  });

  test("SOURCE_ERROR_MESSAGES matches the spec catalog exactly", () => {
    expect(SOURCE_ERROR_MESSAGES).toEqual({
      timeout: "The upstream request exceeded its deadline.",
      transport: "The upstream source could not be reached.",
      "upstream-status": "The upstream source returned an unsuccessful status.",
      "malformed-json": "The upstream source returned invalid JSON.",
      "invalid-shape": "The upstream source response is missing required data.",
      incompatible: "The upstream source response is incompatible.",
      overflow: "The upstream source response may be incomplete.",
      disabled: "The upstream source is not configured.",
    });
  });

  test("CONFIG_ERROR_MESSAGES matches the spec catalog exactly", () => {
    expect(CONFIG_ERROR_MESSAGES).toEqual({
      invalidUrl:
        "The configured source URL must be an absolute HTTP(S) URL without credentials.",
    });
  });

  test("catalog keys are the closed unions and every message is non-empty", () => {
    // The runtime catalog keys are the observable witness that the code-side unions are the
    // exact closed sets from the spec.
    expect(new Set(Object.keys(ERROR_MESSAGES))).toEqual(new Set(collectUnion(COMMON_TS, "ApiErrorCode")));
    expect(new Set(Object.keys(SOURCE_ERROR_MESSAGES))).toEqual(
      new Set(collectUnion(SOURCES_TS, "SourceErrorKind")),
    );
    for (const message of [
      ...Object.values(ERROR_MESSAGES),
      ...Object.values(SOURCE_ERROR_MESSAGES),
      ...Object.values(CONFIG_ERROR_MESSAGES),
    ]) {
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

// --------------------------------------------------------------------------
// §§2–4 Closed unions — extracted from the source AST
// --------------------------------------------------------------------------

/** Cache of parsed source files keyed by repo-relative path. */
const sourceCache = new Map<string, ts.SourceFile>();
function sourceFileOf(relPath: string): ts.SourceFile {
  const cached = sourceCache.get(relPath);
  if (cached) return cached;
  const text = readFileSync(resolve(REPO_ROOT, relPath), "utf8");
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);
  sourceCache.set(relPath, sf);
  return sf;
}

/** All exported type-alias declarations in a file, by name. */
function typeAliases(relPath: string): Map<string, ts.TypeAliasDeclaration> {
  const out = new Map<string, ts.TypeAliasDeclaration>();
  for (const st of sourceFileOf(relPath).statements) {
    if (ts.isTypeAliasDeclaration(st)) out.set(st.name.text, st);
  }
  return out;
}

/**
 * Flatten a string-literal union type alias into its members, expanding any referenced
 * sibling union aliases in the same file (e.g. ApiErrorCode ⊇ EstateBundleApiErrorCode).
 */
function collectUnion(relPath: string, name: string): string[] {
  const aliases = typeAliases(relPath);
  const seen = new Set<string>();
  const literals: string[] = [];
  const visit = (typeName: string): void => {
    if (seen.has(typeName)) return;
    seen.add(typeName);
    const decl = aliases.get(typeName);
    if (!decl) throw new Error(`type alias ${typeName} not found in ${relPath}`);
    const members = ts.isUnionTypeNode(decl.type) ? decl.type.types : [decl.type];
    for (const member of members) {
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
        literals.push(member.literal.text);
      } else if (ts.isTypeReferenceNode(member) && ts.isIdentifier(member.typeName)) {
        visit(member.typeName.text);
      } else {
        throw new Error(`unexpected union member in ${typeName} (${relPath})`);
      }
    }
  };
  visit(name);
  return literals;
}

describe("closed identifier and status unions (§§2–4)", () => {
  const cases: ReadonlyArray<readonly [file: string, name: string, members: readonly string[]]> = [
    [COMMON_TS, "ViewId", ["overview", "alerts", "estate", "engine", "timeline"]],
    [
      COMMON_TS,
      "SourceId",
      [
        "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
        "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
        "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
      ],
    ],
    [COMMON_TS, "HealthState", ["healthy", "unhealthy", "unknown", "not-configured"]],
    [COMMON_TS, "AvailabilityState", ["current", "stale", "unavailable", "not-configured"]],
    [COMMON_TS, "RangeId", ["1h", "6h", "24h", "7d"]],
    [COMMON_TS, "TargetKind", ["estate", "host", "service", "endpoint"]],
    [COMMON_TS, "Unit", ["state", "percent", "count", "seconds", "milliseconds", "bytes", "scalar"]],
    [
      COMMON_TS,
      "EstateBundleApiErrorCode",
      [
        "ESTATE_BUNDLE_MISSING", "ESTATE_BUNDLE_UNREADABLE", "ESTATE_BUNDLE_UNPARSEABLE",
        "ESTATE_BUNDLE_VERSION", "ESTATE_BUNDLE_STRUCTURE", "ESTATE_BUNDLE_INCOHERENT",
      ],
    ],
    [
      COMMON_TS,
      "ApiErrorCode",
      [
        "INVALID_REQUEST", "API_NOT_FOUND", "METHOD_NOT_ALLOWED", "QUERY_NOT_FOUND",
        "TARGET_NOT_FOUND", "QUERY_NOT_APPLICABLE", "RANGE_UNSUPPORTED", "NOT_READY",
        "HISTORY_OVERLOADED", "SOURCE_UNAVAILABLE", "SOURCE_TIMEOUT", "HISTORY_LIMIT_EXCEEDED",
        "MODEL_CHANGED", "HISTORY_CANCELLED", "CYCLE_BUILD_FAILED",
        "ESTATE_BUNDLE_MISSING", "ESTATE_BUNDLE_UNREADABLE", "ESTATE_BUNDLE_UNPARSEABLE",
        "ESTATE_BUNDLE_VERSION", "ESTATE_BUNDLE_STRUCTURE", "ESTATE_BUNDLE_INCOHERENT",
        "INTERNAL_ERROR",
      ],
    ],
    [
      SOURCES_TS,
      "SourceErrorKind",
      [
        "timeout", "transport", "upstream-status", "malformed-json",
        "invalid-shape", "incompatible", "overflow", "disabled",
      ],
    ],
    [CYCLE_TS, "CycleBuildFailureKind", ["fold", "canonicalization", "hash", "compression", "payload-limit"]],
  ];

  for (const [file, name, members] of cases) {
    test(`${name} is exactly the specified closed set`, () => {
      expect(collectUnion(file, name).sort()).toEqual([...members].sort());
    });
  }
});

// --------------------------------------------------------------------------
// §§3–4 Result unions, observations, and materialized payload contracts (AST)
// --------------------------------------------------------------------------

/** Names of exported interfaces in a file mapped to their declaration. */
function interfaces(relPath: string): Map<string, ts.InterfaceDeclaration> {
  const out = new Map<string, ts.InterfaceDeclaration>();
  for (const st of sourceFileOf(relPath).statements) {
    if (ts.isInterfaceDeclaration(st)) out.set(st.name.text, st);
  }
  return out;
}

/** Property-signature names declared directly on an interface. */
function interfaceProps(relPath: string, name: string): string[] {
  const decl = interfaces(relPath).get(name);
  if (!decl) throw new Error(`interface ${name} not found in ${relPath}`);
  return decl.members
    .filter((m): m is ts.PropertySignature => ts.isPropertySignature(m))
    .map((m) => (ts.isIdentifier(m.name) ? m.name.text : String((m.name as ts.StringLiteral).text)));
}

describe("result, observation, and materialized-payload contracts (§§3–4)", () => {
  test("SourceError and SourceRecord expose the specified fields", () => {
    expect(interfaceProps(SOURCES_TS, "SourceError").sort()).toEqual(["kind", "message", "status"]);
    expect(interfaceProps(SOURCES_TS, "SourceAttempt").sort()).toEqual(["attemptedAt", "result"]);
    expect(interfaceProps(SOURCES_TS, "SourceRecord").sort()).toEqual(["lastGood", "latest"]);
  });

  test("DataAvailability, SourceObservation, and CycleObservation match §4", () => {
    expect(interfaceProps(COMMON_TS, "DataAvailability").sort()).toEqual([
      "lastGoodAt", "message", "source", "state",
    ]);
    expect(interfaceProps(COMMON_TS, "SourceObservation").sort()).toEqual([
      "lastAttemptAt", "lastSuccess", "state",
    ]);
    expect(interfaceProps(COMMON_TS, "CycleObservation").sort()).toEqual([
      "appVersion", "generation", "observedAt", "seq", "sources",
    ]);
  });

  test("EncodedRepresentation, MaterializedPayload, and CycleBuildFailure match §4", () => {
    expect(interfaceProps(CYCLE_TS, "EncodedRepresentation").sort()).toEqual(["bytes", "etag"]);
    expect(interfaceProps(CYCLE_TS, "MaterializedPayload").sort()).toEqual([
      "gzip", "identity", "plain", "value",
    ]);
    expect(interfaceProps(CYCLE_TS, "CycleBuildFailure").sort()).toEqual(["kind", "message", "view"]);
  });

  test("SourceResult discriminates on `ok` with data/error arms", () => {
    const alias = typeAliases(SOURCES_TS).get("SourceResult");
    expect(alias && ts.isUnionTypeNode(alias.type) ? alias.type.types.length : 0).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Criterion 2 — every exported public field is readonly
// --------------------------------------------------------------------------

describe("public field readonly discipline (criterion 2)", () => {
  const PACKAGE_FILES = [COMMON_TS, SOURCES_TS, CYCLE_TS];

  /** Collect exported property signatures (nested type literals included) lacking `readonly`. */
  function mutableProps(relPath: string): string[] {
    const sf = sourceFileOf(relPath);
    const offenders: string[] = [];
    const isReadonly = (m: ts.PropertySignature): boolean =>
      (m.modifiers ?? []).some((mod) => mod.kind === ts.SyntaxKind.ReadonlyKeyword);
    const checkMembers = (members: ts.NodeArray<ts.TypeElement>): void => {
      for (const m of members) {
        if (!ts.isPropertySignature(m)) continue;
        const nm = ts.isIdentifier(m.name) ? m.name.text : String((m.name as ts.StringLiteral).text);
        if (!isReadonly(m)) {
          const { line } = sf.getLineAndCharacterOfPosition(m.getStart(sf));
          offenders.push(`${relPath}:${line + 1} ${nm}`);
        }
        if (m.type) walk(m.type);
      }
    };
    const walk = (node: ts.TypeNode): void => {
      if (ts.isTypeLiteralNode(node)) {
        checkMembers(node.members);
        return;
      }
      ts.forEachChild(node, (c) => {
        if (ts.isTypeNode(c)) walk(c);
      });
    };
    for (const st of sf.statements) {
      const exported = ts.canHaveModifiers(st)
        && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isInterfaceDeclaration(st)) checkMembers(st.members);
      else if (ts.isTypeAliasDeclaration(st)) walk(st.type);
    }
    return offenders;
  }

  test("no exported interface/object-type property in the package is mutable", () => {
    expect(PACKAGE_FILES.flatMap(mutableProps)).toEqual([]);
  });

  test("the readonly guard is non-vacuous", () => {
    const sf = ts.createSourceFile(
      "synthetic.ts",
      "export interface X {\n  readonly a: string;\n  b: number;\n}",
      ts.ScriptTarget.Latest,
      true,
    );
    const iface = sf.statements.find(ts.isInterfaceDeclaration)!;
    const mutable = iface.members
      .filter((m): m is ts.PropertySignature => ts.isPropertySignature(m))
      .filter((m) => !(m.modifiers ?? []).some((mod) => mod.kind === ts.SyntaxKind.ReadonlyKeyword))
      .map((m) => (m.name as ts.Identifier).text);
    expect(mutable).toEqual(["b"]);
  });
});
