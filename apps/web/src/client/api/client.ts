// apps/web/src/client/api/client.ts — the client-side API surface (01-core-definitions.md §11,
// 08-events-live-state-and-freshness-migration.md §§5–6).
//
// Isolation constraint: this file MUST NOT import anything from `src/server/**` or
// `src/shared/constants.ts` — the client graph is walled off. `SHELL_MARKERS` and
// `DEV_BUILD_ID_PATH` are therefore duplicated here as client literals; a test pins each to its
// server-side counterpart. The one cross-package dependency is `@pulse/web-data/wire`, which is
// browser-safe by construction (its emitted graph has no Node/Bun/renderer/source runtime edge).

import {
  ERROR_MESSAGES,
  OBSERVATION_HEADER_MAX_BYTES,
  validateCycleObservation,
  validateHashId,
  type ApiErrorCode,
  type CycleObservation,
  type ErrorEnvelope,
} from "@pulse/web-data/wire";

/**
 * Client copy of the shell marker names (`00-core-definitions.md §1.4`). MUST stay identical to
 * the copy in `src/server/assets.ts` — asserted deep-equal by a future test (`tests/assets.test.ts`).
 */
export const SHELL_MARKERS = {
  /** `<meta name="pulse-build-id" content="<buildId>">` — present whenever a manifest loaded. */
  buildIdMeta: "pulse-build-id",
  /** `<meta name="pulse-dev" content="1">` — present only under `{ dev: true }`. */
  devMeta: "pulse-dev",
  /** `<script type="application/json" id="pulse-chunk-css">` — the inert `chunkCss` island. */
  chunkCssIsland: "pulse-chunk-css",
  /** `<meta name="pulse-csp-nonce" nonce="<nonce>">` — the per-response CSP style nonce, stamped by
   *  the router on every shell response (read through the element's `.nonce` property). */
  cspNonceMeta: "pulse-csp-nonce",
} as const;

/** Client copy of `DEV_BUILD_ID_PATH` (`00 §2.2`). Duplicated, not imported — see file header. */
export const DEV_BUILD_ID_PATH = "/__dev/build-id" as const;

/**
 * Read `<meta name="…">`'s content, or `null` when the tag is absent or empty. Never throws;
 * `doc` is injectable for tests.
 */
export function readShellMeta(name: string, doc: Document = document): string | null {
  const el = doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  const content = el?.content ?? "";
  return content === "" ? null : content;
}

/**
 * Read the dev server's current build id. Returns `null` on ANY failure — network error, non-2xx,
 * non-JSON body, or a body without a non-empty string `buildId` (server restarting, or the loader
 * is in directory-scan fallback mode and reports `{ "buildId": null }`). NEVER throws.
 */
export async function fetchDevBuildId(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(DEV_BUILD_ID_PATH, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const buildId = (body as { buildId?: unknown } | null)?.buildId;
    return typeof buildId === "string" && buildId !== "" ? buildId : null;
  } catch {
    return null;
  }
}

/**
 * The exact discriminated outcome of one `apiFetch` call (01 §11). Expected HTTP failures resolve
 * here as `status:"error"`; network/protocol failures become a bounded `INTERNAL_ERROR` error
 * result, never an uncaught throw.
 */
export type ApiFetchResult<T> =
  | {
      /** Successful-body discriminator. */ readonly status: "ok";
      /** Validated decoded payload. */ readonly value: T;
      /** Strong selected-representation validator, or null when the route carries none. */ readonly etag: string | null;
      /** Semantic payload identity, or null for non-cycle routes. */ readonly identity: string | null;
      /** Parsed cycle observation, or null for non-cycle routes. */ readonly observation: CycleObservation | null;
    }
  | {
      /** Conditional-reuse discriminator. */ readonly status: "not-modified";
      /** Strong validator retained by the caller and re-confirmed by the 304. */ readonly etag: string;
      /** Current semantic payload identity supplied on the 304. */ readonly identity: string;
      /** Latest observation supplied on the 304, or null when the header was absent. */ readonly observation: CycleObservation | null;
    }
  | {
      /** Expected-failure discriminator. */ readonly status: "error";
      /** Validated shared error envelope (bounded `INTERNAL_ERROR` on protocol/network failure). */ readonly error: ErrorEnvelope;
      /** HTTP status returned by the server, or 0 for a network/transport failure. */ readonly httpStatus: number;
    };

/** Options for a single `apiFetch` call. */
export interface ApiFetchOptions {
  /** Prior strong validator; sent as a strong `If-None-Match` for conditional cycle requests. */
  readonly etag?: string;
  /** Optional request cancellation signal. */
  readonly signal?: AbortSignal;
}

/** The `status:"error"` arm, independent of the payload type parameter. */
type ApiFetchErrorResult = Extract<ApiFetchResult<unknown>, { status: "error" }>;

/** Sentinel: a 304 that cannot be accepted as reuse — one unconditional retry is required. */
const RETRY = Symbol("retry");

/** The five current-cycle routes: the ones that carry full observation/payload-id/ETag metadata. */
const CYCLE_PATHS: ReadonlySet<string> = new Set([
  "/api/overview",
  "/api/alerts",
  "/api/estate",
  "/api/engine",
  "/api/timeline",
]);

/** Whether `path` (query stripped) is one of the five cycle routes requiring full metadata. */
function isCyclePath(path: string): boolean {
  const pathname = path.split("?", 1)[0] ?? path;
  return CYCLE_PATHS.has(pathname);
}

/** A non-null, non-array plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The bounded `INTERNAL_ERROR` envelope; message is the exact catalog text, never interpolated. */
function internalErrorEnvelope(): ErrorEnvelope {
  return { code: "INTERNAL_ERROR", message: ERROR_MESSAGES.INTERNAL_ERROR };
}

/** A bounded error result for a protocol/network failure at HTTP status `httpStatus` (0 = network). */
function internalError(httpStatus: number): ApiFetchErrorResult {
  return { status: "error", error: internalErrorEnvelope(), httpStatus };
}

/** Strip one layer of surrounding double quotes from an entity-tag header value, if present. */
function unquoteEtag(raw: string | null): string | null {
  if (raw === null) return null;
  const t = raw.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * Decode and strictly validate an `X-Pulse-Observation` header value. base64url → UTF-8 bytes
 * (bounded to `OBSERVATION_HEADER_MAX_BYTES`) → JSON → `validateCycleObservation`. Returns the
 * validated observation, or `null` for an absent header or any malformed/oversized value. Never
 * throws and never echoes the raw header.
 */
function decodeObservation(header: string | null): CycleObservation | null {
  if (header === null) return null;
  let bytes: Uint8Array;
  try {
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length > OBSERVATION_HEADER_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  return validateCycleObservation(parsed);
}

/** Read and validate a JSON error body into a bounded `ErrorEnvelope` (falls back to INTERNAL_ERROR). */
async function readErrorEnvelope(res: Response): Promise<ErrorEnvelope> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return internalErrorEnvelope();
  }
  if (!isRecord(body) || typeof body.code !== "string" || body.code === "" || typeof body.message !== "string") {
    return internalErrorEnvelope();
  }
  const envelope: ErrorEnvelope = { code: body.code as ApiErrorCode, message: body.message };
  return isRecord(body.details)
    ? { ...envelope, details: body.details as Readonly<Record<string, string | number | boolean | null>> }
    : envelope;
}

/**
 * Perform one HTTP round trip. Returns the final `ApiFetchResult`, or the `RETRY` sentinel when a
 * 304 arrives that cannot be accepted as conditional reuse (no retained validator or malformed 304
 * metadata) — the caller then re-issues the request unconditionally.
 */
async function requestOnce<T>(
  path: string,
  options: ApiFetchOptions | undefined,
  fetchImpl: typeof fetch,
  cycle: boolean,
  sendConditional: boolean,
): Promise<ApiFetchResult<T> | typeof RETRY> {
  const headers = new Headers({ accept: "application/json" });
  const retainedEtag = options?.etag;
  // Conditional requests are a cycle-route concern only (08 §6); session/history never send one.
  if (cycle && sendConditional && retainedEtag !== undefined && retainedEtag !== "") {
    headers.set("if-none-match", `"${retainedEtag}"`);
  }

  let res: Response;
  try {
    res = await fetchImpl(path, {
      headers,
      cache: "no-store",
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch {
    return internalError(0); // network/transport/abort — bounded, never an uncaught throw
  }

  // 304 — conditional reuse. Accept only with a retained validator AND valid 304 metadata; an
  // invalid 304 (or one without a retained validator) is never empty success — retry unconditionally.
  if (res.status === 304) {
    if (!cycle || retainedEtag === undefined || retainedEtag === "") return RETRY;
    const identity = validateHashId(res.headers.get("x-pulse-payload-id"));
    const obsHeader = res.headers.get("x-pulse-observation");
    const observation = decodeObservation(obsHeader);
    if (identity === null || (obsHeader !== null && observation === null)) return RETRY;
    return { status: "not-modified", etag: retainedEtag, identity, observation };
  }

  // Non-2xx (and not 304) — validated error envelope.
  if (!res.ok) {
    return { status: "error", error: await readErrorEnvelope(res), httpStatus: res.status };
  }

  // 200 on a cycle route — validate ETag/payload-id/observation BEFORE touching the body.
  if (cycle) {
    const etag = validateHashId(unquoteEtag(res.headers.get("etag")));
    const identity = validateHashId(res.headers.get("x-pulse-payload-id"));
    const observation = decodeObservation(res.headers.get("x-pulse-observation"));
    if (etag === null || identity === null || observation === null) return internalError(res.status);
    let value: T;
    try {
      value = (await res.json()) as T;
    } catch {
      return internalError(res.status);
    }
    return { status: "ok", value, etag, identity, observation };
  }

  // 200 on a non-cycle route (session/history) — null cycle metadata by route contract.
  let value: T;
  try {
    value = (await res.json()) as T;
  } catch {
    return internalError(res.status);
  }
  return { status: "ok", value, etag: null, identity: null, observation: null };
}

/**
 * Fetch and validate one app API response (01 §11, 08 §6). Sends a strong `If-None-Match` when a
 * prior `etag` is supplied for a cycle route, accepts gzip normally, and validates status-specific
 * bodies plus ETag/payload-id/observation metadata before accepting a 200 or 304. Cycle routes
 * require the full valid metadata contract; session/history routes permit null cycle metadata. An
 * invalid 304 without a retained validator triggers exactly one unconditional retry and is never
 * empty success. Expected HTTP failures resolve as `status:"error"`; network/protocol failures
 * become a bounded `INTERNAL_ERROR` result — this never rejects for expected failure.
 */
export async function apiFetch<T>(
  path: string,
  options?: ApiFetchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiFetchResult<T>> {
  const cycle = isCyclePath(path);
  const first = await requestOnce<T>(path, options, fetchImpl, cycle, true);
  if (first !== RETRY) return first;
  // One unconditional retry: re-issue without `If-None-Match` so the server returns a full body.
  const second = await requestOnce<T>(path, options, fetchImpl, cycle, false);
  if (second !== RETRY) return second;
  return internalError(0); // a second 304 with no body is a protocol failure, never empty success
}
