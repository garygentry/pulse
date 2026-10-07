// packages/web-data/src/sources/gatus.ts — the Gatus source client
// (03-source-clients-and-validation.md §8, Gatus 5.13.1). Supports exactly two operations:
//
//   - endpointStatuses(expected)  one GET /api/v1/endpoints/statuses?page=1&pageSize=512;
//   - endpointHistory(key,{signal})  one cancellable GET of the pinned per-endpoint
//                                     history endpoint for a single exact key.
//
// `endpointStatuses` always issues exactly one page-1/pageSize-512 request, independent of
// estate size or viewer count, and retains every endpoint's `name`, `group`, `key`, derived
// identity, and every valid recent result. It rejects the complete attempt as `overflow`
// when the returned page is saturated (exactly 512 rows), the expected identity count is at
// least 512, an expected identity is absent, or a duplicate identity/key appears; a malformed
// body, endpoint, or nested result fails the whole operation as `invalid-shape`. Unexpected
// returned identities are retained only within bounds and explicitly attributed
// (`expected: false`); they never satisfy a missing expected identity. No subset is ever
// published after a completeness failure.
//
// `endpointHistory` validates/encodes one exact key, uses the pinned Gatus history endpoint,
// returns every valid result to the history service (which applies the range/600-result
// semantics), and propagates caller cancellation through fetch and streamed body reading
// while observing the 32 MiB source bound. Every method resolves a SourceResult and never
// rejects.

import { z } from "zod";
import {
  GATUS_MAX_ENDPOINTS,
  GATUS_STATUS_PAGE_SIZE,
  SOURCE_MAX_BODY_BYTES,
  SOURCE_MAX_NAME_BYTES,
  SOURCE_TIMEOUT_MS,
} from "../wire/common.js";
import type { FetchLike, SourceClientOptions, SourceResult } from "./types.js";
import { fetchJsonUnknown, normalizeBaseUrl, sourceFailure, sourceSuccess } from "./fetch.js";

// ---------------------------------------------------------------------------
// §8 Consumed value types (source-level; the fold adds renderer attribution)
// ---------------------------------------------------------------------------

/** One validated Gatus condition-result needed by downstream check summaries. */
export interface GatusConditionResult {
  /** The evaluated condition expression as reported by Gatus. */
  readonly condition: string;
  /** Whether this individual condition passed. */
  readonly success: boolean;
}

/** One validated Gatus evaluation result within an endpoint's recent history. */
export interface GatusCheckResult {
  /** Evaluation time as a parseable finite UTC ISO-8601 instant. */
  readonly timestamp: string;
  /** Whether every condition passed for this evaluation. */
  readonly success: boolean;
  /** Round-trip duration in milliseconds (converted from Go nanoseconds), or null when absent. */
  readonly durationMs: number | null;
  /** Condition results retained for downstream summaries; empty when none were reported. */
  readonly conditionResults: readonly GatusConditionResult[];
}

/**
 * One validated Gatus endpoint status: its stable rendered-model identity, Gatus composite
 * key, group, whether it matched an expected identity, and every valid recent result.
 */
export interface GatusEndpointState {
  /** Endpoint name — the rendered-model endpoint identity convention. */
  readonly name: string;
  /** Endpoint group (empty string when Gatus reports none). */
  readonly group: string;
  /** Gatus composite key (`<group>_<name>`), unique across the returned page. */
  readonly key: string;
  /** Stable identity derived from the documented Gatus tuple (the endpoint name). */
  readonly identity: string;
  /** Whether this identity was present in the caller-supplied expected set. */
  readonly expected: boolean;
  /** Every valid recent evaluation result, retained in upstream order. */
  readonly results: readonly GatusCheckResult[];
}

/** Complete validated per-endpoint history for one exact key. */
export interface GatusEndpointHistory {
  /** The exact validated endpoint key the history was fetched for. */
  readonly key: string;
  /** Every valid result returned by the pinned history endpoint, in upstream order. */
  readonly results: readonly GatusCheckResult[];
}

/** The Gatus source client. Every method resolves a SourceResult and never throws. */
export interface GatusClient {
  /**
   * Fetch the one fixed `page=1&pageSize=512` endpoint-statuses page and return every
   * validated endpoint state, or a completeness/overflow/shape failure as data.
   * @param expected - the rendered-model expected endpoint identities that must all be present.
   */
  endpointStatuses(expected: readonly string[]): Promise<SourceResult<readonly GatusEndpointState[]>>;
  /**
   * Fetch the complete recent history for one exact endpoint key, forwarding caller
   * cancellation through fetch and body reading.
   */
  endpointHistory(
    key: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SourceResult<GatusEndpointHistory>>;
}

// ---------------------------------------------------------------------------
// Validation helpers and consumed-body schemas
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** Byte length of a string as UTF-8. */
function byteLen(s: string): number {
  return utf8.encode(s).length;
}

/** A non-empty consumed name/key bounded to the §2 512-byte limit. */
const boundedName = z
  .string()
  .min(1)
  .refine((s) => byteLen(s) <= SOURCE_MAX_NAME_BYTES);

/** A parseable finite UTC timestamp; any unparseable value fails the whole operation. */
const timestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)));

const conditionResultSchema = z
  .object({ condition: z.string(), success: z.boolean() })
  .passthrough();

const resultSchema = z
  .object({
    success: z.boolean(),
    timestamp,
    duration: z.number().optional(),
    conditionResults: z.array(conditionResultSchema).optional(),
  })
  .passthrough();

const endpointSchema = z
  .object({
    name: boundedName,
    group: z.string().optional(),
    key: boundedName,
    results: z.array(resultSchema),
  })
  .passthrough();

/** The `/api/v1/endpoints/statuses` body is a bare array of endpoint objects. */
const statusesResponseSchema = z.array(endpointSchema);

/** The pinned per-endpoint history body is a single endpoint object. */
const endpointHistoryResponseSchema = endpointSchema;

/** Map one validated result envelope to the closed value; pure (shape already validated). */
function mapResult(r: z.infer<typeof resultSchema>): GatusCheckResult {
  const durationMs =
    r.duration !== undefined && Number.isFinite(r.duration) ? Math.round(r.duration / 1e6) : null;
  const conditionResults = (r.conditionResults ?? []).map((c) => ({
    condition: c.condition,
    success: c.success,
  }));
  return { timestamp: r.timestamp, success: r.success, durationMs, conditionResults };
}

/** Map one validated endpoint envelope to the closed value with its complete result set. */
function mapEndpoint(ep: z.infer<typeof endpointSchema>, expected: boolean): GatusEndpointState {
  return {
    name: ep.name,
    group: ep.group ?? "",
    key: ep.key,
    identity: ep.name,
    expected,
    results: ep.results.map(mapResult),
  };
}

/**
 * Results requested per endpoint-history call. Gatus 5.13.1 keeps at most 100 results per endpoint
 * and caps `pageSize` at 100; without the parameter it returns only its default page of 20, which
 * truncates check history to about 20 minutes at a one-minute interval.
 */
export const GATUS_HISTORY_PAGE_SIZE = 100;

/** Characters Gatus 5.13.1 replaces with `-` when building an endpoint key. */
const GATUS_KEY_REPLACED = new Set(["/", "_", ".", ",", " ", "#", "+", "&"]);

/** Gatus 5.13.1 `sanitize`: trim(lowercase(s)), then map each replaced character to `-`. */
function sanitizeGatusKeyPart(value: string): string {
  let out = "";
  for (const ch of value.toLowerCase().trim()) out += GATUS_KEY_REPLACED.has(ch) ? "-" : ch;
  return out;
}

/**
 * Derive the composite key Gatus uses to address one endpoint
 * (`/api/v1/endpoints/{key}/statuses`, and the `key` metric label). Pinned to Gatus 5.13.1
 * `config/endpoint/key.go`: `sanitize(group) + "_" + sanitize(name)`. A bare DNS endpoint has
 * an empty group, so its key starts with `_` (`("", "dns:a.b")` → `"_dns:a-b"`).
 */
export function gatusEndpointKey(group: string, name: string): string {
  return `${sanitizeGatusKeyPart(group)}_${sanitizeGatusKeyPart(name)}`;
}

/** Whether a caller-supplied endpoint key is a non-empty, bounded, control-free string. */
function isValidKey(key: string): boolean {
  if (key.length === 0 || byteLen(key) > SOURCE_MAX_NAME_BYTES) return false;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Construct a {@link GatusClient} bound to a validated Gatus base URL. Fails closed
 * (throws {@link SourceConfigError}) on a non-absolute, credential-bearing, or non-HTTP(S)
 * base URL so direct tests exercise the same validation as production config.
 */
export function createGatusClient(baseUrl: string, options: SourceClientOptions = {}): GatusClient {
  const base = normalizeBaseUrl(baseUrl);
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SOURCE_TIMEOUT_MS;

  return {
    async endpointStatuses(
      expected: readonly string[],
    ): Promise<SourceResult<readonly GatusEndpointState[]>> {
      const url = new URL(base + "/api/v1/endpoints/statuses");
      url.searchParams.set("page", "1");
      url.searchParams.set("pageSize", String(GATUS_STATUS_PAGE_SIZE));
      const raw = await fetchJsonUnknown(url, {
        fetchImpl,
        timeoutMs,
        maxBytes: SOURCE_MAX_BODY_BYTES,
      });
      if (!raw.ok) return raw;

      const parsed = statusesResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      const rows = parsed.data;

      // A saturated page (exactly pageSize rows) means the estate exceeds the 511 cap and
      // the page cannot be trusted as complete: reject wholly rather than publish a subset.
      if (rows.length >= GATUS_STATUS_PAGE_SIZE) return sourceFailure("overflow");

      // The expected identity count itself must fit within the supported envelope.
      const expectedSet = new Set(expected);
      if (expectedSet.size > GATUS_MAX_ENDPOINTS) return sourceFailure("overflow");

      // Build states, rejecting any duplicate identity or key across the returned page.
      const seenIdentity = new Set<string>();
      const seenKey = new Set<string>();
      const states: GatusEndpointState[] = [];
      for (const ep of rows) {
        if (seenIdentity.has(ep.name) || seenKey.has(ep.key)) return sourceFailure("overflow");
        seenIdentity.add(ep.name);
        seenKey.add(ep.key);
        states.push(mapEndpoint(ep, expectedSet.has(ep.name)));
      }

      // Every expected identity must be present; an unexpected identity never satisfies one.
      for (const identity of expectedSet) {
        if (!seenIdentity.has(identity)) return sourceFailure("overflow");
      }

      return sourceSuccess(states);
    },

    async endpointHistory(
      key: string,
      historyOptions?: { readonly signal?: AbortSignal },
    ): Promise<SourceResult<GatusEndpointHistory>> {
      // Validate/encode one exact key before issuing any request.
      if (!isValidKey(key)) return sourceFailure("invalid-shape");
      // Gatus matches the raw path segment without decoding `%3A`, so a DNS key such as
      // `_dns:example-com` must keep its literal `:` (a valid path character); every other
      // reserved character stays percent-encoded.
      const segment = encodeURIComponent(key).replace(/%3A/gi, ":");
      const url = new URL(base + `/api/v1/endpoints/${segment}/statuses`);
      url.searchParams.set("page", "1");
      url.searchParams.set("pageSize", String(GATUS_HISTORY_PAGE_SIZE));
      const signal = historyOptions?.signal;
      const raw = await fetchJsonUnknown(url, {
        fetchImpl,
        timeoutMs,
        maxBytes: SOURCE_MAX_BODY_BYTES,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!raw.ok) return raw;

      const parsed = endpointHistoryResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      return sourceSuccess({ key, results: parsed.data.results.map(mapResult) });
    },
  };
}
