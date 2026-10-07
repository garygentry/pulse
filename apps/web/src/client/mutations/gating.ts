// mutations/gating.ts — the client-side capability gate (REQ-AUTHZ-04/05).
import type { SessionPayload } from "@pulse/web-data/wire";
import type { AppStore } from "../store/index.js";

/**
 * Capability key, derived from the wire payload. This is equivalent to the server's `CapabilityName`,
 * which lives in server code the client may not import.
 */
export type ClientCapability = keyof SessionPayload["capabilities"]; // "silence" | "ack" | "proposeEstateEdit"

/**
 * Deny-by-default gate (REQ-AUTHZ-04/05). True only when ALL hold:
 * density !== "wallboard", route query kiosk !== "1", and session capability === true.
 * Reading the signals in render subscribes the caller. `false` ⇒ the caller renders NOTHING,
 * never a disabled control.
 */
export function canAct(store: AppStore, cap: ClientCapability): boolean {
  if (store.density.value === "wallboard") return false; // types.ts Density; forced under ?kiosk=1 (store/index.ts)
  if (store.route.value.query["kiosk"] === "1") return false; // route-level kiosk (belt and braces)
  return store.session.value?.capabilities[cap] === true;
}
