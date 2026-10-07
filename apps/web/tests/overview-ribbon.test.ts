// apps/web/tests/overview-ribbon.test.ts — the firing ribbon. Desk/mobile triage
// actions go through a mock PathRouter and are asserted against exact encoded paths; kiosk is a
// text-only summary with no interactive/focusable descendant; the rendered list is exactly the
// snapshot's firing list (no client re-filter). Renders via describeDom + renderWithStore.

import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import { act } from "./react-render.js";

import type { OverviewAlertSummary, OverviewSnapshotV2 } from "@pulse/web-data/wire";
import { ALERT_SEVERITY } from "@/ui";
import { createEstateClock } from "../src/client/format.js";
import type { PathRouter, RouteMatch } from "../src/client/router.js";
import { KIOSK_ALERT_NAME_LIMIT } from "../src/client/views/overview/model.js";
import {
  ALERT_STATE_STALE_TEXT,
  FiringRibbon,
  NO_FIRING_ALERTS_TEXT,
  type FiringRibbonProps,
} from "../src/client/views/overview/ribbon/FiringRibbon.js";
import { DEFAULT_OVERVIEW_PREFERENCES } from "../src/client/views/overview/model.js";
import { buildKioskFiringSummary, countAcked, deriveOverviewModel, deriveOverviewStats } from "../src/client/views/overview/selectors.js";
import { StatHeader } from "../src/client/views/overview/stats/StatHeader.js";
import { FIXTURE_ESTATE, makeEnvelopeOverviewSnapshot, makeOverviewSnapshot } from "./fixtures/overview/factory.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, renderWithStore } from "./dom.js";

isolateDomGlobals();

const CLOCK = createEstateClock(FIXTURE_ESTATE);
const STALE_AT = "2026-09-01T11:40:00.000Z";

interface MockRouter extends PathRouter {
  readonly calls: string[];
}

function mockRouter(): MockRouter {
  const calls: string[] = [];
  const match: RouteMatch = { path: "/", view: "overview", params: {}, query: {} };
  return {
    calls,
    current: () => match,
    navigate: (path: string) => {
      calls.push(path);
    },
    subscribe: () => () => {},
    stop: () => {},
  };
}

function alert(over: Partial<OverviewAlertSummary> & Pick<OverviewAlertSummary, "fingerprint" | "name">): OverviewAlertSummary {
  return { severity: "warning", startsAt: "2026-09-01T11:00:00.000Z", target: null, ...over };
}

const mounted: Array<{ unmount(): void }> = [];

afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
});

async function mountRibbon(overrides: Partial<FiringRibbonProps> & Pick<FiringRibbonProps, "alerts">): Promise<{ root: HTMLElement; router: MockRouter }> {
  const router = mockRouter();
  const props: FiringRibbonProps = {
    router,
    clock: CLOCK,
    kiosk: false,
    alertsCurrent: true,
    alertsLastGoodAt: null,
    ...overrides,
  };
  let result!: Awaited<ReturnType<typeof renderWithStore>>;
  await act(async () => {
    result = await renderWithStore(createElement(FiringRibbon, props) as unknown as ReactElement);
  });
  mounted.push(result);
  return { root: result.container, router };
}

const ROW = "[data-ribbon] li[data-fingerprint]";
const ALERT_ACTION = "[data-ribbon-action='alert']";
const TARGET_ACTION = "[data-ribbon-action='target']";

function click(el: Element | null): void {
  if (el === null) throw new Error("missing element");
  act(() => {
    (el as HTMLElement).click();
  });
}

describeDom("FiringRibbon — desk/mobile triage navigation", () => {
  test("alert action navigates to the exact encoded fingerprint path", async () => {
    const a = alert({ fingerprint: "fp/1 a&b?", name: "DiskFull", target: { kind: "host", id: "host:host-001" } });
    const { root, router } = await mountRibbon({ alerts: [a] });
    click(root.querySelector(ALERT_ACTION));
    expect(router.calls).toEqual(["/alerts/fp%2F1%20a%26b%3F"]);
  });

  test("target action navigates to the exact encoded TargetIdentity.id path", async () => {
    const a = alert({ fingerprint: "abc", name: "SvcDown", target: { kind: "service", id: "svc:host-001/api v2&x" } });
    const { root, router } = await mountRibbon({ alerts: [a] });
    const targetButton = root.querySelector(TARGET_ACTION);
    expect(targetButton?.getAttribute("aria-label")).toBe("Alerts for target svc:host-001/api v2&x");
    click(targetButton);
    expect(router.calls).toEqual(["/alerts?target=svc%3Ahost-001%2Fapi%20v2%26x"]);
  });

  test("fixture alerts: every alert and target action uses the canonical helpers", async () => {
    const snapshot = makeOverviewSnapshot();
    const { root, router } = await mountRibbon({ alerts: snapshot.alerts });
    const items = Array.from(root.querySelectorAll(ROW));
    for (const [i, item] of items.entries()) {
      const a = snapshot.alerts[i]!;
      click(item.querySelector(ALERT_ACTION));
      expect(router.calls.at(-1)).toBe(`/alerts/${encodeURIComponent(a.fingerprint)}`);
      if (a.target !== null) {
        click(item.querySelector(TARGET_ACTION));
        expect(router.calls.at(-1)).toBe(`/alerts?target=${encodeURIComponent(a.target.id)}`);
      }
    }
  });

  test("a null-target alert renders no target link but keeps its alert action", async () => {
    const a = alert({ fingerprint: "watch", name: "WatchdogInfo", severity: "info", target: null });
    const { root, router } = await mountRibbon({ alerts: [a] });
    expect(root.querySelector(TARGET_ACTION)).toBeNull();
    const buttons = Array.from(root.querySelectorAll("button"));
    expect(buttons.length).toBe(1);
    click(buttons[0]!);
    expect(router.calls).toEqual(["/alerts/watch"]);
  });

  test("the fixture's unattributed info alert has no target link", async () => {
    const snapshot = makeOverviewSnapshot();
    const { root } = await mountRibbon({ alerts: snapshot.alerts });
    const info = snapshot.alerts.find((a) => a.target === null)!;
    const item = root.querySelector(`${ROW}[data-fingerprint="${info.fingerprint}"]`)!;
    expect(item.querySelector(ALERT_ACTION)).not.toBeNull();
    expect(item.querySelector(TARGET_ACTION)).toBeNull();
  });

  test("accessible names carry alert name, severity, start and target", async () => {
    const a = alert({ fingerprint: "x", name: "HostDown", severity: "critical", target: { kind: "host", id: "host:host-003" } });
    const { root } = await mountRibbon({ alerts: [a] });
    expect(root.querySelector(ALERT_ACTION)?.getAttribute("aria-label")).toBe(
      "Open alert HostDown, Critical, Started 2026-09-01 11:00:00 UTC, target host:host-003",
    );
  });

  test("alert/target actions are named buttons meeting the 44px touch minimum", async () => {
    const a = alert({ fingerprint: "x", name: "HostDown", severity: "critical", target: { kind: "host", id: "host:host-003" } });
    const { root } = await mountRibbon({ alerts: [a] });
    for (const sel of [ALERT_ACTION, TARGET_ACTION]) {
      const el = root.querySelector(sel)!;
      expect(el.tagName).toBe("BUTTON");
      expect(el.getAttribute("aria-label")).not.toBe("");
      expect(el.className).toContain("min-h-11");
      expect(el.className).toContain("min-w-11");
    }
  });

  test("severity badges come from ALERT_SEVERITY; info keeps the info tone", async () => {
    const alerts = [
      alert({ fingerprint: "c", name: "C", severity: "critical" }),
      alert({ fingerprint: "w", name: "W", severity: "warning" }),
      alert({ fingerprint: "i", name: "I", severity: "info" }),
    ];
    const { root } = await mountRibbon({ alerts });
    for (const a of alerts) {
      const badge = root.querySelector(`${ROW}[data-fingerprint="${a.fingerprint}"] [data-slot="status-badge"]`)!;
      expect(badge.getAttribute("data-severity")).toBe(a.severity);
      expect(badge.getAttribute("data-tone")).toBe(ALERT_SEVERITY[a.severity].tone);
      expect(badge.querySelector("svg")).not.toBeNull();
      expect(badge.textContent).toBe(ALERT_SEVERITY[a.severity].label);
    }
    expect(root.querySelector(`${ROW}[data-fingerprint="i"] [data-slot="status-badge"]`)?.getAttribute("data-tone")).toBe("info");
  });

  test("the alert name carries the summary tooltip only when a summary exists", async () => {
    const alerts = [
      alert({ fingerprint: "s", name: "WithSummary", summary: "Disk at 97%" }),
      alert({ fingerprint: "n", name: "NoSummary", summary: "" }),
    ];
    const { root } = await mountRibbon({ alerts });
    expect(root.querySelector(`${ROW}[data-fingerprint="s"] ${ALERT_ACTION}`)?.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(root.querySelector(`${ROW}[data-fingerprint="n"] ${ALERT_ACTION}`)?.getAttribute("data-slot")).toBe("button");
  });

  test("desk ribbon is a region headed 'Firing alerts (n)'", async () => {
    const { root } = await mountRibbon({ alerts: makeOverviewSnapshot().alerts });
    const ribbon = root.querySelector("section[data-ribbon='desk']")!;
    expect(ribbon.getAttribute("aria-label")).toBe("Firing alerts");
    expect(ribbon.querySelector("h2")?.textContent).toBe(`Firing alerts (${makeOverviewSnapshot().alerts.length})`);
  });

  test("a missing fingerprint renders non-interactive content and invents no path", async () => {
    const a = alert({ fingerprint: "", name: "Broken", target: null });
    const { root, router } = await mountRibbon({ alerts: [a] });
    expect(root.querySelector("button")).toBeNull();
    expect(root.textContent).toContain("Broken");
    expect(router.calls).toEqual([]);
  });

  test("the ribbon exposes no silence/ack/edit/mutation control", async () => {
    const { root } = await mountRibbon({ alerts: makeOverviewSnapshot().alerts });
    for (const el of Array.from(root.querySelectorAll("button, a, [role='button'], [role='menuitem']"))) {
      const name = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`;
      expect(name).not.toMatch(/silence|acknowledge|\back\b|edit|delete|mutate|post/i);
    }
    expect(root.querySelector("form, input, select, textarea, a")).toBeNull();
  });
});

describeDom("FiringRibbon — no client re-filtering", () => {
  test("exactly the snapshot's firing summaries render, in snapshot order", async () => {
    const snapshot = makeEnvelopeOverviewSnapshot();
    expect(snapshot.alertCounts.silenced).toBeGreaterThan(0);
    const { root } = await mountRibbon({ alerts: snapshot.alerts });
    const fingerprints = Array.from(root.querySelectorAll(ROW)).map((li) => li.getAttribute("data-fingerprint"));
    expect(fingerprints).toEqual(snapshot.alerts.map((a) => a.fingerprint));
    expect(root.querySelectorAll(`${ROW}[data-severity="info"]`).length).toBe(
      snapshot.alerts.filter((a) => a.severity === "info").length,
    );
  });

  test("duplicate names/targets are not deduplicated", async () => {
    const target = { kind: "host", id: "host:host-001" } as const;
    const alerts = [
      alert({ fingerprint: "a", name: "Same", target }),
      alert({ fingerprint: "b", name: "Same", target }),
      alert({ fingerprint: "c", name: "Same", severity: "info", target }),
    ];
    const { root } = await mountRibbon({ alerts });
    expect(root.querySelectorAll(ROW).length).toBe(3);
    const kiosk = await mountRibbon({ alerts, kiosk: true });
    expect(Array.from(kiosk.root.querySelectorAll("[data-ribbon-name]")).map((n) => n.textContent)).toEqual(["Same", "Same", "Same"]);
  });
});

describeDom("FiringRibbon — empty and stale alert evidence", () => {
  test("an empty list with current evidence is affirmatively 'No firing alerts'", async () => {
    const { root } = await mountRibbon({ alerts: [] });
    expect(root.textContent).toContain(NO_FIRING_ALERTS_TEXT);
    expect(root.textContent).not.toContain(ALERT_STATE_STALE_TEXT);
  });

  test("an empty list with non-current evidence is stale/unavailable with last-good, never 'No firing alerts'", async () => {
    const { root } = await mountRibbon({ alerts: [], alertsCurrent: false, alertsLastGoodAt: STALE_AT });
    expect(root.textContent).not.toContain(NO_FIRING_ALERTS_TEXT);
    expect(root.textContent).toContain(ALERT_STATE_STALE_TEXT);
    expect(root.textContent).toContain("Last good 2026-09-01 11:40:00 UTC");
    const kiosk = await mountRibbon({ alerts: [], alertsCurrent: false, alertsLastGoodAt: null, kiosk: true });
    expect(kiosk.root.textContent).not.toContain(NO_FIRING_ALERTS_TEXT);
    expect(kiosk.root.textContent).toContain("No successful observation");
  });

  test("retained alerts stay visible with the stale treatment", async () => {
    const snapshot = makeOverviewSnapshot();
    const { root } = await mountRibbon({ alerts: snapshot.alerts, alertsCurrent: false, alertsLastGoodAt: STALE_AT });
    expect(root.querySelector("[data-ribbon]")?.getAttribute("data-alerts-current")).toBe("false");
    // A static note, never an announced alert.
    const stale = root.querySelector("[data-ribbon-stale]")!;
    expect(stale.getAttribute("role")).toBe("note");
    expect(stale.getAttribute("data-alerts-current")).toBe("false");
    expect(root.querySelector("[role='alert']")).toBeNull();
    expect(root.querySelectorAll(ROW).length).toBe(snapshot.alerts.length);
    expect(root.textContent).toContain(ALERT_STATE_STALE_TEXT);
  });
});

describeDom("FiringRibbon — kiosk summary", () => {
  function sixAlerts(): OverviewAlertSummary[] {
    // Deliberately unsorted input; expected order: critical (oldest first), warning, info.
    return [
      alert({ fingerprint: "f6", name: "InfoOne", severity: "info", startsAt: "2026-09-01T10:00:00.000Z" }),
      alert({ fingerprint: "f2", name: "WarnOld", severity: "warning", startsAt: "2026-09-01T09:00:00.000Z" }),
      alert({ fingerprint: "f1", name: "CritNew", severity: "critical", startsAt: "2026-09-01T11:00:00.000Z" }),
      alert({ fingerprint: "f0", name: "CritOld", severity: "critical", startsAt: "2026-09-01T08:00:00.000Z" }),
      alert({ fingerprint: "f4", name: "WarnB", severity: "warning", startsAt: "2026-09-01T10:30:00.000Z" }),
      alert({ fingerprint: "f3", name: "WarnA", severity: "warning", startsAt: "2026-09-01T10:30:00.000Z" }),
    ];
  }

  test("counts, at most five ordered names and exact '+1 more'", async () => {
    const alerts = sixAlerts();
    const { root } = await mountRibbon({ alerts, kiosk: true });
    expect(root.querySelector("[data-ribbon-counts]")?.textContent).toBe("Critical 2 · Warning 3 · Info 1");
    const names = Array.from(root.querySelectorAll("[data-ribbon-name]")).map((n) => n.textContent);
    expect(names).toEqual(["CritOld", "CritNew", "WarnOld", "WarnA", "WarnB"]);
    expect(names.length).toBe(KIOSK_ALERT_NAME_LIMIT);
    expect(root.querySelector("[data-ribbon-overflow]")?.textContent).toBe("+1 more");
  });

  test("envelope: counts cover every alert and overflow is exact", async () => {
    const snapshot = makeEnvelopeOverviewSnapshot();
    const { root } = await mountRibbon({ alerts: snapshot.alerts, kiosk: true });
    const summary = buildKioskFiringSummary(snapshot.alerts);
    expect(Array.from(root.querySelectorAll("[data-ribbon-name]")).map((n) => n.textContent)).toEqual([...summary.names]);
    expect(root.querySelector("[data-ribbon-overflow]")?.textContent).toBe(`+${snapshot.alerts.length - KIOSK_ALERT_NAME_LIMIT} more`);
    expect(root.querySelector("[data-ribbon-counts]")?.textContent).toBe(
      `Critical ${summary.counts.critical} · Warning ${summary.counts.warning} · Info ${summary.counts.info}`,
    );
  });

  test("no overflow text when every alert fits", async () => {
    const { root } = await mountRibbon({ alerts: sixAlerts().slice(0, 5), kiosk: true });
    expect(root.querySelectorAll("[data-ribbon-name]").length).toBe(5);
    expect(root.querySelector("[data-ribbon-overflow]")).toBeNull();
  });

  test("kiosk has no button, link, role=button, tabindex or handler and never navigates", async () => {
    const snapshot = makeEnvelopeOverviewSnapshot();
    const { root, router } = await mountRibbon({ alerts: snapshot.alerts, kiosk: true });
    const ribbon = root.querySelector("[data-ribbon]")!;
    expect(ribbon.getAttribute("data-kiosk")).toBe("true");
    expect(ribbon.querySelectorAll("button, a, [role='button'], [tabindex], [href]").length).toBe(0);
    for (const el of Array.from(ribbon.querySelectorAll("*"))) {
      (el as HTMLElement).click();
    }
    expect(router.calls).toEqual([]);
  });

  test("the input array is not mutated by kiosk ordering", async () => {
    const alerts = sixAlerts();
    const before = alerts.map((a) => a.fingerprint);
    await mountRibbon({ alerts: Object.freeze(alerts) as readonly OverviewAlertSummary[], kiosk: true });
    expect(alerts.map((a) => a.fingerprint)).toEqual(before);
  });

  test("the stat header beside the kiosk ribbon keeps its surface state and repeats no feed line", async () => {
    const snapshot: OverviewSnapshotV2 = makeOverviewSnapshot();
    const router = mockRouter();
    let result!: Awaited<ReturnType<typeof renderWithStore>>;
    await act(async () => {
      result = await renderWithStore(
        createElement("div", null,
          createElement(StatHeader, {
            stats: deriveOverviewStats(snapshot),
            surface: { status: "stale", snapshot, stale: true, lastGoodAt: Date.parse(STALE_AT) },
            clock: CLOCK,
          }),
          createElement(FiringRibbon, { alerts: snapshot.alerts, router, clock: CLOCK, kiosk: true, alertsCurrent: true, alertsLastGoodAt: null }),
        ) as unknown as ReactElement,
      );
    });
    mounted.push(result);
    expect(result.container.querySelector('section[aria-label="Estate statistics"]')?.getAttribute("data-surface")).toBe("stale");
    // Live/Stale + update time is the shell's top-bar indicator (rendered in kiosk too).
    expect(result.container.querySelector("[data-feed]")).toBeNull();
    expect(result.container.querySelector('[data-ribbon="kiosk"]')).not.toBeNull();
  });
});

describeDom("FiringRibbon — read-only acked marker (REQ-ACK-07d, REQ-AUTHZ-05)", () => {
  test("an acked desk row shows 'Acknowledged' with a circle-check glyph after the name, before the start", async () => {
    const a = alert({ fingerprint: "fp-acked", name: "DiskFull", acked: true });
    const { root } = await mountRibbon({ alerts: [a] });
    const marker = root.querySelector(`${ROW} [data-acked]`);
    expect(marker?.textContent).toBe("Acknowledged");
    expect(marker?.querySelector("svg")?.getAttribute("class") ?? "").toContain("circle-check");
    expect(marker?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const item = root.querySelector(ROW)!;
    const children = Array.from(item.children);
    const at = children.findIndex((el) => el.hasAttribute("data-acked"));
    expect(at).toBeGreaterThan(0);
    expect(children[at - 1]?.getAttribute("data-ribbon-action")).toBe("alert");
    expect(children[at + 1]?.hasAttribute("data-started")).toBe(true);
  });

  test("the marker is never an affordance: no button/a/input and not focusable (REQ-AUTHZ-05)", async () => {
    const { root } = await mountRibbon({ alerts: [alert({ fingerprint: "fp-acked", name: "DiskFull", acked: true })] });
    const marker = root.querySelector("[data-acked]")!;
    expect(marker.tagName).toBe("SPAN");
    expect(marker.querySelectorAll("button, a, input, [tabindex], [href], [role='button']").length).toBe(0);
    expect(marker.hasAttribute("tabindex")).toBe(false);
  });

  test("an alert without acked renders no marker (REQ-ACK-07d)", async () => {
    const { root } = await mountRibbon({ alerts: [alert({ fingerprint: "fp-plain", name: "DiskFull" })] });
    expect(root.querySelector("[data-acked]")).toBeNull();
    expect(root.textContent).not.toContain("Acknowledged");
  });

  test("fixture snapshot (no acked keys) renders no marker anywhere", async () => {
    const { root } = await mountRibbon({ alerts: makeOverviewSnapshot().alerts });
    expect(root.querySelector("[data-acked]")).toBeNull();
  });
});

describe("overview selectors — acked carried through (REQ-ACK-07d)", () => {
  test("countAcked counts only acked === true summaries", () => {
    expect(countAcked([])).toBe(0);
    expect(
      countAcked([
        alert({ fingerprint: "a", name: "A", acked: true }),
        alert({ fingerprint: "b", name: "B" }),
        alert({ fingerprint: "c", name: "C", acked: true }),
      ]),
    ).toBe(2);
  });

  test("a newly acked alert is not replaced by its prior un-acked reference across cycles", () => {
    const base = makeOverviewSnapshot();
    const first = base.alerts[0]!;
    const acked: OverviewSnapshotV2 = { ...base, alerts: [{ ...first, acked: true }, ...base.alerts.slice(1)] };
    const prior = deriveOverviewModel(base, DEFAULT_OVERVIEW_PREFERENCES);
    const next = deriveOverviewModel(acked, DEFAULT_OVERVIEW_PREFERENCES, prior);
    expect(next.firing[0]?.acked).toBe(true);
    const back = deriveOverviewModel(base, DEFAULT_OVERVIEW_PREFERENCES, next);
    expect(back.firing[0]?.acked).toBeUndefined();
  });
});
