// packages/renderer/src/render/web-safety.ts
//
// Shared rendered-model-v2 safety TYPE contracts plus the pure safety layer
// (00-core-definitions.md §3, 03-web-safety-and-findings.md). Item 001 froze the compile-time
// surface; item 003 adds the deterministic helpers: safety-context creation, display-only
// credential projection, lexical estate-relative provenance, URL-userinfo removal, sensitive
// channel-option tokenization, canary finalization, and the eight-rule recursive three-artifact
// assertion. Every function here is synchronous, deterministic, and free of environment,
// filesystem, network, clock, random, and locale access. No function throws for a domain input,
// resolves a secret, or copies a withheld value into a finding.
import type { ChannelOptions, Finding, Provenance, SecretRef } from "@pulse/core";
import { FINDING_CODES } from "@pulse/core";

import { WEB_ARTIFACT_PATHS, type WebArtifactPath } from "./web-artifacts.js";
import type { WebCredentialReference, WebProvenance } from "./web-model.js";
import { compareString } from "../order.js";

/** Exact withheld literals that the final recursive assertion must prove absent (00 §3). */
export interface ForbiddenCanarySet {
  /** Unique non-empty strings, sorted longest-first then raw code point. */
  readonly values: readonly string[];
}

/** Location of a recursively visited key or scalar (00 §3). */
export interface SafetyCursor {
  /** Artifact being checked. */
  readonly artifact: WebArtifactPath;
  /** JSON field path within that artifact. */
  readonly path: string;
}

/** Context accumulated while producing safe projections (00 §3). */
export interface WebSafetyContext {
  /** Renderer-created sanitization/fatal findings. */
  readonly findings: Finding[];
  /** Sensitive literals intentionally withheld from output. */
  readonly canaries: Set<string>;
}

/** Safe-projection operation outcome (00 §3). */
export type WebProjectionResult<T> =
  | { ok: true; value: T; findings: Finding[] }
  | { ok: false; findings: Finding[] };

// ---------------------------------------------------------------------------
// Safety context and canary collection (03 §§4, 5.1)
// ---------------------------------------------------------------------------

/** Create an empty safety context: no findings, no withheld canaries (03 §3.2). */
export function createWebSafetyContext(): WebSafetyContext {
  return { findings: [], canaries: new Set<string>() };
}

/**
 * Build the exact `ForbiddenCanarySet` for the final assertion from a context's collected
 * literals (03 §5.1): remove empty strings, deduplicate exact strings, then sort by descending
 * length with raw code-point order as the tie-breaker. Canaries are never trimmed, decoded,
 * case-folded, or otherwise transformed.
 *
 * @param ctx - The safety context whose `canaries` were accumulated during projection.
 * @returns The normalized, longest-first forbidden set.
 */
export function finalizeCanaries(ctx: WebSafetyContext): ForbiddenCanarySet {
  const unique = new Set<string>();
  for (const canary of ctx.canaries) {
    if (canary !== "") unique.add(canary);
  }
  const values = [...unique].sort((a, b) => b.length - a.length || compareString(a, b));
  return { values };
}

// ---------------------------------------------------------------------------
// Field-aware safe projection (03 §4)
// ---------------------------------------------------------------------------

/**
 * Project a validated `SecretRef` to a display-only reference (03 §4.1): exactly
 * `{ kind, display }` where `display` is the original validated reference text. It never copies
 * `varName`/`vault`/`item`/`field`, resolves the reference, reads the environment, or adds the
 * (valid) reference to any canary set.
 */
export function projectCredential(ref: SecretRef): WebCredentialReference {
  return { kind: ref.kind, display: ref.raw };
}

/**
 * Project a core `Provenance` into a safe estate-root-relative `WebProvenance` (03 §4.5). `file`
 * has backslashes converted to `/` and is lexically normalized; `path`, `line`, and `col` are
 * copied unchanged. Rejects (fatal `WEB_UNSAFE_PROVENANCE`) when `file` is empty, contains NUL,
 * is absolute (`/` or `//`), is drive-qualified, or normalizes above the estate root. No
 * filesystem access; `estateRoot` is an accepted compatibility seam that never legitimizes an
 * absolute path.
 *
 * @param provenance - The validated source location (already loader-relative).
 * @param estateRoot - Unused compatibility seam; must not cause I/O.
 * @returns A safe `WebProvenance`, or a fatal result whose finding never echoes `provenance.file`.
 */
export function projectProvenance(
  provenance: Provenance,
  estateRoot?: string,
): WebProjectionResult<WebProvenance> {
  void estateRoot;
  const file = normalizeRelativePath(provenance.file);
  if (file === null) {
    return { ok: false, findings: [unsafeProvenanceFinding(provenance.path)] };
  }
  return {
    ok: true,
    value: { file, path: provenance.path, line: provenance.line, col: provenance.col },
    findings: [],
  };
}

/**
 * Remove userinfo from a URL-position scalar and emit one warning when it is stripped (03 §4.3).
 * Absolute URLs and `//` network-path references parseable by the platform `URL` are handled;
 * any parseable value carrying a non-empty username/password has both cleared while scheme, host,
 * port, path, query, and fragment are retained. The removed username, password, and exact
 * authority userinfo substring are added to `ctx.canaries`. A value with no userinfo, or one the
 * parser rejects, is returned unchanged (the recursive guard still applies later).
 *
 * @param value - The candidate URL string, verbatim.
 * @param source - Safe provenance of the exact URL field (used for the warning location).
 * @param ctx - Accumulates the removal warning and withheld userinfo canaries.
 * @returns The sanitized URL, or `value` unchanged when nothing was removed.
 */
export function sanitizeUrl(value: string, source: WebProvenance, ctx: WebSafetyContext): string {
  const networkPath = value.startsWith("//");
  let url: URL;
  try {
    url = networkPath ? new URL(value, SYNTHETIC_BASE) : new URL(value);
  } catch {
    return value;
  }
  if (url.username === "" && url.password === "") {
    return value;
  }
  if (url.username !== "") ctx.canaries.add(url.username);
  if (url.password !== "") ctx.canaries.add(url.password);
  const rawUserinfo = originalAuthorityUserinfo(value, networkPath);
  if (rawUserinfo !== null && rawUserinfo !== "") ctx.canaries.add(rawUserinfo);

  url.username = "";
  url.password = "";
  let out = url.toString();
  if (networkPath && out.startsWith(SYNTHETIC_SCHEME)) {
    // Restore the network-path form by dropping only the synthetic `http:` scheme prefix.
    out = out.slice(SYNTHETIC_SCHEME.length);
  }
  ctx.findings.push(urlWarning(source));
  return out;
}

/**
 * Tokenize channel-option keys and omit sensitive pairs (03 §4.4). Own keys are visited in raw
 * code-point order. A key is omitted iff any of its tokens exactly equals a sensitive token;
 * tokenization inserts a boundary before an ASCII uppercase letter preceded by an ASCII lowercase
 * letter or digit, splits on every non-ASCII-alphanumeric run, and folds `A`–`Z` to lowercase.
 * Omitted string values are added to `ctx.canaries` (numbers/booleans have no secret string).
 * Each omitted key appends one warning whose path never contains the value. Returns `null` when
 * no options were declared or no safe entries remain.
 *
 * @param options - The declared channel options, or `undefined`.
 * @param source - Safe provenance of the containing channel (used for warning locations).
 * @param ctx - Accumulates omission warnings and withheld option-value canaries.
 * @returns The safe option subset, or `null`.
 */
export function sanitizeChannelOptions(
  options: ChannelOptions | undefined,
  source: WebProvenance,
  ctx: WebSafetyContext,
): Record<string, string | number | boolean> | null {
  if (options === undefined) return null;
  const keys = Object.keys(options).sort(compareString);
  const safe: Record<string, string | number | boolean> = {};
  let kept = 0;
  for (const key of keys) {
    const value = options[key];
    if (value === undefined) continue;
    if (isSensitiveOptionKey(key)) {
      if (typeof value === "string" && value !== "") ctx.canaries.add(value);
      ctx.findings.push(optionWarning(source, key));
      continue;
    }
    safe[key] = value;
    kept += 1;
  }
  return kept === 0 ? null : safe;
}

// ---------------------------------------------------------------------------
// Recursive final assertion (03 §5)
// ---------------------------------------------------------------------------

/**
 * Assert the three coordinated web artifacts are safe for read-only web exposure (03 §5.2/5.3).
 * Requires exactly the three `WEB_ARTIFACT_PATHS` roots (rule 8) and then recursively visits
 * every array index, own enumerable object key (in raw code-point order), and scalar of each
 * artifact in `WEB_ARTIFACT_PATHS` order, yielding a deterministic first failure. Applies the
 * finite eight-rule protection set; on the first violation returns a single fatal
 * `WEB_ARTIFACT_LEAK_DETECTED` finding that names the artifact and rule but never reproduces the
 * unsafe value, canary, userinfo, omitted option value, or unsafe path.
 *
 * @param artifacts - The three unstamped/stamped payloads keyed by their fixed paths.
 * @param canaries - The finalized forbidden set, already sorted longest-first.
 * @returns `{ ok: true, value: true }` when safe, else `{ ok: false, findings: [finding] }`.
 */
export function assertWebArtifactsSafe(
  artifacts: Readonly<Record<WebArtifactPath, unknown>>,
  canaries: ForbiddenCanarySet,
): WebProjectionResult<true> {
  const present = Object.keys(artifacts).sort(compareString);
  const expected = [...WEB_ARTIFACT_PATHS].sort(compareString);
  if (present.length !== expected.length || !expected.every((k, i) => present[i] === k)) {
    return { ok: false, findings: [rootLeakFinding()] };
  }
  for (const path of WEB_ARTIFACT_PATHS) {
    const violation = walkValue(
      artifacts[path],
      { artifact: path, path: "" },
      { inOptions: false, inDeadman: false, inMapData: false },
      canaries.values,
      new Set<object>(),
    );
    if (violation !== null) return { ok: false, findings: [violation] };
  }
  return { ok: true, value: true, findings: [] };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Fixed base for parsing `//` network-path references; parsing performs no lookup (03 §4.3). */
const SYNTHETIC_BASE = "http://pulse.invalid";
/** The synthetic scheme prefix removed to restore a `//` network-path form. */
const SYNTHETIC_SCHEME = "http:";

/** Sensitive channel-option tokens; any exact token match omits the whole pair (03 §4.4). */
const SENSITIVE_CHANNEL_OPTION_TOKENS: ReadonlySet<string> = new Set([
  "key",
  "password",
  "secret",
  "token",
  "webhook",
]);

/** Core-internal credential keys rejected outside declared map data (03 §5.3 rule 5). */
const CORE_INTERNAL_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "raw",
  "varName",
  "vault",
  "item",
  "field",
]);

/** The only keys allowed directly under a `deadman` property (03 §5.3 rule 6). */
const DEADMAN_ALLOWED_KEYS: ReadonlySet<string> = new Set(["configured", "kind"]);

/**
 * Lexically normalize a candidate estate-relative path (03 §4.5). Returns the normalized POSIX
 * path, or `null` when it is empty, contains NUL, is absolute (`/`/`//`), is drive-qualified, or
 * escapes the root. No filesystem access; used for provenance `file`, finding `file`, and every
 * `artifacts[]` element.
 */
function normalizeRelativePath(file: string): string | null {
  if (file === "" || file.includes("\0")) return null;
  const slashed = file.replaceAll("\\", "/");
  if (slashed.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(slashed)) return null;
  const out: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const normalized = out.join("/");
  return normalized === "" || normalized === "." ? null : normalized;
}

/** True iff a candidate string is a safe estate-relative path (03 §4.5 / §5.3 rule 7). */
function isSafeRelativePath(value: string): boolean {
  return normalizeRelativePath(value) !== null;
}

/**
 * Extract the exact original authority userinfo substring (before the host-delimiting `@`) from a
 * URL string (03 §4.3), or `null` when there is none. The host is taken to be after the last
 * `@`, matching WHATWG authority parsing.
 */
function originalAuthorityUserinfo(value: string, networkPath: boolean): string | null {
  let authStart: number;
  if (networkPath) {
    authStart = 2;
  } else {
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
    if (scheme === null) return null;
    authStart = scheme[0].length;
  }
  let authEnd = value.length;
  for (let i = authStart; i < value.length; i += 1) {
    const c = value[i];
    if (c === "/" || c === "?" || c === "#") {
      authEnd = i;
      break;
    }
  }
  const authority = value.slice(authStart, authEnd);
  const at = authority.lastIndexOf("@");
  return at === -1 ? null : authority.slice(0, at);
}

/** Tokenize an option key and test membership in the sensitive token set (03 §4.4). */
function isSensitiveOptionKey(key: string): boolean {
  let bounded = "";
  for (let i = 0; i < key.length; i += 1) {
    const c = key[i]!;
    const prev = i > 0 ? key[i - 1]! : "";
    const prevIsLowerOrDigit =
      (prev >= "a" && prev <= "z") || (prev >= "0" && prev <= "9");
    if (c >= "A" && c <= "Z" && prevIsLowerOrDigit) bounded += " ";
    bounded += c;
  }
  for (const token of bounded.split(/[^A-Za-z0-9]+/)) {
    if (token === "") continue;
    if (SENSITIVE_CHANNEL_OPTION_TOKENS.has(token.toLowerCase())) return true;
  }
  return false;
}

/** True iff a value parseable as an absolute or `//` URL carries non-empty userinfo (rule 2). */
function urlHasUserinfo(value: string): boolean {
  let url: URL;
  try {
    url = value.startsWith("//") ? new URL(value, SYNTHETIC_BASE) : new URL(value);
  } catch {
    return false;
  }
  return url.username !== "" || url.password !== "";
}

/** Validate a value below a `credential` key: `null` or exactly `{ kind, display }` (rule 4). */
function isValidCredentialValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("kind" in value) || !("display" in value)) return false;
  const { kind, display } = value as { kind: unknown; display: unknown };
  if (typeof display !== "string") return false;
  if (kind === "env") return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(display);
  if (kind === "op") return /^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(display);
  return false;
}

/** Recursion flags describing the enclosing contract context (03 §5.3). */
interface WalkFlags {
  /** Any ancestor key was exactly `options`. */
  readonly inOptions: boolean;
  /** Any ancestor key was exactly `deadman`. */
  readonly inDeadman: boolean;
  /** Any ancestor key was exactly `labels` or `responseMapping` (arbitrary map keys allowed). */
  readonly inMapData: boolean;
}

/**
 * Recursively visit one value, returning the first fatal leak finding or `null` (03 §5.2/5.3).
 * Object keys are visited in raw code-point order and arrays in index order; key-level guards run
 * before descending so a violation surfaces at its exact contract path.
 */
function walkValue(
  value: unknown,
  cursor: SafetyCursor,
  flags: WalkFlags,
  canaries: readonly string[],
  ancestors: Set<object>,
): Finding | null {
  if (value === null) return null;

  if (typeof value === "string") {
    for (const canary of canaries) {
      if (value.includes(canary)) return leakFinding(cursor, "canary");
    }
    if (urlHasUserinfo(value)) return leakFinding(cursor, "url-userinfo");
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : leakFinding(cursor, "non-contract-number");
  }
  if (typeof value === "boolean") return null;

  if (Array.isArray(value)) {
    if (ancestors.has(value)) return leakFinding(cursor, "cyclic");
    ancestors.add(value);
    for (let i = 0; i < value.length; i += 1) {
      const found = walkValue(
        value[i],
        { artifact: cursor.artifact, path: `${cursor.path}[${i}]` },
        flags,
        canaries,
        ancestors,
      );
      if (found !== null) {
        ancestors.delete(value);
        return found;
      }
    }
    ancestors.delete(value);
    return null;
  }

  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return leakFinding(cursor, "non-contract-object");
    }
    if (ancestors.has(value)) return leakFinding(cursor, "cyclic");
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort(compareString)) {
      const childPath = cursor.path === "" ? key : `${cursor.path}.${key}`;
      const childCursor: SafetyCursor = { artifact: cursor.artifact, path: childPath };
      const child = record[key];

      // Rule 5: core-internal credential keys outside declared map data.
      if (!flags.inMapData && CORE_INTERNAL_CREDENTIAL_KEYS.has(key)) {
        ancestors.delete(value);
        return leakFinding(childCursor, "credential-key");
      }
      // Rule 3: sensitive tokenized keys below `options`.
      if (flags.inOptions && isSensitiveOptionKey(key)) {
        ancestors.delete(value);
        return leakFinding(childCursor, "sensitive-option");
      }
      // Rule 6: only `configured`/`kind` are allowed under `deadman`.
      if (flags.inDeadman && !DEADMAN_ALLOWED_KEYS.has(key)) {
        ancestors.delete(value);
        return leakFinding(childCursor, "deadman");
      }
      // Rule 4: shape of a value below a `credential` key.
      if (key === "credential" && !isValidCredentialValue(child)) {
        ancestors.delete(value);
        return leakFinding(childCursor, "credential-shape");
      }
      // Rule 7: safe relative `file` path.
      if (key === "file" && typeof child === "string" && !isSafeRelativePath(child)) {
        ancestors.delete(value);
        return leakFinding(childCursor, "relative-path");
      }
      // Rule 7: safe relative paths for every `artifacts[]` element.
      if (key === "artifacts" && Array.isArray(child)) {
        for (let i = 0; i < child.length; i += 1) {
          const element = child[i];
          if (typeof element === "string" && !isSafeRelativePath(element)) {
            ancestors.delete(value);
            return leakFinding(
              { artifact: cursor.artifact, path: `${childPath}[${i}]` },
              "relative-path",
            );
          }
        }
      }

      const childFlags: WalkFlags = {
        inOptions: flags.inOptions || key === "options",
        inDeadman: flags.inDeadman || key === "deadman",
        inMapData: flags.inMapData || key === "labels" || key === "responseMapping",
      };
      const found = walkValue(child, childCursor, childFlags, canaries, ancestors);
      if (found !== null) {
        ancestors.delete(value);
        return found;
      }
    }
    ancestors.delete(value);
    return null;
  }

  // undefined, function, symbol, bigint.
  return leakFinding(cursor, "non-contract-value");
}

// ---------------------------------------------------------------------------
// Stable non-echoing findings (03 §6)
// ---------------------------------------------------------------------------

/** One `WEB_URL_USERINFO_REMOVED` warning at the sanitized URL field (03 §6.2). */
function urlWarning(source: WebProvenance): Finding {
  return {
    severity: "warning",
    code: FINDING_CODES.WEB_URL_USERINFO_REMOVED,
    file: source.file,
    path: source.path,
    message: "URL user information was removed from the web projection.",
    fix: "Remove user information from this URL and use a credential reference instead.",
  };
}

/** One `WEB_SENSITIVE_CHANNEL_OPTION_OMITTED` warning per omitted key; value never echoed (03 §6.3). */
function optionWarning(source: WebProvenance, key: string): Finding {
  const optionPath = source.path === "" ? `options.${key}` : `${source.path}.options.${key}`;
  return {
    severity: "warning",
    code: FINDING_CODES.WEB_SENSITIVE_CHANNEL_OPTION_OMITTED,
    file: source.file,
    path: optionPath,
    message: "A sensitive channel option was omitted from the web projection.",
    fix: "Remove this option and place the sensitive value in the channel credential reference.",
  };
}

/** The fatal `WEB_UNSAFE_PROVENANCE` finding; never reproduces `provenance.file` (03 §4.5/§6.4). */
function unsafeProvenanceFinding(path: string): Finding {
  return {
    severity: "error",
    code: FINDING_CODES.WEB_UNSAFE_PROVENANCE,
    file: "<estate>",
    path,
    message: "Source provenance was not a safe estate-root-relative path.",
    fix: "Reload and render from an estate-root-relative source so provenance can be displayed safely.",
  };
}

/** The fatal `WEB_ARTIFACT_LEAK_DETECTED` finding for a recursive guard violation (03 §5.4/§6.4). */
function leakFinding(cursor: SafetyCursor, rule: string): Finding {
  return {
    severity: "error",
    code: FINDING_CODES.WEB_ARTIFACT_LEAK_DETECTED,
    file: "<rendered>",
    path: cursor.path,
    message: `Web artifact ${cursor.artifact} failed the ${rule} safety guard.`,
    fix: "Correct the named web projector or contract before rendering again; never edit generated artifacts.",
  };
}

/** The fatal artifact-root guard finding (03 §5.3 rule 8). */
function rootLeakFinding(): Finding {
  return {
    severity: "error",
    code: FINDING_CODES.WEB_ARTIFACT_LEAK_DETECTED,
    file: "<rendered>",
    path: "",
    message: "Web artifact set did not contain exactly the three required artifact roots.",
    fix: "Correct the coordinated web emitter to supply exactly the three web artifacts before rendering again.",
  };
}
