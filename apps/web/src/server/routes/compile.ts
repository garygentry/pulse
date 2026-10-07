// src/server/routes/compile.ts — the compiled GET-route pattern engine (05 §2).
//
// Module-private compiler internals (no package export): pattern → segment array with startup
// validation (malformed / duplicate-name / ambiguous / unknown `slashParams` name), decode-once
// parameter matching with the control/NUL/slash-after-decode and 512-byte bounds (a route's
// `slashParams` opt in to a structurally-checked `/`, amendment 12 §1), and the 2 KiB /
// repeated-key query guard.
// `assertRegistry` runs once at registry load (fails startup on a malformed set); `matchRoutes`
// runs per request over the LIVE routes array (so a runtime-appended route — the skeleton seam —
// is still matched) with per-pattern compilation memoized.

import type { RouteDefinition } from "../../shared/registry.js";

/** Decoded parameter values may be at most 512 UTF-8 bytes (§2). */
export const MAX_PARAM_BYTES = 512;
/** Raw query strings are capped at 2 KiB (§2). */
export const MAX_QUERY_BYTES = 2048;

const utf8 = new TextEncoder();

/** One compiled pattern segment: an exact static match or a single named capture. */
type CompiledSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string };

/** Thrown at startup when a registered pattern (or the set) is malformed (§10 — fail before bind). */
export class RouteCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteCompileError";
  }
}

/** Per-pattern compilation cache — keyed by the exact pattern string. Lets `matchRoutes` recompile
 *  cheaply over the live routes array while still O(1) per already-seen pattern. */
const segmentCache = new Map<string, readonly CompiledSegment[]>();

/**
 * Compile one route pattern into its segment array, validating structure (§2). Rejects: a pattern
 * without a leading `/`, an empty internal segment (`//`), wildcard syntax, an empty `:` name, and a
 * duplicate parameter name within the pattern. Result is memoized per pattern string.
 */
export function compileSegments(pattern: string): readonly CompiledSegment[] {
  const cached = segmentCache.get(pattern);
  if (cached !== undefined) return cached;

  if (!pattern.startsWith("/")) {
    throw new RouteCompileError(`route pattern must start with '/': ${JSON.stringify(pattern)}`);
  }
  const raw = pattern.slice(1).split("/");
  const segments: CompiledSegment[] = [];
  const names = new Set<string>();
  for (const part of raw) {
    if (part.length === 0) {
      throw new RouteCompileError(`route pattern has an empty segment: ${JSON.stringify(pattern)}`);
    }
    if (part.includes("*")) {
      throw new RouteCompileError(`route pattern uses unsupported wildcard syntax: ${JSON.stringify(pattern)}`);
    }
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (name.length === 0 || name.includes(":")) {
        throw new RouteCompileError(`route pattern has a malformed parameter: ${JSON.stringify(pattern)}`);
      }
      if (names.has(name)) {
        throw new RouteCompileError(`route pattern repeats parameter name ':${name}': ${JSON.stringify(pattern)}`);
      }
      names.add(name);
      segments.push({ kind: "param", name });
    } else {
      segments.push({ kind: "static", value: part });
    }
  }
  const frozen = Object.freeze(segments);
  segmentCache.set(pattern, frozen);
  return frozen;
}

/** Whether two compiled segments could both match some concrete segment (param matches anything). */
function segmentsOverlap(a: CompiledSegment, b: CompiledSegment): boolean {
  if (a.kind === "param" || b.kind === "param") return true;
  return a.value === b.value;
}

/** Whether two patterns are ambiguous: same length and every position overlaps, so some concrete
 *  path matches both. Declaration order is never used to break such a tie (§2). */
function patternsAmbiguous(a: readonly CompiledSegment[], b: readonly CompiledSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!segmentsOverlap(a[i]!, b[i]!)) return false;
  }
  return true;
}

/** Reject a `slashParams` entry that is not a `:param` of the route's own path (amendment 12 §1). */
function assertSlashParams(route: RouteDefinition, segments: readonly CompiledSegment[]): void {
  if (route.slashParams === undefined) return;
  const names = new Set(segments.flatMap((seg) => (seg.kind === "param" ? [seg.name] : [])));
  for (const name of route.slashParams) {
    if (!names.has(name)) {
      throw new RouteCompileError(
        `slashParams names ${JSON.stringify(name)}, which is not a parameter of ${JSON.stringify(route.path)}`,
      );
    }
  }
}

/**
 * Validate the whole registry at startup (§2/§10). Compiles each pattern (throwing on a malformed
 * one), rejects a `slashParams` name that is not a parameter of its route, and rejects any
 * ambiguous same-shape pair — including two identical patterns. Returns the
 * compiled segment arrays in declaration order for reuse.
 */
export function assertRegistry(routes: readonly RouteDefinition[]): readonly (readonly CompiledSegment[])[] {
  const compiled = routes.map((route) => compileSegments(route.path));
  routes.forEach((route, i) => assertSlashParams(route, compiled[i]!));
  for (let i = 0; i < compiled.length; i += 1) {
    for (let j = i + 1; j < compiled.length; j += 1) {
      if (patternsAmbiguous(compiled[i]!, compiled[j]!)) {
        throw new RouteCompileError(
          `ambiguous route patterns: ${JSON.stringify(routes[i]!.path)} and ${JSON.stringify(routes[j]!.path)}`,
        );
      }
    }
  }
  return compiled;
}

/** Split a request pathname into its segments (leading slash dropped; a trailing slash yields a
 *  trailing empty segment so `/api/overview/` never matches `/api/overview`). */
function splitPath(pathname: string): string[] {
  return pathname.startsWith("/") ? pathname.slice(1).split("/") : pathname.split("/");
}

/**
 * Whether a decoded parameter value is safe (§2; amendment 12 §1): no control/NUL, ≤512 UTF-8
 * bytes, and no `/` after decoding — unless `allowSlash` (the param is in the route's
 * `slashParams`). An opted-in value may contain `/` but must not start or end with it, contain
 * `//`, have a `/`-separated piece equal to `.` or `..`, or contain `\`.
 */
function decodedParamIsValid(value: string, allowSlash: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false; // control / NUL
    if (code === 0x2f && !allowSlash) return false; // '/' after decode
  }
  if (allowSlash) {
    if (value.includes("\\")) return false;
    // An empty piece is a leading/trailing '/' or a '//'.
    for (const piece of value.split("/")) {
      if (piece.length === 0 || piece === "." || piece === "..") return false;
    }
  }
  return utf8.encode(value).length <= MAX_PARAM_BYTES;
}

/** The outcome of matching a request path against the registry. */
export type MatchOutcome =
  | { readonly kind: "match"; readonly route: RouteDefinition; readonly params: Readonly<Record<string, string>> }
  // Shape matched but a parameter was malformed/out-of-bounds → 400. `route` carries the matched
  // template so the metric label and any error detail use the pattern, never the raw path.
  | { readonly kind: "invalid"; readonly route: RouteDefinition }
  | { readonly kind: "none" };

/**
 * Match a request `pathname` against the LIVE routes array (§2). The path is split on literal `/`
 * BEFORE decoding, so an encoded `%2F` stays inside one segment. Static segments compare exactly;
 * `:param` segments capture one non-empty segment, decode exactly once, and are rejected (→ 400)
 * on malformed encoding, control/NUL, a >512-byte value, or a slash after decoding — except that a
 * param listed in the route's `slashParams` may carry a structurally-valid `/` (amendment 12 §1).
 * The registry is non-ambiguous (enforced by `assertRegistry`), so at most one route shape-matches.
 */
export function matchRoutes(routes: readonly RouteDefinition[], pathname: string): MatchOutcome {
  const parts = splitPath(pathname);
  for (const route of routes) {
    const segments = compileSegments(route.path);
    if (segments.length !== parts.length) continue;

    let shapeMatches = true;
    let malformed = false;
    const params: Record<string, string> = {};
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      const part = parts[i]!;
      if (seg.kind === "static") {
        if (seg.value !== part) {
          shapeMatches = false;
          break;
        }
        continue;
      }
      // Parameter segment: must be non-empty, decode exactly once, and pass the safety bounds.
      if (part.length === 0) {
        shapeMatches = false;
        break;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        malformed = true;
        break;
      }
      if (!decodedParamIsValid(decoded, route.slashParams?.includes(seg.name) ?? false)) {
        malformed = true;
        break;
      }
      params[seg.name] = decoded;
    }
    if (!shapeMatches) continue;
    if (malformed) return { kind: "invalid", route };
    return { kind: "match", route, params: Object.freeze(params) };
  }
  return { kind: "none" };
}

/** The outcome of validating a request query string. */
export type QueryOutcome = { readonly ok: true } | { readonly ok: false };

/**
 * Validate a raw query string (§2): cap the raw length at 2 KiB, reject any repeated key, and —
 * when `allowedKeys` is provided — reject any key outside the handler's declared set. The current
 * routes allow no keys; history allows only `range` (enforced by its handler in item 038).
 */
export function validateQuery(search: string, allowedKeys?: readonly string[]): QueryOutcome {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw.length === 0) return { ok: true };
  if (utf8.encode(raw).length > MAX_QUERY_BYTES) return { ok: false };
  const seen = new Set<string>();
  for (const [key] of new URLSearchParams(raw)) {
    if (seen.has(key)) return { ok: false };
    seen.add(key);
    if (allowedKeys !== undefined && !allowedKeys.includes(key)) return { ok: false };
  }
  return { ok: true };
}

/** Test seam: clear the per-pattern compilation cache (so a malformed-pattern test is not masked by
 *  a cached compile from a sibling test). */
export function __resetCompileCacheForTest(): void {
  segmentCache.clear();
}
