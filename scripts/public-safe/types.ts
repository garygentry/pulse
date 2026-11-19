/** Rule identifiers, as printed in output. */
export type RuleId = "hostname" | "ip-address" | "home-path" | "local-deny" | "stale-exception" | "empty-scope";

/** One finding. `masked` never reproduces more of the value than is needed to locate it. */
export interface Violation {
  /** Repo-relative path, forward slashes. */ readonly path: string;
  /** 1-based line. */ readonly line: number;
  /** 1-based column (UTF-16 code units, start of the match). */ readonly column: number;
  /** Rule broken. */ readonly rule: RuleId;
  /** Masked offending value: first label + "…" (hosts), first octet/group + "…" (IPs), "/home/…" (paths), first 2 chars + "…" (deny terms). */ readonly masked: string;
  /** Suggested safe replacement, e.g. "pulse.example.com", "192.0.2.10", "2001:db8::10", "~/…". */ readonly suggestion: string;
}

/** One entry of public-safe-exceptions.json. */
export interface LintException {
  /** Exact offending value, as matched (unmasked; the file is tracked, so the value must itself be acceptable to publish). */ readonly value: string;
  /** Exact repo-relative path or a glob (`*`, `**`, `?`). */ readonly path: string;
  /** Why it is permitted. Non-empty. */ readonly reason: string;
}

/** public-safe-exceptions.json. */
export interface ExceptionsFile {
  /** File format version. */ readonly formatVersion: 1;
  /** Entries (may be empty). */ readonly exceptions: readonly LintException[];
}

/** A file to scan. */
export interface ScanInput {
  /** Repo-relative path. */ readonly path: string;
  /** UTF-8 text. */ readonly text: string;
}

/** Inputs to one run of the engine. */
export interface LintRunInput {
  /** Files in scope. */ readonly files: readonly ScanInput[];
  /** Parsed exceptions. */ readonly exceptions: readonly LintException[];
  /** Lower-cased local deny terms from .public-safe.local (empty when absent). */ readonly denyTerms: readonly string[];
  /** Number of files the walk found under contract/ (empty-scope guard). */ readonly contractFileCount: number;
}

/** Engine output. */
export interface LintResult {
  /** All violations sorted by path, line, column, rule. Empty means pass. */ readonly violations: readonly Violation[];
  /** Files scanned. */ readonly scanned: number;
}

/** Scan set selection. */
export type ScanSet = "tracked" | "tracked+local-specs";
