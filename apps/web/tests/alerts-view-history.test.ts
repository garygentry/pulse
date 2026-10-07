// apps/web/tests/alerts-view-history.test.ts — on-demand firing-history strip (05, REQ-DETAIL-05..08,
// REQ-PERF-02, CON-09). globalThis.fetch is stubbed per test; DOM blocks use describeDom (tests/dom.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ActiveAlert, AlertHistoryLane, IntervalHistoryPayload } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { buildLanes, deriveDomain, isAlertOwnLane } from "../src/client/views/alerts/detail/history-model.js";
import { firingRows } from "../src/client/views/alerts/model.js";
import { describeDom } from "./dom.js";
import {
  FIXTURE_FINGERPRINTS,
  FIXTURE_NOW,
  makeAlertsPayload,
  makeHistoryOverflow,
  makeHistoryPayload,
} from "./alerts-fixtures.js";

const payload = makeAlertsPayload({ scenario: "mixed" });
function byFp(fp: string): ActiveAlert {
  const a = firingRows(payload).find((x) => x.fingerprint === fp);
  if (a === undefined) throw new Error(`fixture alert ${fp} missing`);
  return a;
}
const hostDown = byFp(FIXTURE_FINGERPRINTS.hostDown);
const diskFull = byFp(FIXTURE_FINGERPRINTS.diskFull);
const loadHigh = byFp(FIXTURE_FINGERPRINTS.loadHigh); // historyRef null
const backupAge = byFp(FIXTURE_FINGERPRINTS.backupAge); // historyRef target service:backup (differs from hostDown)

function lanesOf(p: IntervalHistoryPayload): readonly AlertHistoryLane[] {
  return p.lanes;
}

describe("isAlertOwnLane (canonical tuple, never the fingerprint)", () => {
  const [hostLane, diskLane, unmatched] = lanesOf(makeHistoryPayload({ kind: "unmatched" }));

  test("matches the lane whose (alertname,severity,host,service,instance) tuple equals the alert's", () => {
    expect(isAlertOwnLane(hostDown, hostLane!)).toBe(true);
    expect(isAlertOwnLane(diskFull, diskLane!)).toBe(true);
    expect(isAlertOwnLane(hostDown, diskLane!)).toBe(false);
    // Same alertname + severity but a different host/instance tuple → not this alert's lane.
    expect(isAlertOwnLane(hostDown, unmatched!)).toBe(false);
  });

  test("ignores the Alertmanager fingerprint entirely", () => {
    const churned: ActiveAlert = { ...hostDown, fingerprint: "fp-totally-different" };
    expect(isAlertOwnLane(churned, hostLane!)).toBe(true);
    // A lane id equal to the fingerprint never creates a match on its own.
    const spoof: AlertHistoryLane = { ...diskLane!, id: `sha256:${hostDown.fingerprint}` };
    expect(isAlertOwnLane(hostDown, spoof)).toBe(false);
  });

  test("TargetIdentity must agree when both sides are resolved; tuple suffices otherwise", () => {
    const otherTarget: AlertHistoryLane = { ...hostLane!, target: { kind: "host", id: "web-02" } };
    expect(isAlertOwnLane(hostDown, otherTarget)).toBe(false);
    const laneNoTarget: AlertHistoryLane = { ...hostLane!, target: null };
    expect(isAlertOwnLane(hostDown, laneNoTarget)).toBe(true);
    const alertNoRef: ActiveAlert = { ...hostDown, historyRef: null };
    expect(isAlertOwnLane(alertNoRef, otherTarget)).toBe(true);
  });

  test("History.tsx attribution source never reads alert.fingerprint and takes StatusTimeline from the @/ui barrel", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/client/views/alerts/detail/History.tsx", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/\.fingerprint\b/);
    expect(src).not.toContain("TimeSeriesChart");
    expect(src).not.toMatch(/from "[^"]*\/viz\//);
    expect(src).not.toMatch(/from "[^"]*ui\/kit\.js"/);
    expect(src).not.toMatch(/from "@\/ui\//); // barrel only, never a deep import
    const barrel = src.match(/^import \{([^}]*)\} from "@\/ui";/m);
    expect(barrel?.[1]?.split(",").map((n) => n.trim())).toContain("StatusTimeline");
  });
});

describe("buildLanes / deriveDomain", () => {
  test("includes every lane, own lane first with 'this alert', unmatched last and labeled", () => {
    const p = makeHistoryPayload({ kind: "unmatched" });
    const lanes = buildLanes(p, diskFull);
    expect(lanes.length).toBe(p.lanes.length);
    expect(lanes[0]!.id).toBe(p.lanes[1]!.id);
    expect(lanes[0]!.label).toBe("DiskAlmostFull (this alert)");
    expect(lanes[1]!.label).toBe("HostDown");
    expect(lanes[2]!.label).toBe("HostDown (unmatched)");
    expect(new Set(lanes.map((l) => l.id))).toEqual(new Set(p.lanes.map((l) => l.id)));
  });

  test("segments are numeric epoch ms with INTERVAL_STATUS status", () => {
    const lanes = buildLanes(makeHistoryPayload(), hostDown);
    const seg = lanes[0]!.segments[0]!;
    expect(seg.start).toBe(Date.parse("2026-09-22T02:00:00.000Z"));
    expect(seg.end).toBe(Date.parse("2026-09-22T02:20:00.000Z"));
    expect(seg.status).toBe("critical");
  });

  test("domain prefers [fetchedAt - range, fetchedAt], falls back to lane bounds", () => {
    const p = makeHistoryPayload();
    const end = Date.parse(FIXTURE_NOW);
    expect(deriveDomain(p)).toEqual({ domainStart: end - 24 * 3_600_000, domainEnd: end });
    const bad: IntervalHistoryPayload = { ...p, fetchedAt: "not-a-date" };
    expect(deriveDomain(bad)).toEqual({
      domainStart: Date.parse("2026-09-22T02:00:00.000Z"),
      domainEnd: Date.parse("2026-09-22T12:00:00.000Z"),
    });
  });
});

// ---------------------------------------------------------------------------
// DOM: fetch lifecycle + rendered states
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly signal: AbortSignal | null;
}

const originalFetch = globalThis.fetch;

/** Install a fetch stub; `respond` decides each call's outcome. */
function stubFetch(respond: (call: FetchCall) => Promise<unknown>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), signal: init?.signal ?? null };
    calls.push(call);
    return respond(call).then((body) => ({ json: () => Promise.resolve(body) }));
  }) as unknown as typeof fetch;
  return calls;
}

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The StatusTimeline root (EmptyState icons are also <svg>, so match the strip label). */
const TIMELINE = 'svg[role="img"][aria-label^="Firing history"]';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

describeDom("History", (dom) => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function mountHistory(alert: ActiveAlert): Promise<{ container: HTMLElement; unmount(): void }> {
    const { createElement: h } = await import("react");
    const { History } = await import("../src/client/views/alerts/detail/History.js");
    return dom.mount(h(History, { alert }) as unknown as ReactElement);
  }

  function stateOf(c: HTMLElement): string | null {
    return c.querySelector("[data-history-state]")?.getAttribute("data-history-state") ?? null;
  }

  test("issues exactly one GET /api/history/alerts?range=24h on mount and renders StatusTimeline", async () => {
    const calls = stubFetch(() => Promise.resolve(makeHistoryPayload({ kind: "unmatched" })));
    const { container, unmount } = await mountHistory(hostDown);
    expect(stateOf(container)).toBe("loading");
    expect(container.querySelector('[data-history-state="loading"] [data-slot="skeleton"]')).not.toBeNull();
    const region = container.querySelector("section[aria-labelledby]");
    expect(container.querySelector(`#${region?.getAttribute("aria-labelledby")}`)?.textContent).toBe("Firing history");
    await waitFor(() => stateOf(container) === "ready");
    await settle();
    expect(calls.length).toBe(1);
    expect(container.querySelector('[data-history-state="ready"]')?.getAttribute("data-stale")).toBe("false");
    expect(calls[0]!.url).toBe("/api/history/alerts?range=24h");
    const svg = container.querySelector(TIMELINE);
    expect(svg).not.toBeNull();
    const labels = [...container.querySelectorAll("g[data-lane]")].map((g) => g.getAttribute("aria-label"));
    expect(labels).toEqual(["HostDown (this alert)", "DiskAlmostFull", "HostDown (unmatched)"]);
    expect(container.querySelector('[data-history-note="unmatched"]')).not.toBeNull();
    unmount();
  });

  test("issues no fetch when historyRef is null and renders the no-ref state", async () => {
    const calls = stubFetch(() => Promise.resolve(makeHistoryPayload()));
    const { container, unmount } = await mountHistory(loadHigh);
    await settle();
    expect(calls.length).toBe(0);
    expect(stateOf(container)).toBe("no-ref");
    const empty = container.querySelector('[data-history-state="no-ref"] [data-slot="empty-state"]');
    expect(empty?.getAttribute("role")).toBe("status");
    expect(empty?.textContent).toContain("No history reference");
    expect(container.querySelector(TIMELINE)).toBeNull();
    unmount();
  });

  test("close mid-flight aborts; a slow response that ignores the signal is dropped silently", async () => {
    let release: (v: unknown) => void = () => {};
    const calls = stubFetch(() => new Promise((r) => (release = r)));
    const { container, unmount } = await mountHistory(hostDown);
    await waitFor(() => calls.length === 1);
    unmount();
    expect(calls[0]!.signal?.aborted).toBe(true);
    release(makeHistoryOverflow());
    await settle();
    expect(container.querySelector('[data-history-state="error"]')).toBeNull();
  });

  test("an AbortError rejection is silent (no error state)", async () => {
    const calls = stubFetch(
      (call) =>
        new Promise((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(abortError()));
        }),
    );
    const { createElement: h } = await import("react");
    const { render } = await import("./react-render.js");
    const { History } = await import("../src/client/views/alerts/detail/History.js");
    const { container, unmount } = await mountHistory(hostDown);
    await waitFor(() => calls.length === 1);
    // Re-open with a different historyRef: the prior request is aborted before the next one is issued.
    render(h(History, { alert: backupAge }) as unknown as ReactElement, container as unknown as Element);
    await waitFor(() => calls.length === 2);
    expect(calls[0]!.signal?.aborted).toBe(true);
    await settle();
    expect(stateOf(container)).toBe("loading");
    unmount();
    expect(calls[1]!.signal?.aborted).toBe(true);
  });

  test("a new live cycle (structurally equal but new alert/historyRef objects) neither refetches nor flashes loading", async () => {
    const calls = stubFetch(() => Promise.resolve(makeHistoryPayload({ kind: "unmatched" })));
    const { createElement: h } = await import("react");
    const { render } = await import("./react-render.js");
    const { History } = await import("../src/client/views/alerts/detail/History.js");
    const { container, unmount } = await mountHistory(hostDown);
    await waitFor(() => stateOf(container) === "ready");
    // Simulate live-state replacing the payload: deep-cloned alert => fresh historyRef identity.
    for (let cycle = 0; cycle < 3; cycle++) {
      const next = structuredClone(hostDown) as ActiveAlert;
      expect(next.historyRef).not.toBe(hostDown.historyRef);
      render(h(History, { alert: next }) as unknown as ReactElement, container as unknown as Element);
      expect(stateOf(container)).toBe("ready");
      await settle();
      expect(stateOf(container)).toBe("ready");
    }
    expect(calls.length).toBe(1);
    expect(calls[0]!.signal?.aborted).toBe(false);
    unmount();
  });

  test("changing range or historyRef still refetches; a null historyRef shows no-ref", async () => {
    const calls = stubFetch(() => Promise.resolve(makeHistoryPayload({ kind: "unmatched" })));
    const { createElement: h } = await import("react");
    const { render } = await import("./react-render.js");
    const { History } = await import("../src/client/views/alerts/detail/History.js");
    const { container, unmount } = await mountHistory(hostDown);
    await waitFor(() => stateOf(container) === "ready");
    expect(calls.length).toBe(1);

    render(h(History, { alert: hostDown, range: "6h" }) as unknown as ReactElement, container as unknown as Element);
    await waitFor(() => calls.length === 2);
    expect(calls[1]!.url).toBe("/api/history/alerts?range=6h");
    expect(calls[0]!.signal?.aborted).toBe(true);
    await waitFor(() => stateOf(container) === "ready");

    render(h(History, { alert: backupAge, range: "6h" }) as unknown as ReactElement, container as unknown as Element);
    await waitFor(() => calls.length === 3);
    await waitFor(() => stateOf(container) === "ready");

    render(h(History, { alert: loadHigh, range: "6h" }) as unknown as ReactElement, container as unknown as Element);
    await waitFor(() => stateOf(container) === "no-ref");
    await settle();
    expect(calls.length).toBe(3);
    expect(calls[2]!.signal?.aborted).toBe(true);
    unmount();
  });

  test("a body whose operation is not 'alert-intervals' renders the error state, no StatusTimeline", async () => {
    stubFetch(() => Promise.resolve({ ...makeHistoryPayload(), operation: "endpoint-history" }));
    const { container, unmount } = await mountHistory(hostDown);
    await waitFor(() => stateOf(container) === "error");
    expect(container.querySelector(TIMELINE)).toBeNull();
    unmount();
  });

  test("HISTORY_LIMIT_EXCEEDED renders the distinct 'History unavailable' overflow state, never a partial strip", async () => {
    stubFetch(() => Promise.resolve(makeHistoryOverflow()));
    const { container, unmount } = await mountHistory(hostDown);
    await waitFor(() => stateOf(container) === "error");
    const root = container.querySelector('[data-history-state="error"]');
    expect(root?.getAttribute("data-history-code")).toBe("HISTORY_LIMIT_EXCEEDED");
    expect(root?.textContent ?? "").toContain("History unavailable");
    expect(root?.textContent ?? "").toContain("exceeds the history service's limits");
    expect(container.querySelector(TIMELINE)).toBeNull();
    expect(container.querySelector("g[data-lane]")).toBeNull();
    unmount();
  });

  test("a non-abort network failure becomes NETWORK_ERROR, never a throw", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const { container, unmount } = await mountHistory(hostDown);
    await waitFor(() => stateOf(container) === "error");
    const root = container.querySelector('[data-history-state="error"]');
    expect(root?.getAttribute("data-history-code")).toBe("NETWORK_ERROR");
    expect(root?.textContent ?? "").toContain("could not be loaded");
    expect(root?.querySelector('[data-slot="empty-state"]')).not.toBeNull();
    // The error is announced politely through the shell's live region.
    await waitFor(
      () =>
        document.querySelector('#pulse-a11y-announcer [data-politeness="polite"]')?.textContent ===
        "Alert history is unavailable.",
    );
    unmount();
  });

  test("a valid payload with zero lanes renders 'No firing history'", async () => {
    stubFetch(() => Promise.resolve({ ...makeHistoryPayload(), lanes: [] }));
    const { container, unmount } = await mountHistory(hostDown);
    await waitFor(() => stateOf(container) === "empty");
    expect(container.querySelector('[data-history-state="empty"] [data-slot="empty-state"]')?.textContent ?? "").toContain(
      "No firing history",
    );
    expect(container.querySelector(TIMELINE)).toBeNull();
    unmount();
  });
});
