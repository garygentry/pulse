// mutations/session.ts — lazy /api/session loader (REQ-AUTHZ-04, REQ-SEC-06).
import type { SessionPayload } from "@pulse/web-data/wire";
import type { AppStore } from "../store/index.js";
import type { SessionState } from "../store/types.js";
import type { MutationClientError } from "./client.js";

/** One in-flight load per store (memo). A failed load is evicted so a later mount retries. */
const MEMO = new WeakMap<AppStore, Promise<void>>();

/** Refusals that mean the session view is stale, so it is re-fetched. */
export const SESSION_REFRESH_REASONS: ReadonlySet<MutationClientError["reason"]> =
  new Set<MutationClientError["reason"]>(["capability-false", "untrusted-identity", "write-path-degraded"]);

/**
 * Map the wire payload to store state. Identity → displayName ONLY: `subject` and `source` never
 * enter client state (REQ-SEC-06). Capabilities are copied as explicit booleans (deny by default).
 */
export function toSessionState(p: SessionPayload): SessionState {
  return {
    identity: p.identity === null ? null : p.identity.displayName,
    authMode: p.authMode,
    capabilities: {
      silence: p.capabilities.silence === true,
      ack: p.capabilities.ack === true,
      proposeEstateEdit: p.capabilities.proposeEstateEdit === true,
    },
  };
}

/** Minimal runtime shape check; anything else leaves store.session untouched (deny). */
function isSessionPayload(v: unknown): v is SessionPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const caps = o["capabilities"];
  return typeof o["authMode"] === "string" && typeof caps === "object" && caps !== null && "identity" in o;
}

async function load(store: AppStore, fetchImpl: typeof fetch, replace: boolean): Promise<void> {
  const res = await fetchImpl("/api/session", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`session ${res.status}`);
  const body: unknown = await res.json();
  if (!isSessionPayload(body)) throw new Error("session shape");
  // A value set while the fetch was in flight (e.g. by a test) wins unless this is a refresh.
  if (replace || store.session.peek() === null) store.session.value = toSessionState(body);
}

/**
 * Memoized one-shot GET /api/session → store.session, ONLY when it is null: an already-seeded
 * session (e.g. one a DOM test installed) is never overwritten.
 * Never throws. On failure the session stays null (canAct false), and the memo is evicted so a later
 * mount retries once. There is no retry loop.
 */
export function ensureSession(store: AppStore, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (store.session.peek() !== null) return Promise.resolve();
  const hit = MEMO.get(store);
  if (hit !== undefined) return hit;
  const p = load(store, fetchImpl, false).catch(() => {
    MEMO.delete(store);
  });
  MEMO.set(store, p);
  return p;
}

/**
 * Re-fetch and REPLACE store.session. Call it only after a SESSION_REFRESH_REASONS refusal
 * On failure the old value is kept; the server re-checks every request (AUTHZ-03).
 */
export function refreshSession(store: AppStore, fetchImpl: typeof fetch = fetch): Promise<void> {
  const p = load(store, fetchImpl, true).catch(() => undefined);
  MEMO.set(store, p);
  return p;
}
