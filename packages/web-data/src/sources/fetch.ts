// packages/web-data/src/sources/fetch.ts — the private bounded fetch primitive shared by
// every source client (03-source-clients-and-validation.md §§2–4, 11). NOT re-exported from
// the `/sources` barrel: clients expose only typed factories and result contracts.
//
// The primitive composes caller cancellation with an internal finite timeout, streams the
// response body while enforcing a hard byte bound before JSON parsing, aborts on overflow,
// and clears every timer/listener in `finally`. Every normal failure (timeout, transport,
// non-2xx, malformed JSON, body-bound overflow) resolves as a bounded `SourceResult`; it
// never rejects. Result messages are the exact `SOURCE_ERROR_MESSAGES[kind]` catalog text —
// no interpolation — so raw bodies, exception text, URLs, credentials, and headers never
// enter a result.

import { CONFIG_ERROR_MESSAGES, SOURCE_ERROR_MESSAGES } from "../wire/common.js";
import type { FetchLike, SourceError, SourceErrorKind, SourceResult } from "./types.js";

/** HTTP methods the source primitive may issue: GET reads and the two dark AM writes. */
export type FetchMethod = "GET" | "POST" | "DELETE";

/** Injected inputs for one bounded fetch+decode. All network/clock effects are injectable. */
export interface FetchJsonOptions {
  /** Injectable network boundary; production passes the global `fetch`. */ readonly fetchImpl: FetchLike;
  /** Finite internal timeout in milliseconds composed with any caller signal. */ readonly timeoutMs: number;
  /** Optional caller cancellation composed with the internal timeout. */ readonly signal?: AbortSignal;
  /** Hard decoded-body byte bound enforced before JSON parsing. */ readonly maxBytes: number;
  /** Optional additional request headers merged with `accept: application/json`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Request method; defaults to `GET`. Only the dark AM writes pass `POST`/`DELETE`. */
  readonly method?: FetchMethod;
  /** Optional pre-serialized request body for write methods. */ readonly body?: string;
  /**
   * When true, a 2xx response with an empty (whitespace-only) body resolves success with
   * `null` data instead of `malformed-json`. Only the dark AM `expireSilence` DELETE — whose
   * success response carries no JSON body — sets this; every read leaves it unset.
   */
  readonly allowEmptyBody?: boolean;
}

/**
 * Thrown by {@link normalizeBaseUrl} when a configured source base URL is not an absolute,
 * credential-free HTTP(S) URL. The message is the fixed {@link CONFIG_ERROR_MESSAGES}`.invalidUrl`
 * catalog text and never echoes the offending URL, so the failure classifies safely.
 */
export class SourceConfigError extends Error {
  constructor() {
    super(CONFIG_ERROR_MESSAGES.invalidUrl);
    this.name = "SourceConfigError";
  }
}

/** Build a bounded failure result carrying the exact catalog message for `kind`. */
export function sourceFailure(kind: SourceErrorKind, status: number | null = null): SourceResult<never> {
  const error: SourceError = { kind, message: SOURCE_ERROR_MESSAGES[kind], status };
  return { ok: false, error };
}

/** Build a success result wrapping a fully validated value. */
export function sourceSuccess<T>(data: T): SourceResult<T> {
  return { ok: true, data };
}

/**
 * Validate and normalize a configured source base URL. Accepts only absolute HTTP(S) URLs,
 * rejects any embedded credentials (user info), drops query/fragment, and strips a single
 * trailing slash. Returns the normalized base string (origin plus path prefix, no trailing
 * slash). Throws {@link SourceConfigError} — never echoing the input — on any violation.
 */
export function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SourceConfigError();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SourceConfigError();
  if (parsed.username !== "" || parsed.password !== "") throw new SourceConfigError();
  const base = `${parsed.origin}${parsed.pathname}`;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

/**
 * Issue one bounded request and decode a JSON body from `unknown`, resolving a
 * {@link SourceResult}. Composes `options.signal` with an internal finite timeout, streams the
 * body while counting bytes, aborts and returns `incompatible` on overflow, and maps every
 * failure to the exact bounded {@link SourceError}. Normal failures never reject; only a
 * programming error (e.g. a thrown injected `fetchImpl` unrelated to abort) surfaces as
 * `transport`.
 */
export async function fetchJsonUnknown(
  url: URL,
  options: FetchJsonOptions,
): Promise<SourceResult<unknown>> {
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let overBudget = false;

  const onCallerAbort = (): void => {
    callerAborted = true;
    controller.abort();
  };

  // A caller signal already aborted before we start is a caller cancellation.
  if (options.signal) {
    if (options.signal.aborted) callerAborted = true;
    else options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    if (callerAborted) return sourceFailure("transport");

    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    const init: RequestInit = { method: options.method ?? "GET", headers, signal: controller.signal };
    if (options.body !== undefined) init.body = options.body;

    let response: Response;
    try {
      response = await options.fetchImpl(url, init);
    } catch {
      // Any fetch-time rejection: distinguish deadline abort from caller/transport abort.
      if (timedOut) return sourceFailure("timeout");
      return sourceFailure("transport");
    }

    if (!response.ok) return sourceFailure("upstream-status", response.status);

    // Stream and count bytes, enforcing the bound before any JSON parse. Never call an
    // unbounded `response.text()`/`response.json()` first.
    const decoded = await readBounded(response, options.maxBytes, controller, () => {
      overBudget = true;
    });
    if (decoded === null) {
      if (overBudget) return sourceFailure("incompatible");
      if (timedOut) return sourceFailure("timeout");
      return sourceFailure("transport");
    }

    if (options.allowEmptyBody === true && decoded.trim() === "") return sourceSuccess(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      return sourceFailure("malformed-json", response.status);
    }
    return sourceSuccess(parsed);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Read `response` into a UTF-8 string while enforcing `maxBytes`. Aborts `controller` and
 * invokes `onOverflow` when the bound is exceeded, returning `null`. Returns `null` on any
 * read failure (aborted stream, transport error); the caller classifies the cause.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
  controller: AbortController,
  onOverflow: () => void,
): Promise<string | null> {
  const body = response.body;
  if (!body) {
    // No stream available (some mocks): read the buffer, then enforce the bound post-hoc.
    try {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        onOverflow();
        return null;
      }
      return new TextDecoder("utf-8").decode(buffer);
    } catch {
      return null;
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        onOverflow();
        controller.abort();
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(combined);
}
