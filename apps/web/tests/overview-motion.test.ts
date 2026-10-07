// apps/web/tests/overview-motion.test.ts — status-change marker tracker + hook (03 §6, 08 §4.3;
// REQ-MOTION-01..02, REQ-GROUP-04). Marker expiry runs on a fake timer queue installed on
// globalThis; effects flush through React's `act`, so no case waits on the wall clock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement, StrictMode, type JSX } from "react";
import { act } from "./react-render.js";

import type { TargetStatus } from "@pulse/web-data/wire";
import type { ChangeTracker, StatusChange } from "../src/client/views/overview/model.js";
import {
  STATUS_CHANGE_MARKER_WINDOW_MS,
  changeMarkerAttribute,
  createChangeTracker,
  useStatusChangeMarker,
} from "../src/client/views/overview/grid/change-marker.js";
import { describeDom } from "./dom.js";

describe("createChangeTracker (pure)", () => {
  test("marker window is 1200 ms", () => {
    expect(STATUS_CHANGE_MARKER_WINDOW_MS).toBe(1_200);
  });

  test("first observation of an id is inert", () => {
    const tracker = createChangeTracker();
    expect(tracker.observe("host:a", "ok", false)).toBeNull();
    expect(tracker.observe("host:b", "critical", true)).toBeNull();
  });

  test("an accepted transition marks only the changed id", () => {
    const tracker = createChangeTracker();
    tracker.observe("host:a", "ok", false);
    tracker.observe("host:b", "ok", false);
    tracker.observe("svc:a/api", "warning", false);

    expect(tracker.observe("host:a", "ok", false)).toBeNull();
    expect(tracker.observe("host:b", "critical", false)).toEqual({
      drilldownId: "host:b",
      previous: "ok",
      current: "critical",
      marker: "animated",
    });
    expect(tracker.observe("svc:a/api", "warning", false)).toBeNull();
    // The transition is consumed: observing the new status again is not a second change.
    expect(tracker.observe("host:b", "critical", false)).toBeNull();
  });

  test("reorder (any observation order) with unchanged statuses marks nothing", () => {
    const tracker = createChangeTracker();
    const ids = ["host:a", "host:b", "host:c", "host:d"];
    const statuses: readonly TargetStatus[] = ["ok", "warning", "critical", "unknown"];
    ids.forEach((id, i) => tracker.observe(id, statuses[i]!, false));
    // Group/sort/page reorder = the same (id, status) pairs observed in a different order.
    for (const i of [3, 1, 0, 2, 2, 0]) {
      expect(tracker.observe(ids[i]!, statuses[i]!, false)).toBeNull();
    }
  });

  test("retain() forgets removed ids so their next observation re-seeds", () => {
    const tracker = createChangeTracker();
    tracker.observe("host:a", "ok", false);
    tracker.observe("host:b", "ok", false);
    tracker.retain(new Set(["host:b"]));
    expect(tracker.observe("host:a", "critical", false)).toBeNull();
    expect(tracker.observe("host:b", "critical", false)?.drilldownId).toBe("host:b");
  });

  test("clear() forgets every id and is idempotent", () => {
    const tracker = createChangeTracker();
    tracker.observe("host:a", "ok", false);
    tracker.clear();
    tracker.clear();
    expect(tracker.observe("host:a", "critical", false)).toBeNull();
  });

  test("reduced motion yields a static marker; normal yields animated", () => {
    const tracker = createChangeTracker();
    tracker.observe("host:a", "ok", true);
    expect(tracker.observe("host:a", "warning", true)?.marker).toBe("static");
    expect(tracker.observe("host:a", "critical", false)?.marker).toBe("animated");
  });

  test("changeMarkerAttribute exposes the marker kind as the data-changed value, or nothing", () => {
    const tracker = createChangeTracker();
    expect(changeMarkerAttribute(null)).toBeUndefined();
    tracker.observe("host:a", "ok", false);
    tracker.observe("host:b", "ok", true);
    expect(changeMarkerAttribute(tracker.observe("host:a", "critical", false))).toBe("animated");
    expect(changeMarkerAttribute(tracker.observe("host:b", "critical", true))).toBe("static");
  });

  test("the returned change is frozen", () => {
    const tracker = createChangeTracker();
    tracker.observe("host:a", "ok", false);
    expect(Object.isFrozen(tracker.observe("host:a", "suppressed", false))).toBe(true);
  });
});

/** Fake timer queue swapped onto globalThis for one test; `advance` fires due callbacks. */
interface FakeTimers {
  advance(ms: number): void;
  pending(): number;
  restore(): void;
}

function installFakeTimers(): FakeTimers {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    const id = nextId++;
    queue.set(id, { at: now + ms, fn });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    queue.delete(id);
  }) as unknown as typeof clearTimeout;
  return {
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at > now) continue;
        queue.delete(id);
        entry.fn();
      }
    },
    pending: () => queue.size,
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

interface ProbeProps {
  tracker: ChangeTracker;
  id: string;
  status: TargetStatus;
  reducedMotion: boolean;
}

function Probe({ tracker, id, status, reducedMotion }: ProbeProps): JSX.Element {
  const change: StatusChange | null = useStatusChangeMarker(tracker, id, status, reducedMotion);
  return createElement("div", {
    "data-target-id": id,
    "data-status": status,
    "data-marker": change?.marker ?? "none",
  });
}

describeDom("useStatusChangeMarker", (dom) => {
  let timers: FakeTimers;
  let container: HTMLElement;

  beforeEach(() => {
    timers = installFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    const { render } = await import("./react-render.js");
    act(() => {
      render(null, container as unknown as Element);
    });
    container.remove();
    timers.restore();
  });

  /** Render a list of probes (in the given order) and flush effects synchronously. */
  async function renderProbes(probes: readonly ProbeProps[]): Promise<void> {
    const { render } = await import("./react-render.js");
    act(() => {
      render(
        createElement(
          "div",
          null,
          probes.map((p) => createElement(Probe, { ...p, key: p.id })),
        ),
        container as unknown as Element,
      );
    });
  }

  function markers(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const el of container.querySelectorAll("[data-target-id]")) {
      out[el.getAttribute("data-target-id")!] = el.getAttribute("data-marker")!;
    }
    return out;
  }

  function probes(
    tracker: ChangeTracker,
    statuses: Record<string, TargetStatus>,
    reducedMotion = false,
  ): ProbeProps[] {
    return Object.entries(statuses).map(([id, status]) => ({ tracker, id, status, reducedMotion }));
  }

  test("first render is inert", async () => {
    expect(dom.win).toBeDefined();
    const tracker = createChangeTracker();
    await renderProbes(probes(tracker, { "host:a": "ok", "host:b": "warning" }));
    expect(markers()).toEqual({ "host:a": "none", "host:b": "none" });
    expect(timers.pending()).toBe(0);
  });

  test("a real transition marks only the changed id, then expires after the window", async () => {
    const tracker = createChangeTracker();
    await renderProbes(probes(tracker, { "host:a": "ok", "host:b": "ok", "host:c": "ok" }));
    await renderProbes(probes(tracker, { "host:a": "ok", "host:b": "critical", "host:c": "ok" }));
    expect(markers()).toEqual({ "host:a": "none", "host:b": "animated", "host:c": "none" });
    expect(timers.pending()).toBe(1);

    act(() => timers.advance(STATUS_CHANGE_MARKER_WINDOW_MS - 1));
    expect(markers()["host:b"]).toBe("animated");
    act(() => timers.advance(1));
    expect(markers()["host:b"]).toBe("none");
    expect(timers.pending()).toBe(0);
  });

  test("reorder with the same statuses marks nothing", async () => {
    const tracker = createChangeTracker();
    const initial = probes(tracker, { "host:a": "ok", "host:b": "warning", "host:c": "critical" });
    await renderProbes(initial);
    await renderProbes([...initial].reverse());
    await renderProbes([initial[1]!, initial[2]!, initial[0]!]);
    expect(markers()).toEqual({ "host:a": "none", "host:b": "none", "host:c": "none" });
    expect(timers.pending()).toBe(0);
  });

  test("a StrictMode mount over a changed status never leaves a marker without its timer", async () => {
    const { render } = await import("./react-render.js");
    const tracker = createChangeTracker();
    tracker.observe("host:a", "ok", false); // seen while unmounted (collapsed group, other page)
    act(() => {
      render(
        createElement(StrictMode, null, createElement(Probe, { tracker, id: "host:a", status: "critical", reducedMotion: false })),
        container as unknown as Element,
      );
    });
    act(() => timers.advance(STATUS_CHANGE_MARKER_WINDOW_MS));
    expect(markers()).toEqual({ "host:a": "none" });
    expect(timers.pending()).toBe(0);
  });

  test("remount with the same status marks nothing", async () => {
    const tracker = createChangeTracker();
    const statuses = { "host:a": "ok", "host:b": "warning" } as const;
    await renderProbes(probes(tracker, statuses));
    await renderProbes([]); // unmount every probe (e.g. collapse or kiosk page move)
    await renderProbes(probes(tracker, statuses));
    expect(markers()).toEqual({ "host:a": "none", "host:b": "none" });
  });

  test("ids forgotten by retain() re-seed on their next render", async () => {
    const tracker = createChangeTracker();
    await renderProbes(probes(tracker, { "host:a": "ok", "host:b": "ok" }));
    await renderProbes(probes(tracker, { "host:b": "ok" }));
    tracker.retain(new Set(["host:b"]));
    await renderProbes(probes(tracker, { "host:a": "critical", "host:b": "critical" }));
    expect(markers()).toEqual({ "host:a": "none", "host:b": "animated" });
  });

  test("reduced motion yields a static marker for the same bounded window", async () => {
    const tracker = createChangeTracker();
    await renderProbes(probes(tracker, { "host:a": "ok" }, true));
    await renderProbes(probes(tracker, { "host:a": "warning" }, true));
    expect(markers()["host:a"]).toBe("static");
    act(() => timers.advance(STATUS_CHANGE_MARKER_WINDOW_MS));
    expect(markers()["host:a"]).toBe("none");
  });

  test("a second transition restarts the window and cancels the prior timer", async () => {
    const tracker = createChangeTracker();
    await renderProbes(probes(tracker, { "host:a": "ok" }));
    await renderProbes(probes(tracker, { "host:a": "warning" }));
    act(() => timers.advance(1_000));
    await renderProbes(probes(tracker, { "host:a": "critical" }));
    expect(timers.pending()).toBe(1);
    act(() => timers.advance(1_000));
    expect(markers()["host:a"]).toBe("animated");
    act(() => timers.advance(STATUS_CHANGE_MARKER_WINDOW_MS - 1_000));
    expect(markers()["host:a"]).toBe("none");
  });

  test("unmount cancels a pending marker timer", async () => {
    const tracker = createChangeTracker();
    await renderProbes(probes(tracker, { "host:a": "ok" }));
    await renderProbes(probes(tracker, { "host:a": "critical" }));
    expect(timers.pending()).toBe(1);
    await renderProbes([]);
    expect(timers.pending()).toBe(0);
  });
});
