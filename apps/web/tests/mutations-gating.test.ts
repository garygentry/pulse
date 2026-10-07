// mutations-gating.test.ts — capability × density × kiosk truth table for canAct (09 §3.2; 00 §10.3).
import { describe, expect, test } from "bun:test";
import { canAct } from "../src/client/mutations/gating.js";
import type { ClientCapability } from "../src/client/mutations/gating.js";
import { createAppStore } from "../src/client/store/index.js";
import type { Density } from "../src/client/store/types.js";

const CAPS: readonly ClientCapability[] = ["silence", "ack", "proposeEstateEdit"];

/** Capability states: absent session, absent key, false, a truthy non-boolean, and true. */
const CAP_STATES = ["no-session", "absent", "false", "truthy-non-boolean", "true"] as const;
type CapState = (typeof CAP_STATES)[number];
const DENSITIES: readonly Density[] = ["desk", "wallboard"];
const KIOSK: readonly (string | null)[] = [null, "0", "1"];

function storeFor(cap: ClientCapability, state: CapState, density: Density, kiosk: string | null) {
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.density.value = density;
  store.route.value = { ...store.route.value, query: kiosk === null ? {} : { kiosk } };
  if (state !== "no-session") {
    const caps: Record<string, boolean> = {};
    if (state === "false") caps[cap] = false;
    if (state === "true") caps[cap] = true;
    if (state === "truthy-non-boolean") (caps as Record<string, unknown>)[cap] = 1;
    store.session.value = { identity: "Operator", authMode: "proxy-header", capabilities: caps };
  }
  return store;
}

describe("canAct truth table: capability × density × kiosk (REQ-AUTHZ-04, REQ-AUTHZ-05)", () => {
  for (const cap of CAPS) {
    for (const state of CAP_STATES) {
      for (const density of DENSITIES) {
        for (const kiosk of KIOSK) {
          const expected = state === "true" && density === "desk" && kiosk !== "1";
          test(`${cap} / ${state} / ${density} / kiosk=${kiosk ?? "unset"} → ${expected}`, () => {
            expect(canAct(storeFor(cap, state, density, kiosk), cap)).toBe(expected);
          });
        }
      }
    }
  }

  test("only desk density + no kiosk=1 + capability === true returns true (REQ-AUTHZ-04, REQ-AUTHZ-05)", () => {
    let trues = 0;
    for (const cap of CAPS)
      for (const state of CAP_STATES)
        for (const density of DENSITIES)
          for (const kiosk of KIOSK) if (canAct(storeFor(cap, state, density, kiosk), cap)) trues += 1;
    // Per capability: state "true" × desk × kiosk ∈ {unset, "0"} = 2 rows.
    expect(trues).toBe(CAPS.length * 2);
  });

  test("one capability being true never grants another (REQ-AUTHZ-04)", () => {
    const store = storeFor("silence", "true", "desk", null);
    expect(canAct(store, "silence")).toBe(true);
    expect(canAct(store, "ack")).toBe(false);
    expect(canAct(store, "proposeEstateEdit")).toBe(false);
  });
});
