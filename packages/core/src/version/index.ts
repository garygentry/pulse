import type { Finding } from "../findings/index.js";
import { FINDING_CODES } from "../findings/codes.js";

/**
 * The schema major this build authors and normalizes against (REQ-VER-02).
 * Defined in 00-core-definitions.md §2; this module is its canonical file and the barrel
 * re-exports it from here.
 */
export const CURRENT_SCHEMA_MAJOR = 1 as const;

/**
 * The set of schema majors this build accepts. v1 ships exactly one (REQ-VER-01/02).
 * Defined in 00-core-definitions.md §2; declared here as the loader's supported-major set.
 * A declared major outside this set is rejected (§4, UNSUPPORTED_VERSION).
 */
export const SUPPORTED_SCHEMA_MAJORS: readonly number[] = [1] as const;

/**
 * Discriminated result of recognizing a declared `schema_version`.
 *
 * - `ok: true`  → the declared value is a supported integer major; `major` is the
 *   recognized value, later recorded as `EstateModel.schemaMajor` (00 §3.0, §7 in
 *   06-versioning-and-compat.md).
 * - `ok: false` → the declared value is absent/not-an-integer (MISSING_VERSION) or a
 *   well-formed integer outside the supported set (UNSUPPORTED_VERSION); `finding`
 *   carries **exactly one** agent-actionable Finding (REQ-VER-01) and the caller
 *   short-circuits (§5).
 */
export type VersionCheck =
  | { ok: true; major: number }
  | { ok: false; finding: Finding };

/**
 * Recognize the declared `schema_version` and decide whether body validation may proceed.
 *
 * Pure and total: never throws, performs no I/O, returns for every input. `declared` is
 * `unknown` because the version is read **before** the estate body is shape-validated
 * (§3), so it may be any YAML-parsed value (number, string, object, `undefined`, …).
 *
 * @param declared - The raw value of `estate.schema_version` from the parsed YAML, or
 *                    `undefined` if the field (or the estate block) is absent.
 * @param file     - Source file the estate block came from, **relative to the loaded
 *                    directory** (matches `Provenance.file`, 00 §3.7) — used for the
 *                    finding's `file`. Never an absolute path (REQ-DET-01).
 * @returns A `VersionCheck`: `{ ok: true, major }` when supported, else `{ ok: false,
 *          finding }` carrying exactly one Finding.
 */
export function checkVersion(declared: unknown, file: string): VersionCheck {
  // Branch A — MISSING_VERSION: field absent, or present but not an integer major.
  // Rejects: undefined, null, "1" (string), 1.5 (non-integer), NaN, objects, etc.
  if (typeof declared !== "number" || !Number.isInteger(declared)) {
    return {
      ok: false,
      finding: missingVersionFinding(declared, file),
    };
  }

  // Branch B — UNSUPPORTED_VERSION: a well-formed integer major outside the supported set.
  if (!SUPPORTED_SCHEMA_MAJORS.includes(declared)) {
    return {
      ok: false,
      finding: unsupportedVersionFinding(declared, file),
    };
  }

  // Supported major — body validation may proceed; caller records `major` on the model.
  return { ok: true, major: declared };
}

/** Human-readable rendering of the supported-major set for a finding's fix path, e.g.
 *  "1" for [1], or "1, 2" for [1, 2]. Deterministic — preserves declared order. */
function supportedList(): string {
  return SUPPORTED_SCHEMA_MAJORS.join(", ");
}

/**
 * Build the single MISSING_VERSION finding (declared absent or not an integer major).
 * `declared` is described as "missing" when `undefined`, else quoted so the agent sees
 * exactly what it wrote (e.g. a `"1"` string or a `1.5` float).
 */
function missingVersionFinding(declared: unknown, file: string): Finding {
  const shown = declared === undefined ? "missing" : `${JSON.stringify(declared)}`;
  return {
    severity: "error",
    code: FINDING_CODES.MISSING_VERSION,
    file,
    path: "estate.schema_version",
    message:
      `Estate config does not declare an integer 'schema_version' ` +
      `(found: ${shown}). The schema version is required so the loader knows which ` +
      `contract to validate against.`,
    fix:
      `Add 'schema_version: ${CURRENT_SCHEMA_MAJOR}' to the estate metadata block. ` +
      `Supported version(s): ${supportedList()}. It must be a bare integer major ` +
      `(e.g. ${CURRENT_SCHEMA_MAJOR}), not a string or a dotted version.`,
  };
}

/**
 * Build the single UNSUPPORTED_VERSION finding (a well-formed integer outside the
 * supported set). Names the declared major and how to proceed.
 */
function unsupportedVersionFinding(declared: number, file: string): Finding {
  return {
    severity: "error",
    code: FINDING_CODES.UNSUPPORTED_VERSION,
    file,
    path: "estate.schema_version",
    message:
      `Estate config declares schema_version ${declared}, which this build does not ` +
      `support. Supported version(s): ${supportedList()}.`,
    fix:
      `Set 'schema_version' to a supported major (${supportedList()}) and reconcile the ` +
      `config to that schema, or upgrade/downgrade @pulse/core to a build that supports ` +
      `version ${declared}. This build authors version ${CURRENT_SCHEMA_MAJOR}. ` +
      `No automated migration is provided in v1.`,
  };
}
