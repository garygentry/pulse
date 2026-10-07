/** Loader entry point: sorted directory read + public types (03 §4.1, §4.2).
 *
 *  `loadAndValidate` (the pipeline) is wired in item 010; this file provides the read layer
 *  and the public `LoadOptions`/`LoadResult`/`RawSource` surface, and re-exports
 *  `ConfigIoError` and the `ProvenanceIndex` type so 008/009 import them from one place.
 *
 *  Synchronous fs only; relative paths only; no network/write/child-process (01 §4). */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { ConfigIoError } from "./errors.js";
import { parseYamlDocument } from "./yaml.js";
import { mergeSources } from "./merge.js";
import { checkVersion } from "../version/index.js"; // 06
import { inventorySchema } from "../schema/index.js"; // 02
import { validateAndNormalize } from "../validate/index.js"; // 04
import { FindingCollector } from "../findings/collect.js"; // 05
import type { EstateModel } from "../model/index.js";
import type { Finding } from "../findings/index.js";
import type { ParsedSource } from "./yaml.js";
import type { MergedContent } from "./merge.js";

// Re-exports so downstream modules (008/009) import from a single place.
export { ConfigIoError } from "./errors.js";
export type { ConfigIoErrorCode } from "./errors.js";
export type { ProvenanceIndex, MergedContent } from "./merge.js";
export type { ParsedSource, FileLocations } from "./yaml.js";

/** Options for `loadAndValidate` / {@link readEstateDir}. */
export interface LoadOptions {
  /** Load these explicit files instead of scanning `dir` (library overload, REQ-LOAD-03).
   *  Paths are resolved relative to `dir`; the same sort + content-merge rules apply. When
   *  omitted, `dir` is scanned for `*.yaml`/`*.yml`. */
  files?: string[];
}

/** Discriminated result of a load (REQ-LOAD-03, REQ-VAL-04). `ok` is `true` **iff** no
 *  `error`-severity finding was produced; a successful load MAY still carry `warning`/`info`
 *  findings. On `ok: false` there is **no** model — the caller acts on the full finding set. */
export type LoadResult =
  | { ok: true; model: EstateModel; findings: Finding[] }
  | { ok: false; findings: Finding[] };

/** A source file read from disk: its path **relative to `dir`** (deterministic — no absolute
 *  paths, REQ-DET-01) and its raw text. */
export interface RawSource {
  /** Path relative to the loaded directory; matches `Provenance.file` and `Finding.file`. */
  file: string;
  /** UTF-8 file contents, unparsed. */
  text: string;
}

/** YAML file extensions recognized by a directory scan (REQ-LOAD-01). */
const YAML_EXTS = [".yaml", ".yml"] as const;

/**
 * Read the estate config files, sorted, as `(relative-file, text)` pairs. **The sort is the
 * determinism seam** — the merge and every downstream finding order derive from it
 * (REQ-DET-01).
 *
 * @param dir - Estate directory. Must be a string naming an existing directory.
 * @param opts - When `opts.files` is set, those explicit files are read (each resolved
 *   relative to `dir`) instead of scanning `dir` for `*.yaml`/`*.yml`.
 * @returns Sorted `RawSource[]` — ascending by `file` (REQ-DET-01).
 * @throws {ConfigIoError} `INVALID_ARG` — `dir` is not a non-empty string, or an
 *   `opts.files` entry is not a non-empty string.
 * @throws {ConfigIoError} `DIR_NOT_FOUND` — `dir` (or an explicit file) does not exist.
 * @throws {ConfigIoError} `NOT_A_DIRECTORY` — `dir` exists but is not a directory (scan mode).
 * @throws {ConfigIoError} `UNREADABLE` — a path exists but could not be read (permissions/I/O).
 */
export function readEstateDir(dir: string, opts?: LoadOptions): RawSource[] {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new ConfigIoError("INVALID_ARG", "loadAndValidate: `dir` must be a non-empty string.");
  }

  // Explicit-files overload (REQ-LOAD-03): read exactly the listed files, still sorted.
  if (opts?.files) {
    const sources = opts.files.map((f) => {
      if (typeof f !== "string" || f.length === 0) {
        throw new ConfigIoError(
          "INVALID_ARG",
          "loadAndValidate: every `opts.files` entry must be a non-empty string.",
        );
      }
      const abs = isAbsolute(f) ? f : join(dir, f);
      return { file: relative(dir, abs) || f, text: readTextOrThrow(abs) };
    });
    return sortSources(sources);
  }

  // Directory-scan mode (REQ-LOAD-01).
  let entries: string[];
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) {
      throw new ConfigIoError("NOT_A_DIRECTORY", `Not a directory: ${dir}`, dir);
    }
    entries = readdirSync(dir);
  } catch (err) {
    if (err instanceof ConfigIoError) throw err;
    throw ioErrorFor(err, dir); // ENOENT → DIR_NOT_FOUND, else → UNREADABLE
  }

  const sources = entries
    .filter((name) => YAML_EXTS.some((ext) => name.endsWith(ext)))
    .map((name) => ({ file: name, text: readTextOrThrow(join(dir, name)) }));

  return sortSources(sources);
}

/** Stable ascending sort by relative `file` (REQ-DET-01). Uses code-unit comparison — no
 *  locale collator (locale order is non-deterministic across environments). */
function sortSources(sources: RawSource[]): RawSource[] {
  return [...sources].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function readTextOrThrow(absPath: string): string {
  try {
    return readFileSync(absPath, "utf8");
  } catch (err) {
    throw ioErrorFor(err, absPath);
  }
}

/** Map a Node fs error to the correct ConfigIoError code (tech spec §3.8). */
function ioErrorFor(err: unknown, path: string): ConfigIoError {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === "ENOENT") return new ConfigIoError("DIR_NOT_FOUND", `Path not found: ${path}`, path);
  if (code === "ENOTDIR") return new ConfigIoError("NOT_A_DIRECTORY", `Not a directory: ${path}`, path);
  return new ConfigIoError("UNREADABLE", `Could not read path: ${path}`, path);
}

/**
 * Load a directory of estate YAML and validate it (the `load-and-validate` contract,
 * REQ-LOAD-03). Directory of YAML in → typed {@link EstateModel} OR agent-actionable
 * {@link Finding}s out.
 *
 * The phases are wired in a **fixed** order and thread **one** {@link FindingCollector}, so
 * the whole run is a single pass (REQ-VAL-02). The **version short-circuit** (§4.6) sits
 * between merge and shape: an unsupported/missing `schema_version` emits **exactly one**
 * finding and returns without running body validation (REQ-VER-01) — you cannot validate a
 * body against a schema you do not have.
 *
 * @param dir - Estate config directory.
 * @param opts - {@link LoadOptions}; `opts.files` supplies an explicit file list (§4.2).
 * @returns {@link LoadResult} — `ok: true` with a model iff zero error-severity findings.
 * @throws {ConfigIoError} Usage failures only (missing dir, unreadable path, invalid arg —
 *   §4.3). Config content problems, including malformed YAML, are findings, never throws.
 */
export function loadAndValidate(dir: string, opts?: LoadOptions): LoadResult {
  const collector = new FindingCollector();

  // Phase 1 — read (may THROW ConfigIoError; §4.2/§4.3).
  const sources = readEstateDir(dir, opts);

  // Phase 2 — parse each file; malformed YAML → MALFORMED_YAML finding (§4.4), never a throw.
  const parsed = sources.map(parseYamlDocument);
  for (const p of parsed) collector.addAll(p.findings);

  // Phase 3 — content-based merge + duplicate detection (§4.5).
  const merged = mergeSources(parsed);
  collector.addAll(merged.findings);

  // Phase 4 — VERSION SHORT-CIRCUIT (REQ-VER-01, §4.6). `schema_version` is read from the raw
  // estate block BEFORE shape validation; on missing/unsupported emit EXACTLY that one finding
  // and DO NOT run body validation.
  const vc = checkVersion(rawSchemaVersion(merged.content), estateFileOf(parsed)); // 06
  if (!vc.ok) {
    collector.add(vc.finding);
    return finalize(collector);
  }

  // Phase 5 — shape validation (Zod, strict, one-pass; 02). safeParse never throws; the
  // Zod-issue → Finding mapper (05) attributes each issue's file via the unified provenance.
  const shape = inventorySchema.safeParse(merged.content);
  if (!shape.success) {
    collector.addZodError(shape.error, merged.provenance); // 05 owns the mapper
    return finalize(collector);
  }

  // Phase 6 — semantic invariants + normalization → EstateModel (04). Threads the SHARED
  // collector: the semantic layer appends its findings and returns the model only when no
  // error-severity finding was produced (by this layer or an earlier one).
  const model = validateAndNormalize(shape.data, merged.provenance, collector);

  return finalize(collector, model);
}

/** The raw, pre-validation `schema_version` read from the merged estate block (it lives under
 *  `estate`, per 02 §4.1 / 06 §3), or `undefined` if absent. */
function rawSchemaVersion(content: MergedContent["content"]): unknown {
  return (content.estate as { schema_version?: unknown } | undefined)?.schema_version;
}

/** The estate file's relative path, for the version finding's `file` (checkVersion takes a
 *  string, 06 §4): the first parsed source that declared an `estate` block, else the first
 *  source in sorted order. Deterministic; a source always exists because the version gate runs
 *  only after ≥1 file parsed (a directory with no readable YAML still yields sorted `parsed`). */
function estateFileOf(parsed: ParsedSource[]): string {
  const withEstate = parsed.find((p) => p.content !== undefined && p.content.estate !== undefined);
  return (withEstate ?? parsed[0])?.file ?? "";
}

/** Compute the final LoadResult: `ok` iff no error-severity finding AND a model exists
 *  (REQ-VAL-04). `drain()` (05) returns the deterministically sorted findings (§4.7). */
function finalize(collector: FindingCollector, model?: EstateModel): LoadResult {
  const findings = collector.drain(); // sorted by (file, path, code, …) — 05 §6
  if (!model || collector.hasErrors()) return { ok: false, findings };
  return { ok: true, model, findings }; // findings here are warning/info only
}
