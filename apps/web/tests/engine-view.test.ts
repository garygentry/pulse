// apps/web/tests/engine-view.test.ts — engine view DOM tests. This file currently covers the
// presentational components (components.tsx, verdict-banner.tsx, pipeline.tsx) and the scrape/rules
// disclosures (scrape.tsx, rules.tsx), rendered directly with renderWithStore(vnode), and the full
// EngineView (view.tsx) mounted per the 08 §4.1 router/kiosk setup. The lazy chart is stubbed per
// 08 §4.1 (one shared StubChart, one top-level mock.module, the real module re-mocked in afterAll)
// and the five trend routes go through installHistoryStub.

import { afterAll, afterEach, beforeAll, expect, jest, mock, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, render as reactRender } from "./react-render.js";
import type { ReactElement } from "react";

import type { DataAvailability, EngineComponent, EnginePayload } from "@pulse/web-data/wire";
import { createEstateClock } from "../src/client/format.js";
import { Icon } from "../src/client/ui/index.js";
import type { IconName } from "../src/client/ui/index.js";
import { TARGET_STATUS } from "@/ui";
import {
  ComponentCards, ErrorDetail, ErrorText, LastKnown, NotReported,
  SourceDegradedBadge, ValueText,
} from "../src/client/views/engine/components.js";
import { healthText, presentationLabel } from "../src/client/views/engine/presentation.js";
import { VERDICT_ICON, VerdictBanner } from "../src/client/views/engine/verdict-banner.js";
import { bannerSummary } from "../src/client/views/engine/verdict.js";
import type { BannerVerdict } from "../src/client/views/engine/verdict.js";
import {
  CapacityTiles, DeadmanPanel, NotificationTiles, TileValueView,
} from "../src/client/views/engine/pipeline.js";
import { CAPACITY_FORMAT, NOTIFICATION_FORMAT } from "../src/client/views/engine/pipeline-format.js";
import {
  CAPACITY_TILE_LABEL, HEALTH_TEXT, NOT_REPORTED, NO_LAST_GOOD, PRESENTATION_ICON, UNAVAILABLE, componentPresentation, degradedText,
} from "../src/client/views/engine/labels.js";
import { canaryRule, capacityTiles, notificationSection, ruleSection, scrapeSection } from "../src/client/views/engine/model.js";
import type { ScrapeTarget } from "../src/client/views/engine/model.js";
import { ScrapeJob, ScrapeJobs } from "../src/client/views/engine/scrape.js";
import { TARGET_HEALTH, orderTargets } from "../src/client/views/engine/scrape-model.js";
import { RULE_CATALOG_HREF, RuleGroup, RuleGroups } from "../src/client/views/engine/rules.js";
import { estateHostPath } from "../src/client/views/engine/scrape-match.js";
import { presentVerdict } from "../src/client/views/engine/verdict.js";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import { createPathRouter } from "../src/client/router.js";
import type { PathRouter } from "../src/client/router.js";
import type { ViewRotationContext } from "../src/shared/registry.js";
import { REFRESH_INTERVAL_MS } from "../src/shared/constants.js";
import { CLIENT_QUERY_META, ENGINE_TREND_QUERIES } from "../src/client/views/_shared/timeseries/query-meta.js";
import { LIVE_REFRESH_MS } from "../src/client/views/_shared/timeseries/history/client.js";
import { isolateDomGlobals, realGlobal } from "./alerts-dom-isolation.js";
import { describeDom, renderWithStore, restoreRealTimers } from "./dom.js";
import type { RenderResult } from "./dom.js";
import {
  ENGINE_NOW_ISO, ENGINE_SCENARIOS, degradedEngine, delivery, makeComponent, makeEngineSnapshot, makeEnginePayload, makeObservation, okEngine,
} from "./engine-fixtures.js";
import { StubChart, resetChartStub } from "./chart-stub.js";
import { installUiStubs } from "./rtl.js";
import { installHistoryStub, makeSeriesHistory } from "./timeline-fixtures.js";
import type { StubRoute } from "./timeline-fixtures.js";

isolateDomGlobals();

const CHART = "../src/client/ui/viz/uplot-chart.js";
const realChart = { ...(await import(CHART)) };
mock.module(CHART, () => ({ default: StubChart }));
afterEach(() => {
  resetChartStub();
});
afterAll(() => {
  mock.module(CHART, () => realChart);
});

/** `createElement` typed to return a plain element (exactOptionalPropertyTypes rejects ReactElement<P> → ReactElement<{}>). */
const el = createElement as unknown as (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ReactElement;

const clock = createEstateClock({ name: "", timezone: "America/Chicago", tzFallback: false });
const LAST_GOOD_ISO = "2026-09-24T11:55:00.000Z";

/** Flush React's scheduled re-render (inside act()). */
async function flush(): Promise<void> {
  // React runs non-urgent updates on a scheduler task; act() flushes them with the microtasks.
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const mounted: RenderResult[] = [];
async function render(vnode: ReactElement): Promise<HTMLElement> {
  const r = await renderWithStore(vnode);
  mounted.push(r);
  return r.container;
}

const text = (n: Element | null | undefined): string => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const all = (root: ParentNode, sel: string): Element[] => Array.from(root.querySelectorAll(sel));

/** The lucide icon class of the first svg inside `root` (e.g. "lucide-wifi-off"). */
function iconOf(root: Element): string | null {
  const cls = root.querySelector("svg")?.getAttribute("class") ?? "";
  return /\blucide-[a-z0-9-]+/.exec(cls)?.[0] ?? null;
}

/** The lucide icon class that `Icon` renders for a curated name (lucide may alias names). */
function iconClass(name: IconName): string | null {
  const host = document.createElement("div");
  reactRender(el(Icon, { name }), host as unknown as Element);
  const out = iconOf(host as unknown as Element);
  reactRender(null, host as unknown as Element);
  return out;
}

/** A `@/ui` StatusBadge (each carries `data-status`). */
const BADGE = '[data-slot="status-badge"]';
/** The source-named degraded notice. */
const DEGRADED = "[data-availability]";

/** The section named `name` (a `section` labelled by its own h2 or aria-label). */
function sectionNamed(root: ParentNode, name: string): Element {
  const nameOf = (s: Element): string | null => {
    const id = s.getAttribute("aria-labelledby");
    return id === null ? s.getAttribute("aria-label") : text(s.ownerDocument.getElementById(id));
  };
  const hit = all(root, "section").find((s) => nameOf(s) === name);
  if (hit === undefined) throw new Error(`no section named ${name}`);
  return hit;
}

/** The `dd` paired with the `dt` whose text is `label`, inside `root`. */
function valueFor(root: ParentNode, label: string): Element | null {
  const dt = all(root, "dt").find((d) => text(d) === label);
  return dt?.nextElementSibling ?? null;
}

/** The ErrorText disclosure buttons under `root`, in document order. */
function errorToggles(root: ParentNode): HTMLButtonElement[] {
  return all(root, "[data-error-text]")
    .map((span) => span.closest("button"))
    .filter((b): b is HTMLButtonElement => b !== null);
}

/** The open ErrorDetail regions under `root`. */
const errorDetails = (root: ParentNode): Element[] =>
  all(root, '[role="region"]').filter((r) => (r.getAttribute("aria-label") ?? "").startsWith("Full last error for "));

function unavailable(source: DataAvailability["source"], lastGoodAt: string | null): DataAvailability {
  return { source, state: "unavailable", lastGoodAt, message: null };
}

describeDom("engine components", () => {
  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.unmount();
  });

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  test("REQ-COMP-03: NotReported/ValueText/LastKnown render the shared not-reported and last-known elements", async () => {
    const c = await render(el("div", null,
      el(NotReported, null),
      el(ValueText, { text: NOT_REPORTED, lastKnown: true }),
      el(ValueText, { text: "v1.2.3", lastKnown: true }),
      el(ValueText, { text: "0 s", lastKnown: false }),
      el(LastKnown, null),
    ));
    const nr = all(c, "[data-not-reported]");
    expect(nr).toHaveLength(2);
    for (const n of nr) expect(text(n)).toBe("not reported");
    expect(all(c, "[data-last-known]")).toHaveLength(2);
    const values = all(c, "[data-value]").map(text);
    expect(values).toEqual(["v1.2.3 last known", "0 s"]);
  });

  test("REQ-DEGRADE-01: SourceDegradedBadge is null when current and source-named otherwise", async () => {
    const current: DataAvailability = { source: "alertmanager-status", state: "current", lastGoodAt: ENGINE_NOW_ISO, message: null };
    const down: DataAvailability = { source: "alertmanager-status", state: "unavailable", lastGoodAt: LAST_GOOD_ISO, message: "connect refused" };
    const c = await render(el("div", null,
      el(SourceDegradedBadge, { availability: current, clock }),
      el(SourceDegradedBadge, { availability: down, clock }),
    ));
    const badges = all(c, DEGRADED);
    expect(badges).toHaveLength(1);
    const b = badges[0]!;
    expect(b.getAttribute("data-availability")).toBe("unavailable");
    expect(b.getAttribute("data-source")).toBe("alertmanager-status");
    expect(b.getAttribute("data-status")).toBe("unknown");
    // A static note, never a live alert.
    expect(b.getAttribute("role")).toBe("note");
    expect(all(c, '[role="alert"]')).toHaveLength(0);
    expect(text(b)).toContain(degradedText(down, clock.format)!);
    expect(iconOf(b)).toBe(iconClass("triangle-alert"));
    expect(text(b.querySelector("[data-degraded-detail]"))).toBe("connect refused");
  });

  test("REQ-A11Y-01: healthText is total and agrees with HEALTH_TEXT", () => {
    expect(healthText("healthy")).toBe(HEALTH_TEXT.healthy);
    expect(healthText("not-configured")).toBe("Not configured");
    expect(healthText("bogus")).toBe("Unknown");
    expect(healthText("toString")).toBe("Unknown");
  });

  test("REQ-SCRAPE-03: ErrorText is a disclosure button with a focus tooltip, or a plain span without onToggle", async () => {
    // Radix portals the tooltip into document.body once its layout effect runs; install the
    // happy-dom stubs before mounting so the hook binding is stable for the tree's lifetime.
    const restoreUi = installUiStubs();
    let toggles = 0;
    const c = await render(el("div", null,
      el(ErrorText, { text: "boom", expanded: false, detailId: "d1", onToggle: () => { toggles++; } }),
      el(ErrorText, { text: "kiosk boom", expanded: false, detailId: "d2", onToggle: null }),
      el(ErrorDetail, { id: "d1", owner: "web01:9100", text: "boom full" }),
    ));
    const btn = c.querySelector("button[aria-controls]")!;
    expect(text(btn)).toBe("boom");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe("d1");
    expect(all(c, "button")).toHaveLength(1);
    // The kiosk form is plain text: the full string stays in the DOM, only visually truncated.
    expect(all(c, "[data-error-text]").map(text)).toEqual(["boom", "kiosk boom"]);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    try {
      await act(async () => {
        (btn as HTMLElement).focus();
      });
      await flush();
      expect(text(document.querySelector('[role="tooltip"]'))).toBe("boom");
    } finally {
      restoreUi();
    }
    (btn as HTMLElement).click();
    expect(toggles).toBe(1);
    const detail = c.querySelector("#d1")!;
    expect(detail.getAttribute("role")).toBe("region");
    expect(detail.getAttribute("aria-label")).toBe("Full last error for web01:9100");
    expect(text(detail.querySelector("[data-error-owner]"))).toBe("web01:9100");
    expect(text(detail.querySelector("[data-error-full]"))).toBe("boom full");
  });

  // -------------------------------------------------------------------------
  // Component cards
  // -------------------------------------------------------------------------

  test("REQ-COMP-01: cards render one li[data-component] per component in payload order", async () => {
    const base = okEngine();
    const reversed = [...base.components].reverse();
    const c = await render(el(ComponentCards, { components: reversed, clock, notCurrent: false }));
    expect(all(c, "li[data-component]").map((li) => li.getAttribute("data-component"))).toEqual(reversed.map((x) => x.id));
    const section = sectionNamed(c, "Components");
    expect(text(section.querySelector("h2"))).toBe("Components");
    // Each card is an article named "<name>: <badge label>" with an h3 name.
    const vm = c.querySelector('li[data-component="victoriametrics"] [role="article"]')!;
    expect(vm.getAttribute("aria-label")).toBe("VictoriaMetrics: Healthy");
    expect(text(vm.querySelector("h3"))).toBe("VictoriaMetrics");
  });

  test("REQ-COMP-01: an empty component list renders the EmptyState", async () => {
    const c = await render(el(ComponentCards, { components: [], clock, notCurrent: false }));
    expect(text(c.querySelector('[role="status"]'))).toContain("No engine components reported");
    expect(all(c, "li[data-component]")).toHaveLength(0);
  });

  test("REQ-COMP-02: healthy, unhealthy, unknown and not-configured are four distinct presentations, statuses and icons", async () => {
    const components: EngineComponent[] = [
      makeComponent("victoriametrics"),
      makeComponent("vmalert", { state: "unhealthy", availability: { lastGoodAt: LAST_GOOD_ISO } }),
      makeComponent("alertmanager", { state: "unknown", availability: { lastGoodAt: null } }),
      makeComponent("grafana", { state: "not-configured" }),
    ];
    const c = await render(el(ComponentCards, { components, clock, notCurrent: false }));
    const headers = all(c, "[data-presentation]");
    expect(headers.map((x) => x.getAttribute("data-presentation"))).toEqual(["healthy", "unreachable", "unknown", "not-configured"]);
    const chips = headers.map((x) => x.querySelector(BADGE)!);
    const statuses = chips.map((x) => x.getAttribute("data-status"));
    // not-configured shares the unknown status and is told apart by its icon and word.
    expect(statuses).toEqual(["ok", "critical", "unknown", "unknown"]);
    const icons = chips.map(iconOf);
    expect(icons.every((i) => i !== null)).toBe(true);
    expect(icons).toEqual((["circle-check", "wifi-off", "circle-help", "minus"] as const).map(iconClass));
    expect(new Set(icons).size).toBe(4);

    const labels = chips.map(text);
    expect(new Set(labels).size).toBe(4);
    expect(labels[0]).toContain("Healthy");
    expect(labels[1]).toMatch(new RegExp(`Unreachable — last good ${clock.format(LAST_GOOD_ISO).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    expect(labels[2]).toMatch(new RegExp(`Unknown — ${NO_LAST_GOOD}$`));
    expect(labels[3]).toBe("Not configured");
    expect(text(c.querySelector('[data-component="grafana"]'))).toContain("Not configured in this estate.");
    expect(c.querySelector(`[data-component="grafana"] ${DEGRADED}`)).toBeNull();
    // Not configured has no "Last good" fact.
    expect(valueFor(c.querySelector('[data-component="grafana"]')!, "Last good")).toBeNull();
    expect(valueFor(c.querySelector('[data-component="vmalert"]')!, "Last good")).not.toBeNull();
  });

  test("REQ-COMP-02: presentationLabel suffixes every non-healthy, configured kind", () => {
    const withLast = componentPresentation(makeComponent("vmalert", { state: "unhealthy", availability: { lastGoodAt: LAST_GOOD_ISO } }));
    expect(presentationLabel(withLast, clock.format)).toBe(`Unreachable — last good ${clock.format(LAST_GOOD_ISO)}`);
    const healthy = componentPresentation(makeComponent("vmalert"));
    expect(presentationLabel(healthy, clock.format)).toBe("Healthy");
    const nc = componentPresentation(makeComponent("grafana", { state: "not-configured" }));
    expect(presentationLabel(nc, clock.format)).toBe("Not configured");
    expect(Object.keys(PRESENTATION_ICON).sort()).toEqual(["healthy", "not-configured", "stale", "unknown", "unreachable"]);
  });

  test("REQ-COMP-03: null version/uptime render [data-not-reported] 'not reported', never 0", async () => {
    const c = await render(el(ComponentCards, { components: okEngine().components, clock, notCurrent: false }));
    const nr = all(c, "[data-not-reported]");
    expect(nr.length).toBeGreaterThanOrEqual(4);
    for (const n of nr) expect(text(n)).toBe("not reported");
    for (const id of ["grafana", "web"]) {
      const uptime = valueFor(c.querySelector(`[data-component="${id}"]`)!, "Uptime");
      expect(uptime?.querySelector("[data-not-reported]")).not.toBeNull();
    }
    for (const id of ["vmalert", "gatus"]) {
      const version = valueFor(c.querySelector(`[data-component="${id}"]`)!, "Version");
      expect(version?.querySelector("[data-not-reported]")).not.toBeNull();
    }
    for (const dd of all(c, "dd")) expect(text(dd)).not.toBe("0");
  });

  test("REQ-COMP-04 / REQ-DEGRADE-01: a non-current source shows the degradedText badge and values carry [data-last-known]", async () => {
    const outage = ENGINE_SCENARIOS.sourceOutage();
    const c = await render(el(ComponentCards, { components: outage.components, clock, notCurrent: false }));
    const vm = c.querySelector('[data-component="victoriametrics"]')!;
    const badge = vm.querySelector(DEGRADED);
    const comp = outage.components.find((x) => x.id === "victoriametrics")!;
    expect(badge?.getAttribute("data-source")).toBe(comp.availability.source);
    expect(text(badge)).toContain(degradedText(comp.availability, clock.format)!);
    expect(vm.querySelectorAll("[data-last-known]").length).toBeGreaterThan(0);
    // web stays current: no badge, no qualifier.
    const web = c.querySelector('[data-component="web"]')!;
    expect(web.querySelector(DEGRADED)).toBeNull();
    expect(web.querySelector("[data-last-known]")).toBeNull();
  });

  test("REQ-EFRESH-02: with notCurrent=true no card shows Healthy", async () => {
    const c = await render(el(ComponentCards, { components: okEngine().components, clock, notCurrent: true }));
    expect(all(c, "[data-presentation]").every((x) => x.getAttribute("data-presentation") !== "healthy")).toBe(true);
    const chips = all(c, BADGE);
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) expect(text(chip)).not.toContain("Healthy");
    expect(text(c)).not.toContain("Healthy");
    // Healthy components present as stale with the clock icon.
    const vmHeader = c.querySelector('[data-component="victoriametrics"] [data-presentation]')!;
    expect(vmHeader.getAttribute("data-presentation")).toBe("stale");
    expect(iconOf(vmHeader)).toBe(iconClass("clock"));
  });

  // -------------------------------------------------------------------------
  // Verdict banner
  // -------------------------------------------------------------------------

  const FIVE = ["vmalert unreachable", "2 scrape targets down", "deadman not configured", "1 rule groups failing", "cycle degraded"];

  test("REQ-VERDICT-01: a degraded verdict with 5 contributors shows 3 inline and an 'and 2 more' disclosure revealing all 5", async () => {
    const verdict: BannerVerdict = { kind: "degraded", contributors: FIVE };
    const c = await render(el(VerdictBanner, { verdict, presentation: presentVerdict(verdict, clock.format), kiosk: false }));
    const section = c.querySelector("section[data-verdict]")!;
    expect(section.getAttribute("data-verdict")).toBe("degraded");
    expect(section.getAttribute("data-status")).toBe("warning");
    expect(text(section.querySelector("h2"))).toBe("Engine verdict");
    expect(text(c.querySelector('[role="status"] [data-verdict-summary]'))).toBe(`— ${FIVE.slice(0, 3).join("; ")}`);
    const btn = section.querySelector("button[aria-expanded]") as HTMLElement;
    // The control and the full list sit outside the live region.
    expect(c.querySelector('[role="status"] button')).toBeNull();
    expect(text(btn)).toBe("and 2 more");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    const list = c.querySelector(`#${CSS.escape(btn.getAttribute("aria-controls")!)}`)!;
    expect(list.hasAttribute("hidden")).toBe(true);
    btn.click();
    await flush();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(list.hasAttribute("hidden")).toBe(false);
    expect(all(list, "li").map(text)).toEqual(FIVE);
  });

  test("REQ-VERDICT-01 / REQ-KIOSK-02: in kiosk every contributor is inline and there is no button", async () => {
    const verdict: BannerVerdict = { kind: "degraded", contributors: FIVE };
    const c = await render(el(VerdictBanner, { verdict, presentation: presentVerdict(verdict, clock.format), kiosk: true }));
    expect(text(c.querySelector("[data-verdict-summary]"))).toBe(`— ${FIVE.join("; ")}`);
    expect(c.querySelector("button")).toBeNull();
  });

  test("REQ-VERDICT-01: OK has an empty summary; the chip carries glyph and word", async () => {
    const verdict: BannerVerdict = { kind: "ok" };
    const p = presentVerdict(verdict, clock.format);
    expect(bannerSummary(verdict, p, false)).toBe("");
    const c = await render(el(VerdictBanner, { verdict, presentation: p, kiosk: false }));
    expect(c.querySelector("[data-verdict-summary]")).toBeNull();
    const chip = c.querySelector('[data-slot="callout"][role="status"]')!;
    expect(chip.getAttribute("data-status")).toBe("ok");
    expect(chip.getAttribute("data-tone")).toBe("ok");
    expect(text(chip.querySelector("[data-verdict-word]"))).toBe("OK");
    expect(iconOf(chip)).toBe(iconClass(VERDICT_ICON.ok));
    expect(c.querySelector("button")).toBeNull();
  });

  test("REQ-VERDICT-05: the Unknown summary drops the '{word} — ' prefix", async () => {
    const since = Date.parse(LAST_GOOD_ISO);
    const verdict: BannerVerdict = { kind: "unknown", since };
    const p = presentVerdict(verdict, clock.format);
    const summary = bannerSummary(verdict, p, false);
    expect(summary).toBe(`engine data not current since ${clock.format(LAST_GOOD_ISO)}`);
    expect(summary.startsWith("Unknown")).toBe(false);
    const c = await render(el(VerdictBanner, { verdict, presentation: p, kiosk: false }));
    const section = c.querySelector("section[data-verdict]")!;
    expect(section.getAttribute("data-verdict")).toBe("unknown");
    expect(section.getAttribute("data-status")).toBe("unknown");
    const chip = c.querySelector('[data-slot="callout"][role="status"]')!;
    expect(iconOf(chip)).toBe(iconClass(VERDICT_ICON.unknown));
    expect(text(chip.querySelector("[data-verdict-word]"))).toBe("Unknown");
    expect(text(c.querySelector("[data-verdict-summary]"))).toBe(`— ${summary}`);
    // Without since, the headline has no "since" but the prefix is still dropped.
    const noSince: BannerVerdict = { kind: "unknown", since: null };
    expect(bannerSummary(noSince, presentVerdict(noSince, clock.format), false)).toBe("engine data not current");
  });

  test("REQ-VERDICT-05: a degraded chip carries the ▲ glyph and the word Degraded", async () => {
    const verdict: BannerVerdict = { kind: "degraded", contributors: ["vmalert unreachable"] };
    const c = await render(el(VerdictBanner, { verdict, presentation: presentVerdict(verdict, clock.format), kiosk: false }));
    const chip = c.querySelector('[data-slot="callout"][role="status"]')!;
    expect(chip.getAttribute("data-tone")).toBe("warn");
    expect(text(chip.querySelector("[data-verdict-word]"))).toBe("Degraded");
    expect(iconOf(chip)).toBe(iconClass(VERDICT_ICON.degraded));
    expect(c.querySelector("button")).toBeNull(); // more === 0
  });

  // -------------------------------------------------------------------------
  // Deadman
  // -------------------------------------------------------------------------

  test("REQ-DEADMAN-01/02: deadman not configured renders an unknown 'Not configured' badge with the minus icon, distinct from healthy", async () => {
    const degraded = degradedEngine();
    const green = okEngine();
    const c = await render(el("div", null,
      el("div", { id: "nc" }, el(DeadmanPanel, { deadman: degraded.deadman, canary: canaryRule(degraded), clock })),
      el("div", { id: "ok" }, el(DeadmanPanel, { deadman: green.deadman, canary: canaryRule(green), clock })),
    ));
    const nc = c.querySelector("#nc")!;
    const ncChip = nc.querySelector(`[data-configured] ${BADGE}`)!;
    expect(ncChip.getAttribute("data-status")).toBe("unknown");
    expect(text(ncChip)).toBe("Not configured");
    expect(iconOf(ncChip)).toBe(iconClass("minus"));
    expect(iconOf(ncChip)).not.toBe(iconClass(TARGET_STATUS.unknown.icon as IconName));
    expect(nc.querySelector("[data-configured]")?.getAttribute("data-configured")).toBe("false");
    expect(nc.querySelector("[data-configured]")?.getAttribute("data-presentation")).toBe("not-configured");
    expect(text(nc)).toContain("No deadman (canary) rule is configured.");
    expect(text(valueFor(nc, "Configured"))).toBe("No");
    expect(nc.querySelector("[data-canary]")).toBeNull();
    const section = sectionNamed(nc, "Deadman");
    expect(text(section.querySelector("h2"))).toBe("Deadman");

    const ok = c.querySelector("#ok")!;
    const okChip = ok.querySelector(`[data-configured] ${BADGE}`)!;
    expect(okChip.getAttribute("data-status")).toBe("ok");
    expect(text(okChip)).toContain("Healthy");
    expect(iconOf(okChip)).not.toBe(iconOf(ncChip));
  });

  test("REQ-DEADMAN-01: a canary rule shows its name, health and last evaluation", async () => {
    const green = okEngine();
    const canary = canaryRule(green)!;
    expect(canary).not.toBeNull();
    const c = await render(el(DeadmanPanel, { deadman: green.deadman, canary, clock }));
    const rule = c.querySelector("[data-canary]")!;
    expect(text(rule.querySelector("[data-rule-name]"))).toBe(canary.name);
    expect(rule.querySelector(BADGE)?.getAttribute("data-status")).toBe("ok");
    expect(text(rule.querySelector("[data-last-eval]"))).toBe(`Last evaluated ${clock.format(canary.lastEvaluationAt!)}`);
    expect(text(valueFor(c, "Configured"))).toBe("Yes");
    expect(text(valueFor(c, "Last evaluation"))).toBe(clock.format(green.deadman.lastEvaluationAt!));
    // A configured deadman without a canary rule says so; a null evaluation reads not reported.
    const c2 = await render(el(DeadmanPanel, {
      deadman: { ...green.deadman, lastEvaluationAt: null }, canary: null, clock,
    }));
    expect(text(c2)).toContain("The canary rule is not present in rule state.");
    expect(valueFor(c2, "Last evaluation")?.querySelector("[data-not-reported]")).not.toBeNull();
  });

  test("REQ-DEGRADE-01: a deadman whose source is not current never reads Healthy and names its source", async () => {
    const green = okEngine();
    const deadman = { ...green.deadman, availability: unavailable("vmalert-rules", LAST_GOOD_ISO) };
    const c = await render(el(DeadmanPanel, { deadman, canary: canaryRule(green), clock }));
    expect(c.querySelector("[data-configured]")?.getAttribute("data-presentation")).toBe("stale");
    expect(text(c.querySelector("[data-configured]"))).not.toContain("Healthy");
    expect(c.querySelector(DEGRADED)?.getAttribute("data-source")).toBe("vmalert-rules");
  });

  // -------------------------------------------------------------------------
  // Notifications and capacity
  // -------------------------------------------------------------------------

  test("REQ-NOTIFY-01: notification cells render values, 'not reported' and 'Failing' only when the rate is > 0", async () => {
    // Built directly: fixture Overrides merge record maps, which would re-add the default keys.
    const section = notificationSection({
      failuresPerSecond: { email: 0, slack: 0.5 },
      latencyP95Seconds: { email: 0.42, webhook: 0.05 },
      availability: okEngine().notifications.availability,
    });
    const c = await render(el(NotificationTiles, { section, clock }));
    expect(text(sectionNamed(c, "Notifications").querySelector("h2"))).toBe("Notifications");
    const tiles = all(c, "[data-integration]");
    expect(tiles.map((t) => t.getAttribute("data-integration"))).toEqual(["email", "slack", "webhook"]);
    const [email, slack, webhook] = tiles as [Element, Element, Element];
    // Each tile: dt = integration (+ Failing badge), dd[0] = "Failures: " (sr-only) + value,
    // dd[1] = "Failures · p95 latency …".
    const cells = (t: Element): Element[] => all(t, "dd");

    expect(text(email.querySelector("dt"))).toBe("email");
    expect(text(cells(email)[0])).toBe("Failures: " + NOTIFICATION_FORMAT.failures(0));
    expect(text(cells(email)[1])).toBe(`Failures · p95 latency ${NOTIFICATION_FORMAT.latency(0.42)}`);
    expect(email.querySelector(BADGE)).toBeNull();
    expect(email.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("neutral");

    expect(text(slack.querySelector(BADGE))).toBe("Failing");
    expect(slack.querySelector(BADGE)?.getAttribute("data-status")).toBe("critical");
    expect(slack.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe(TARGET_STATUS.critical.tone);
    expect(text(cells(slack)[0])).toBe("Failures: " + NOTIFICATION_FORMAT.failures(0.5));
    expect(text(cells(slack)[1])).toBe("Failures · p95 latency not reported");
    expect(cells(slack)[1]?.querySelector("[data-not-reported]")).not.toBeNull();

    expect(cells(webhook)[0]?.querySelector("[data-not-reported]")).not.toBeNull();
    expect(text(cells(webhook)[0])).toBe("Failures: " + "not reported");
    expect(text(cells(webhook)[1])).toBe(`Failures · p95 latency ${NOTIFICATION_FORMAT.latency(0.05)}`);
    expect(webhook.querySelector(BADGE)).toBeNull();
    expect(all(c, BADGE).filter((x) => text(x).includes("Failing"))).toHaveLength(1);
  });

  test("REQ-NOTIFY-01: a non-current source renders every cell 'unavailable' and no Failing chip", async () => {
    const payload = makeEnginePayload({
      notifications: {
        failuresPerSecond: { email: 3 },
        availability: { state: "unavailable", lastGoodAt: LAST_GOOD_ISO },
      },
    });
    const section = notificationSection(payload.notifications);
    const c = await render(el(NotificationTiles, { section, clock }));
    const tiles = all(c, "[data-integration]");
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      const [failures, latency] = all(t, "dd") as [Element, Element];
      expect(text(failures)).toBe(`Failures: ${UNAVAILABLE}`);
      expect(failures.querySelector("[data-unavailable]")).not.toBeNull();
      expect(text(latency)).toBe(`Failures · p95 latency ${UNAVAILABLE}`);
      expect(latency.querySelector("[data-unavailable]")).not.toBeNull();
    }
    expect(text(c)).not.toContain("Failing");
    expect(c.querySelector(DEGRADED)?.getAttribute("data-source")).toBe(payload.notifications.availability.source);
  });

  test("REQ-NOTIFY-01: none-reported renders the empty copy; unavailable renders only the badge", async () => {
    const empty = notificationSection({ failuresPerSecond: null, latencyP95Seconds: null, availability: okEngine().notifications.availability });
    const c = await render(el(NotificationTiles, { section: empty, clock }));
    expect(text(c.querySelector('[role="status"]'))).toContain("No notification integrations reported");
    const gone = notificationSection({ failuresPerSecond: null, latencyP95Seconds: null, availability: unavailable("victoriametrics-signals", null) });
    expect(gone.state).toBe("unavailable");
    const c2 = await render(el(NotificationTiles, { section: gone, clock }));
    expect(text(c2)).not.toContain("No notification integrations reported");
    expect(c2.querySelector(DEGRADED)).not.toBeNull();
    expect(all(c2, "[data-integration]")).toHaveLength(0);
  });

  test("REQ-CAP-01 / REQ-VERDICT-04: capacity renders four CAPACITY_TILE_LABEL tiles with no StatusChip", async () => {
    const payload = okEngine();
    const tiles = capacityTiles(payload.capacity);
    const c = await render(el(CapacityTiles, { tiles, availability: payload.capacity.availability, clock }));
    expect(text(sectionNamed(c, "Capacity").querySelector("h2"))).toBe("Capacity");
    const items = all(c, "[data-capacity]");
    expect(items.map((i) => i.getAttribute("data-capacity"))).toEqual(["ingestion-rate", "active-series", "data-size", "free-disk"]);
    expect(items.map((i) => text(i.querySelector("dt")))).toEqual([
      CAPACITY_TILE_LABEL["ingestion-rate"], CAPACITY_TILE_LABEL["active-series"], CAPACITY_TILE_LABEL["data-size"], CAPACITY_TILE_LABEL["free-disk"],
    ]);
    expect(text(valueFor(items[0]!, CAPACITY_TILE_LABEL["ingestion-rate"]))).toBe(CAPACITY_FORMAT["ingestion-rate"](payload.capacity.ingestionRowsPerSecond!));
    expect(c.querySelector(BADGE)).toBeNull();
    expect(c.querySelector("[data-status]")).toBeNull();
    // No tone either: every tile is neutral.
    expect(all(c, "[data-tone]").map((t) => t.getAttribute("data-tone"))).toEqual(["neutral", "neutral", "neutral", "neutral"]);
  });

  test("REQ-CAP-01: null capacity values render 'not reported' and a non-current source renders 'unavailable'", async () => {
    const payload = makeEnginePayload({ capacity: { dataBytes: null, freeDiskBytes: null } });
    const c = await render(el(CapacityTiles, { tiles: capacityTiles(payload.capacity), availability: payload.capacity.availability, clock }));
    expect(all(c, "[data-not-reported]")).toHaveLength(2);
    const outage = ENGINE_SCENARIOS.sourceOutage();
    const c2 = await render(el(CapacityTiles, { tiles: capacityTiles(outage.capacity), availability: outage.capacity.availability, clock }));
    expect(all(c2, "[data-unavailable]")).toHaveLength(4);
    expect(c2.querySelector(DEGRADED)).not.toBeNull();
    expect(c2.querySelector(`[data-capacity] [data-status]`)).toBeNull();
  });

  test("REQ-CAP-01: TileValueView renders zero as a value and never as not reported", async () => {
    const c = await render(el("div", null,
      el(TileValueView, { value: { kind: "value", value: 0 }, format: CAPACITY_FORMAT["active-series"] }),
      el(TileValueView, { value: { kind: "not-reported" }, format: CAPACITY_FORMAT["active-series"] }),
      el(TileValueView, { value: { kind: "unavailable" }, format: CAPACITY_FORMAT["active-series"] }),
    ));
    expect(text(c.querySelector("[data-tile-value]"))).toBe(CAPACITY_FORMAT["active-series"](0));
    expect(all(c, "[data-not-reported]")).toHaveLength(1);
    expect(all(c, "[data-unavailable]")).toHaveLength(1);
  });

  test("REQ-CAP-01: no engine source imports Gauge", async () => {
    const importsGauge = /import[^;]*\bGauge\b[^;]*from/;
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = new URL("../src/client/views/engine/", import.meta.url).pathname;
    for await (const f of glob.scan({ cwd: root })) {
      const src = await Bun.file(root + f).text();
      expect({ f, gauge: importsGauge.test(src) }).toEqual({ f, gauge: false });
    }
  });

  // -------------------------------------------------------------------------
  // Plain text (REQ-SEC-02)
  // -------------------------------------------------------------------------

  test("REQ-SEC-02: hostileStrings values render literally as text", async () => {
    const hostile: EnginePayload = ENGINE_SCENARIOS.hostileStrings();
    const job = hostile.scrapeJobs[0]!;
    const lastError = job.targets.find((t) => t.lastError !== null)!.lastError!;
    const hostileGroup = hostile.ruleGroups.find((g) => g.health === "unhealthy")!;
    const hostileRule = hostileGroup.rules[0]!;
    const canary = { ...hostileRule, deadman: true };
    const notifications = notificationSection({
      failuresPerSecond: { [job.job]: 1 }, latencyP95Seconds: null, availability: hostile.notifications.availability,
    });
    const verdict: BannerVerdict = { kind: "degraded", contributors: [lastError] };
    const c = await render(el("div", null,
      el(ErrorText, { text: lastError, expanded: true, detailId: "hx", onToggle: () => undefined }),
      el(ErrorDetail, { id: "hx", owner: job.job, text: lastError }),
      el(DeadmanPanel, { deadman: hostile.deadman, canary, clock }),
      el(NotificationTiles, { section: notifications, clock }),
      el(VerdictBanner, { verdict, presentation: presentVerdict(verdict, clock.format), kiosk: false }),
    ));
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("b")).toBeNull();
    expect(text(c.querySelector('button[aria-controls="hx"]'))).toBe(lastError);
    expect(text(c.querySelector("[data-error-full]"))).toBe(lastError);
    expect(text(c.querySelector("[data-error-owner]"))).toBe(job.job);
    expect(text(c.querySelector("[data-canary] [data-rule-name]"))).toBe(hostileRule.name);
    expect(text(c.querySelector("[data-integration] dt > span"))).toBe(job.job);
    expect(text(c.querySelector("[data-verdict-summary]"))).toBe(`— ${lastError}`);
    expect(c.innerHTML).toContain("&lt;img");
  });

  test("REQ-SEC-02: no engine source uses dangerouslySetInnerHTML", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = new URL("../src/client/views/engine/", import.meta.url).pathname;
    for await (const f of glob.scan({ cwd: root })) {
      const src = await Bun.file(root + f).text();
      expect({ f, hit: src.includes("dangerouslySetInnerHTML") }).toEqual({ f, hit: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Scrape jobs and rule groups (scrape.tsx, rules.tsx)
// ---------------------------------------------------------------------------

const snapshotHosts = makeEngineSnapshot().hosts;

/** Toggle button of a job/group li (null in kiosk or when absent). */
const disclosureOf = (li: Element | null | undefined): HTMLButtonElement | null =>
  (li?.querySelector("[data-group-header] h3 > button[aria-controls]") ?? null) as HTMLButtonElement | null;

function makeTarget(instance: string, health: ScrapeTarget["health"], lastError: string | null = null): ScrapeTarget {
  return { job: "j", instance, scrapeUrl: `http://user:secret@${instance}/metrics`, health, lastScrapeAt: ENGINE_NOW_ISO, lastError };
}

describeDom("engine scrape jobs and rule groups", () => {
  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.unmount();
  });

  test("REQ-SCRAPE-02: orderTargets is stable (down, unknown, up) and does not mutate its input", () => {
    const input: ScrapeTarget[] = [
      makeTarget("a:1", "up"), makeTarget("b:1", "unknown"), makeTarget("c:1", "down"),
      makeTarget("d:1", "up"), { ...makeTarget("e:1", "up"), health: "bogus" as ScrapeTarget["health"] }, makeTarget("f:1", "down"),
    ];
    const before = input.map((t) => t.instance);
    const out = orderTargets(input);
    expect(out.map((t) => t.instance)).toEqual(["c:1", "f:1", "b:1", "e:1", "a:1", "d:1"]);
    expect(input.map((t) => t.instance)).toEqual(before);
    expect(out).not.toBe(input);
    expect(TARGET_HEALTH.up).toEqual({ status: "ok", text: "Up" });
    expect(TARGET_HEALTH.down).toEqual({ status: "critical", text: "Down" });
    expect(TARGET_HEALTH.unknown).toEqual({ status: "unknown", text: "Unknown" });
  });

  test("REQ-SCRAPE-01/02: problem jobs come first and expanded; healthy jobs are collapsed '{job} — N up'; a disclosure toggles the table", async () => {
    const engine = degradedEngine({ downTargets: 2 });
    const section = scrapeSection(engine, makeObservation());
    const c = await render(el(ScrapeJobs, { section, hosts: snapshotHosts, clock, kiosk: false }));
    const lis = all(c, "li[data-job]");
    expect(lis.map((li) => li.getAttribute("data-job"))).toEqual(["node", "pulse-engine", "smartctl"]);
    expect(lis.map((li) => li.getAttribute("data-problem"))).toEqual(["true", "false", "false"]);

    const nodeBtn = disclosureOf(lis[0])!;
    expect(nodeBtn.getAttribute("aria-expanded")).toBe("true");
    expect(c.ownerDocument.getElementById(nodeBtn.getAttribute("aria-controls")!)).not.toBeNull();
    expect(lis[0]!.querySelectorAll("tbody tr")).toHaveLength(4);
    // Problem-first targets inside the job: the two down targets top the table.
    expect(all(lis[0]!, "tbody tr").slice(0, 2).map((tr) => tr.querySelector('[data-slot="status-badge"]')!.getAttribute("data-status"))).toEqual(["critical", "critical"]);
    expect(text(lis[0]!.querySelector('tbody tr [data-slot="status-badge"]'))).toContain("Down");
    expect(all(lis[0]!, "th").map(text)).toEqual(["Instance", "Health", "Last scrape", "Last error"]);
    expect(text(lis[0]!.querySelector("[data-group-header] [data-counts]"))).toBe("2 up · 2 down · 0 unknown");

    const healthyBtn = disclosureOf(lis[1])!;
    expect(healthyBtn.getAttribute("aria-expanded")).toBe("false");
    expect(text(healthyBtn)).toBe("pulse-engine — 4 up");
    expect(lis[1]!.querySelector("table")).toBeNull();
    expect(c.ownerDocument.getElementById(healthyBtn.getAttribute("aria-controls")!)!.hasAttribute("hidden")).toBe(true);

    healthyBtn.click();
    await flush();
    const opened = disclosureOf(c.querySelector('li[data-job="pulse-engine"]'))!;
    expect(opened.getAttribute("aria-expanded")).toBe("true");
    expect(c.querySelector('li[data-job="pulse-engine"] table')).not.toBeNull();

    disclosureOf(c.querySelector('li[data-job="node"]'))!.click();
    await flush();
    expect(disclosureOf(c.querySelector('li[data-job="node"]'))!.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector('li[data-job="node"] table')).toBeNull();
    expect(c.querySelector('li[data-job="node"] tbody tr')).toBeNull();
  });

  test("REQ-SCRAPE-01 / REQ-DEGRADE-01: empty renders 'No scrape jobs reported'; unavailable renders only the badge", async () => {
    const empty = scrapeSection(makeEnginePayload({ scrapeJobs: [] }), makeObservation());
    expect(empty.state).toBe("empty");
    const c1 = await render(el(ScrapeJobs, { section: empty, hosts: snapshotHosts, clock, kiosk: false }));
    expect(text(c1)).toContain("No scrape jobs reported");
    expect(c1.querySelector("[data-availability]")).toBeNull();

    const unavailable = scrapeSection(makeEnginePayload({ scrapeJobs: [] }), makeObservation({ sources: { "victoriametrics-targets": "unavailable" } }));
    expect(unavailable.state).toBe("unavailable");
    const c2 = await render(el(ScrapeJobs, { section: unavailable, hosts: snapshotHosts, clock, kiosk: false }));
    expect(text(c2)).not.toContain("No scrape jobs reported");
    expect(c2.querySelector("ul")).toBeNull();
    expect(c2.querySelector("[data-discovery-notice]")).toBeNull();
    expect(c2.querySelectorAll("[data-availability]")).toHaveLength(1);
  });

  test("REQ-SCRAPE-03 / REQ-SEC-02: a markup lastError renders literally, shows its Tooltip on focus and opens one ErrorDetail at a time", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    const engine = makeEnginePayload({
      scrapeJobs: [{
        job: "node", state: "unhealthy",
        targets: [makeTarget("web01:9100", "down", `dial: ${markup}`), makeTarget("web02:9100", "down", "second <b>x</b>")],
      }],
    });
    // The Radix tooltip portals into document.body once its layout effect runs (stubs before mount).
    const restoreUi = installUiStubs();
    try {
      const c = await render(el(ScrapeJobs, { section: scrapeSection(engine, makeObservation()), hosts: snapshotHosts, clock, kiosk: false }));
      expect(c.querySelector("img")).toBeNull();
      expect(c.querySelector("b")).toBeNull();
      const toggles = errorToggles(c);
      expect(toggles.map(text)).toEqual([`dial: ${markup}`, "second <b>x</b>"]);

      await act(async () => {
        toggles[0]!.focus();
      });
      await flush();
      expect(text(document.querySelector('[role="tooltip"]'))).toBe(`dial: ${markup}`);
      expect(document.querySelector("img")).toBeNull();

      toggles[0]!.click();
      await flush();
      let details = errorDetails(c);
      expect(details).toHaveLength(1);
      expect(text(details[0]!.querySelector("[data-error-full]"))).toBe(`dial: ${markup}`);
      expect(details[0]!.getAttribute("aria-label")).toBe("Full last error for web01:9100");
      expect(details[0]!.id).toBe(toggles[0]!.getAttribute("aria-controls")!);
      expect(errorToggles(c)[0]!.getAttribute("aria-expanded")).toBe("true");

      errorToggles(c)[1]!.click();
      await flush();
      details = errorDetails(c);
      expect(details).toHaveLength(1);
      expect(text(details[0]!.querySelector("[data-error-full]"))).toBe("second <b>x</b>");
      expect(errorToggles(c).map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);

      errorToggles(c)[1]!.click();
      await flush();
      expect(errorDetails(c)).toHaveLength(0);
    } finally {
      restoreUi();
    }
  });

  test("REQ-SCRAPE-04: with discovery not current every job reads Unknown, targets read '(last known)', the notice and the named badge render", async () => {
    const obs = makeObservation({ sources: { "victoriametrics-targets": "stale" } });
    const section = scrapeSection(degradedEngine({ downTargets: 2 }), obs);
    const c = await render(el(ScrapeJobs, { section, hosts: snapshotHosts, clock, kiosk: false }));
    const jobChips = all(c, '[data-group-header] > [data-slot="status-badge"]');
    expect(jobChips).toHaveLength(3);
    for (const chip of jobChips) {
      expect(chip.getAttribute("data-status")).toBe("unknown");
      expect(text(chip)).toContain("Unknown");
    }
    expect(text(c.querySelector("[data-discovery-notice]"))).toBe("Jobs read unknown until target discovery recovers.");
    const badge = c.querySelector('[data-source="victoriametrics-targets"]')!;
    const lastSuccess = obs.sources["victoriametrics-targets"].lastSuccess!;
    expect(text(badge)).toContain(degradedText(section.availability, clock.format)!);
    expect(text(badge)).toContain("VictoriaMetrics target discovery");
    expect(text(badge)).toContain(clock.format(lastSuccess));
    // Every expanded job's target chips read unknown "(last known)", never green.
    for (const b of all(c, "[data-group-header] h3 > button[aria-controls]") as HTMLButtonElement[]) {
      if (b.getAttribute("aria-expanded") === "false") b.click();
    }
    await flush();
    const targetChips = all(c, 'tbody [data-slot="status-badge"]');
    expect(targetChips).toHaveLength(12);
    for (const chip of targetChips) {
      expect(chip.getAttribute("data-status")).toBe("unknown");
      expect(text(chip)).toMatch(/(Up|Down|Unknown) \(last known\)$/);
    }
    expect(targetChips.some((chip) => text(chip).includes("Down (last known)"))).toBe(true);
  });

  test("REQ-ELINK-02 / REQ-SEC-03/04: exactly one matching host links to estateHostPath; zero or several matches are plain text; scrapeUrl never renders", async () => {
    const hosts = [
      ...snapshotHosts,
      { ...snapshotHosts[0]!, name: "dup-a", addresses: ["10.9.9.9"], drilldownId: "host:dup-a" },
      { ...snapshotHosts[0]!, name: "dup-b", addresses: ["10.9.9.9"], drilldownId: "host:dup-b" },
      { ...snapshotHosts[0]!, name: "we/ird?#", addresses: ["10.8.8.8"], drilldownId: "host:we/ird?#" },
    ];
    const engine = makeEnginePayload({
      scrapeJobs: [{
        job: "mixed", state: "unhealthy",
        targets: [
          makeTarget("web01:9100", "down"), makeTarget("10.0.0.12:9633", "up"), makeTarget("nowhere:9100", "up"),
          makeTarget("10.9.9.9:9100", "up"), makeTarget("10.8.8.8:9100", "up"),
        ],
      }],
    });
    const c = await render(el(ScrapeJobs, { section: scrapeSection(engine, makeObservation()), hosts, clock, kiosk: false }));
    const links = all(c, "tbody a[href]");
    expect(links.map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["web01:9100", estateHostPath("web01")],
      ["10.0.0.12:9633", estateHostPath("web02")],
      ["10.8.8.8:9100", estateHostPath("we/ird?#")],
    ]);
    expect(links[2]!.getAttribute("href")).toBe("/estate/host/we%2Fird%3F%23");
    for (const a of links) expect(a.hasAttribute("target")).toBe(false);
    const cells = all(c, "tbody tr").map((tr) => tr.querySelector("td")!);
    const plain = cells.filter((td) => td.querySelector("a") === null).map(text);
    expect(plain).toEqual(["nowhere:9100", "10.9.9.9:9100"]);
    expect(c.innerHTML).not.toContain("/metrics");
    expect(c.innerHTML).not.toContain("secret");
  });

  test("REQ-SCALE-02: a collapsed job mounts no rows and a zero-target job renders 'No targets reported'", async () => {
    const engine = makeEnginePayload({ scrapeJobs: [{ job: "empty-job", state: "unhealthy", targets: [] }] });
    const [row] = scrapeSection(engine, makeObservation()).rows;
    const c = await render(el("div", null,
      el(ScrapeJob, { row, expanded: true, onToggle: () => undefined, discoveryStale: false, hosts: [], clock, kiosk: false }),
    ));
    expect(text(c)).toContain("No targets reported");
    expect(c.querySelector('tbody [data-slot="status-badge"]')).toBeNull();
    const big = scrapeSection(ENGINE_SCENARIOS.envelope(), makeObservation());
    const c2 = await render(el(ScrapeJobs, { section: big, hosts: snapshotHosts, clock, kiosk: false }));
    expect(all(c2, "li[data-job]")).toHaveLength(25);
    expect(c2.querySelector("tbody tr")).toBeNull();
  });

  test("REQ-RULE-01: problem groups come first and expanded; healthy groups read '{group} — N rules' and toggle their table", async () => {
    const base = makeEnginePayload();
    const engine = makeEnginePayload({
      ruleGroups: [
        ...base.ruleGroups,
        { group: "broken", health: "unhealthy", lastEvaluationAt: null, rules: [{ ...base.ruleGroups[1]!.rules[0]!, group: "broken", health: "unhealthy" as const, lastError: "boom" }] },
      ],
    });
    const c = await render(el(RuleGroups, { section: ruleSection(engine), clock, kiosk: false }));
    const lis = all(c, "li[data-group]");
    expect(lis.map((li) => li.getAttribute("data-group"))).toEqual(["broken", "pulse-deadman", "pulse-engine", "pulse-hosts", "pulse-services"]);
    expect(disclosureOf(lis[0])!.getAttribute("aria-expanded")).toBe("true");
    expect(lis[0]!.querySelector("table")).not.toBeNull();
    expect(text(lis[0]!.querySelector("[data-group-header] [data-last-eval]"))).toBe(`Last evaluated ${NOT_REPORTED}`);
    expect(lis[0]!.querySelector("[data-group-header] [data-last-eval] [data-not-reported]")).not.toBeNull();
    expect(text(disclosureOf(lis[1]))).toBe("pulse-deadman — 1 rule");
    expect(text(disclosureOf(lis[3]))).toBe("pulse-hosts — 3 rules");
    expect(disclosureOf(lis[3])!.getAttribute("aria-expanded")).toBe("false");
    expect(lis[3]!.querySelector("table")).toBeNull();
    expect(text(lis[3]!.querySelector("[data-group-header] [data-last-eval]"))).toBe(`Last evaluated ${clock.format(base.ruleGroups[2]!.lastEvaluationAt!)}`);

    disclosureOf(lis[3])!.click();
    await flush();
    const hosts = c.querySelector('li[data-group="pulse-hosts"]')!;
    expect(disclosureOf(hosts)!.getAttribute("aria-expanded")).toBe("true");
    expect(hosts.querySelectorAll("tbody tr")).toHaveLength(3);
    disclosureOf(hosts)!.click();
    await flush();
    expect(c.querySelector('li[data-group="pulse-hosts"] table')).toBeNull();
  });

  test("REQ-RULE-01 / REQ-DEGRADE-01: empty renders 'No rule groups reported'; unavailable renders only the badge; stale reads '(last known)'", async () => {
    const c1 = await render(el(RuleGroups, { section: ruleSection(makeEnginePayload({ ruleGroups: [] })), clock, kiosk: false }));
    expect(text(c1)).toContain("No rule groups reported");

    const vmDown = makeComponent("vmalert", { availability: unavailable("vmalert-rules", LAST_GOOD_ISO) });
    const noRules = makeEnginePayload({ ruleGroups: [] });
    const outage = { ...noRules, components: noRules.components.map((x) => x.id === "vmalert" ? vmDown : x) };
    const c2 = await render(el(RuleGroups, { section: ruleSection(outage), clock, kiosk: false }));
    expect(text(c2)).not.toContain("No rule groups reported");
    expect(c2.querySelector("ul")).toBeNull();
    expect(c2.querySelectorAll('[data-source="vmalert-rules"]')).toHaveLength(1);

    const withRules = makeEnginePayload();
    const stale = { ...withRules, components: withRules.components.map((x) => x.id === "vmalert" ? vmDown : x) };
    const c3 = await render(el(RuleGroups, { section: ruleSection(stale), clock, kiosk: false }));
    const chips = all(c3, '[data-group-header] > [data-slot="status-badge"]');
    expect(chips).toHaveLength(4);
    for (const chip of chips) {
      expect(chip.getAttribute("data-status")).toBe("unknown");
      expect(text(chip)).toContain("Healthy (last known)");
    }
  });

  test("REQ-ELINK-03 / REQ-RULE-03 / REQ-SEC-02: every rule name links to the catalog, there is no Duration column, markup renders literally", async () => {
    const hostile = ENGINE_SCENARIOS.hostileStrings();
    const c = await render(el(RuleGroups, { section: ruleSection(hostile), clock, kiosk: false }));
    for (const b of all(c, "[data-group-header] h3 > button[aria-controls]") as HTMLButtonElement[]) {
      if (b.getAttribute("aria-expanded") === "false") b.click();
    }
    await flush();
    expect(RULE_CATALOG_HREF).toBe("/alerts?tab=catalog");
    const links = all(c, "tbody a[href]");
    const ruleCount = hostile.ruleGroups.reduce((n, g) => n + g.rules.length, 0);
    expect(links).toHaveLength(ruleCount);
    for (const a of links) {
      expect(a.getAttribute("href")).toBe("/alerts?tab=catalog");
      expect(a.hasAttribute("target")).toBe(false);
    }
    const headers = all(c, "th").map(text);
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.some((hd) => /duration/i.test(hd))).toBe(false);
    for (const table of all(c, "table")) expect(all(table, "th").map(text)).toEqual(["Rule", "State", "Health", "Last error"]);
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("b")).toBeNull();
    const names = links.map(text);
    expect(names).toContain("Rule <b>x</b>");
    expect(names).toContain("<img src=x onerror=alert(1)>");
    expect(text(c.querySelector('li[data-problem="true"] [data-group-header] h3'))).toBe("group <img src=x onerror=alert(1)>");

    const errToggle = errorToggles(c)[0]!;
    expect(text(errToggle)).toBe("eval failed: <img src=x onerror=alert(1)>");
    errToggle.click();
    await flush();
    expect(errorDetails(c)).toHaveLength(1);
    expect(text(c.querySelector("[data-error-full]"))).toBe("eval failed: <img src=x onerror=alert(1)>");
  });

  test("REQ-SEC-02: hostile job names and scrape errors render literally", async () => {
    const hostile = ENGINE_SCENARIOS.hostileStrings();
    const c = await render(el(ScrapeJobs, { section: scrapeSection(hostile, makeObservation()), hosts: snapshotHosts, clock, kiosk: false }));
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("b")).toBeNull();
    expect(text(c.querySelector("[data-group-header] h3"))).toBe("node <b>x</b>");
    expect(c.querySelector("li[data-job]")!.getAttribute("data-job")).toBe("node <b>x</b>");
    expect(text(errorToggles(c)[0])).toBe("dial tcp: <img src=x onerror=alert(1)> <b>x</b>");
  });

  test("REQ-KIOSK-02: in kiosk problem items are expanded; healthy rows and last-error cells contain no button", async () => {
    const engine = degradedEngine({ downTargets: 2 });
    const base = engine.ruleGroups;
    const withBroken = { ...engine, ruleGroups: [...base, { group: "broken", health: "unhealthy" as const, lastEvaluationAt: null, rules: [{ ...base[1]!.rules[0]!, group: "broken", health: "unhealthy" as const, lastError: "boom" }] }] };
    const c = await render(el("div", null,
      el(ScrapeJobs, { section: scrapeSection(withBroken, makeObservation()), hosts: snapshotHosts, clock, kiosk: true }),
      el(RuleGroups, { section: ruleSection(withBroken), clock, kiosk: true }),
    ));
    expect(c.querySelector("button")).toBeNull();
    const problemJob = c.querySelector('li[data-job="node"]')!;
    expect(problemJob.getAttribute("data-problem")).toBe("true");
    expect(problemJob.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(problemJob.querySelectorAll("[data-error-text]")).toHaveLength(2);
    expect(text(problemJob.querySelector("[data-group-header] h3"))).toBe("node");
    const healthyJob = c.querySelector('li[data-job="pulse-engine"]')!;
    expect(healthyJob.querySelector("table")).toBeNull();
    expect(text(healthyJob.querySelector("[data-group-header] h3"))).toBe("pulse-engine — 4 up");
    expect(healthyJob.querySelector("[tabindex]")).toBeNull();

    const problemGroup = c.querySelector('li[data-group="broken"]')!;
    expect(problemGroup.querySelector("table")).not.toBeNull();
    expect(text(problemGroup.querySelector("[data-error-text]"))).toBe("boom");
    expect(c.querySelector('li[data-group="pulse-hosts"] table')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  test("REQ-KIOSK-02: RuleGroup with onToggle null renders a non-interactive header", async () => {
    const [row] = ruleSection(okEngine()).rows;
    const c = await render(el("div", null, el(RuleGroup, { row, expanded: false, onToggle: null, sourceStale: false, clock, kiosk: true })));
    expect(c.querySelector("button")).toBeNull();
    expect(text(c.querySelector("[data-group-header] h3"))).toBe("pulse-deadman — 1 rule");
  });
});

// ---------------------------------------------------------------------------
// Full view: EngineView (view.tsx, 04 §2; 08 §4.1 router/kiosk setup, 08 §4.2, 08 §7)
// ---------------------------------------------------------------------------

const REGION_ORDER = ["verdict", "components", "deadman", "scrape", "rules", "notifications", "capacity", "trends", "grafana"] as const;

/** 200 routes for the five curated trends. */
function trendRoutes(): StubRoute[] {
  return ENGINE_TREND_QUERIES.map((id) => ({
    path: `/api/history/estate/${id}`,
    reply: { status: 200, body: makeSeriesHistory(id, CLIENT_QUERY_META[id]!.defaultRange) },
  }));
}

/** A snapshot whose first host carries a Grafana board link, so deriveGrafanaBase has a base. */
function snapshotWithGrafana(url: string, boardUid = "host-board"): ReturnType<typeof makeEngineSnapshot> {
  const snap = makeEngineSnapshot();
  const [first, ...rest] = snap.hosts;
  return { ...snap, hosts: [{ ...first!, grafana: { boardUid, url } }, ...rest] };
}

describeDom("engine view — EngineView (item 017)", (dom) => {
  interface MountOptions {
    readonly search?: string;
    readonly rotation?: ViewRotationContext | null;
    readonly engine?: EnginePayload | null;
    readonly phase?: "initial" | "current" | "stale";
    readonly connection?: "initial" | "live" | "stale";
    readonly snapshot?: ReturnType<typeof makeEngineSnapshot> | null;
  }
  interface Mounted {
    readonly container: HTMLElement;
    readonly store: AppStore;
    readonly router: PathRouter;
    unmount(): void;
  }

  let savedGlobalRaf: PropertyDescriptor | undefined;
  const live: Mounted[] = [];
  const cleanups: (() => void)[] = [];
  let stub: ReturnType<typeof installHistoryStub> | null = null;

  beforeAll(() => {
    // The chart's rAF runs on microtasks (fake-timer safe).
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    savedGlobalRaf = Object.getOwnPropertyDescriptor(g, "requestAnimationFrame");
    g.requestAnimationFrame = (cb: (t: number) => void): number => {
      queueMicrotask(() => cb(0));
      return 0;
    };
  });

  afterAll(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (savedGlobalRaf !== undefined) Object.defineProperty(g, "requestAnimationFrame", savedGlobalRaf);
    else delete g["requestAnimationFrame"];
  });

  afterEach(() => {
    while (live.length > 0) live.pop()!.unmount();
    while (cleanups.length > 0) cleanups.pop()!();
    stub?.restore();
    stub = null;
    restoreRealTimers();
  });

  async function settle(): Promise<void> {
    // React runs non-urgent updates on a scheduler task; act() flushes them with the microtasks.
    await act(async () => {
      for (let i = 0; i < 40; i++) await Promise.resolve();
    });
  }

  /** 08 §4.1 router and kiosk setup, with the engine path and view id. */
  async function mountView(o: MountOptions = {}): Promise<Mounted> {
    const { default: EngineView } = await import("../src/client/views/engine/view.js");
    stub ??= installHistoryStub(trendRoutes());
    const win = dom.win as unknown as Window;
    win.history.replaceState({}, "", "/engine" + (o.search ?? ""));
    const router = createPathRouter({ routes: [{ pattern: "/engine", view: "engine" }], fallback: "/engine", win });
    const kiosk = (o.search ?? "").includes("kiosk=1");
    const store = createAppStore({ storage: null, initialQuery: kiosk ? { kiosk: "1" } : {} });
    store.route.value = router.current();
    const off = router.subscribe((m) => {
      store.route.value = m;
    });
    store.engine.value = o.engine === undefined ? okEngine() : o.engine;
    store.snapshot.value = o.snapshot === undefined ? makeEngineSnapshot() : o.snapshot;
    const phase = o.phase ?? "current";
    store.connection.value = {
      ...store.connection.value,
      phase: o.connection ?? "live",
      observation: makeObservation(),
      views: { ...store.connection.value.views, engine: delivery(phase) },
    };
    const { container, unmount } = await dom.mount(el(EngineView, { store, router, rotation: o.rotation ?? null }));
    await settle();
    const m: Mounted = {
      container, store, router,
      unmount(): void {
        unmount();
        off();
        router.stop();
      },
    };
    live.push(m);
    return m;
  }

  const regions = (c: ParentNode): string[] =>
    all(c, '[data-slot="engine-page"] > [data-region]').map((n) => n.getAttribute("data-region") ?? "");
  const region = (c: ParentNode, id: string): Element => c.querySelector(`[data-region="${id}"]`)!;

  // --- structure (REQ-EXPOSE-01, REQ-OBS-01, REQ-DEADMAN-02) --------------------------------------

  test("REQ-EXPOSE-01: view.tsx has one default export EngineView plus estateClockFor and EngineGrafanaLink", async () => {
    const mod = await import("../src/client/views/engine/view.js");
    expect(Object.keys(mod).sort()).toEqual(["EngineGrafanaLink", "default", "estateClockFor"]);
    expect(mod.default.name).toBe("EngineView");
    const src = await Bun.file(new URL("../src/client/views/engine/view.tsx", import.meta.url).pathname).text();
    expect(src.match(/^export default /gm)).toHaveLength(1);
    expect(src).toContain("<PageErrorBoundary");
    expect(src).not.toMatch(/^import\s+["'][^"']*\.css["']/m);
  });

  test("REQ-EXPOSE-01 / REQ-DEADMAN-02: regions render in data-region order under the header", async () => {
    const m = await mountView();
    const c = m.container;
    expect(regions(c)).toEqual([...REGION_ORDER]);
    expect(all(c, "h1").map(text)).toEqual(["Monitoring engine"]);
    expect(text(c.querySelector('[data-slot="page-header"] [data-zone]'))).toBe("Times in America/Chicago");
    for (const id of ["components", "deadman", "scrape", "rules", "notifications", "capacity"]) {
      expect({ id, h2: region(c, id).querySelector("section[aria-labelledby] h2") !== null }).toEqual({ id, h2: true });
    }
    expect(region(c, "verdict").querySelector("[data-verdict]")!.getAttribute("data-verdict")).toBe("ok");
    expect(region(c, "deadman").textContent).not.toBe("");
    expect(all(region(c, "trends"), "li[data-query]")).toHaveLength(5);
  });

  test("REQ-RANGE-03: no snapshot gives the UTC fallback clock with TZ_FALLBACK_MARKER", async () => {
    const { TZ_FALLBACK_MARKER } = await import("../src/client/format.js");
    const m = await mountView({ snapshot: null });
    const zone = text(m.container.querySelector("[data-zone]"));
    expect(zone).toContain("Times in UTC");
    expect(zone).toContain(TZ_FALLBACK_MARKER);
  });

  test("REQ-OBS-01: a child that throws inside one region shows the fault there while the other eight render", async () => {
    const engine = okEngine();
    // `version` is read only by ComponentCard (formatVersion); rollUpVerdict and the section
    // selectors never touch it, so the throw lands inside the components region alone.
    const components = engine.components.map((comp) => {
      if (comp.id !== "victoriametrics") return comp;
      const copy = { ...comp } as Record<string, unknown>;
      Object.defineProperty(copy, "version", { get: () => { throw new Error("boom"); }, enumerable: true });
      return copy as unknown as EngineComponent;
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => errorSpy.mockRestore());
    const m = await mountView({ engine: { ...engine, components } });
    const c = m.container;
    expect(regions(c)).toEqual([...REGION_ORDER]);
    expect(region(c, "components").querySelector('[data-slot="fragment-boundary"]')).not.toBeNull();
    expect(text(region(c, "components"))).toContain("Components unavailable");
    for (const id of REGION_ORDER.filter((r) => r !== "components")) {
      expect({ id, fault: region(c, id).querySelector('[data-slot="fragment-boundary"]') !== null }).toEqual({ id, fault: false });
    }
    expect(region(c, "verdict").querySelector("[data-verdict]")).not.toBeNull();
    expect(region(c, "scrape").querySelector("li[data-job]")).not.toBeNull();
    expect(c.querySelector('[data-slot="page-error-boundary"]')).toBeNull();
  });

  // --- loading / unknown / refresh (REQ-EFRESH-01/03, REQ-VERDICT-01) -----------------------------

  test("REQ-EFRESH-03 / REQ-VERDICT-01: null engine, phase initial, not notCurrent → loading layout, no banner, no history request", async () => {
    const m = await mountView({ engine: null, phase: "initial", connection: "initial" });
    const root = m.container.querySelector('[data-slot="engine-page"]')!;
    expect(root.getAttribute("data-region")).toBe("loading");
    expect(root.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(text(root)).toContain("Loading engine state…");
    expect(m.container.querySelector("[data-verdict]")).toBeNull();
    expect(m.container.querySelector('[data-region="trends"]')).toBeNull();
    expect(stub!.calls).toEqual([]);
  });

  test("REQ-VERDICT-01 / REQ-DEGRADE-01: null engine with a persistently stale connection → Unknown banner and 'Engine data unavailable'", async () => {
    const m = await mountView({ engine: null, phase: "initial", connection: "stale" });
    const c = m.container;
    expect(c.querySelector("[aria-busy]")).toBeNull();
    expect(region(c, "verdict").querySelector("[data-verdict]")!.getAttribute("data-verdict")).toBe("unknown");
    expect(text(region(c, "unavailable"))).toContain("Engine data unavailable");
    expect(regions(c)).toEqual(["verdict", "unavailable", "trends", "grafana"]);
  });

  test("REQ-VERDICT-01: null engine with phase current → Unknown banner and 'Engine data unavailable'; trends still render", async () => {
    const m = await mountView({ engine: null, phase: "current" });
    const c = m.container;
    expect(region(c, "verdict").querySelector("[data-verdict]")!.getAttribute("data-verdict")).toBe("unknown");
    expect(text(c)).toContain("Engine data unavailable");
    expect(all(region(c, "trends"), "li[data-query]")).toHaveLength(5);
    expect(c.querySelector('[data-region="components"]')).toBeNull();
  });

  test("REQ-EFRESH-01: assigning a new store.engine payload re-renders in place without a reload", async () => {
    const m = await mountView({ engine: null, phase: "initial", connection: "initial" });
    expect(m.container.querySelector("[aria-busy]")).not.toBeNull();
    m.store.engine.value = okEngine();
    m.store.connection.value = { ...m.store.connection.value, phase: "live", views: { ...m.store.connection.value.views, engine: delivery("current") } };
    await settle();
    expect(m.container.querySelector("[data-verdict]")!.getAttribute("data-verdict")).toBe("ok");
    const root = m.container.querySelector('[data-slot="engine-page"]')!;
    m.store.engine.value = ENGINE_SCENARIOS.degraded();
    await settle();
    expect(m.container.querySelector('[data-slot="engine-page"]')).toBe(root);
    expect(m.container.querySelector("[data-verdict]")!.getAttribute("data-verdict")).toBe("degraded");
  });

  // --- persistent vs transient staleness (REQ-EFRESH-02) ------------------------------------------

  test("REQ-EFRESH-02: a view phase stale longer than REFRESH_INTERVAL_MS gives Unknown, the not-current notice, and no 'Healthy' chip", async () => {
    jest.useFakeTimers();
    const m = await mountView({ phase: "stale" });
    const c = m.container;
    expect(c.querySelector("[data-verdict]")!.getAttribute("data-verdict")).toBe("ok");
    expect(c.querySelector("[data-not-current-notice]")).toBeNull();
    jest.advanceTimersByTime(REFRESH_INTERVAL_MS + 1);
    await settle();
    expect(c.querySelector("[data-verdict]")!.getAttribute("data-verdict")).toBe("unknown");
    expect(c.querySelector('[data-slot="engine-page"]')!.getAttribute("data-not-current")).toBe("true");
    const notice = c.querySelector("[data-not-current-notice]")!;
    expect(text(notice)).toContain("Not current");
    expect(text(notice)).toContain("Showing the last engine data received");
    // The notice sits directly under the banner.
    expect(region(c, "verdict").nextElementSibling).toBe(notice);
    const chips = all(region(c, "components"), BADGE).map((n) => text(n));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.some((t) => t.includes("Healthy"))).toBe(false);
  });

  test("REQ-EFRESH-02: a stale phase shorter than REFRESH_INTERVAL_MS keeps OK", async () => {
    jest.useFakeTimers();
    const m = await mountView({ phase: "stale" });
    jest.advanceTimersByTime(REFRESH_INTERVAL_MS - 5_000);
    await settle();
    m.store.connection.value = { ...m.store.connection.value, views: { ...m.store.connection.value.views, engine: delivery("current") } };
    await settle();
    jest.advanceTimersByTime(REFRESH_INTERVAL_MS);
    await settle();
    const c = m.container;
    expect(c.querySelector("[data-verdict]")!.getAttribute("data-verdict")).toBe("ok");
    expect(c.querySelector("[data-not-current-notice]")).toBeNull();
    expect(all(region(c, "components"), BADGE).some((n) => text(n).includes("Healthy"))).toBe(true);
  });

  test("REQ-VERDICT-01: the degraded fixture's banner names each contributor", async () => {
    const m = await mountView({ engine: ENGINE_SCENARIOS.degraded() });
    const banner = m.container.querySelector("[data-verdict]")!;
    expect(banner.getAttribute("data-verdict")).toBe("degraded");
    const t = text(banner);
    for (const c of ["vmalert unreachable", "2 scrape targets down", "deadman not configured"]) expect(t).toContain(c);
  });

  // --- kiosk (REQ-KIOSK-01/02/04, CON-08) ---------------------------------------------------------

  /** Degraded with one more unhealthy component, so the desk banner needs "and N more". */
  function wideDegraded(): EnginePayload {
    const e = ENGINE_SCENARIOS.degraded();
    return { ...e, components: e.components.map((comp) => (comp.id === "gatus" ? { ...comp, state: "unhealthy" as const } : comp)) };
  }

  test("REQ-KIOSK-02: the desk banner shows 'and N more'; ?kiosk=1 shows every contributor inline with no button", async () => {
    const desk = await mountView({ engine: wideDegraded() });
    const deskBanner = desk.container.querySelector("[data-verdict]")!;
    expect(deskBanner.querySelector("button")).not.toBeNull();
    desk.unmount();

    const m = await mountView({ search: "?kiosk=1", engine: wideDegraded() });
    const banner = m.container.querySelector("[data-verdict]")!;
    expect(m.container.querySelector('[data-slot="engine-page"]')!.getAttribute("data-kiosk")).toBe("1");
    expect(banner.querySelector("button")).toBeNull();
    const verdict = { kind: "degraded" as const, contributors: ["vmalert unreachable", "Gatus unreachable", "deadman not configured", "2 scrape targets down"] };
    for (const c of verdict.contributors) expect(text(banner)).toContain(c);
  });

  test("REQ-KIOSK-01/02/04, CON-08: ?kiosk=1 with a rotation prop — problem groups expanded, healthy rows have no button, rotation untouched, only LIVE_REFRESH_MS recurs", async () => {
    const g = realGlobal as unknown as { setInterval: (...a: unknown[]) => unknown; setTimeout: (...a: unknown[]) => unknown };
    const intervalSpy = spyOn(g, "setInterval");
    const timeoutSpy = spyOn(g, "setTimeout");
    cleanups.push(() => {
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
    });
    const rotation: ViewRotationContext = Object.freeze({ entry: Object.freeze({ viewId: "engine", dwellMs: 30_000 }), index: 0, total: 3, epoch: 7 });
    const before = JSON.stringify(rotation);
    const m = await mountView({ search: "?kiosk=1", rotation, engine: wideDegraded() });
    const c = m.container;

    expect(c.querySelector('[data-slot="engine-page"]')!.getAttribute("data-kiosk")).toBe("1");
    const problemJob = c.querySelector('li[data-job="node"]')!;
    expect(problemJob.getAttribute("data-problem")).toBe("true");
    expect(problemJob.querySelector("table")).not.toBeNull();
    for (const row of all(c, 'li[data-problem="false"]')) {
      expect({ row: row.getAttribute("data-job") ?? row.getAttribute("data-group"), button: row.querySelector("button") !== null })
        .toEqual({ row: row.getAttribute("data-job") ?? row.getAttribute("data-group"), button: false });
    }
    expect(all(c, 'li[data-problem="false"]').length).toBeGreaterThan(0);
    expect(c.querySelector("[data-verdict] button")).toBeNull();
    expect(JSON.stringify(rotation)).toBe(before);

    const intervals = intervalSpy.mock.calls.map((a) => a[1]);
    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals.every((p) => p === LIVE_REFRESH_MS)).toBe(true);
    // No one-shot timer is a rotation-length timer either (CON-08): nothing at the dwell period.
    expect(timeoutSpy.mock.calls.some((a) => a[1] === 30_000)).toBe(false);
  });

  // --- Grafana link and plain text (REQ-ELINK-01, REQ-SEC-02/04) ----------------------------------

  test("REQ-ELINK-01 / REQ-SEC-04: the Grafana link is {base}/d/pulse-engine, target=_blank, rel=noopener noreferrer", async () => {
    const m = await mountView({ snapshot: snapshotWithGrafana("https://grafana.example.net/sub/d/host-board/web01?orgId=1") });
    const a = region(m.container, "grafana").querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://grafana.example.net/sub/d/pulse-engine");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(text(a)).toContain("Open the pulse-engine board in Grafana");
  });

  test("REQ-ELINK-01: the Grafana link is absent when Grafana is not-configured", async () => {
    const e = okEngine();
    const engine = { ...e, components: e.components.map((comp) => (comp.id === "grafana" ? { ...comp, state: "not-configured" as const } : comp)) };
    const m = await mountView({ engine, snapshot: snapshotWithGrafana("https://grafana.example.net/d/host-board/web01") });
    expect(regions(m.container)).toContain("grafana");
    expect(region(m.container, "grafana").querySelector("a")).toBeNull();
  });

  test("REQ-ELINK-01 / REQ-SEC-03: the Grafana link is absent when no base can be derived", async () => {
    const none = await mountView();
    expect(region(none.container, "grafana").querySelector("a")).toBeNull();
    none.unmount();
    const unsafe = await mountView({ snapshot: snapshotWithGrafana("javascript:alert(1)//d/host-board") });
    expect(region(unsafe.container, "grafana").querySelector("a")).toBeNull();
  });

  test("REQ-SEC-02: hostileStrings render literally through the full view", async () => {
    const m = await mountView({ engine: ENGINE_SCENARIOS.hostileStrings() });
    const c = m.container;
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("b")).toBeNull();
    expect(c.textContent).toContain("node <b>x</b>");
    expect(c.textContent).toContain("group <img src=x onerror=alert(1)>");
    expect(c.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
