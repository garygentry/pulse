// apps/cli/src/envelope.ts — the single `--json` envelope shape and its pure builders (00 §5).

import type { Finding } from "@pulse/core";
import { SUPPORTED_SCHEMA_MAJORS } from "@pulse/core";
import type { CoverageEntry, DriftEntry } from "@pulse/renderer";

import type { ExitCode } from "./exit.js";
import { PULSE_VERSION } from "./version.js";

/**
 * The `--json` envelope version (REQ-CLI-04). A static integer bumped ONLY on a breaking
 * change to the envelope's own shape (a removed/renamed top-level field or a changed `meta`
 * contract). Independent of RENDER_FORMAT_VERSION and of PULSE_VERSION. v1 = 1.
 */
export const ENVELOPE_VERSION = 1 as const;

/** The command discriminant carried in the envelope. */
export type PulseCommand = "init" | "render" | "validate" | "coverage" | "proposals";
export type { ProposalsData, ProposalSummary } from "./commands/proposals/types.js";

/** The envelope `meta` block: provenance every command emits identically. */
export interface PulseMeta {
  /** PULSE_VERSION, baked at release build (`01 §5`, REQ-CLI-06). `"0.0.0-dev"` for a local build. */
  pulseVersion: string;
  /** SUPPORTED_SCHEMA_MAJORS of the bundled `@pulse/core` (REQ-VER-01) — the single source of truth. */
  schemaMajors: number[];
  /** Equals ENVELOPE_VERSION; bumped only on a breaking envelope change. */
  envelopeVersion: number;
}

/**
 * The single `--json` payload shape (REQ-CLI-04). Written to STDOUT ONLY, as one parseable
 * object; all human text/diagnostics go to stderr (REQ-CLI-03). `D` is the command-specific
 * `data` shape (below).
 */
export interface PulseEnvelope<D = unknown> {
  /** `true` iff `exitCode === 0`. */
  ok: boolean;
  /** The resolved exit code (REQ-CLI-02). */
  exitCode: ExitCode;
  /** Which command produced this envelope. */
  command: PulseCommand;
  /** core `Finding[]`, verbatim + pre-sorted (CON-04); never coverage/drift/clobber. */
  findings: Finding[];
  /** Command-specific payload; `null` when the command carries no `data`. */
  data: D | null;
  /** Provenance block. */
  meta: PulseMeta;
}

/** `validate` carries no data — findings carry everything (tech spec §5.4). */
export type ValidateData = null;

/** `render` result payload. `drift` present (and exit 1) only for `--check` with drift. */
export interface RenderData {
  /** The resolved absolute-or-relative output root that was written/checked. */
  outputRoot: string;
  /** Tree-relative paths written (sorted); empty for a clean `--check`. */
  filesWritten: string[];
  /** Which mode ran. */
  mode: "write" | "check";
  /** Drift set for `--check`; present and non-empty ⇒ exit 1 (REQ-RND-07). */
  drift?: DriftEntry[];
}

/** `coverage` result payload — the three buckets (REQ-COV-01/02). */
export interface CoverageData {
  /** Entities mapping to ≥1 artifact. */
  covered: CoverageEntry[];
  /** Declared-but-unmonitored entities; non-empty ⇒ exit 1 (REQ-COV-01). */
  gaps: CoverageEntry[];
  /** Deliberately suppressed entities, shown as intentional (REQ-COV-02). */
  suppressed: CoverageEntry[];
}

/** `init` result payload. `wouldClobber` present (exit 1) when refusing without `--force`. */
export interface InitData {
  /** Files created (relative to the consumer repo root), sorted. */
  created: string[];
  /** Files skipped because they already existed and matched policy, sorted. */
  skipped: string[];
  /** Existing files init refused to overwrite; present ⇒ exit 1 unless `--force` (REQ-INIT-03). */
  wouldClobber?: string[];
}

/** The inputs `buildEnvelope` assembles into a `PulseEnvelope<D>`. */
export interface EnvelopeInputs<D> {
  /** Which command produced this envelope. */
  command: PulseCommand;
  /** The already-resolved exit code (from `computeOutcomeExit`, or 2 at the top-level catch). */
  exitCode: ExitCode;
  /** core `Finding[]`, verbatim + pre-sorted; copied without re-sorting. */
  findings: readonly Finding[];
  /** Command-specific payload, or `null`. */
  data: D | null;
}

/**
 * Assemble the `--json` envelope (00 §5). Pure and deterministic: `ok` is derived from
 * `exitCode`, `findings` is a FRESH array copied in ORDER (never re-sorted), and `meta`
 * draws its version + supported majors from single sources of truth — no clock/PID/host value.
 */
export function buildEnvelope<D>(inputs: EnvelopeInputs<D>): PulseEnvelope<D> {
  return {
    ok: inputs.exitCode === 0,
    exitCode: inputs.exitCode,
    command: inputs.command,
    findings: [...inputs.findings],
    data: inputs.data,
    meta: {
      pulseVersion: PULSE_VERSION,
      schemaMajors: [...SUPPORTED_SCHEMA_MAJORS],
      envelopeVersion: ENVELOPE_VERSION,
    },
  };
}

/**
 * Serialize an envelope to its canonical `--json` string: 2-space-indented JSON with exactly
 * one trailing newline. Round-trips via `JSON.parse`.
 */
export function serializeEnvelope<D>(envelope: PulseEnvelope<D>): string {
  return JSON.stringify(envelope, null, 2) + "\n";
}
