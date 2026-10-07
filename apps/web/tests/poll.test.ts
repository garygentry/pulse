// apps/web/tests/poll.test.ts — the snapshot poll loop (06-client-ui.md §5, REQ-LIVE-05/06). Uses an
// injected fetch + reload (no network, no real reload) and a tiny interval so the setTimeout chain
// runs many cycles in a short window. Asserts: exactly one reload on an appVersion change, scheduling
// stops afterwards, and the loop retains exactly ONE snapshot (replace, never accumulate).

import { describe, expect, test } from "bun:test";

import { startPolling, type PollState } from "../src/client/poll.js";
import { overviewSnapshot } from "./factories.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** An injectable fetch that returns one `OverviewSnapshot` per call, driven by a caller-supplied
 *  sequence of appVersions (the last entry repeats once the sequence is exhausted). Records call count. */
function sequencedFetch(versions: string[]): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async (): Promise<Response> => {
    const version = versions[Math.min(calls, versions.length - 1)] ?? "v";
    calls += 1;
    return new Response(JSON.stringify(overviewSnapshot({ appVersion: version })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe("startPolling", () => {
  test("fires exactly one reload on an appVersion change and then stops scheduling", async () => {
    // Three polls at "v1" (initial version captured on the first), then "v2" trips the reload.
    const { fetchImpl, calls } = sequencedFetch(["v1", "v1", "v1", "v2", "v2", "v2"]);
    let reloadCount = 0;

    const controller = startPolling({ fetchImpl, intervalMs: 2, reload: () => (reloadCount += 1) });
    await sleep(80);
    const callsAtReload = calls();
    // Give the loop plenty more time — it must NOT keep polling after the reload.
    await sleep(60);
    controller.stop();

    expect(reloadCount).toBe(1);
    // Scheduling stopped at the version-skew tick: no further fetches after the reload.
    expect(calls()).toBe(callsAtReload);
  });

  test("retains exactly one snapshot across many polls (replace, never accumulate)", async () => {
    // A stable version so the loop keeps polling (no reload); every poll REPLACES the snapshot.
    const { fetchImpl } = sequencedFetch(["v1"]);
    let reloadCount = 0;

    const states: PollState[] = [];
    const controller = startPolling({ fetchImpl, intervalMs: 2, reload: () => (reloadCount += 1) });
    const unsubscribe = controller.subscribe((s) => states.push(s));

    await sleep(60);
    controller.stop();
    unsubscribe();

    expect(reloadCount).toBe(0);
    // Many successful polls happened...
    const liveStates = states.filter((s) => s.phase === "live");
    expect(liveStates.length).toBeGreaterThan(2);

    // ...yet each emitted state carries a single `snapshot` object (no array, no growing history).
    for (const s of liveStates) {
      expect(s.snapshot).not.toBeNull();
      expect(Array.isArray(s.snapshot)).toBe(false);
    }
    // Consecutive polls REPLACE the snapshot (distinct object references, previous is discarded).
    expect(liveStates[0]!.snapshot).not.toBe(liveStates[1]!.snapshot);

    // The controller holds only the latest state — `getState().snapshot` is one object, the last one.
    const final = controller.getState();
    expect(final.snapshot).toBe(liveStates[liveStates.length - 1]!.snapshot);
  });

  test("failure retains the last good snapshot and raises appStale after the stale window", async () => {
    // Succeed once, then fail every subsequent poll.
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(overviewSnapshot({ appVersion: "v1" })), { status: 200 });
      }
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const controller = startPolling({ fetchImpl, intervalMs: 2, staleMs: 15, reload: () => {} });
    await sleep(80);
    const state = controller.getState();
    controller.stop();

    // Last good snapshot is retained (never blanked — REQ-LIVE-03) while the app server is down.
    expect(state.snapshot).not.toBeNull();
    expect(state.appStale).toBe(true);
    expect(state.phase).toBe("stale");
    expect(state.failingSince).not.toBeNull();
  });

  test("self-heals: after a failing run, a subsequent success resumes live rendering (REQ-LIVE-06)", async () => {
    // Fail every poll until `succeed` flips, then serve a snapshot — drives fail, fail, …, success.
    let succeed = false;
    const fetchImpl = (async (): Promise<Response> => {
      if (!succeed) throw new Error("network down");
      return new Response(JSON.stringify(overviewSnapshot({ appVersion: "v1" })), { status: 200 });
    }) as unknown as typeof fetch;

    const controller = startPolling({ fetchImpl, intervalMs: 2, staleMs: 10, reload: () => {} });

    // Fail long enough to raise the stale banner (no prior success → nothing retained).
    await sleep(40);
    const down = controller.getState();
    expect(down.appStale).toBe(true);
    expect(down.phase).toBe("stale");
    expect(down.snapshot).toBeNull();

    // Recovery: the next fetch succeeds → the fresh snapshot installs and the failure flags clear.
    succeed = true;
    await sleep(30);
    const healed = controller.getState();
    controller.stop();

    expect(healed.phase).toBe("live");
    expect(healed.appStale).toBe(false);
    expect(healed.failingSince).toBeNull();
    expect(healed.snapshot).not.toBeNull();
    expect(healed.snapshot!.appVersion).toBe("v1");
  });
});
