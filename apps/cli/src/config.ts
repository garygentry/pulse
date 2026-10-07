// apps/cli/src/config.ts — resolve the effective configuration by layering
// flag > env (PULSE_*) > pulse.config.yaml > built-in default, per field (tech spec §3.4,
// 04 §7). The config file is OPTIONAL: a missing DEFAULT pulse.config.yaml yields defaults.
// The ONLY thrown type is ConfigIoError (a value export reused from @pulse/core the CLI may
// construct) — config *shape* faults are usage-class → exit 2 (REQ-CLI-02b), never a Finding.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { parse as parseYaml } from "yaml";

import { ConfigIoError } from "@pulse/core";
import type { GlobalFlags } from "./args.js";

/** The fields `pulse.config.yaml` may carry (tech spec §3.4); all optional in the file. */
export interface PulseConfigFile {
  /** Where estate YAML lives (input to validate/render/coverage). */
  estateDir?: string;
  /** Where the rendered tree is written (committed, diff-reviewable). */
  outputRoot?: string;
  /** Default `--strict` (a flag still overrides). */
  strict?: boolean;
  /** Proposals directory (REQ-PROP-11). The signing secret is NEVER read from this file (REQ-SEC-04). */
  proposalsDir?: string;
}

/**
 * The fully-resolved configuration a command runs against — every field concrete after applying
 * precedence (§7.2). No optional fields: defaults fill any gap.
 */
export interface ResolvedConfig {
  /** Resolved estate input directory (relative to `cwd` unless absolute). */
  estateDir: string;
  /** Resolved rendered-tree output root (relative to `cwd` unless absolute). */
  outputRoot: string;
  /** Effective strict mode (flag > env > file > default). */
  strict: boolean;
  /**
   * Resolved absolute proposals directory, present ONLY when some source set it
   * (flag > PULSE_PROPOSALS_DIR > file). Omitted, not `undefined`, when unset. The proposal
   * secret is NOT a field of this type (REQ-SEC-04).
   */
  proposalsDir?: string;
}

/** Built-in defaults (tech spec §3.4) — the file is optional; these apply when nothing overrides. */
const DEFAULTS = { estateDir: "estate", outputRoot: "rendered", strict: false } as const;

/** Inputs to {@link resolveConfig} — all sources injectable for tests. */
export interface ConfigInputs {
  /** Parsed global flags (supplies `strict` and `--config` path). */
  flags: GlobalFlags;
  /** `render --output-root` override, when present (highest precedence for `outputRoot`). */
  outputRootFlag?: string;
  /** `proposals --proposals-dir <path>` (highest precedence for `proposalsDir`). */
  proposalsDirFlag?: string;
  /** The process environment (`PULSE_*` keys are read). */
  env: NodeJS.ProcessEnv;
  /** Working directory used to locate the default `pulse.config.yaml`. */
  cwd: string;
}

/**
 * Resolve the effective configuration by layering flag > env > file > default per field
 * (tech spec §3.4). The config file is OPTIONAL at runtime: a missing default
 * `pulse.config.yaml` yields `{}` and defaults apply. An explicit `--config <path>` that is
 * missing/unreadable, or ANY malformed config content, is a TOOL FAULT → `ConfigIoError` →
 * exit `2` (§8.4).
 *
 * @param inputs - Flags, the optional `--output-root`, `process.env`, and `cwd`.
 * @returns A concrete {@link ResolvedConfig}.
 * @throws {ConfigIoError} `UNREADABLE` when an explicit `--config` path cannot be read;
 *   `INVALID_ARG` when the file is not a YAML mapping or a field has the wrong type.
 */
export function resolveConfig(inputs: ConfigInputs): ResolvedConfig {
  const { flags, env, cwd } = inputs;
  const explicit = flags.configPath !== undefined;
  const path = explicit
    ? resolvePath(cwd, flags.configPath!)
    : resolvePath(cwd, "pulse.config.yaml");
  const file = readConfigFile(path, explicit); // {} when the default file is absent

  // strict: flag OR env OR file OR default. `--strict` is a pure boolean flag: presence ⇒ true;
  // it can only turn strict ON, so it participates as `flags.strict || …`.
  const strict =
    flags.strict || envBool(env.PULSE_STRICT) || file.strict === true || DEFAULTS.strict;

  const estateDir = env.PULSE_ESTATE_DIR ?? file.estateDir ?? DEFAULTS.estateDir;
  const outputRoot =
    inputs.outputRootFlag ?? env.PULSE_OUTPUT_ROOT ?? file.outputRoot ?? DEFAULTS.outputRoot;
  // proposalsDir: flag > env (empty falls through) > file; no default — `requireProposalsDir`
  // raises the missing-dir fault lazily, only when a `proposals` sub-verb runs.
  const proposalsDir =
    inputs.proposalsDirFlag ?? nonEmpty(env.PULSE_PROPOSALS_DIR) ?? file.proposalsDir;

  return {
    estateDir: isAbsolute(estateDir) ? estateDir : resolvePath(cwd, estateDir),
    outputRoot: isAbsolute(outputRoot) ? outputRoot : resolvePath(cwd, outputRoot),
    strict,
    ...(proposalsDir !== undefined
      ? { proposalsDir: isAbsolute(proposalsDir) ? proposalsDir : resolvePath(cwd, proposalsDir) }
      : {}),
  };
}

/** Read + shape-check a config file. Returns `{}` when a NON-explicit path is absent. */
function readConfigFile(path: string, explicit: boolean): PulseConfigFile {
  let text: string;
  try {
    const st = statSync(path); // throws ENOENT when absent
    if (!st.isFile()) {
      throw new ConfigIoError("UNREADABLE", `pulse config is not a file: ${path}`, path);
    }
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof ConfigIoError) throw err;
    // A missing DEFAULT file is fine (config is optional); a missing EXPLICIT --config is a fault.
    if (isEnoent(err) && !explicit) return {};
    throw new ConfigIoError(
      "UNREADABLE",
      `cannot read pulse config: ${path}: ${(err as Error).message}`,
      path,
    );
  }
  return validateConfigShape(text, path);
}

/** Parse YAML and assert the mapping shape; any deviation is a tool fault (INVALID_ARG). */
function validateConfigShape(text: string, path: string): PulseConfigFile {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigIoError(
      "INVALID_ARG",
      `pulse config is not valid YAML: ${path}: ${(err as Error).message}`,
      path,
    );
  }
  if (raw === null || raw === undefined) return {}; // empty file ⇒ defaults
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigIoError("INVALID_ARG", `pulse config must be a YAML mapping: ${path}`, path);
  }
  const obj = raw as Record<string, unknown>;
  const out: PulseConfigFile = {};
  if ("estateDir" in obj) out.estateDir = asString(obj.estateDir, "estateDir", path);
  if ("outputRoot" in obj) out.outputRoot = asString(obj.outputRoot, "outputRoot", path);
  if ("strict" in obj) out.strict = asBool(obj.strict, "strict", path);
  if ("proposalsDir" in obj) out.proposalsDir = asString(obj.proposalsDir, "proposalsDir", path);
  // REQ-SEC-04: the secret is env-only. A secret-looking key in the file is a config fault; its
  // value is never echoed.
  for (const k of Object.keys(obj)) {
    if (/secret/i.test(k)) {
      throw new ConfigIoError(
        "INVALID_ARG",
        `pulse config field '${k}' is not allowed: the proposal secret is read only from PULSE_PROPOSAL_SECRET: ${path}`,
        path,
      );
    }
  }
  return out;
}

/** `PULSE_STRICT` truthiness: `"1"` or `"true"` (case-insensitive) ⇒ true; anything else ⇒ false. */
function envBool(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true";
}

/** Treat an empty env value as unset (so `PULSE_PROPOSALS_DIR=` falls through). */
function nonEmpty(v: string | undefined): string | undefined {
  return v === "" ? undefined : v;
}

function asString(v: unknown, field: string, path: string): string {
  if (typeof v !== "string") {
    throw new ConfigIoError(
      "INVALID_ARG",
      `pulse config field '${field}' must be a string: ${path}`,
      path,
    );
  }
  return v;
}

function asBool(v: unknown, field: string, path: string): boolean {
  if (typeof v !== "boolean") {
    throw new ConfigIoError(
      "INVALID_ARG",
      `pulse config field '${field}' must be a boolean: ${path}`,
      path,
    );
  }
  return v;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
