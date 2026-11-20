// APNs HTTP/2 client: request, result, classification and dependency types, the fixed origins and the client
// itself (one lazily opened HTTP/2 session per environment).

import http2 from "node:http2";

import type { PushEnvironment } from "@pulse/web-data/wire";
import { log } from "../../log.js";
import type { ApnsSettings } from "../config.js";
import { PUSH_LIMITS } from "../constants.js";
import type { Timers } from "../dispatch/queue.js";
import type { Clock } from "../ids.js";
import type { ProviderTokenSigner } from "./jwt.js";

/** Built request: headers + serialised body (≤ 4096 bytes). */
export interface ApnsRequest {
  /** HTTP/2 request headers. */
  readonly headers: {
    /** Always "alert". */
    readonly "apns-push-type": "alert";
    /** The configured bundle id (`APNS_TOPIC_PATTERN`). */
    readonly "apns-topic": string;
    /** "10" for immediate delivery, "5" for power-considerate delivery. */
    readonly "apns-priority": "10" | "5";
    /** APNs expiration, epoch seconds as a decimal string. */
    readonly "apns-expiration": string;
    /** Collapse id; absent for a test notification. */
    readonly "apns-collapse-id"?: string;
  };
  /** UTF-8 JSON of the PushPayload. */
  readonly body: Uint8Array;
}

/** Raw result of one APNs request. */
export type ApnsResult =
  | {
      /** APNs answered. */
      readonly kind: "response";
      /** HTTP status APNs returned. */
      readonly status: number;
      /** Raw `reason` from the JSON error body; `null` for an empty, non-JSON or reason-less body. */
      readonly reason: string | null;
    }
  | {
      /** No usable answer arrived. */
      readonly kind: "error";
      /** Request timeout, connection failure, or HTTP/2 session failure. */
      readonly error: "timeout" | "connection" | "session";
    };

/** Classification of an ApnsResult: what the queue or test send does next. */
export type ApnsClassification =
  | {
      /** APNs accepted the request. */
      readonly kind: "delivered";
    }
  | {
      /** Retry with backoff until the deadline. */
      readonly kind: "transient";
      /** Sanitised reason. */
      readonly reason: string;
    }
  | {
      /** Fail without retry. */
      readonly kind: "permanent";
      /** Sanitised reason. */
      readonly reason: string;
    }
  | {
      /** The token is dead; the device is removed. */
      readonly kind: "dead-token";
      /** Sanitised reason; "Unregistered" when APNs gave none. */
      readonly reason: string;
    }
  | {
      /** Re-sign the provider JWT and resend (403 ExpiredProviderToken). */
      readonly kind: "auth-expired";
    }
  | {
      /** Provider authentication failed (403 Invalid/MissingProviderToken); not retried. */
      readonly kind: "auth-failed";
      /** Sanitised reason. */
      readonly reason: string;
    };

/** Test/override seam. Production uses the fixed APNs origins and the system CA. */
export interface ApnsDeps {
  /** HTTPS origin per APNs environment. */
  readonly origins: Readonly<Record<PushEnvironment, string>>;
  /** Extra trusted CA (tests); absent uses the system CA. */
  readonly ca?: string | Buffer;
  /** Time source for JWT refresh and timeouts. */
  readonly clock: Clock;
  /** Timer source for timeouts, pings and idle close. */
  readonly timers: Timers;
}

/** An APNs HTTP/2 client with one session per environment. */
export interface ApnsClient {
  /** Send one request to `deviceToken` (`APNS_TOKEN_PATTERN`); never rejects, failures are `kind: "error"`. */
  send(environment: PushEnvironment, deviceToken: string, request: ApnsRequest): Promise<ApnsResult>;
  /** Close every HTTP/2 session. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------------------------------------------

/**
 * Apple's push service origins. This module is the ONLY place in the repository where these hostnames are written.
 * Docs and examples say "Apple's production push service" and "Apple's sandbox push service" instead.
 * No environment variable can override these. Only `ApnsDeps.origins` can, and only tests set it (the fake APNs).
 */
export const APNS_ORIGINS: Readonly<Record<PushEnvironment, string>> = Object.freeze({
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
});

/**
 * Test-only observation hooks. Production passes none. They are kept separate from `ApnsDeps` so the shared
 * dependency type stays unchanged.
 */
export interface ApnsClientHooks {
  /**
   * Called once per HTTP/2 request, synchronously after `stream.end(body)` has handed the request to the session.
   * This is the "written to the stream" instant the delivery-latency measurement uses. It is also called for the
   * ExpiredProviderToken retry.
   *
   * @param environment - The session the request went to.
   * @param deviceToken - The APNs token in the `:path`. A test hook only; production never logs it.
   * @param atMs - `deps.clock.nowMs()` at the write.
   */
  readonly onRequestWritten?: (environment: PushEnvironment, deviceToken: string, atMs: number) => void;
}

/** Upper bound on an error body read from Apple. Apple's bodies are about 30 bytes; the rest is discarded. */
const MAX_RESPONSE_BODY_BYTES = 4096;

/** How long close() waits for sessions to emit "close" before destroying them. */
const CLOSE_GRACE_MS = 1_000;

const SESSION_ERROR: ApnsResult = Object.freeze({ kind: "error", error: "session" });
const CONNECTION_ERROR: ApnsResult = Object.freeze({ kind: "error", error: "connection" });
const TIMEOUT_ERROR: ApnsResult = Object.freeze({ kind: "error", error: "timeout" });

interface PendingRequest {
  /** Settle the caller's promise exactly once. Later calls are ignored. */
  settle(result: ApnsResult): void;
  /** The open stream, or null before `session.request` returned. */
  stream: http2.ClientHttp2Stream | null;
}

interface SessionSlot {
  readonly environment: PushEnvironment;
  readonly session: http2.ClientHttp2Session;
  /** Requests on this session with no result yet. */
  readonly inFlight: Set<PendingRequest>;
  /** True once the TLS + SETTINGS handshake completed ("connect" event). */
  connected: boolean;
  /** True once the session emitted "close". */
  closed: boolean;
  /** Ping interval handle, or null once cleared. */
  pingHandle: unknown;
  /** Idle-close handle, armed while `inFlight` is empty. */
  idleHandle: unknown;
  /** Resolvers waiting for this session's "close" event (close()). */
  readonly closeWaiters: Array<() => void>;
}

/** Extract `reason` from an APNs JSON error body. Returns null for an empty or non-JSON body or a non-string reason. */
function parseReason(body: Uint8Array): string | null {
  if (body.byteLength === 0) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(body));
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { reason?: unknown }).reason === "string") {
      return (parsed as { reason: string }).reason;
    }
    return null;
  } catch {
    return null;
  }
}

/** Unref a timer handle when the runtime supports it, so an idle gateway never keeps the process alive. */
function unrefHandle(handle: unknown): unknown {
  try {
    (handle as { unref?: () => void } | null)?.unref?.();
  } catch {
    // Opaque handles (fake timers) have nothing to unref.
  }
  return handle;
}

/**
 * Create the APNs client. It holds at most one HTTP/2 session per environment, opened lazily on the first send.
 *
 * `send` never rejects and never throws. Every failure is an `ApnsResult` of kind `"error"`.
 *
 * @param settings - Validated APNs settings. Only `settings.topic` is read here. It is written as `apns-topic`
 *   and overrides `request.headers["apns-topic"]` (both always hold the same value).
 * @param signer - Provider-token signer, shared with the queues and the test send.
 * @param deps - Origins, optional CA override (fake APNs), clock and timers.
 * @param hooks - Optional test hooks.
 */
export function createApnsClient(
  settings: ApnsSettings,
  signer: ProviderTokenSigner,
  deps: ApnsDeps,
  hooks?: ApnsClientHooks,
): ApnsClient {
  const slots = new Map<PushEnvironment, SessionSlot>();
  /** Every slot whose session has not emitted "close" yet, current or detached (close() waits for them). */
  const live = new Set<SessionSlot>();
  let closed = false;
  let closing: Promise<void> | null = null;
  let internalErrorLogged = false;

  function logInternalOnce(): void {
    if (internalErrorLogged) return;
    internalErrorLogged = true;
    log({ event: "push_internal_error", ok: false, route: "apns" });
  }

  function clearTimers(slot: SessionSlot): void {
    if (slot.pingHandle !== null) {
      deps.timers.clearInterval(slot.pingHandle);
      slot.pingHandle = null;
    }
    if (slot.idleHandle !== null) {
      deps.timers.clearTimeout(slot.idleHandle);
      slot.idleHandle = null;
    }
  }

  /** Remove `slot` from the map if it is still current. Idempotent; never touches a newer slot. */
  function detach(slot: SessionSlot): void {
    if (slots.get(slot.environment) === slot) slots.delete(slot.environment);
  }

  function settleAll(slot: SessionSlot, result: ApnsResult): void {
    for (const pending of [...slot.inFlight]) pending.settle(result);
  }

  function destroySession(slot: SessionSlot): void {
    try {
      slot.session.destroy();
    } catch {
      // Already destroyed.
    }
  }

  function closeSessionGracefully(slot: SessionSlot): void {
    try {
      slot.session.close();
    } catch {
      destroySession(slot);
    }
  }

  function armIdle(slot: SessionSlot): void {
    if (slot.idleHandle !== null || slot.closed || slots.get(slot.environment) !== slot) return;
    slot.idleHandle = unrefHandle(
      deps.timers.setTimeout(() => {
        slot.idleHandle = null;
        if (slot.inFlight.size > 0) return;
        detach(slot);
        clearTimers(slot);
        closeSessionGracefully(slot);
      }, PUSH_LIMITS.apnsIdleCloseMs),
    );
  }

  function openSlot(environment: PushEnvironment): SessionSlot {
    const ca = deps["ca"];
    const session = http2.connect(deps.origins[environment], ca === undefined ? {} : { ca });
    const slot: SessionSlot = {
      environment,
      session,
      inFlight: new Set(),
      connected: false,
      closed: false,
      pingHandle: null,
      idleHandle: null,
      closeWaiters: [],
    };
    live.add(slot);
    session.on("connect", () => {
      slot.connected = true;
    });
    session.on("goaway", () => {
      // Streams Apple already accepted finish normally; refused ones end with a stream error. Let the session
      // drain and close by itself, but never send on it again.
      detach(slot);
      clearTimers(slot);
      if (slot.inFlight.size === 0) closeSessionGracefully(slot);
    });
    session.on("error", () => {
      detach(slot);
      settleAll(slot, slot.connected ? SESSION_ERROR : CONNECTION_ERROR);
      destroySession(slot);
    });
    session.on("close", () => {
      detach(slot);
      slot.closed = true;
      settleAll(slot, slot.connected ? SESSION_ERROR : CONNECTION_ERROR);
      clearTimers(slot);
      live.delete(slot);
      for (const resolve of slot.closeWaiters.splice(0)) resolve();
    });
    slot.pingHandle = unrefHandle(
      deps.timers.setInterval(() => {
        if (slots.get(environment) !== slot || slot.closed) return;
        try {
          slot.session.ping((err) => {
            if (err) destroySession(slot);
          });
        } catch {
          destroySession(slot);
        }
      }, PUSH_LIMITS.apnsPingIntervalMs),
    );
    slots.set(environment, slot);
    return slot;
  }

  function currentSlot(environment: PushEnvironment): SessionSlot {
    const existing = slots.get(environment);
    if (existing !== undefined && !existing.closed && !existing.session.closed && !existing.session.destroyed) {
      return existing;
    }
    if (existing !== undefined) detach(existing);
    return openSlot(environment);
  }

  /** One wire request (steps 3–10). Never rejects. */
  function attempt(environment: PushEnvironment, deviceToken: string, request: ApnsRequest): Promise<ApnsResult> {
    let jwt: string;
    try {
      jwt = signer.current();
    } catch {
      logInternalOnce();
      return Promise.resolve(SESSION_ERROR);
    }

    return new Promise<ApnsResult>((resolve) => {
      let slot: SessionSlot | null = null;
      let timeoutHandle: unknown = null;
      let done = false;
      const pending: PendingRequest = {
        stream: null,
        settle(result) {
          if (done) return;
          done = true;
          if (timeoutHandle !== null) {
            deps.timers.clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          if (slot !== null) {
            slot.inFlight.delete(pending);
            if (slot.inFlight.size === 0) armIdle(slot);
          }
          resolve(result);
        },
      };

      try {
        slot = currentSlot(environment);
        const s = slot;
        if (s.idleHandle !== null) {
          deps.timers.clearTimeout(s.idleHandle);
          s.idleHandle = null;
        }
        s.inFlight.add(pending);

        const headers: http2.OutgoingHttpHeaders = {
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          ":scheme": "https",
          authorization: `bearer ${jwt}`,
          "content-type": "application/json",
          ...request.headers,
          "apns-topic": settings.topic,
        };

        let stream: http2.ClientHttp2Stream;
        try {
          stream = s.session.request(headers);
        } catch {
          detach(s);
          clearTimers(s);
          pending.settle(SESSION_ERROR);
          destroySession(s);
          return;
        }
        pending.stream = stream;
        const failure = (): ApnsResult => (s.connected ? SESSION_ERROR : CONNECTION_ERROR);

        timeoutHandle = unrefHandle(
          deps.timers.setTimeout(() => {
            timeoutHandle = null;
            try {
              stream.close(http2.constants.NGHTTP2_CANCEL);
            } catch {
              // The stream is already gone; the timeout result still stands.
            }
            pending.settle(TIMEOUT_ERROR);
          }, PUSH_LIMITS.apnsRequestTimeoutMs),
        );

        let status: number | null = null;
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        stream.on("response", (h) => {
          const value = Number(h[":status"]);
          status = Number.isFinite(value) ? value : null;
        });
        stream.on("data", (chunk: Buffer | string) => {
          if (bytes >= MAX_RESPONSE_BODY_BYTES) return;
          const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
          const take = buf.subarray(0, MAX_RESPONSE_BODY_BYTES - bytes);
          chunks.push(take);
          bytes += take.byteLength;
        });
        const finish = (): void => {
          if (status === null) {
            pending.settle(failure());
            return;
          }
          const body = Buffer.concat(chunks, bytes);
          pending.settle({ kind: "response", status, reason: chunks.length === 0 ? null : parseReason(body) });
        };
        stream.on("end", finish);
        stream.on("error", () => {
          if (status === null) pending.settle(failure());
          else pending.settle({ kind: "response", status, reason: null });
        });
        stream.on("close", () => {
          if (status === null) pending.settle(failure());
          else pending.settle({ kind: "response", status, reason: null });
        });

        stream.end(request.body);
        hooks?.onRequestWritten?.(environment, deviceToken, deps.clock.nowMs());
      } catch {
        logInternalOnce();
        pending.settle(SESSION_ERROR);
      }
    });
  }

  async function send(environment: PushEnvironment, deviceToken: string, request: ApnsRequest): Promise<ApnsResult> {
    try {
      if (closed) return SESSION_ERROR;
      const first = await attempt(environment, deviceToken, request);
      if (first.kind === "response" && first.status === 403 && first.reason === "ExpiredProviderToken" && !closed) {
        signer.invalidate();
        return await attempt(environment, deviceToken, request);
      }
      return first;
    } catch {
      logInternalOnce();
      return SESSION_ERROR;
    }
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      closed = true;
      const all = [...live];
      slots.clear();
      const waits = all.map(
        (slot) =>
          new Promise<void>((resolve) => {
            if (slot.closed) resolve();
            else slot.closeWaiters.push(resolve);
          }),
      );
      for (const slot of all) {
        clearTimers(slot);
        for (const pending of [...slot.inFlight]) {
          try {
            pending.stream?.close(http2.constants.NGHTTP2_CANCEL);
          } catch {
            // Already closed.
          }
          pending.settle(SESSION_ERROR);
        }
        closeSessionGracefully(slot);
      }
      if (waits.length === 0) return;
      let graceHandle: unknown = null;
      await Promise.race([
        Promise.all(waits),
        new Promise<void>((resolve) => {
          graceHandle = unrefHandle(
            deps.timers.setTimeout(() => {
              graceHandle = null;
              for (const slot of all) if (!slot.closed) destroySession(slot);
              resolve();
            }, CLOSE_GRACE_MS),
          );
        }),
      ]);
      if (graceHandle !== null) deps.timers.clearTimeout(graceHandle);
    })().catch(() => {
      logInternalOnce();
    });
    return closing;
  }

  return Object.freeze({ send, close });
}
