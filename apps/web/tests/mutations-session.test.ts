// mutations-session.test.ts — lazy /api/session loader (09 §3.1; 02 constraint: never overwrite a
// seeded store.session). Every fetch is a stub passed through `fetchImpl`; no real network.
import { describe, expect, test } from "bun:test";
import type { SessionPayload } from "@pulse/web-data/wire";
import {
  SESSION_REFRESH_REASONS,
  ensureSession,
  refreshSession,
  toSessionState,
} from "../src/client/mutations/session.js";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import type { SessionState } from "../src/client/store/types.js";

const PAYLOAD: SessionPayload = {
  identity: { subject: "gary-subject", displayName: "Gary Gentry", source: "proxy-header" },
  authMode: "proxy-header",
  capabilities: { silence: true, ack: true, proposeEstateEdit: false },
};

const SEEDED: SessionState = {
  identity: "Seeded User",
  authMode: "proxy-header",
  capabilities: { silence: false, ack: true, proposeEstateEdit: false },
};

function freshStore(): AppStore {
  return createAppStore({ storage: null, initialQuery: {} });
}

/** A counting stub fetch; each call awaits `gate` (if any) before answering with `respond()`. */
function stubFetch(respond: () => Response, gate?: Promise<void>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (gate !== undefined) await gate;
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("toSessionState (REQ-SEC-06)", () => {
  test("drops subject/source — only displayName reaches state; caps copied as explicit booleans", () => {
    const state = toSessionState(PAYLOAD);
    expect(state).toEqual({
      identity: "Gary Gentry",
      authMode: "proxy-header",
      capabilities: { silence: true, ack: true, proposeEstateEdit: false },
    });
    const text = JSON.stringify(state);
    expect(text).not.toContain("gary-subject");
    expect(text).not.toContain("source");
  });

  test("null identity stays null; non-boolean caps become false (deny by default)", () => {
    const state = toSessionState({
      identity: null,
      authMode: "none",
      capabilities: { silence: 1, ack: "true", proposeEstateEdit: true } as unknown as SessionPayload["capabilities"],
    });
    expect(state.identity).toBeNull();
    expect(state.capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: true });
  });
});

describe("ensureSession (REQ-AUTHZ-04, 02 no-overwrite constraint)", () => {
  test("does not fetch and does not overwrite when store.session is non-null", async () => {
    const store = freshStore();
    store.session.value = SEEDED;
    const { fetchImpl, urls } = stubFetch(() => Response.json(PAYLOAD));
    await ensureSession(store, fetchImpl);
    expect(urls).toHaveLength(0);
    expect(store.session.value).toBe(SEEDED);
  });

  test("fetches /api/session exactly once for concurrent calls when null (memo)", async () => {
    const store = freshStore();
    const gate = Promise.withResolvers<void>();
    const { fetchImpl, urls } = stubFetch(() => Response.json(PAYLOAD), gate.promise);
    const a = ensureSession(store, fetchImpl);
    const b = ensureSession(store, fetchImpl);
    expect(b).toBe(a);
    gate.resolve();
    await Promise.all([a, b]);
    expect(urls).toEqual(["/api/session"]);
    expect(store.session.value).toEqual(toSessionState(PAYLOAD));
    // Loaded: later calls short-circuit on the non-null value.
    await ensureSession(store, fetchImpl);
    expect(urls).toHaveLength(1);
  });

  test("a value seeded while the fetch is in flight wins over the loaded payload", async () => {
    const store = freshStore();
    const gate = Promise.withResolvers<void>();
    const { fetchImpl } = stubFetch(() => Response.json(PAYLOAD), gate.promise);
    const p = ensureSession(store, fetchImpl);
    store.session.value = SEEDED;
    gate.resolve();
    await p;
    expect(store.session.value).toBe(SEEDED);
  });

  test("a failed load leaves session null, never throws, and a later call retries", async () => {
    const store = freshStore();
    const failing = stubFetch(() => new Response("nope", { status: 500 }));
    await expect(ensureSession(store, failing.fetchImpl)).resolves.toBeUndefined();
    expect(store.session.value).toBeNull();
    expect(failing.urls).toHaveLength(1);

    const thrown = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    await expect(ensureSession(store, thrown)).resolves.toBeUndefined();
    expect(store.session.value).toBeNull();

    const shape = stubFetch(() => Response.json({ authMode: "none" }));
    await ensureSession(store, shape.fetchImpl);
    expect(shape.urls).toHaveLength(1);
    expect(store.session.value).toBeNull();

    const ok = stubFetch(() => Response.json(PAYLOAD));
    await ensureSession(store, ok.fetchImpl);
    expect(ok.urls).toHaveLength(1);
    expect(store.session.value).toEqual(toSessionState(PAYLOAD));
  });

  test("the memo is per store", async () => {
    const { fetchImpl, urls } = stubFetch(() => Response.json(PAYLOAD));
    await Promise.all([ensureSession(freshStore(), fetchImpl), ensureSession(freshStore(), fetchImpl)]);
    expect(urls).toHaveLength(2);
  });
});

describe("refreshSession (REQ-AUTHZ-04)", () => {
  test("replaces an existing value", async () => {
    const store = freshStore();
    store.session.value = SEEDED;
    const { fetchImpl, urls } = stubFetch(() => Response.json(PAYLOAD));
    await refreshSession(store, fetchImpl);
    expect(urls).toEqual(["/api/session"]);
    expect(store.session.value).toEqual(toSessionState(PAYLOAD));
  });

  test("keeps the old value on failure and never throws", async () => {
    const store = freshStore();
    store.session.value = SEEDED;
    const { fetchImpl } = stubFetch(() => new Response("x", { status: 503 }));
    await expect(refreshSession(store, fetchImpl)).resolves.toBeUndefined();
    expect(store.session.value).toBe(SEEDED);
  });

  test("SESSION_REFRESH_REASONS is exactly capability-false, untrusted-identity, write-path-degraded", () => {
    expect([...SESSION_REFRESH_REASONS].sort()).toEqual([
      "capability-false",
      "untrusted-identity",
      "write-path-degraded",
    ]);
  });
});
