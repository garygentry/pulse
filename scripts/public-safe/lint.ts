/**
 * `bun run lint:public-safe` — checks that the tracked public trees, and the local planning specs when
 * present, use only public-safe placeholders. See CONTRIBUTING.md "Public-safe placeholders".
 */

import { resolve } from "node:path";

import { PublicSafeConfigError } from "./errors.js";
import { loadDenyTerms, loadExceptions, MIN_DENY_TERM_LENGTH } from "./exceptions.js";
import { formatViolation, scan } from "./rules.js";
import type { ScanSet } from "./types.js";
import { LOCAL_SPEC_ROOT, walkScanSet } from "./walk.js";

/** Output sinks (injectable for tests). */
export interface LintIo {
  /** Violations, notes and the summary line. */
  readonly out: (line: string) => void;
  /** Usage and configuration/internal errors. */
  readonly err: (line: string) => void;
}

/** Usage text printed for --help and for usage errors. */
export const USAGE = "usage: bun run lint:public-safe [--tracked-only]";

function describeError(error: unknown, repoRoot: string): string {
  let label = "Error";
  let message = String(error);
  if (error instanceof Error) {
    label = "code" in error && typeof error.code === "string" ? error.code : error.name;
    message = error.message;
  }
  // The absolute root is replaced so logs never carry a home path.
  return `${label}: ${message.replaceAll(repoRoot, ".")}`;
}

/**
 * Run the lint. Default set: tracked roots plus the local spec root. `--tracked-only` drops the latter.
 * @returns 0 pass, 1 violations found, 2 usage, configuration or internal error. Never throws.
 */
export async function runLint(argv: readonly string[], repoRoot: string, io: LintIo): Promise<0 | 1 | 2> {
  let set: ScanSet = "tracked+local-specs";
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      io.out(USAGE);
      return 0;
    }
    if (arg === "--tracked-only") {
      set = "tracked";
    } else {
      io.err("public-safe: unknown argument (see --help)");
      io.err(USAGE);
      return 2;
    }
  }

  try {
    const { exceptions } = await loadExceptions(repoRoot);
    const deny = await loadDenyTerms(repoRoot);
    if (deny.ignoredShort > 0) {
      io.out(
        `public-safe: note: ignored ${deny.ignoredShort} deny term(s) shorter than ${MIN_DENY_TERM_LENGTH} characters`,
      );
    }
    const report = await walkScanSet(repoRoot, set);
    for (const root of report.skippedRoots) io.out(`public-safe: ${root} absent — skipped`);

    const { violations, scanned } = scan({
      files: report.files,
      exceptions,
      denyTerms: deny.terms,
      contractFileCount: report.contractFileCount,
    });
    for (const violation of violations) io.out(formatViolation(violation));

    const local =
      set === "tracked" ? "not scanned" : report.localSpecCount === null ? "absent" : String(report.localSpecCount);
    const scope = `scanned ${scanned} files (tracked ${report.trackedCount}; ${LOCAL_SPEC_ROOT} ${local})`;
    if (violations.length === 0) {
      io.out(`public-safe: ok — ${scope}`);
      return 0;
    }
    const fileCount = new Set(violations.map((violation) => violation.path)).size;
    io.out(`public-safe: ${violations.length} violation(s) in ${fileCount} file(s) — ${scope}`);
    return 1;
  } catch (error) {
    if (error instanceof PublicSafeConfigError) {
      io.err(`public-safe: config error ${error.code} ${error.file}: ${error.message}`);
    } else {
      io.err(`public-safe: internal error: ${describeError(error, repoRoot)}`);
    }
    return 2;
  }
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
if (import.meta.main) {
  process.exitCode = await runLint(process.argv.slice(2), REPO_ROOT, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
