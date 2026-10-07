// apps/web/tests/overview-drawer.test.ts — the read-only selected-target drawer and its
// snapshot-backed sections. Every rendered case goes through describeDom +
// renderWithStore over the deterministic overview fixture factory and the real selectors, for both
// host and service targets. Snapshot-section cases use an inert spy controller; the liveness cases
// drive the real history controller through an injected deferred HistoryFetch (no network).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import type { ReactElement } from "react";
import { useState } from "react";
import { act } from "./react-render.js";

import type { DataAvailability, LiveSignal, OverviewSnapshotV2 } from "@pulse/web-data/wire";
import type { ApiFetchResult } from "../src/client/api/client.js";
import { createEstateClock } from "../src/client/format.js";
import { AlertList } from "../src/client/views/overview/drawer/AlertList.js";
import { CheckHistory, NO_RECENT_CHECKS_TEXT, OBSERVATION_TIME_UNAVAILABLE_TEXT } from "../src/client/views/overview/drawer/CheckHistory.js";
import { NONE_DECLARED_TEXT } from "../src/client/views/overview/drawer/DeclaredFacts.js";
import {
  LIVENESS_HISTORY_STALE_TEXT,
  LIVENESS_HISTORY_UNAVAILABLE_TEXT,
  RETRY_LIVENESS_HISTORY_LABEL,
} from "../src/client/views/overview/drawer/LivenessSparkline.js";
import { NO_SUCCESSFUL_OBSERVATION_TEXT, SIGNAL_UNAVAILABLE_TEXT } from "../src/client/views/overview/drawer/format.js";
import { LiveSignals } from "../src/client/views/overview/drawer/LiveSignals.js";
import {
  canonicalIdFromStoreSelection,
  CLOSE_TARGET_DETAILS_LABEL,
  NO_GRAFANA_BOARD_TEXT,
  safeGrafanaHref,
  TargetDrawer,
  toStoreSelection,
  UNSAFE_GRAFANA_TEXT,
} from "../src/client/views/overview/drawer/TargetDrawer.js";
import { createChangeTracker } from "../src/client/views/overview/grid/change-marker.js";
import { OverviewGrid } from "../src/client/views/overview/grid/OverviewGrid.js";
import { createHistoryController } from "../src/client/views/overview/history.js";
import { DEFAULT_OVERVIEW_PREFERENCES } from "../src/client/views/overview/model.js";
import type { HistoryController, OverviewTarget, TargetDrawerModel, TargetHistoryState } from "../src/client/views/overview/model.js";
import { deriveOverviewModel, deriveTargetDrawerModel, resolveOverviewTarget } from "../src/client/views/overview/selectors.js";
import { FIXTURE_IDS } from "./fixtures/overview/expected.js";
import { FIXTURE_ESTATE, FIXTURE_GRAFANA_ORIGIN, makeLivenessHistoryPayload, makeOverviewSnapshot } from "./fixtures/overview/factory.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, renderWithStore } from "./dom.js";
import { installUiStubs } from "./rtl.js";

// Restore globalThis once this file finishes so a later non-DOM suite never sees the closed window.
isolateDomGlobals();

const CLOCK = createEstateClock(FIXTURE_ESTATE);
const STALE_AT = "2026-09-01T11:40:00.000Z";
const STALE_AT_TEXT = "2026-09-01 11:40:00 UTC";
const DRAWER_DIR = new URL("../src/client/views/overview/drawer/", import.meta.url);

/** Inert history controller: records every call and stays idle. */
function spyHistory(): HistoryController & { readonly calls: string[] } {
  const calls: string[] = [];
  const idle: TargetHistoryState = { status: "idle" } as TargetHistoryState;
  return {
    calls,
    state: () => idle,
    subscribe: () => {
      calls.push("subscribe");
      return () => {};
    },
    load: async () => {
      calls.push("load");
      return idle;
    },
    retry: async () => {
      calls.push("retry");
      return idle;
    },
    cancel: () => calls.push("cancel"),
    dispose: () => calls.push("dispose"),
  };
}

function target(snapshot: OverviewSnapshotV2, id: string): OverviewTarget {
  const resolved = resolveOverviewTarget(snapshot, id);
  if (resolved === null) throw new Error(`fixture target ${id} missing`);
  return resolved;
}

function drawerModel(snapshot: OverviewSnapshotV2, id: string): TargetDrawerModel {
  return deriveTargetDrawerModel(snapshot, target(snapshot, id));
}

const mounted: Array<{ unmount(): void }> = [];

afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
});

async function mountVNode(vnode: ReactElement): Promise<HTMLElement> {
  let result!: Awaited<ReturnType<typeof renderWithStore>>;
  await act(async () => {
    result = await renderWithStore(vnode);
  });
  mounted.push(result);
  return result.container;
}

/** The portalled Sheet (Radix renders it into document.body, outside the mount container). */
function dialogElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

/** The drawer paints its frame first and renders its sections a frame later: wait for them. */
async function awaitDrawerBody(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (document.querySelector('[data-drawer-body="ready"]') !== null) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("drawer sections never rendered");
}

/** Mount an open drawer, wait for its sections, and return its dialog element. */
async function mountDrawer(model: TargetDrawerModel, onClose: () => void = () => {}, history = spyHistory()): Promise<HTMLElement> {
  await mountVNode(createElement(TargetDrawer, { open: true, model, history, clock: CLOCK, onClose }) as unknown as ReactElement);
  const dialog = dialogElement();
  if (dialog === null) throw new Error("drawer did not open");
  await awaitDrawerBody();
  return dialog;
}

/** Radix moves focus back a tick after the Sheet unmounts. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/** Radix Portal/FocusScope need a real layout effect under happy-dom: stub before any mount. */
function useUiStubs(): void {
  let restore: (() => void) | null = null;
  beforeAll(() => {
    restore = installUiStubs();
  });
  afterAll(() => restore?.());
}

function text(root: ParentNode, selector: string): string {
  const el = root.querySelector(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function all(root: ParentNode, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector));
}

function stale(source: DataAvailability["source"], lastGoodAt: string | null, message: string | null = null): DataAvailability {
  return { state: "stale", source, lastGoodAt, message };
}

describeDom("TargetDrawer — Sheet composition", () => {
  useUiStubs();

  test("open=false renders nothing and never touches history", async () => {
    const snapshot = makeOverviewSnapshot();
    const history = spyHistory();
    const root = await mountVNode(
      createElement(TargetDrawer, { open: false, model: drawerModel(snapshot, FIXTURE_IDS.okHost), history, clock: CLOCK, onClose: () => {} }) as unknown as ReactElement,
    );
    expect(dialogElement()).toBeNull();
    expect(root.textContent).toBe("");
    expect(history.calls).toEqual([]);
  });

  test("opening paints the Sheet frame first; the sections render a frame later", async () => {
    const snapshot = makeOverviewSnapshot();
    const history = spyHistory();
    const model = drawerModel(snapshot, FIXTURE_IDS.okService);
    await mountVNode(createElement(TargetDrawer, { open: true, model, history, clock: CLOCK, onClose: () => {} }) as unknown as ReactElement);
    const dialog = dialogElement()!;
    // First commit: the named dialog and its close control, with a busy placeholder body.
    expect(dialog.querySelector("h2")?.textContent).toBe(model.target.service !== null ? `${model.target.service.name} on ${model.target.host.name}` : model.target.host.name);
    expect(dialog.querySelector('[data-drawer-body="pending"][aria-busy="true"]')).not.toBeNull();
    expect(dialog.querySelector("[data-section]")).toBeNull();
    await awaitDrawerBody();
    expect(dialog.querySelector('[data-drawer-body="pending"]')).toBeNull();
    expect(dialog.querySelectorAll("[data-section]").length).toBeGreaterThan(0);
  });

  test("renders a modal Sheet named by the target, with exactly one visible close control", async () => {
    const snapshot = makeOverviewSnapshot();
    const history = spyHistory();
    const dialog = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.okService), () => {}, history);
    expect(dialog.getAttribute("data-slot")).toBe("sheet-content");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const titleId = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe("api on host-001");
    expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1);
    const closes = all(dialog, "button").filter((b) => /close/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`));
    expect(closes).toHaveLength(1);
    const close = closes[0] as HTMLButtonElement;
    expect(close.getAttribute("aria-label")).toBe(CLOSE_TARGET_DETAILS_LABEL);
    expect(close.getAttribute("type")).toBe("button");
    expect(close.textContent).toBe("Close");
    // The body is the scroll container and carries the target hooks.
    const body = dialog.querySelector<HTMLElement>("[data-drawer-target]")!;
    expect(body.dataset["drawerTarget"]).toBe(FIXTURE_IDS.okService);
    expect(body.dataset["targetKind"]).toBe("service");
    // Every section is a heading-named region with its unchanged h3 title, including the lazy liveness region.
    const titles: Record<string, string> = {
      facts: "Declared facts",
      signals: "Live signals",
      alerts: "Firing alerts",
      checks: "Recent checks",
      liveness: "Liveness (1 h)",
      grafana: "Dashboards",
    };
    for (const [section, title] of Object.entries(titles)) {
      const region = dialog.querySelector<HTMLElement>(`section[data-section="${section}"]`)!;
      const heading = region.querySelector("h3")!;
      expect(heading.textContent).toBe(title);
      expect(region.getAttribute("aria-labelledby")).toBe(heading.id);
    }
    // Opening mounts LivenessSparkline: it subscribes, then asks for exactly one load.
    expect(history.calls).toEqual(["subscribe", "load"]);
  });

  test("the drawer imports the library only through the @/ui barrel", () => {
    for (const file of ["TargetDrawer.tsx", "DeclaredFacts.tsx", "LiveSignals.tsx", "AlertList.tsx", "CheckHistory.tsx", "LivenessSparkline.tsx"]) {
      const src = readFileSync(new URL(file, DRAWER_DIR), "utf8");
      expect(src).not.toMatch(/ui\/kit\.js|viz\/index\.js|from "@\/ui\/|useFocusTrap|addEventListener/);
      expect(src).not.toMatch(/\boverview-[a-z]/);
    }
    const src = readFileSync(new URL("TargetDrawer.tsx", DRAWER_DIR), "utf8");
    expect(src).toMatch(/import \{[^}]*\bSheet\b[^}]*\} from "@\/ui"/);
    expect(src).toMatch(/import \{[^}]*\bExternalLink\b[^}]*\} from "@\/ui"/);
  });

  test("close button, Escape and overlay all call onClose; closing returns focus to the trigger", async () => {
    const snapshot = makeOverviewSnapshot();
    const model = drawerModel(snapshot, FIXTURE_IDS.okHost);
    let closes = 0;
    function Harness(): ReactElement {
      const [open, setOpen] = useState(false);
      return createElement(
        "div",
        null,
        createElement("button", { id: "trigger", type: "button", onClick: () => setOpen(true) }, "open"),
        createElement(TargetDrawer, { open, model, history: spyHistory(), clock: CLOCK, onClose: () => { closes++; setOpen(false); } }),
      ) as unknown as ReactElement;
    }
    const root = await mountVNode(createElement(Harness, null) as unknown as ReactElement);
    const trigger = root.querySelector("#trigger") as HTMLButtonElement;
    const openDrawer = async (): Promise<Element> => {
      trigger.focus();
      await act(async () => trigger.click());
      // Radix arms its outside-pointer listener a tick after mounting.
      await settle();
      const dialog = dialogElement()!;
      // Initial focus is the dialog itself (named by its title); Close is the next tab stop.
      expect(document.activeElement).toBe(dialog);
      return dialog;
    };

    let dialog = await openDrawer();
    await act(async () => (dialog.querySelector(`[aria-label="${CLOSE_TARGET_DETAILS_LABEL}"]`) as HTMLButtonElement).click());
    await settle();
    expect(dialogElement()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    dialog = await openDrawer();
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(dialogElement()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await openDrawer();
    const overlay = document.querySelector('[data-slot="sheet-overlay"]') as HTMLElement;
    await act(async () => {
      // A primary-button outside press dismisses on the click that completes it. happy-dom clears
      // event.target once dispatch ends (browsers keep it), so click while pointerdown is still
      // bubbling: this listener is registered after Radix's and runs right after it.
      document.addEventListener("pointerdown", () => overlay.click(), { once: true });
      overlay.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();
    expect(dialogElement()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(closes).toBe(3);
  });
});

describeDom("TargetDrawer — declared facts", () => {
  useUiStubs();

  test("host target: id, name, kind, class, addresses, current status and last good", async () => {
    const snapshot = makeOverviewSnapshot();
    const host = snapshot.hosts[0]!;
    const root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.okHost));
    expect(text(root, '[data-fact="id"] dd')).toBe(FIXTURE_IDS.okHost);
    expect(text(root, '[data-fact="name"] dd')).toBe("host-001");
    expect(text(root, '[data-fact="kind"] dd')).toBe("Host");
    expect(text(root, '[data-fact="host"] dd')).toBe("host-001");
    expect(text(root, '[data-fact="class"] dd')).toBe(host.collectionClass);
    expect(all(root, '[data-fact="addresses"] li').map((li) => li.textContent)).toEqual([...host.addresses]);
    expect(text(root, '[data-fact="suppression"] dd')).toBe("Not suppressed");
    // Service-only facts are absent for a host.
    expect(root.querySelector('[data-fact="managed"]')).toBeNull();
    const status = root.querySelector("[data-status][data-availability]")!;
    expect(status.getAttribute("data-status")).toBe("ok");
    expect(status.getAttribute("data-availability")).toBe("current");
    const badge = status.querySelector('[data-slot="status-badge"]')!;
    expect(badge.getAttribute("data-status")).toBe("ok");
    expect(badge.textContent).toContain("OK");
  });

  test("host with no declared addresses says 'None declared'", async () => {
    const base = makeOverviewSnapshot();
    const snapshot: OverviewSnapshotV2 = { ...base, hosts: [{ ...base.hosts[0]!, addresses: [] }, ...base.hosts.slice(1)] };
    const root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.okHost));
    expect(text(root, '[data-fact="addresses"] dd')).toBe(NONE_DECLARED_TEXT);
  });

  test("service target: owning host, managed, deep health and ingress", async () => {
    const snapshot = makeOverviewSnapshot();
    let root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.okService));
    expect(text(root, '[data-fact="id"] dd')).toBe(FIXTURE_IDS.okService);
    expect(text(root, '[data-fact="name"] dd')).toBe("api");
    expect(text(root, '[data-fact="kind"] dd')).toBe("Service");
    expect(text(root, '[data-fact="host"] dd')).toBe("host-001");
    expect(text(root, '[data-fact="managed"] dd')).toBe("Yes");
    expect(text(root, '[data-fact="deep-health"] dd')).toBe("Yes");
    expect(text(root, '[data-fact="ingress"] dd')).toBe(NONE_DECLARED_TEXT);
    expect(root.querySelector('[data-fact="class"]')).toBeNull();
    for (const m of mounted.splice(0)) m.unmount();

    const host = snapshot.hosts[0]!;
    const withIngress: OverviewSnapshotV2 = {
      ...snapshot,
      hosts: [{ ...host, services: [host.services[0]!, { ...host.services[1]!, ingressUrl: "https://db.example.test/" }, host.services[2]!] }, ...snapshot.hosts.slice(1)],
    };
    root = await mountDrawer(drawerModel(withIngress, FIXTURE_IDS.okServiceNoBoard));
    expect(text(root, '[data-fact="managed"] dd')).toBe("No");
    expect(text(root, '[data-fact="deep-health"] dd')).toBe("No");
    // Ingress is text, never a link.
    expect(text(root, '[data-fact="ingress"] dd')).toBe("https://db.example.test/");
    expect(root.querySelector('[data-fact="ingress"] a')).toBeNull();
  });

  test("suppression class and rationale for suppressed host and service", async () => {
    const snapshot = makeOverviewSnapshot({ hostCount: 5 });
    let root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.suppressedHost));
    expect(text(root, '[data-fact="suppression"] dd')).toBe("maintenance: host-005 is deliberately suppressed for planned maintenance.");
    expect(root.querySelector("[data-status][data-availability]")?.getAttribute("data-status")).toBe("suppressed");
    for (const m of mounted.splice(0)) m.unmount();

    root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.suppressedService));
    expect(text(root, '[data-fact="suppression"] [data-slot="drawer-suppression-class"]')).toBe("maintenance");
    expect(text(root, '[data-fact="suppression"] [data-slot="drawer-suppression-rationale"]')).toBe("cache is deliberately suppressed for planned maintenance.");
  });

  test("non-current target evidence shows unknown with its message and estate last-good time", async () => {
    const snapshot = makeOverviewSnapshot({
      targetAvailability: { [FIXTURE_IDS.okService]: stale("victoriametrics-targets", STALE_AT, "Targets source is stale.") },
    });
    const root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.okService));
    const status = root.querySelector("[data-status][data-availability]")!;
    expect(status.getAttribute("data-status")).toBe("unknown");
    expect(status.getAttribute("data-availability")).toBe("stale");
    expect(text(root, '[data-slot="drawer-availability"]')).toBe("Stale");
    expect(text(root, '[data-slot="drawer-availability-message"]')).toBe("Targets source is stale.");
    expect(text(root, '[data-slot="drawer-last-good"]')).toBe(`Last good ${STALE_AT_TEXT}`);
  });
});

describeDom("TargetDrawer — live signals", () => {
  useUiStubs();

  test("host percent signal renders value with its unit and current availability", async () => {
    const snapshot = makeOverviewSnapshot();
    const root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.warningHost));
    const rows = all(root, "[data-section='signals'] li[data-signal-id]");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.getAttribute("data-signal-id")).toBe("cpu.utilization");
    expect(text(row, '[data-slot="drawer-signal-label"]')).toBe("CPU utilization");
    expect(text(row, '[data-slot="drawer-signal-value"]')).toBe("7 %");
    expect(row.querySelector("[data-unit]")?.getAttribute("data-unit")).toBe("percent");
    expect(text(row, '[data-slot="drawer-signal-state"]')).toBe("Current");
    expect(text(row, '[data-slot="drawer-signal-last-good"]')).toMatch(/^Last good 2026-09-01 /);
  });

  test("service state signal renders Yes/No, never a raw boolean", async () => {
    const snapshot = makeOverviewSnapshot();
    let root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.okService));
    expect(text(root, '[data-slot="drawer-signal-value"]')).toBe("Yes");
    for (const m of mounted.splice(0)) m.unmount();
    root = await mountDrawer(drawerModel(snapshot, "svc:host-003/api")); // critical → live false
    expect(text(root, '[data-slot="drawer-signal-value"]')).toBe("No");
  });

  test("null values show 'Unavailable' with the availability message — never 0 or false", async () => {
    const snapshot = makeOverviewSnapshot({
      targetAvailability: {
        [FIXTURE_IDS.unknownHost]: { state: "unavailable", source: "victoriametrics-signals", lastGoodAt: null, message: "Signals source is unavailable." },
        "svc:host-004/api": stale("victoriametrics-targets", STALE_AT, "Targets are stale."),
      },
    });
    let root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.unknownHost));
    let row = root.querySelector("li[data-signal-id]")!;
    expect(row.querySelector('[data-slot="drawer-signal-value"]')?.getAttribute("data-value")).toBe("unavailable");
    expect(text(row, '[data-slot="drawer-signal-value"]')).toBe(`${SIGNAL_UNAVAILABLE_TEXT} — Signals source is unavailable.`);
    expect(text(row, '[data-slot="drawer-signal-state"]')).toBe("Unavailable");
    expect(text(row, '[data-slot="drawer-signal-last-good"]')).toBe(NO_SUCCESSFUL_OBSERVATION_TEXT);
    expect(row.textContent).not.toMatch(/\b0\b|\bNo\b|false/);
    for (const m of mounted.splice(0)) m.unmount();

    root = await mountDrawer(drawerModel(snapshot, "svc:host-004/api"));
    row = root.querySelector("li[data-signal-id]")!;
    expect(text(row, '[data-slot="drawer-signal-value"]')).toBe(`${SIGNAL_UNAVAILABLE_TEXT} — Targets are stale.`);
    expect(text(row, '[data-slot="drawer-signal-state"]')).toBe("Stale");
    expect(text(row, '[data-slot="drawer-signal-last-good"]')).toBe(`Last good ${STALE_AT_TEXT}`);
  });

  test("every declared unit renders its own suffix; string and non-finite values are handled", async () => {
    const host = { kind: "host", id: FIXTURE_IDS.okHost } as const;
    const current: DataAvailability = { state: "current", source: "victoriametrics-signals", lastGoodAt: STALE_AT, message: null };
    const signal = (id: string, unit: LiveSignal["unit"], value: LiveSignal["value"]): LiveSignal =>
      ({ target: host, id, label: id, unit, value, availability: current });
    const signals: LiveSignal[] = [
      signal("s-seconds", "seconds", 12), signal("s-ms", "milliseconds", 4.5), signal("s-bytes", "bytes", 1024),
      signal("s-count", "count", 3), signal("s-scalar", "scalar", 0.25), signal("s-state", "state", "running"),
      signal("s-zero", "percent", 0), signal("s-nan", "percent", Number.NaN),
    ];
    const root = await mountVNode(createElement(LiveSignals, { signals, clock: CLOCK }) as unknown as ReactElement);
    const values = all(root, '[data-slot="drawer-signal-value"]').map((el) => (el.textContent ?? "").trim());
    // A real zero is a value; a non-finite number is unavailable, never 0.
    expect(values).toEqual(["12 s", "4.5 ms", "1024 bytes", "3 count", "0.25", "running", "0 %", SIGNAL_UNAVAILABLE_TEXT]);
  });

  test("a target without signals says so", async () => {
    const snapshot = makeOverviewSnapshot({ signals: false });
    const root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.okHost));
    expect(text(root, '[data-section="signals"] [data-slot="drawer-empty"]')).toBe("No live signals attributed to this target.");
    // Target availability is still shown above the (empty) signals.
    expect(root.querySelector("[data-status][data-availability]")?.getAttribute("data-availability")).toBe("current");
  });
});

/** Snapshot where signals/alerts/checks carry near-miss attributions around host-001 and its api service. */
function attributionSnapshot(): OverviewSnapshotV2 {
  const base = makeOverviewSnapshot();
  const current: DataAvailability = { state: "current", source: "victoriametrics-signals", lastGoodAt: STALE_AT, message: null };
  const hostId = FIXTURE_IDS.okHost;
  const svcId = FIXTURE_IDS.okService;
  const sig = (kind: "host" | "service" | "endpoint", id: string, sid: string): LiveSignal =>
    ({ target: { kind, id }, id: sid, label: sid, unit: "count", value: 1, availability: current });
  return {
    ...base,
    signals: [
      sig("host", hostId, "z-first"),
      sig("service", hostId, "wrong-kind"),
      sig("endpoint", hostId, "wrong-kind-endpoint"),
      sig("host", "host:host-0010", "prefix-id"),
      sig("service", svcId, "svc-only"),
      ...base.signals,
      sig("host", hostId, "a-last"),
    ],
    alerts: [
      { fingerprint: "fp-z", name: "ZuluAlert", severity: "warning", startsAt: STALE_AT, target: { kind: "host", id: hostId }, summary: "First by server order" },
      { fingerprint: "fp-kind", name: "WrongKind", severity: "critical", startsAt: STALE_AT, target: { kind: "service", id: hostId } },
      { fingerprint: "fp-svc", name: "ServiceOnly", severity: "critical", startsAt: STALE_AT, target: { kind: "service", id: svcId } },
      { fingerprint: "fp-null", name: "Unattributed", severity: "info", startsAt: STALE_AT, target: null },
      { fingerprint: "fp-a", name: "AlphaInfo", severity: "info", startsAt: STALE_AT, target: { kind: "host", id: hostId } },
    ],
    recentChecks: [
      { target: { kind: "service", id: svcId }, endpoint: "zeta", success: false, observedAt: "2026-09-01T11:58:00.000Z", durationMs: 30 },
      { target: { kind: "host", id: svcId }, endpoint: "wrong-kind", success: true, observedAt: "2026-09-01T11:58:00.000Z", durationMs: 1 },
      { target: null, endpoint: "unattributed", success: true, observedAt: "2026-09-01T11:58:00.000Z", durationMs: 1 },
      { target: { kind: "service", id: "svc:host-002/api" }, endpoint: "other-service", success: true, observedAt: "2026-09-01T11:58:00.000Z", durationMs: 1 },
      { target: { kind: "service", id: svcId }, endpoint: "alpha", success: true, observedAt: "2026-09-01T11:59:00.000Z", durationMs: 12 },
      { target: { kind: "service", id: svcId }, endpoint: "zeta", success: null, observedAt: null, durationMs: null },
    ],
  };
}

describeDom("TargetDrawer — exact attribution and server order", () => {
  useUiStubs();

  test("host drawer shows only signals/alerts attributed to host kind + exact id, in server order", async () => {
    const root = await mountDrawer(drawerModel(attributionSnapshot(), FIXTURE_IDS.okHost));
    expect(all(root, "li[data-signal-id]").map((el) => el.getAttribute("data-signal-id"))).toEqual(["z-first", "cpu.utilization", "a-last"]);
    expect(all(root, "li[data-signal-id]").every((el) => el.getAttribute("data-target-kind") === "host")).toBe(true);
    expect(all(root, "li[data-fingerprint]").map((el) => el.getAttribute("data-fingerprint"))).toEqual(["fp-z", "fp-a"]);
    expect(text(root, '[data-fingerprint="fp-z"] [data-slot="drawer-alert-summary"]')).toBe("First by server order");
    expect(text(root, '[data-fingerprint="fp-z"] [data-slot="drawer-alert-start"]')).toMatch(new RegExp(`^Started ${STALE_AT_TEXT} \\(`));
    // Severity comes from ALERT_SEVERITY: warning is a warn badge; info is the info tone, never ok/danger.
    expect(text(root, '[data-fingerprint="fp-z"] [data-slot="status-badge"][data-severity="warning"]')).toBe("Warning");
    const info = root.querySelector('[data-fingerprint="fp-a"] [data-slot="status-badge"]')!;
    expect(info.getAttribute("data-severity")).toBe("info");
    expect(info.getAttribute("data-tone")).toBe("info");
    expect(text(root, '[data-fingerprint="fp-a"] [data-slot="status-badge"]')).toBe("Info");
    // Host has no attributed checks here (the service-kind check with the same id is excluded).
    expect(text(root, '[data-section="checks"] [data-slot="drawer-empty"]')).toBe(NO_RECENT_CHECKS_TEXT);
  });

  test("service drawer shows only its own signals/alerts/checks, in server order", async () => {
    const snapshot = attributionSnapshot();
    const root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.okService));
    expect(all(root, "li[data-signal-id]").map((el) => el.getAttribute("data-signal-id"))).toEqual(["svc-only", "service.up"]);
    expect(all(root, "li[data-fingerprint]").map((el) => el.getAttribute("data-fingerprint"))).toEqual(["fp-svc"]);
    expect(all(root, "li[data-endpoint]").map((el) => el.getAttribute("data-endpoint"))).toEqual(["zeta", "alpha", "zeta"]);
    const nullTime = all(root, "li[data-endpoint]")[2]!;
    expect(text(nullTime, '[data-slot="drawer-check-time"]')).toBe(OBSERVATION_TIME_UNAVAILABLE_TEXT);
    expect(text(nullTime, '[data-slot="drawer-check-outcome"]')).toBe("Result unavailable");
    expect(all(root, "li[data-endpoint]").map((el) => el.getAttribute("data-outcome"))).toEqual(["critical", "ok", "unknown"]);
  });

  test("CheckHistory renders the shared StatusTimeline over buildCheckTimeline lanes", async () => {
    const model = drawerModel(attributionSnapshot(), FIXTURE_IDS.okService);
    expect(model.checkLanes.map((lane) => lane.id)).toEqual(["alpha", "zeta"]);
    const root = await mountDrawer(model);
    const svg = root.querySelector('[data-section="checks"] svg[role="img"]')!;
    expect(svg.getAttribute("aria-label")).toBe("Recent check outcomes");
    expect(all(svg, "g[data-lane]").map((g) => g.getAttribute("data-lane"))).toEqual(["alpha", "zeta"]);
    expect(all(svg, 'g[data-lane="zeta"] rect').map((r) => r.getAttribute("data-status"))).toEqual(["critical"]);
    expect(all(svg, 'g[data-lane="alpha"] rect').map((r) => r.getAttribute("data-status"))).toEqual(["ok"]);
    const src = readFileSync(new URL("CheckHistory.tsx", DRAWER_DIR), "utf8");
    expect(src).toMatch(/import \{[^}]*\bStatusTimeline\b[^}]*\} from "@\/ui"/);
    expect(src).not.toMatch(/TimeSeriesChart|uplot|fetch|\/api\//);
  });

  test("checks whose times are all unavailable keep textual outcomes and omit the timeline", async () => {
    const checks = [
      { target: { kind: "service", id: FIXTURE_IDS.okService }, endpoint: "e", success: false, observedAt: null, durationMs: null },
    ] as const;
    const root = await mountVNode(createElement(CheckHistory, { checks, lanes: [], clock: CLOCK }) as unknown as ReactElement);
    expect(root.querySelector("svg")).toBeNull();
    expect(text(root, '[data-slot="drawer-check-outcome"]')).toBe("Failed");
    expect(text(root, '[data-slot="drawer-check-time"]')).toBe(OBSERVATION_TIME_UNAVAILABLE_TEXT);
  });

  test("AlertList with no attributed alerts renders the explicit empty copy", async () => {
    const root = await mountVNode(createElement(AlertList, { alerts: [], clock: CLOCK }) as unknown as ReactElement);
    expect(text(root, '[data-section="alerts"] [data-slot="drawer-empty"]')).toBe("No firing alerts attributed to this target.");
  });
});

describeDom("TargetDrawer — Grafana deep links and read-only surface", () => {
  useUiStubs();

  test("host and service links carry the resolved snapshot URL with target=_blank and rel noopener noreferrer", async () => {
    const snapshot = makeOverviewSnapshot();
    for (const [id, board] of [[FIXTURE_IDS.okHost, "pulse-host-001"], [FIXTURE_IDS.okService, "pulse-host-001-api"]] as const) {
      const root = await mountDrawer(drawerModel(snapshot, id));
      const links = all(root, "[data-section='grafana'] a");
      expect(links).toHaveLength(1);
      const link = links[0]!;
      expect(link.getAttribute("href")).toBe(`${FIXTURE_GRAFANA_ORIGIN}/d/${board}`);
      expect(link.getAttribute("target")).toBe("_blank");
      const rel = (link.getAttribute("rel") ?? "").split(/\s+/);
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
      expect(link.getAttribute("data-slot")).toBe("external-link");
      // ExternalLink appends a visually hidden new-tab warning to the accessible name.
      expect(link.textContent).toBe(`Open in Grafana (${board}) (opens in new tab)`);
      for (const m of mounted.splice(0)) m.unmount();
    }
  });

  test("a target without a board renders no link and no invented URL", async () => {
    const snapshot = makeOverviewSnapshot();
    const root = await mountDrawer(drawerModel(snapshot, FIXTURE_IDS.okServiceNoBoard));
    expect(root.querySelector("[data-section='grafana'] a")).toBeNull();
    expect(root.querySelector("a")).toBeNull();
    expect(text(root, '[data-section="grafana"] [data-slot="drawer-empty"]')).toBe(NO_GRAFANA_BOARD_TEXT);
    expect(root.innerHTML).not.toContain(FIXTURE_GRAFANA_ORIGIN);
  });

  test("an unsafe server URL renders explanatory text, never a link", async () => {
    const model = drawerModel(makeOverviewSnapshot(), FIXTURE_IDS.okHost);
    for (const url of ["javascript:alert(1)", "https://user:pw@grafana.example.test/d/x", "/d/relative", ""]) {
      const root = await mountDrawer({ ...model, grafana: { boardUid: "pulse-host-001", url } });
      expect(root.querySelector("a")).toBeNull();
      expect(text(root, '[data-section="grafana"] [data-slot="drawer-empty"]')).toBe(UNSAFE_GRAFANA_TEXT);
      for (const m of mounted.splice(0)) m.unmount();
    }
  });

  test("safeGrafanaHref accepts only credential-free absolute http(s)", () => {
    expect(safeGrafanaHref("https://grafana.example.test/d/a?x=1")).toBe("https://grafana.example.test/d/a?x=1");
    expect(safeGrafanaHref("http://grafana.local/d/a")).toBe("http://grafana.local/d/a");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://g/d", "https://u@g/d", "https://u:p@g/d", "/relative", "not a url", ""]) {
      expect(safeGrafanaHref(bad)).toBeNull();
    }
  });

  test("no iframe, PromQL/query input, chart, secret or mutation control exists", async () => {
    const snapshot = makeOverviewSnapshot();
    for (const id of [FIXTURE_IDS.criticalHost, FIXTURE_IDS.okService]) {
      const dialog = await mountDrawer(drawerModel(snapshot, id));
      expect(dialog.querySelector("iframe, embed, object, input, textarea, select, form, canvas")).toBeNull();
      // The only control is the close button; the only link is Grafana.
      expect(all(dialog, "button").map((b) => b.getAttribute("aria-label"))).toEqual([CLOSE_TARGET_DETAILS_LABEL]);
      expect(all(dialog, "a").every((a) => a.closest("[data-section='grafana']") !== null)).toBe(true);
      expect(all(dialog, '[role="button"], [role="menuitem"], [contenteditable]')).toEqual([]);
      const body = dialog.textContent ?? "";
      expect(body).not.toMatch(/promql|silence|acknowledge|\bedit\b|delete|secret/i);
      for (const m of mounted.splice(0)) m.unmount();
    }
  });
});

describeDom("TargetDrawer — canonical store selection adapter", () => {
  useUiStubs();

  test("toStoreSelection copies names from the resolved host and service targets", () => {
    const snapshot = makeOverviewSnapshot();
    expect(toStoreSelection(target(snapshot, FIXTURE_IDS.okHost))).toEqual({ kind: "host", host: "host-001" });
    expect(toStoreSelection(target(snapshot, FIXTURE_IDS.okService))).toEqual({ kind: "service", host: "host-001", service: "api" });
  });

  test("canonicalIdFromStoreSelection returns the snapshot's own drilldownId, never a constructed one", () => {
    const base = makeOverviewSnapshot();
    // Ids that cannot be reconstructed from names prove the adapter reads the snapshot object.
    const host = { ...base.hosts[1]!, drilldownId: "opaque-host-7", services: base.hosts[1]!.services.map((s, i) => ({ ...s, drilldownId: `opaque-svc-${i}` })) };
    const snapshot: OverviewSnapshotV2 = { ...base, hosts: [base.hosts[0]!, host, ...base.hosts.slice(2)] };
    expect(canonicalIdFromStoreSelection(snapshot, { kind: "host", host: "host-002" })).toBe("opaque-host-7");
    expect(canonicalIdFromStoreSelection(snapshot, { kind: "service", host: "host-002", service: "db" })).toBe("opaque-svc-1");
    // Round trip through toStoreSelection for every target.
    for (const h0 of base.hosts) {
      for (const id of [h0.drilldownId, ...h0.services.map((s) => s.drilldownId)]) {
        expect(canonicalIdFromStoreSelection(base, toStoreSelection(target(base, id)))).toBe(id);
      }
    }
  });

  test("missing or ambiguous names resolve to null", () => {
    const base = makeOverviewSnapshot();
    expect(canonicalIdFromStoreSelection(base, { kind: "host", host: "no-such-host" })).toBeNull();
    expect(canonicalIdFromStoreSelection(base, { kind: "service", host: "host-001", service: "no-such" })).toBeNull();
    const dupHost = { ...base.hosts[1]!, name: "host-001", drilldownId: "host:dup" };
    const ambiguousHosts: OverviewSnapshotV2 = { ...base, hosts: [base.hosts[0]!, dupHost] };
    expect(canonicalIdFromStoreSelection(ambiguousHosts, { kind: "host", host: "host-001" })).toBeNull();
    expect(canonicalIdFromStoreSelection(ambiguousHosts, { kind: "service", host: "host-001", service: "api" })).toBeNull();
    const h0 = base.hosts[0]!;
    const dupService = { ...h0, services: [...h0.services, { ...h0.services[0]!, drilldownId: "svc:dup" }] };
    const ambiguousServices: OverviewSnapshotV2 = { ...base, hosts: [dupService, ...base.hosts.slice(1)] };
    expect(canonicalIdFromStoreSelection(ambiguousServices, { kind: "service", host: "host-001", service: "api" })).toBeNull();
    expect(canonicalIdFromStoreSelection(ambiguousServices, { kind: "host", host: "host-001" })).toBe(h0.drilldownId);
  });
});

// ---------------------------------------------------------------------------------------------
// Lazy liveness region (05 §§6.4.1, 7; 08 §4.6 cases 1, 3, 4, 8)
// ---------------------------------------------------------------------------------------------

type HistoryResult = ApiFetchResult<unknown>;

/** Deferred fake HistoryFetch: every call stays pending until the test settles it. */
function deferredHistoryFetch() {
  const calls: Array<{ readonly path: string; resolve(result: HistoryResult): void }> = [];
  const fetch = (path: string): Promise<HistoryResult> =>
    new Promise<HistoryResult>((resolve) => {
      calls.push({ path, resolve });
    });
  return { calls, fetch };
}

function historyOk(value: unknown): HistoryResult {
  return { status: "ok", value: JSON.parse(JSON.stringify(value)) as unknown, etag: null, identity: null, observation: null };
}

/** Grid + drawer harness: the drawer opens only when a grid target is activated. */
async function mountGridWithDrawer(snapshot: OverviewSnapshotV2, history: HistoryController) {
  const overview = deriveOverviewModel(snapshot, DEFAULT_OVERVIEW_PREFERENCES);
  const changeTracker = createChangeTracker();
  const collapsed = new Set<string>();
  function Harness(): ReactElement {
    const [selected, setSelected] = useState<string | null>(null);
    const selectedTarget = selected === null ? null : resolveOverviewTarget(snapshot, selected);
    return createElement(
      "div",
      null,
      createElement(OverviewGrid, {
        model: overview,
        estateName: FIXTURE_ESTATE.name,
        collapsedGroupIds: collapsed,
        selectedTargetId: selected,
        wallboard: false,
        changeTracker,
        reducedMotion: false,
        onToggleGroup: () => {},
        onSelect: setSelected,
      }),
      selectedTarget === null
        ? null
        : createElement(TargetDrawer, {
            open: true,
            model: deriveTargetDrawerModel(snapshot, selectedTarget),
            history,
            clock: CLOCK,
            onClose: () => setSelected(null),
          }),
    ) as unknown as ReactElement;
  }
  const root = await mountVNode(createElement(Harness, null) as unknown as ReactElement);
  const open = async (id: string): Promise<Element> => {
    const trigger = root.querySelector(`[data-overview-target][data-target-id="${id}"]`) as HTMLElement;
    await act(async () => trigger.click());
    const dialog = dialogElement();
    if (dialog === null) throw new Error("drawer did not open");
    await awaitDrawerBody();
    return dialog;
  };
  return { root, open };
}

function liveness(root: ParentNode): Element {
  const region = root.querySelector('[data-section="liveness"] [data-history-state]');
  if (region === null) throw new Error("missing liveness region");
  return region;
}

/** Snapshot sections and the grid that must survive every liveness state. */
function expectSurroundingsRendered(root: ParentNode, dialog: Element): void {
  for (const section of ["facts", "signals", "alerts", "checks", "grafana"]) {
    expect(dialog.querySelector(`[data-section="${section}"]`)).not.toBeNull();
  }
  expect(dialog.querySelector('[data-section="checks"] [aria-label="Recent check outcomes"]')).not.toBeNull();
  expect(dialog.querySelector(`[aria-label="${CLOSE_TARGET_DETAILS_LABEL}"]`)).not.toBeNull();
  expect(root.querySelectorAll("[data-overview-target]").length).toBeGreaterThan(0);
}

describeDom("TargetDrawer — lazy liveness sparkline", () => {
  useUiStubs();

  test("no request before the drawer opens; opening issues exactly one; skeleton then sparkline", async () => {
    const snapshot = makeOverviewSnapshot();
    const transport = deferredHistoryFetch();
    const history = createHistoryController({ fetch: transport.fetch, now: () => 1_000 });
    const { root, open } = await mountGridWithDrawer(snapshot, history);
    expect(transport.calls).toHaveLength(0);

    const dialog = await open(FIXTURE_IDS.okService);
    expect(transport.calls.map((c) => c.path)).toEqual([
      `/api/history/target/${encodeURIComponent(FIXTURE_IDS.okService)}/estate.liveness?range=1h`,
    ]);
    let region = liveness(dialog);
    expect(region.getAttribute("data-history-state")).toBe("loading");
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(region.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(region.querySelector("svg")).toBeNull();
    expectSurroundingsRendered(root, dialog);

    const identity = target(snapshot, FIXTURE_IDS.okService).identity;
    await act(async () => transport.calls[0]!.resolve(historyOk(makeLivenessHistoryPayload(identity, { nullEvery: 5, pointCount: 20 }))));
    region = liveness(dialog);
    expect(region.getAttribute("data-history-state")).toBe("ready");
    expect(region.getAttribute("aria-busy")).toBe("false");
    expect(region.querySelector('[data-slot="skeleton"]')).toBeNull();
    const svg = region.querySelector('svg[role="img"]')!;
    expect(svg.getAttribute("aria-label")).toBe("One-hour liveness for api on host-001");
    // Nulls at points 5/10/15/20 split the 20 samples into four separate runs of four — never bridged.
    expect(svg.querySelectorAll("path")).toHaveLength(4);
    expect(region.querySelector("[data-unit]")?.getAttribute("data-unit")).toBe("state");
    expectSurroundingsRendered(root, dialog);
    expect(transport.calls).toHaveLength(1);
    history.dispose();
  });

  test("a series with no finite sample says 'Liveness history unavailable' instead of an empty chart", async () => {
    const snapshot = makeOverviewSnapshot();
    const transport = deferredHistoryFetch();
    const history = createHistoryController({ fetch: transport.fetch, now: () => 1_000 });
    const { open } = await mountGridWithDrawer(snapshot, history);
    const dialog = await open(FIXTURE_IDS.okHost);
    const identity = target(snapshot, FIXTURE_IDS.okHost).identity;
    await act(async () => transport.calls[0]!.resolve(historyOk(makeLivenessHistoryPayload(identity, { nullEvery: 1, pointCount: 6 }))));
    const region = liveness(dialog);
    expect(region.querySelector("svg")).toBeNull();
    expect(region.textContent).toContain(LIVENESS_HISTORY_UNAVAILABLE_TEXT);
    history.dispose();
  });

  test("a stale history payload keeps its chart and shows the stale marker; a current one does not", async () => {
    const snapshot = makeOverviewSnapshot();
    const transport = deferredHistoryFetch();
    const history = createHistoryController({ fetch: transport.fetch, now: () => 1_000 });
    const { open } = await mountGridWithDrawer(snapshot, history);
    const dialog = await open(FIXTURE_IDS.okHost);
    const identity = target(snapshot, FIXTURE_IDS.okHost).identity;
    await act(async () => transport.calls[0]!.resolve(historyOk(makeLivenessHistoryPayload(identity, { stale: true }))));
    const region = liveness(dialog);
    expect(region.getAttribute("data-history-state")).toBe("ready");
    expect(region.querySelector('svg[role="img"]')).not.toBeNull();
    expect(region.querySelector("[data-stale]")?.textContent).toBe(LIVENESS_HISTORY_STALE_TEXT);
    history.dispose();

    const fresh = deferredHistoryFetch();
    const history2 = createHistoryController({ fetch: fresh.fetch, now: () => 1_000 });
    for (const m of mounted.splice(0)) m.unmount();
    const second = await mountGridWithDrawer(snapshot, history2);
    const dialog2 = await second.open(FIXTURE_IDS.okHost);
    await act(async () => fresh.calls[0]!.resolve(historyOk(makeLivenessHistoryPayload(identity))));
    expect(liveness(dialog2).querySelector("[data-stale]")).toBeNull();
    expect(liveness(dialog2).textContent).not.toContain(LIVENESS_HISTORY_STALE_TEXT);
    history2.dispose();
  });

  test("error renders bounded text and a retry control; retry keeps the drawer, sections and grid", async () => {
    const snapshot = makeOverviewSnapshot();
    const transport = deferredHistoryFetch();
    const history = createHistoryController({ fetch: transport.fetch, now: () => 1_000 });
    const { root, open } = await mountGridWithDrawer(snapshot, history);
    const dialog = await open(FIXTURE_IDS.okService);
    await act(async () =>
      transport.calls[0]!.resolve({ status: "error", error: { code: "SOURCE_TIMEOUT", message: "<b>raw</b> server detail" }, httpStatus: 504 }),
    );
    let region = liveness(dialog);
    expect(region.getAttribute("data-history-state")).toBe("error");
    expect(region.getAttribute("aria-busy")).toBe("false");
    expect(region.textContent).not.toContain("raw");
    const retry = Array.from(region.querySelectorAll("button")).find((b) => b.textContent === RETRY_LIVENESS_HISTORY_LABEL) as HTMLButtonElement;
    expect(retry).toBeDefined();
    expect(retry.getAttribute("type")).toBe("button");
    expectSurroundingsRendered(root, dialog);

    await act(async () => retry.click());
    expect(transport.calls).toHaveLength(2);
    expect(dialogElement() as Element | null).toBe(dialog);
    region = liveness(dialog);
    expect(region.getAttribute("data-history-state")).toBe("loading");
    expect(region.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expectSurroundingsRendered(root, dialog);

    const identity = target(snapshot, FIXTURE_IDS.okService).identity;
    await act(async () => transport.calls[1]!.resolve(historyOk(makeLivenessHistoryPayload(identity))));
    expect(liveness(dialog).querySelector('svg[role="img"]')).not.toBeNull();
    expectSurroundingsRendered(root, dialog);
    expect(transport.calls).toHaveLength(2);
    history.dispose();
  });

  test("LivenessSparkline uses the shared Sparkline/Skeleton and never the time-series chart", () => {
    const src = readFileSync(new URL("LivenessSparkline.tsx", DRAWER_DIR), "utf8");
    expect(src).toMatch(/import \{[^}]*\bSkeleton\b[^}]*\} from "@\/ui"/);
    expect(src).toMatch(/import \{[^}]*\bSparkline\b[^}]*\} from "@\/ui"/);
    expect(src).not.toMatch(/TimeSeriesChart|uplot/i);
    expect(readFileSync(new URL("TargetDrawer.tsx", DRAWER_DIR), "utf8")).toMatch(/<LivenessSparkline\b/);
  });
});

describeDom("AlertList — read-only acked marker (REQ-ACK-07d, REQ-AUTHZ-05)", () => {
  useUiStubs();

  const base = { severity: "critical" as const, startsAt: "2026-09-01T11:00:00.000Z", target: null };

  test("an acked row shows 'Acknowledged' with a circle-check glyph right after the name", async () => {
    const root = await mountVNode(
      createElement(AlertList, { alerts: [{ ...base, fingerprint: "fp-a", name: "DiskFull", acked: true }], clock: CLOCK }) as unknown as ReactElement,
    );
    const name = root.querySelector('[data-slot="drawer-alert-name"]')!;
    const marker = name.nextElementSibling!;
    expect(marker.hasAttribute("data-acked")).toBe(true);
    expect(marker.getAttribute("data-slot")).toBe("badge");
    expect(marker.textContent).toBe("Acknowledged");
    expect(marker.querySelector("svg")?.getAttribute("class") ?? "").toContain("circle-check");
    expect(marker.querySelectorAll("button, a, input, [tabindex], [href]").length).toBe(0);
    expect(marker.hasAttribute("tabindex")).toBe(false);
  });

  test("a row without acked shows no marker", async () => {
    const root = await mountVNode(
      createElement(AlertList, { alerts: [{ ...base, fingerprint: "fp-b", name: "DiskFull" }], clock: CLOCK }) as unknown as ReactElement,
    );
    expect(root.querySelector("[data-acked]")).toBeNull();
  });

  test("deriveTargetDrawerModel carries acked through to the drawer alerts", async () => {
    const snapshot = makeOverviewSnapshot();
    const attributed = snapshot.alerts.find((a) => a.target !== null)!;
    const acked: OverviewSnapshotV2 = {
      ...snapshot,
      alerts: snapshot.alerts.map((a) => (a === attributed ? { ...a, acked: true as const } : a)),
    };
    const model = drawerModel(acked, attributed.target!.id);
    expect(model.alerts.some((a) => a.fingerprint === attributed.fingerprint && a.acked === true)).toBe(true);
    const root = await mountDrawer(model);
    expect(all(root, "[data-acked]").length).toBe(1);
  });
});
