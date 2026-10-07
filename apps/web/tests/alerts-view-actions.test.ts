// apps/web/tests/alerts-view-actions.test.ts — capability-gated action-slot seam (04 §8,
// REQ-ACTION-01..04, REQ-SEC-01, CON-06; mutation-foundation 02 §5, REQ-COMPAT-01, REQ-AUTHZ-04/05). DOM blocks use describeDom (tests/dom.ts), happy-dom per file.

import { afterEach, describe, expect, test } from "bun:test";

import type { ActiveAlert } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { canAct } from "../src/client/mutations/gating.js";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import type { SessionState } from "../src/client/store/types.js";
import { ackActionGate } from "../src/client/views/alerts/actions/ack.js";
import { silenceActionGate } from "../src/client/views/alerts/actions/silence.js";
import { ACTION_SLOTS } from "../src/client/views/alerts/constants.js";
import { firingRows } from "../src/client/views/alerts/model.js";
import { describeDom } from "./dom.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload, makeSession } from "./alerts-fixtures.js";

const payload = makeAlertsPayload({ scenario: "mixed" });
const alert: ActiveAlert = (() => {
  const a = firingRows(payload).find((x) => x.fingerprint === FIXTURE_FINGERPRINTS.hostDown);
  if (a === undefined) throw new Error("fixture alert hostDown missing");
  return a;
})();

/** A store seeded with the M1 session (all capabilities false), optionally overriding caps. */
function seededStore(caps: Readonly<Record<string, boolean>> = {}): AppStore {
  const s = makeSession();
  const session: SessionState = {
    identity: null,
    authMode: s.authMode,
    capabilities: { ...s.capabilities, ...caps },
  };
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.session.value = session;
  return store;
}

describe("canAct — deny by default; never on wallboard or kiosk (REQ-AUTHZ-04/05)", () => {
  test("all-false or absent session denies every slot", () => {
    for (const store of [seededStore(), createAppStore({ storage: null, initialQuery: {} })]) {
      for (const name of ACTION_SLOTS) expect(canAct(store, name)).toBe(false);
    }
  });
  test("only an explicit true on desk density grants", () => {
    const store = seededStore({ silence: true });
    store.density.value = "desk";
    expect(canAct(store, "silence")).toBe(true);
    expect(canAct(store, "ack")).toBe(false);
    store.session.value = { identity: null, authMode: "proxy-header", capabilities: { silence: 1 } as unknown as Record<string, boolean> };
    expect(canAct(store, "silence")).toBe(false);
  });
  test("a missing capability key is denied; a truthy non-boolean is not a grant", () => {
    const store = seededStore();
    store.density.value = "desk";
    store.session.value = { identity: null, authMode: "proxy-header", capabilities: {} };
    for (const name of ACTION_SLOTS) expect(canAct(store, name)).toBe(false);
    store.session.value = {
      identity: null,
      authMode: "proxy-header",
      capabilities: { silence: 1, ack: "yes" } as unknown as Record<string, boolean>,
    };
    for (const name of ACTION_SLOTS) expect(canAct(store, name)).toBe(false);
  });
  test("a true capability is denied on wallboard density and under ?kiosk=1", () => {
    const wall = seededStore({ silence: true, ack: true });
    wall.density.value = "wallboard";
    const kiosk = seededStore({ silence: true, ack: true });
    kiosk.density.value = "desk";
    kiosk.route.value = { ...kiosk.route.value, query: { kiosk: "1" } };
    for (const store of [wall, kiosk]) for (const name of ACTION_SLOTS) expect(canAct(store, name)).toBe(false);
  });
});

describe("slot gates render nothing when the capability is false (REQ-COMPAT-01)", () => {
  test("the silence and ack gates return null for an all-false or absent session", () => {
    for (const store of [seededStore(), createAppStore({ storage: null, initialQuery: {} })]) {
      expect(silenceActionGate({ alert, store })).toBeNull();
      expect(ackActionGate({ alert, store })).toBeNull();
    }
  });
});

describe("slot gates are hook-free outer gates (REQ-AUTHZ-04)", () => {
  test("called as plain functions with a true desk capability they return a vnode, never calling hooks", () => {
    const store = seededStore({ silence: true, ack: true });
    store.density.value = "desk";
    expect(silenceActionGate({ alert, store })).not.toBeNull();
    expect(ackActionGate({ alert, store })).not.toBeNull();
    store.density.value = "wallboard";
    expect(silenceActionGate({ alert, store })).toBeNull();
    expect(ackActionGate({ alert, store })).toBeNull();
  });
});

// ActionSlots' mount effect calls ensureSession, which fetches /api/session only when store.session is
// null. Every DOM test runs against a counting stub so no real network request is ever made.
const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
function stubSessionFetch(): void {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

describeDom("ActionSlots", (dom) => {
  // Unmount earlier mounts first so their deferred (after-paint) effects never reach a later stub.
  const mounted: (() => void)[] = [];
  async function mountSlots(store: AppStore, a: ActiveAlert = alert): Promise<HTMLElement> {
    for (const u of mounted.splice(0)) u();
    stubSessionFetch();
    const { createElement: h } = await import("react");
    const { ActionSlots } = await import("../src/client/views/alerts/detail/ActionSlots.js");
    const { container, unmount } = await dom.mount(h(ActionSlots, { store, alert: a }) as unknown as ReactElement);
    mounted.push(unmount);
    return container;
  }

  function assertEmptySlot(c: HTMLElement, name: string): void {
    const region = c.querySelector(`[data-action-slot="${name}"]`);
    expect(region).not.toBeNull();
    // Each slot sits inside the "Actions" region (a Section named by its h3).
    const section = region?.closest("section[aria-labelledby]");
    const heading = section ? c.querySelector(`#${section.getAttribute("aria-labelledby")}`) : null;
    expect(heading?.tagName).toBe("H3");
    expect(heading?.textContent).toBe("Actions");
    expect(region?.querySelectorAll("button, a, input").length).toBe(0);
    expect(region?.childElementCount).toBe(0);
    expect((region?.textContent ?? "").trim()).toBe("");
  }

  test("with M1 all-false capabilities both seam regions exist and render no affordance", async () => {
    const c = await mountSlots(seededStore());
    const regions = [...c.querySelectorAll("[data-action-slot]")].map((e) => e.getAttribute("data-action-slot"));
    expect(regions).toEqual(["silence", "ack"]);
    assertEmptySlot(c, "silence");
    assertEmptySlot(c, "ack");
    expect(c.querySelectorAll("button, a, input").length).toBe(0);
    // A plain note (never a disabled control) says nothing is available.
    expect(c.querySelector("[data-actions-none]")?.textContent).toBe("No actions are available in this session.");
  });

  test("regions are emitted even with no session (deny-by-default)", async () => {
    const c = await mountSlots(createAppStore({ storage: null, initialQuery: {} }));
    assertEmptySlot(c, "silence");
    assertEmptySlot(c, "ack");
  });

  test("a true capability on wallboard or ?kiosk=1 renders no affordance (REQ-AUTHZ-05)", async () => {
    const wall = seededStore({ silence: true, ack: true });
    wall.density.value = "wallboard";
    const kiosk = seededStore({ silence: true, ack: true });
    kiosk.route.value = { ...kiosk.route.value, query: { kiosk: "1" } };
    for (const store of [wall, kiosk]) {
      const c = await mountSlots(store);
      assertEmptySlot(c, "silence");
      assertEmptySlot(c, "ack");
    }
  });

  test("on desk with silence/ack true the slots render 'Silence…' and 'Acknowledge…' (REQ-SIL-01, REQ-ACK-01, REQ-AUTHZ-04)", async () => {
    const store = seededStore({ silence: true, ack: true });
    store.density.value = "desk";
    const c = await mountSlots(store);
    const silence = c.querySelector('[data-action-slot="silence"]')!;
    const ack = c.querySelector('[data-action-slot="ack"]')!;
    expect([...silence.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Silence…"]);
    expect([...ack.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Acknowledge…"]);
    // A false capability never renders a disabled control (REQ-AUTHZ-04).
    for (const b of c.querySelectorAll("button")) expect(b.hasAttribute("disabled")).toBe(false);
  });

  test("only the granted slot renders its affordance (REQ-AUTHZ-04)", async () => {
    const store = seededStore({ ack: true });
    store.density.value = "desk";
    const c = await mountSlots(store);
    assertEmptySlot(c, "silence");
    expect(c.querySelector('[data-action-slot="ack"] button')?.textContent?.trim()).toBe("Acknowledge…");
    expect(c.querySelector("[data-actions-none]")).toBeNull();
  });

  test("an acked alert offers 'Update acknowledgement…' (REQ-ACK-01)", async () => {
    const store = seededStore({ ack: true });
    store.density.value = "desk";
    const acked: ActiveAlert = { ...alert, ack: { by: "Gary Gentry", at: "2026-09-22T12:00:00.000Z", note: null } };
    const container = await mountSlots(store, acked);
    expect(container.querySelector('[data-action-slot="ack"] button')?.textContent?.trim()).toBe("Update acknowledgement…");
  });

  test("a session that arrives after mount, or a density switch, re-renders the slots (REQ-AUTHZ-04/05)", async () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    store.density.value = "desk";
    const c = await mountSlots(store);
    assertEmptySlot(c, "silence");
    store.session.value = seededStore({ silence: true, ack: true }).session.value;
    await new Promise((r) => setTimeout(r, 20));
    expect(c.querySelector('[data-action-slot="silence"] button')?.textContent?.trim()).toBe("Silence…");
    expect(c.querySelector('[data-action-slot="ack"] button')?.textContent?.trim()).toBe("Acknowledge…");
    store.density.value = "wallboard";
    await new Promise((r) => setTimeout(r, 20));
    assertEmptySlot(c, "silence");
    assertEmptySlot(c, "ack");
  });

  test("with a seeded session the mount effect's ensureSession performs no fetch (REQ-AUTHZ-04)", async () => {
    const store = seededStore({ silence: true, ack: true });
    store.density.value = "desk";
    const before = store.session.value;
    await mountSlots(store);
    await new Promise((r) => setTimeout(r, 150)); // let the mount effect run
    expect(fetchCalls).toEqual([]);
    expect(store.session.value).toBe(before);
  });

  test("with no session the mount effect loads /api/session once, and a failed load stays deny-by-default", async () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const c = await mountSlots(store);
    await new Promise((r) => setTimeout(r, 150)); // let the mount effect run
    expect(fetchCalls).toEqual(["/api/session"]);
    expect(store.session.value).toBeNull();
    assertEmptySlot(c, "silence");
    assertEmptySlot(c, "ack");
  });
});
