// packages/web-data/src/sources/grafana.ts — the optional Grafana source client
// (03-source-clients-and-validation.md §9, Grafana 11.4.0). Supports exactly one operation:
//
//   - health()  one GET /api/health
//
// `health()` validates the pinned health/version/database envelope from `unknown` with a zod
// schema, returning only the required bounded `database` and `version` fields. Additive
// unknown upstream fields (e.g. `commit`) pass and are stripped; a missing/invalid consumed
// field fails the whole operation. Every expected failure — transport, timeout, non-2xx,
// malformed JSON, invalid shape — is normalized to a bounded SourceResult and never rejects.
// This client adds no credentials and never forwards request headers.
//
// Runtime creation is conditional: Grafana is optional and never a global startup
// dependency. `resolveGrafanaClient` returns `null` when `PULSE_GRAFANA_URL` is absent, so
// the coordinator makes zero calls and records `grafana-health` as `not-configured` — a state
// distinct from any configured failure. A configured failure degrades only Grafana.

import { z } from "zod";
import { SOURCE_MAX_BODY_BYTES, SOURCE_MAX_NAME_BYTES, SOURCE_TIMEOUT_MS } from "../wire/common.js";
import type { FetchLike, SourceClientOptions, SourceResult } from "./types.js";
import { fetchJsonUnknown, normalizeBaseUrl, sourceFailure, sourceSuccess } from "./fetch.js";

// ---------------------------------------------------------------------------
// §9 Consumed value type
// ---------------------------------------------------------------------------

/** The validated Grafana `/api/health` envelope: only the required bounded fields. */
export interface GrafanaHealth {
  /** Grafana database status token (e.g. `"ok"`/`"failing"`), bounded and non-empty. */
  readonly database: string;
  /** Grafana version string, bounded and non-empty. */
  readonly version: string;
}

/** The optional Grafana source client. The single method resolves a SourceResult and never throws. */
export interface GrafanaClient {
  /** GET /api/health once and return the validated database/version envelope, or a failure as data. */
  health(): Promise<SourceResult<GrafanaHealth>>;
}

// ---------------------------------------------------------------------------
// Validation helpers and consumed-body schema
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** Byte length of a string as UTF-8. */
function byteLen(s: string): number {
  return utf8.encode(s).length;
}

/** A non-empty consumed field bounded to the §2 512-byte limit. */
const boundedField = z
  .string()
  .min(1)
  .refine((s) => byteLen(s) <= SOURCE_MAX_NAME_BYTES);

/**
 * The `/api/health` body validates only the required `database`/`version` fields; every other
 * upstream field (e.g. `commit`) is additive and stripped by `.passthrough()` + the mapper.
 */
const healthResponseSchema = z
  .object({ database: boundedField, version: boundedField })
  .passthrough();

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Construct a {@link GrafanaClient} bound to a validated Grafana base URL. Fails closed
 * (throws {@link SourceConfigError}) on a non-absolute, credential-bearing, or non-HTTP(S)
 * base URL so direct tests exercise the same validation as production config.
 */
export function createGrafanaClient(baseUrl: string, options: SourceClientOptions = {}): GrafanaClient {
  const base = normalizeBaseUrl(baseUrl);
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SOURCE_TIMEOUT_MS;

  return {
    async health(): Promise<SourceResult<GrafanaHealth>> {
      const raw = await fetchJsonUnknown(new URL(base + "/api/health"), {
        fetchImpl,
        timeoutMs,
        maxBytes: SOURCE_MAX_BODY_BYTES,
      });
      if (!raw.ok) return raw;
      const parsed = healthResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      return sourceSuccess({ database: parsed.data.database, version: parsed.data.version });
    },
  };
}

/**
 * Conditionally construct the optional Grafana client. Grafana is never a global startup
 * dependency: when `PULSE_GRAFANA_URL` is absent (null/empty/whitespace) this returns `null`,
 * so the coordinator creates no client, issues zero calls, and records `grafana-health` as
 * `not-configured` — a state distinct from any configured failure. When configured, the client
 * is created with the same fail-closed base-URL validation as {@link createGrafanaClient}.
 *
 * @param configuredUrl - the resolved `PULSE_GRAFANA_URL`, or `null` when unset.
 */
export function resolveGrafanaClient(
  configuredUrl: string | null,
  options: SourceClientOptions = {},
): GrafanaClient | null {
  const url = configuredUrl?.trim();
  if (url === undefined || url === "") return null;
  return createGrafanaClient(url, options);
}
