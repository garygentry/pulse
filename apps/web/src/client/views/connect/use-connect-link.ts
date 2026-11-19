// apps/web/src/client/views/connect/use-connect-link.ts — data hook for the connect screen: fetch the
// server's configured connect link, or fall back to the address being browsed.
import { useCallback, useEffect, useState } from "react";
import { buildConnectLink, type ConnectLinkRefusal } from "@pulse/web-data/contract";
import { CLIENT_TRANSPORT_MESSAGES, type ApiError, type ClientFetchErrorCode } from "@pulse/web-data/wire";

import type { ConnectLinkPayload, ExternalUrlSoftRefusal } from "../../../shared/connect-link.js";
import { apiFetch } from "../../api/client.js";

/** The path of the web-only connect-link route. */
export const CONNECT_LINK_PATH = "/api/connect-link" as const;

/** Where a usable link's address came from. */
export type ConnectLinkOrigin = "configured" | "browsing";

/** Screen state. Exactly one arm holds at a time. */
export type ConnectLinkState =
  | {
      /** The request is in flight. */
      readonly kind: "loading";
    }
  | {
      /** A link can be shown. */
      readonly kind: "usable";
      /** Full pulse://connect link. */
      readonly link: string;
      /** Normalised base the link points at. */
      readonly baseUrl: string;
      /** Where the address came from. */
      readonly source: ConnectLinkOrigin;
    }
  | {
      /** No link: the address cannot be used by a phone. */
      readonly kind: "refused";
      /** Why the address was refused. */
      readonly reason: ConnectLinkRefusal;
      /** "config": PULSE_WEB_EXTERNAL_URL refused; "browsing": location.origin refused. */
      readonly cause: "config" | "browsing";
    }
  | {
      /** The request failed or its body was unusable. */
      readonly kind: "error";
      /** Bounded catalog error from apiFetch, or RESPONSE_INVALID from validation. */
      readonly error: ApiError<ClientFetchErrorCode>;
    };

const LINK_PREFIX = "pulse://connect?";
const ENV_VAR = "PULSE_WEB_EXTERNAL_URL";
const SOFT_REFUSALS: readonly ExternalUrlSoftRefusal[] = ["not-https", "loopback", "too-long"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` has exactly the own keys `a` and `b`. */
function hasExactKeys(value: Record<string, unknown>, a: string, b: string): boolean {
  return Object.keys(value).length === 2 && Object.hasOwn(value, a) && Object.hasOwn(value, b);
}

/**
 * Strictly validate a `/api/connect-link` body. Returns null for anything but the exact shape: exactly the keys
 * `configured` and `refusal`, at most one of them non-null, `configured.link` starting with "pulse://connect?",
 * `refusal.reason` in "not-https" | "loopback" | "too-long" and `refusal.envVar` equal to
 * "PULSE_WEB_EXTERNAL_URL". Pure; never throws.
 */
export function parseConnectLinkPayload(value: unknown): ConnectLinkPayload | null {
  if (!isPlainObject(value) || !hasExactKeys(value, "configured", "refusal")) return null;
  const { configured, refusal } = value;
  if (configured !== null && refusal !== null) return null;

  if (configured !== null) {
    if (!isPlainObject(configured) || !hasExactKeys(configured, "link", "baseUrl")) return null;
    const { link, baseUrl } = configured;
    if (typeof link !== "string" || !link.startsWith(LINK_PREFIX)) return null;
    if (typeof baseUrl !== "string" || baseUrl === "") return null;
    return { configured: { link, baseUrl }, refusal: null };
  }

  if (refusal !== null) {
    if (!isPlainObject(refusal) || !hasExactKeys(refusal, "reason", "envVar")) return null;
    const reason = SOFT_REFUSALS.find((known) => known === refusal["reason"]);
    if (reason === undefined || refusal["envVar"] !== ENV_VAR) return null;
    return { configured: null, refusal: { reason, envVar: ENV_VAR } };
  }

  return { configured: null, refusal: null };
}

/**
 * Map a payload plus the browsing origin to a terminal state. Pure, so it is unit-tested without fetch.
 * - `configured` set: usable, source "configured".
 * - `refusal` set: refused, cause "config" (a refused configured address never falls back to the browsing one).
 * - both null: `buildConnectLink(origin)`. ok gives usable/"browsing"; otherwise refused/"browsing" with the refusal.
 */
export function resolveConnectLinkState(
  payload: ConnectLinkPayload,
  origin: string,
): Exclude<ConnectLinkState, { kind: "loading" | "error" }> {
  if (payload.configured !== null) {
    return { kind: "usable", link: payload.configured.link, baseUrl: payload.configured.baseUrl, source: "configured" };
  }
  if (payload.refusal !== null) return { kind: "refused", reason: payload.refusal.reason, cause: "config" };
  const built = buildConnectLink(origin);
  if (built.ok) return { kind: "usable", link: built.link, baseUrl: built.baseUrl, source: "browsing" };
  return { kind: "refused", reason: built.refusal, cause: "browsing" };
}

const LOADING: ConnectLinkState = { kind: "loading" };

/**
 * Fetch once on mount, then hold a terminal state. Aborts the request on unmount (an aborted call's
 * result is dropped, not shown). `retry()` returns to loading and refetches. Reads no store signals, so
 * callers need no useSignals() for it. `fetchImpl` defaults to `fetch` and `origin` to
 * `window.location.origin`; both are parameters so tests can inject them.
 */
export function useConnectLink(
  fetchImpl?: typeof fetch,
  origin?: string,
): { readonly state: ConnectLinkState; readonly retry: () => void } {
  const [state, setState] = useState<ConnectLinkState>(LOADING);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<unknown>(CONNECT_LINK_PATH, { signal: controller.signal }, fetchImpl).then((result) => {
      if (controller.signal.aborted) return;
      if (result.status === "error") {
        setState({ kind: "error", error: result.error });
        return;
      }
      const payload = result.status === "ok" ? parseConnectLinkPayload(result.value) : null;
      if (payload === null) {
        setState({
          kind: "error",
          error: { code: "RESPONSE_INVALID", message: CLIENT_TRANSPORT_MESSAGES.RESPONSE_INVALID },
        });
        return;
      }
      setState(resolveConnectLinkState(payload, origin ?? window.location.origin));
    });
    return () => controller.abort();
  }, [attempt, fetchImpl, origin]);

  const retry = useCallback(() => {
    setState(LOADING);
    setAttempt((n) => n + 1);
  }, []);

  return { state, retry };
}
