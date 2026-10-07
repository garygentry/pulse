// src/server/estate/watch.ts — per-refresh-cycle change detection + content-hash-guarded reload of
// the rendered estate bundle. NOT an fs-watcher: bind-mounted files make inotify/fs.watch unreliable
// across the container boundary, and the 10s refresh cycle already bounds pickup latency.
//
// The rendered-model-v2 three-file bundle watcher (`createWatcher`/`maybeReload`,
// 06-reload-and-runtime-integration.md §3) is the runtime authority: it examines model + coverage +
// findings as one off-side generation, keeps per-member presence/mtime/size/raw-byte SHA-256, uses
// metadata only as an I/O pre-gate, rereads all mandatory/present members on any metadata change,
// compares the ordered presence/hash tuple before validating, and atomically installs a
// fully-validated `EstateBundle` OR an explicit `EstateBundleError` — never a last-good cache.
//
// This file does not import server/log.ts or map errors to HTTP.

import type { BundleId } from "@pulse/renderer";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { EstateBundleError } from "../../shared/errors.js";
import type {
  EstateBundleArtifact,
  EstateBundleErrorKind,
} from "../../shared/errors.js";
import {
  deriveEstateBundlePaths,
  type BundleFileBytes,
  type EstateBundleLoadResult,
  type EstateBundlePaths,
} from "./load.js";
import { parseEstateBundle } from "./validate.js";

// ── Estate bundle watcher contracts (rendered-model-v2) ─────────────────────────────────────────
// Shared v2 watcher-signature and reload-transition types are homed here (00-core-definitions.md
// §7-§8). Declared once here; later modules import them type-only.

/** One member's inexpensive metadata and authoritative byte identity. */
export interface BundleMemberSignature {
  /** Whether the optional path existed; always true for a successful model read. */
  present: boolean;
  /** mtime in epoch milliseconds, or null when absent. */
  mtimeMs: number | null;
  /** byte size, or null when absent. */
  size: number | null;
  /** SHA-256 of exact bytes, or null when absent/unread. */
  hash: string | null;
}

/** Stable authority-transition kinds emitted by the watcher. */
export type BundleTransitionKind =
  | "bundle_loaded"
  | "bundle_reloaded"
  | "bundle_error"
  | "bundle_recovered";

/** Structured transition describing one authority change, for logging. */
export interface BundleTransition {
  /** Stable transition kind. */
  kind: BundleTransitionKind;
  /** Artifact involved in an error; null on success. */
  artifact: EstateBundleArtifact | null;
  /** Error kind on failure; null on success. */
  errorKind: EstateBundleErrorKind | null;
  /** Bundle identity on success; null on failure. */
  bundleId: BundleId | null;
}

// ── rendered-model-v2 three-file bundle watcher (06 §§3-4) ───────────────────────────────────────

/** The fixed member order: signatures are always keyed and examined model → coverage → findings. */
const BUNDLE_MEMBERS = ["model", "coverage", "findings"] as const;
type BundleMember = (typeof BUNDLE_MEMBERS)[number];

/**
 * The bundle watcher's mutable state, owned by the server tier and threaded through each refresh
 * cycle. Constructed once at startup via `createWatcher`. Signatures and `current` authority always
 * describe the same off-side examination.
 */
export interface EstateWatcherState {
  /** Null only when `PULSE_WEB_ESTATE_MODEL` is unset. */
  readonly paths: EstateBundlePaths | null;
  /** Signature tuple from the last examined generation, keyed in fixed member order. */
  signatures: Record<BundleMember, BundleMemberSignature>;
  /** Current authoritative full bundle or explicit error. */
  current: EstateBundleLoadResult;
}

/** The outcome of one reload check. `result` is ALWAYS the authority to hold after the call. */
export interface ReloadOutcome {
  /** True only for byte/presence-distinct authority changes. */
  reloaded: boolean;
  /** Current full authority after the check. */
  result: EstateBundleLoadResult;
  /** Structured transition for logging, or null on a no-op. */
  transition: BundleTransition | null;
}

/** One off-side filesystem examination, committed only after all members are handled. */
interface BundleExamination {
  /** Metadata and byte identities from this exact examination. */
  signatures: Record<BundleMember, BundleMemberSignature>;
  /** Complete validated bundle or one structured failure. */
  result: EstateBundleLoadResult;
}

/** One member's read outcome: signature (metadata + byte hash) plus decoded bytes / failure flag. */
interface MemberRead {
  /** Signature recorded regardless of outcome; absent members carry null metadata/hash. */
  signature: BundleMemberSignature;
  /** Decoded UTF-8 bytes when present and readable; null when absent or unreadable. */
  bytes: string | null;
  /** True only for a non-ENOENT stat/read failure (not safely readable). */
  unreadable: boolean;
}

/**
 * Create the bundle watcher and perform the initial off-side examination (06 §3.1). A `null` model
 * path yields the structured model `missing` result, `paths: null`, three absent signatures, and no
 * filesystem access. Otherwise it derives all paths once and runs a single `examineBundle` so the
 * seeded signatures and parsed authority necessarily describe the same reads (never a loader call
 * followed by an independent reread, which a rendered-root swap could pair across generations).
 *
 * @param modelPath - config.estateModelPath, or `null` when the env var is unset/empty.
 * @param now       - Injectable clock; defaults to `() => new Date()`.
 */
export async function createWatcher(
  modelPath: string | null,
  now: () => Date = () => new Date(),
): Promise<EstateWatcherState> {
  if (modelPath === null) {
    return {
      paths: null,
      signatures: absentSignatures(),
      current: { ok: false, error: nullConfigError() },
    };
  }
  const paths = deriveEstateBundlePaths(modelPath);
  const { signatures, result } = await examineBundle(paths, now);
  return { paths, signatures, current: result };
}

/**
 * Check the bundle for a byte/presence change and reload if the ordered presence/hash tuple actually
 * differs (06 §§3.3, 4). Called once per refresh cycle. Never throws — every failure is captured as
 * an `EstateBundleError` result, and unexpected read/parse throws are caught defensively.
 *
 * Decision flow:
 *  1. Metadata pre-gate: stat all three paths. If every `(present, mtimeMs, size)` matches the prior
 *     signatures and no stat failed, return a no-op WITHOUT reading files.
 *  2. Otherwise read every mandatory/present member off to the side (`examineBundle`).
 *  3. If the ordered `(present, hash)` tuple is unchanged (a touch/remount without a byte edit),
 *     update only the stored metadata signatures and return a no-op — `current` and its `loadedAt`
 *     are preserved and no transition is emitted.
 *  4. If the tuple differs, classify the transition, then synchronously assign the new signatures
 *     and new authority in one uninterrupted block (no reader can observe a torn state).
 *
 * @param state - The watcher state to advance (mutated in place).
 * @param now   - Injectable clock; defaults to `() => new Date()`.
 */
export async function maybeReload(
  state: EstateWatcherState,
  now: () => Date = () => new Date(),
): Promise<ReloadOutcome> {
  const paths = state.paths;
  if (paths === null) {
    return { reloaded: false, result: state.current, transition: null };
  }

  // 1. Cheap metadata pre-gate — stat only, never read.
  const [mStat, cStat, fStat] = await Promise.all([
    statMember(paths.model),
    statMember(paths.coverage),
    statMember(paths.findings),
  ]);
  const anyStatError = mStat.statError || cStat.statError || fStat.statError;
  const metadataUnchanged =
    !anyStatError &&
    metaEqual(mStat, state.signatures.model) &&
    metaEqual(cStat, state.signatures.coverage) &&
    metaEqual(fStat, state.signatures.findings);
  if (metadataUnchanged) {
    return { reloaded: false, result: state.current, transition: null };
  }

  // 2. Metadata moved (or a member became unreadable) → read every member off to the side.
  let exam: BundleExamination;
  try {
    exam = await examineBundle(paths, now);
  } catch {
    // Defensive only: examineBundle's reads are individually caught and parseEstateBundle never
    // throws, so this is effectively unreachable. Map an unexpected throw to an unreadable model
    // error, seeding signatures from the pre-gate stats so the byte tuple reflects reality.
    exam = {
      signatures: {
        model: sigFromStat(mStat),
        coverage: sigFromStat(cStat),
        findings: sigFromStat(fStat),
      },
      result: { ok: false, error: unreadableError("model", paths.model) },
    };
  }

  // 3. Bytes unchanged (metadata-only touch) → update signatures, preserve authority + loadedAt.
  if (sameByteTuple(exam.signatures, state.signatures)) {
    state.signatures = exam.signatures;
    return { reloaded: false, result: state.current, transition: null };
  }

  // 4. Byte/presence tuple differs → classify, then commit synchronously (run-to-completion).
  const transition = classifyTransition(state.current, exam.result);
  state.signatures = exam.signatures;
  state.current = exam.result;
  return { reloaded: true, result: exam.result, transition };
}

/**
 * Read and validate one three-file generation without mutating watcher/runtime state (06 §3.1). All
 * stats, reads, hashing, timestamp production, parsing, and validation happen in local variables.
 */
async function examineBundle(
  paths: EstateBundlePaths,
  now: () => Date,
): Promise<BundleExamination> {
  const model = await readMember(paths.model);
  const coverage = await readMember(paths.coverage);
  const findings = await readMember(paths.findings);

  const signatures: Record<BundleMember, BundleMemberSignature> = {
    model: model.signature,
    coverage: coverage.signature,
    findings: findings.signature,
  };

  return { signatures, result: buildResult(paths, model, coverage, findings, now) };
}

/**
 * Turn three member reads into one authoritative result (06 §§3.2, 4.2). Deterministic first-error
 * precedence is model → coverage → findings. The `loadedAt` timestamp is produced only after all
 * mandatory/present reads succeed, then all bytes flow to `parseEstateBundle` exactly once.
 */
function buildResult(
  paths: EstateBundlePaths,
  model: MemberRead,
  coverage: MemberRead,
  findings: MemberRead,
  now: () => Date,
): EstateBundleLoadResult {
  // Model is mandatory: a non-ENOENT failure is unreadable; ENOENT/race absence is missing.
  if (model.unreadable) return { ok: false, error: unreadableError("model", paths.model) };
  if (model.bytes === null) return { ok: false, error: modelMissingError(paths.model) };

  // Optional siblings: a non-ENOENT failure is unreadable; ENOENT absence carries null bytes.
  if (coverage.unreadable) return { ok: false, error: unreadableError("coverage", paths.coverage) };
  if (findings.unreadable) return { ok: false, error: unreadableError("findings", paths.findings) };

  // Record load time only after every read succeeded; a thrown/invalid clock is a captured failure.
  let loadedAt: string;
  try {
    loadedAt = now().toISOString();
    if (typeof loadedAt !== "string" || loadedAt.length === 0) {
      return { ok: false, error: clockError(paths.model) };
    }
  } catch {
    return { ok: false, error: clockError(paths.model) };
  }

  const files: BundleFileBytes = {
    model: model.bytes,
    coverage: coverage.bytes,
    findings: findings.bytes,
  };
  return parseEstateBundle(files, paths, loadedAt);
}

/**
 * Stat then read one member, hashing the EXACT raw bytes (06 §3.2). Hash a `Buffer` and decode the
 * same buffer as UTF-8 — never hash reserialized JSON. ENOENT (on stat or a racing read) is absence;
 * any other failure marks the member unreadable. Hashes are lowercase hex without an algorithm
 * prefix (a local byte identity, not an artifact `BundleId`).
 */
async function readMember(path: string): Promise<MemberRead> {
  let mtimeMs: number;
  let size: number;
  try {
    const st = await stat(path);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch (cause) {
    if (isEnoent(cause)) return { signature: absentSignature(), bytes: null, unreadable: false };
    return { signature: absentSignature(), bytes: null, unreadable: true };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (cause) {
    // A stat-said-present member whose read races to ENOENT is treated as absent this examination;
    // cross-file validation still guards any mixed generation.
    if (isEnoent(cause)) return { signature: absentSignature(), bytes: null, unreadable: false };
    return { signature: absentSignature(), bytes: null, unreadable: true };
  }

  const hash = createHash("sha256").update(buffer).digest("hex");
  return {
    signature: { present: true, mtimeMs, size, hash },
    bytes: buffer.toString("utf8"),
    unreadable: false,
  };
}

/** Stat one member for the cheap metadata pre-gate (no read). ENOENT → absent; other → statError. */
async function statMember(
  path: string,
): Promise<{ present: boolean; mtimeMs: number | null; size: number | null; statError: boolean }> {
  try {
    const st = await stat(path);
    return { present: true, mtimeMs: st.mtimeMs, size: st.size, statError: false };
  } catch (cause) {
    if (isEnoent(cause)) return { present: false, mtimeMs: null, size: null, statError: false };
    return { present: false, mtimeMs: null, size: null, statError: true };
  }
}

/** Whether a pre-gate stat matches the stored signature's `(present, mtimeMs, size)`. */
function metaEqual(
  stat: { present: boolean; mtimeMs: number | null; size: number | null },
  signature: BundleMemberSignature,
): boolean {
  return (
    stat.present === signature.present &&
    stat.mtimeMs === signature.mtimeMs &&
    stat.size === signature.size
  );
}

/**
 * Byte authority: member position plus presence and exact-byte hash (06 §3.3). Path position is the
 * fixed record key and fixed order; two examinations are byte-equal iff every member agrees on
 * presence and hash.
 */
function sameByteTuple(
  left: Record<BundleMember, BundleMemberSignature>,
  right: Record<BundleMember, BundleMemberSignature>,
): boolean {
  return BUNDLE_MEMBERS.every(
    (member) =>
      left[member].present === right[member].present &&
      left[member].hash === right[member].hash,
  );
}

/** Classify one byte-distinct authority change into a structured transition (06 §4.3). */
function classifyTransition(
  previous: EstateBundleLoadResult,
  next: EstateBundleLoadResult,
): BundleTransition {
  if (next.ok) {
    return {
      kind: previous.ok ? "bundle_reloaded" : "bundle_recovered",
      artifact: null,
      errorKind: null,
      bundleId: next.bundle.model.bundleId,
    };
  }
  return {
    kind: "bundle_error",
    artifact: next.error.artifact,
    errorKind: next.error.kind,
    bundleId: null,
  };
}

/** An absent member signature (present false, null metadata/hash). */
function absentSignature(): BundleMemberSignature {
  return { present: false, mtimeMs: null, size: null, hash: null };
}

/** Three absent signatures keyed in fixed member order (null model path / unread state). */
function absentSignatures(): Record<BundleMember, BundleMemberSignature> {
  return { model: absentSignature(), coverage: absentSignature(), findings: absentSignature() };
}

/** Build a hash-less signature from a pre-gate stat (defensive-throw seeding only). */
function sigFromStat(stat: {
  present: boolean;
  mtimeMs: number | null;
  size: number | null;
}): BundleMemberSignature {
  return { present: stat.present, mtimeMs: stat.mtimeMs, size: stat.size, hash: null };
}

/** Code-based ENOENT detection — never string-match OS wording (06 §3.2). */
function isEnoent(cause: unknown): cause is NodeJS.ErrnoException {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

// ── Bundle-error builders (06 §4.2; messages mirror load.ts §8 verbatim, no unsafe field echo) ────

/** Null-configuration error: artifact `model`, path `""`, field null. */
function nullConfigError(): EstateBundleError {
  return new EstateBundleError(
    "missing",
    "model",
    "",
    "Estate model path is not configured. Set PULSE_WEB_ESTATE_MODEL to the read-only mount of " +
      "web-estate-model.json.",
  );
}

/** Mandatory model ENOENT error: artifact `model`, model path, field null. */
function modelMissingError(path: string): EstateBundleError {
  return new EstateBundleError(
    "missing",
    "model",
    path,
    `Required estate model is missing at ${path}. Run 'pulse render' and verify the ` +
      `PULSE_WEB_ESTATE_MODEL mount.`,
  );
}

/** Non-ENOENT read failure for any member: field null, no OS error text. */
function unreadableError(artifact: EstateBundleArtifact, path: string): EstateBundleError {
  return new EstateBundleError(
    "unreadable",
    artifact,
    path,
    `Estate bundle ${artifact} is unreadable at ${path}. Verify the read-only rendered-tree mount ` +
      `and file permissions, then run 'pulse render' if needed.`,
  );
}

/** Invalid/thrown clock: artifact `model`, model path, field `loadedAt`. */
function clockError(path: string): EstateBundleError {
  return new EstateBundleError(
    "unreadable",
    "model",
    path,
    `Estate bundle load time could not be recorded for ${path}. Verify the server clock and retry ` +
      `the load.`,
    { field: "loadedAt" },
  );
}
