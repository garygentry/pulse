/**
 * Loaders for the two lint configuration files: the tracked exceptions file and the optional, gitignored
 * local deny list. The parsers are pure; only the `load*` functions touch the filesystem.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PublicSafeConfigError } from "./errors.js";
import type { ExceptionsFile, LintException } from "./types.js";

export { globToRegExp, pathMatches } from "./glob.js";

/** Repo-relative path of the single tracked exceptions file. */
export const EXCEPTIONS_FILE = "public-safe-exceptions.json";
/** Repo-relative path of the optional gitignored deny list. */
export const DENY_FILE = ".public-safe.local";
/** Deny terms shorter than this are ignored. */
export const MIN_DENY_TERM_LENGTH = 3;
/** Longest accepted exception `value`, in characters. */
export const MAX_EXCEPTION_VALUE_LENGTH = 512;

const EXCEPTION_PATH_RE = /^[A-Za-z0-9._\-/*?]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "UNKNOWN";
}

/**
 * Validate exceptions JSON text. Pure. The message names the failing location and never echoes a value.
 * @throws {PublicSafeConfigError} EXCEPTIONS_INVALID
 */
export function parseExceptions(text: string, file: string = EXCEPTIONS_FILE): ExceptionsFile {
  const invalid = (message: string): PublicSafeConfigError =>
    new PublicSafeConfigError("EXCEPTIONS_INVALID", file, message);

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    // The parser message can quote a fragment of the input, so only the error name is reported.
    throw invalid(`invalid JSON: ${error instanceof Error ? error.name : "parse error"}`);
  }
  if (!isPlainObject(root) || !hasExactKeys(root, ["formatVersion", "exceptions"])) {
    throw invalid("root: must be an object with exactly the keys formatVersion and exceptions");
  }
  if (root["formatVersion"] !== 1) throw invalid("formatVersion: must be 1");
  const entries = root["exceptions"];
  if (!Array.isArray(entries)) throw invalid("exceptions: must be an array");

  const exceptions: LintException[] = [];
  const seen = new Map<string, number>();
  entries.forEach((entry: unknown, i) => {
    const at = `exceptions[${i}]`;
    if (!isPlainObject(entry) || !hasExactKeys(entry, ["value", "path", "reason"])) {
      throw invalid(`${at}: must be an object with exactly the keys value, path and reason`);
    }
    const { value, path, reason } = entry;
    if (typeof value !== "string") throw invalid(`${at}.value: must be a string`);
    if (typeof path !== "string") throw invalid(`${at}.path: must be a string`);
    if (typeof reason !== "string") throw invalid(`${at}.reason: must be a string`);
    if (value === "") throw invalid(`${at}.value: must not be empty`);
    if (/[\r\n]/.test(value)) throw invalid(`${at}.value: must not contain a line break`);
    if (value.length > MAX_EXCEPTION_VALUE_LENGTH) {
      throw invalid(`${at}.value: must be at most ${MAX_EXCEPTION_VALUE_LENGTH} characters`);
    }
    if (!EXCEPTION_PATH_RE.test(path)) {
      throw invalid(`${at}.path: must be a repo-relative path or glob (letters, digits, . _ - / * ?)`);
    }
    if (path.startsWith("/") || path.startsWith("./")) throw invalid(`${at}.path: must not start with / or ./`);
    if (path.includes("//")) throw invalid(`${at}.path: must not contain //`);
    if (path.split("/").includes("..")) throw invalid(`${at}.path: must not contain a .. segment`);
    if (reason.trim() === "") throw invalid(`${at}.reason: must not be empty`);
    const key = JSON.stringify([value, path]);
    const earlier = seen.get(key);
    if (earlier !== undefined) throw invalid(`${at}: duplicate of exceptions[${earlier}]`);
    seen.set(key, i);
    exceptions.push({ value, path, reason });
  });
  return { formatVersion: 1, exceptions };
}

/**
 * Read and validate the exceptions file.
 * @throws {PublicSafeConfigError} EXCEPTIONS_UNREADABLE when the file is missing or cannot be read
 * @throws {PublicSafeConfigError} EXCEPTIONS_INVALID when JSON parsing or the schema check fails
 */
export async function loadExceptions(repoRoot: string): Promise<ExceptionsFile> {
  let text: string;
  try {
    text = await readFile(join(repoRoot, EXCEPTIONS_FILE), "utf8");
  } catch (error) {
    // The file is tracked, so a missing file is a wiring error, not an empty list.
    throw new PublicSafeConfigError("EXCEPTIONS_UNREADABLE", EXCEPTIONS_FILE, `cannot read (${errorCode(error)})`);
  }
  return parseExceptions(text, EXCEPTIONS_FILE);
}

/** Parsed deny list. */
export interface DenyTerms {
  /** Lower-cased, de-duplicated terms of length ≥ MIN_DENY_TERM_LENGTH, in file order. */
  readonly terms: readonly string[];
  /** Number of non-comment terms dropped for being too short. */
  readonly ignoredShort: number;
}

/**
 * Parse deny-list text: one term per line, trimmed; blank lines and lines starting with `#` are ignored.
 * Inline comments are not supported, so a term may contain `#`. Pure.
 */
export function parseDenyTerms(text: string): DenyTerms {
  const terms = new Set<string>();
  let ignoredShort = 0;
  for (const raw of text.split(/\r?\n/)) {
    const term = raw.trim().toLowerCase();
    if (term === "" || term.startsWith("#")) continue;
    if (term.length < MIN_DENY_TERM_LENGTH) {
      ignoredShort += 1;
      continue;
    }
    terms.add(term);
  }
  return { terms: [...terms], ignoredShort };
}

/** Read the deny list. Returns empty terms when it does not exist; any other read error propagates. */
export async function loadDenyTerms(repoRoot: string): Promise<DenyTerms> {
  let text: string;
  try {
    text = await readFile(join(repoRoot, DENY_FILE), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { terms: [], ignoredShort: 0 };
    throw error;
  }
  return parseDenyTerms(text);
}
