// apps/web/tests/estate-degrade.test.ts — estate expected-degradation axes (estate-explorer item 006;
// spec 07 §2–§4, 09 §5.5 / §6.2 / §6.3). Wrapped in describeDom so happy-dom is registered per file.

import { expect, test } from "bun:test";
import { createElement } from "react";
import type { ReactNode, ReactElement } from "react";
import type { AvailabilitySection, DataAvailability, EstatePayload } from "@pulse/web-data/wire";

import { mountAnnouncer } from "../src/client/a11y/announcer.js";
import {
  AbsentArtifactState,
  CleanEmptyState,
  StaleNote,
  StalenessNote,
  renderDelivery,
} from "../src/client/views/estate/degrade.js";
import {
  DEFAULT_MODEL_ABSENT_GUIDANCE,
  classifyAvailability,
  toDeliveryState,
} from "../src/client/views/estate/delivery.js";
import type { DeliveryRetry } from "../src/client/views/estate/degrade.js";
import type { EstateDeliveryState } from "../src/client/views/estate/types.js";
import { describeDom } from "./dom.js";

/** toDeliveryState only distinguishes null vs present; a sentinel object is sufficient. */
const PAYLOAD = { generatedAt: "2026-09-22T00:00:00.000Z" } as unknown as EstatePayload;

function availability(state: DataAvailability["state"], over: Partial<DataAvailability> = {}): DataAvailability {
  return { state, source: "rendered-estate", lastGoodAt: null, message: null, ...over };
}

async function waitFor(read: () => string | null, want: string, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (read() === want) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Read the live document via globalThis at call time (see progress.md item 004). */
const liveText = (politeness: "polite" | "assertive"): string | null =>
  (globalThis as { document: Document }).document.querySelector(
    `#pulse-a11y-announcer [aria-live="${politeness}"]`,
  )?.textContent ?? null;

// ── toDeliveryState (07 §2.2 mapping table) ─────────────────────────────────

test("toDeliveryState: phase initial → loading without a payload, ready with one", () => {
  expect(toDeliveryState({ phase: "initial", identity: null }, null)).toEqual({ kind: "loading" });
  expect(toDeliveryState({ phase: "initial", identity: null }, PAYLOAD)).toEqual({ kind: "ready" });
});

test("toDeliveryState: phase current → ready with a payload, model-absent without", () => {
  expect(toDeliveryState({ phase: "current", identity: "h" }, PAYLOAD)).toEqual({ kind: "ready" });
  expect(toDeliveryState({ phase: "current", identity: "h" }, null)).toEqual({
    kind: "model-absent",
    guidance: DEFAULT_MODEL_ABSENT_GUIDANCE,
  });
});

test("toDeliveryState: phase stale → ready", () => {
  expect(toDeliveryState({ phase: "stale", identity: "h" }, PAYLOAD)).toEqual({ kind: "ready" });
  expect(toDeliveryState({ phase: "stale", identity: "h" }, null)).toEqual({ kind: "ready" });
});

test("toDeliveryState: store failure code preserves not-ready/model-absent/error semantics", () => {
  expect(
    toDeliveryState(
      { phase: "initial", identity: null, failure: { code: "NOT_READY", status: 503, message: "warming" } },
      null,
    ),
  ).toEqual({ kind: "not-ready", retryable: true });
  expect(
    toDeliveryState(
      {
        phase: "initial",
        identity: null,
        failure: { code: "ESTATE_BUNDLE_MISSING", status: 503, message: "bundle unavailable" },
      },
      null,
    ),
  ).toEqual({ kind: "model-absent", guidance: DEFAULT_MODEL_ABSENT_GUIDANCE });
  expect(
    toDeliveryState(
      { phase: "initial", identity: null, failure: { code: "INTERNAL_ERROR", status: 503, message: "safe failure" } },
      null,
    ),
  ).toEqual({ kind: "error", message: "safe failure", retryable: true });
});

test("toDeliveryState: status 503 → not-ready; other >= 400 → error with the status in the message", () => {
  expect(toDeliveryState({ status: 503 }, null)).toEqual({ kind: "not-ready", retryable: true });
  expect(toDeliveryState({ status: 503 }, PAYLOAD)).toEqual({ kind: "not-ready", retryable: true });
  expect(toDeliveryState({ status: 500 }, null)).toEqual({
    kind: "error",
    message: "Request failed (500)",
    retryable: true,
  });
  expect(toDeliveryState({ status: 404 }, PAYLOAD)).toMatchObject({ kind: "error", message: "Request failed (404)" });
});

test("toDeliveryState: an already-adapted EstateDeliveryState passes through", () => {
  const states: readonly EstateDeliveryState[] = [
    { kind: "loading" },
    { kind: "ready" },
    { kind: "not-ready", retryable: true },
    { kind: "model-absent", guidance: "configure it" },
    { kind: "error", message: "boom", retryable: true },
  ];
  for (const s of states) expect(toDeliveryState(s, null)).toEqual(s);
});

test("toDeliveryState: null / undefined / unrecognized shapes never map to ready without a payload (I3)", () => {
  const unknowns: readonly unknown[] = [
    null,
    undefined,
    {},
    { phase: "bogus" },
    { kind: "bogus" },
    { status: 200 },
    { status: "503" },
    "ready",
    42,
    true,
    [],
  ];
  for (const raw of unknowns) {
    expect(toDeliveryState(raw, null)).toEqual({ kind: "loading" });
    expect(toDeliveryState(raw, PAYLOAD)).toEqual({ kind: "ready" });
  }
});

test("toDeliveryState: ready is returned only with a real payload unless the raw shape says so explicitly", () => {
  const raws: readonly unknown[] = [null, undefined, {}, { phase: "initial" }, { phase: "current" }, { foo: 1 }];
  for (const raw of raws) expect(toDeliveryState(raw, null).kind).not.toBe("ready");
});

// ── classifyAvailability (07 §3.1) ──────────────────────────────────────────

const isEmptyList = (v: readonly number[]): boolean => v.length === 0;

test("classifyAvailability: null value → absent regardless of availability", () => {
  for (const state of ["current", "stale", "unavailable", "not-configured"] as const) {
    const section: AvailabilitySection<readonly number[]> = { availability: availability(state), value: null };
    expect(classifyAvailability(section, isEmptyList)).toBe("absent");
  }
});

test("classifyAvailability: present-but-not-current → stale, even when empty (never ok — I3)", () => {
  for (const state of ["stale", "unavailable", "not-configured"] as const) {
    expect(classifyAvailability({ availability: availability(state), value: [1, 2] }, isEmptyList)).toBe("stale");
    expect(classifyAvailability({ availability: availability(state), value: [] }, isEmptyList)).toBe("stale");
  }
});

test("classifyAvailability: present-empty-current → empty; present-nonempty-current → ok", () => {
  expect(classifyAvailability({ availability: availability("current"), value: [] }, isEmptyList)).toBe("empty");
  expect(classifyAvailability({ availability: availability("current"), value: [1] }, isEmptyList)).toBe("ok");
});

// ── renderDelivery + components (DOM) ───────────────────────────────────────

describeDom("estate degrade rendering", (dom) => {
  function mount(node: ReactNode): ReturnType<typeof dom.mount> {
    return dom.mount(createElement("div", null, node) as ReactElement);
  }

  test("renderDelivery evaluates the children thunk ONLY when ready", async () => {
    let calls = 0;
    const children = (): ReactNode => {
      calls++;
      return createElement("p", { id: "surface" }, "surfaces");
    };
    const degraded: readonly EstateDeliveryState[] = [
      { kind: "loading" },
      { kind: "not-ready", retryable: true },
      { kind: "model-absent", guidance: DEFAULT_MODEL_ABSENT_GUIDANCE },
      { kind: "error", message: "Request failed (500)", retryable: true },
    ];
    for (const state of degraded) {
      const { container, unmount } = await mount(renderDelivery(state, { children }));
      expect(container.querySelector("#surface")).toBeNull();
      unmount();
    }
    expect(calls).toBe(0);

    const { container, unmount } = await mount(renderDelivery({ kind: "ready" }, { children }));
    expect(calls).toBe(1);
    expect(container.querySelector("#surface")?.textContent).toBe("surfaces");
    expect(container.querySelector("[data-degrade]")).toBeNull();
    unmount();
  });

  test("each degraded delivery state renders a distinct data-degrade with data-status + glyph + text label", async () => {
    const cases: ReadonlyArray<readonly [EstateDeliveryState, string, string, string]> = [
      [{ kind: "loading" }, "loading", "unknown", "Loading the estate"],
      [{ kind: "not-ready", retryable: true }, "not-ready", "unknown", "Estate is still warming up"],
      [{ kind: "model-absent", guidance: DEFAULT_MODEL_ABSENT_GUIDANCE }, "model-absent", "warning", "No rendered estate"],
      [{ kind: "error", message: "Request failed (500)", retryable: true }, "error", "critical", "could not be loaded"],
    ];
    for (const [state, degrade, status, label] of cases) {
      const { container, unmount } = await mount(renderDelivery(state, { children: () => "never" }));
      const region = container.querySelector(`[data-degrade="${degrade}"]`);
      expect(region).not.toBeNull();
      expect(region!.getAttribute("data-status")).toBe(status);
      expect(region!.querySelector("svg")).not.toBeNull();
      expect(region!.textContent).toContain(label);
      expect(container.textContent).not.toContain("never");
      expect(container.textContent?.toLowerCase()).not.toContain("covered");
      unmount();
    }
  });

  test("loading is aria-busy; model-absent shows guidance and no retry; error shows its message", async () => {
    const loading = await mount(renderDelivery({ kind: "loading" }, { children: () => null }));
    const loadingRegion = loading.container.querySelector('[data-degrade="loading"]')!;
    expect(loadingRegion.getAttribute("aria-busy")).toBe("true");
    expect(loadingRegion.getAttribute("aria-label")).toBe("Loading the estate");
    loading.unmount();

    const absent = await mount(
      renderDelivery({ kind: "model-absent", guidance: DEFAULT_MODEL_ABSENT_GUIDANCE }, { children: () => null, onRetry: () => {} }),
    );
    expect(absent.container.textContent).toContain(DEFAULT_MODEL_ABSENT_GUIDANCE);
    expect(absent.container.querySelector("button")).toBeNull();
    absent.unmount();

    const error = await mount(
      renderDelivery({ kind: "error", message: "Request failed (502)", retryable: true }, { children: () => null }),
    );
    expect(error.container.textContent).toContain("Request failed (502)");
    error.unmount();
  });

  test("not-ready and error render a retry control only when onRetry is provided, and it invokes the seam", async () => {
    for (const state of [
      { kind: "not-ready", retryable: true },
      { kind: "error", message: "Request failed (500)", retryable: true },
    ] as const) {
      const without = await mount(renderDelivery(state, { children: () => null }));
      expect(without.container.querySelector("button")).toBeNull();
      without.unmount();

      let retries = 0;
      const onRetry: DeliveryRetry = () => {
        retries++;
      };
      const withRetry = await mount(renderDelivery(state, { children: () => null, onRetry }));
      const buttons = Array.from(withRetry.container.querySelectorAll("button"));
      expect(buttons.length).toBe(1);
      const button = buttons[0]!;
      expect(button.getAttribute("type")).toBe("button");
      expect(button.textContent?.trim()).toBe("Retry");
      button.click();
      expect(retries).toBe(1);
      withRetry.unmount();
    }
  });

  test("the error state is announced assertively once, by its role=alert region", async () => {
    mountAnnouncer();
    const { container, unmount } = await mount(
      renderDelivery({ kind: "error", message: "Request failed (500)", retryable: true }, { children: () => null }),
    );
    const alert = container.querySelector('[data-degrade="error"] [role="alert"]');
    expect(alert?.textContent).toContain("The estate could not be loaded");
    // No second, duplicate assertive announcement through the shared announcer.
    await new Promise((r) => setTimeout(r, 50));
    expect(liveText("assertive")).not.toBe("The estate could not be loaded.");
    unmount();
  });

  test("AbsentArtifactState and CleanEmptyState are textually distinguishable (REQ-DEG-02)", async () => {
    const absent = await mount(createElement(AbsentArtifactState, { artifact: "Findings", reason: "Tree predates findings" }));
    const absentText = absent.container.textContent ?? "";
    const absentRegion = absent.container.querySelector('[data-degrade="absent"]');
    expect(absentRegion).not.toBeNull();
    expect(absentRegion!.querySelector("svg")).not.toBeNull();
    expect(absentText).toContain("re-render to populate");
    expect(absentText).toContain("Tree predates findings");
    absent.unmount();

    const absentNoReason = await mount(createElement(AbsentArtifactState, { artifact: "Coverage", reason: null }));
    expect(absentNoReason.container.textContent).toContain("Re-render to populate");
    absentNoReason.unmount();

    const clean = await mount(createElement(CleanEmptyState, { title: "No findings", description: "Nothing to report." }));
    const cleanText = clean.container.textContent ?? "";
    const cleanRegion = clean.container.querySelector('[data-degrade="clean"]');
    expect(cleanRegion).not.toBeNull();
    expect(cleanRegion!.getAttribute("data-status")).toBe("ok");
    expect(cleanRegion!.querySelector("svg")).not.toBeNull();
    expect(cleanText).toContain("No findings");
    expect(cleanText).not.toContain("re-render");
    expect(cleanText).not.toBe(absentText);
    clean.unmount();
  });

  test("StaleNote renders role=status with message + lastGoodAt and announces politely", async () => {
    expect(StalenessNote).toBe(StaleNote);
    mountAnnouncer();
    const avail = availability("stale", { message: "Render is 2 cycles old", lastGoodAt: "2026-09-21T12:00:00.000Z" });
    const { container, unmount } = await mount(createElement(StaleNote, { availability: avail }));
    const note = container.querySelector('[role="status"][data-availability]');
    expect(note).not.toBeNull();
    expect(note!.getAttribute("data-availability")).toBe("stale");
    expect(note!.getAttribute("data-status")).toBe("warning");
    expect(note!.querySelector("svg")).not.toBeNull();
    expect(note!.textContent).toContain("Data may be out of date");
    expect(note!.querySelector("[data-stale-message]")?.textContent).toBe("Render is 2 cycles old");
    expect(note!.querySelector("[data-stale-last-good]")?.textContent).toBe("Last good: 2026-09-21T12:00:00.000Z");
    expect(note!.querySelector("time")?.getAttribute("datetime")).toBe("2026-09-21T12:00:00.000Z");

    const want = "Data may be out of date: Render is 2 cycles old";
    await waitFor(() => liveText("polite"), want);
    expect(liveText("polite")).toBe(want);
    unmount();
  });

  test("StaleNote omits message/lastGoodAt when null and labels unavailable distinctly", async () => {
    const { container, unmount } = await mount(createElement(StaleNote, { availability: availability("unavailable") }));
    const note = container.querySelector('[role="status"][data-availability="unavailable"]')!;
    expect(note.getAttribute("data-status")).toBe("warning");
    expect(note.textContent).toContain("Data unavailable");
    expect(note.querySelector("[data-stale-message]")).toBeNull();
    expect(note.querySelector("[data-stale-last-good]")).toBeNull();
    expect(note.querySelector("time")).toBeNull();
    unmount();
  });
});
