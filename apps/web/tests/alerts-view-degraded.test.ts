// apps/web/tests/alerts-view-degraded.test.ts — per-source degraded notices (source Callouts). Pure helpers are tested headless; DOM blocks use describeDom
// (tests/dom.ts), happy-dom per file.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import type { AlertsPayload, DataAvailability } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { describeDom } from "./dom.js";
import { FIXTURE_LAST_GOOD_AT, makeAlertsPayload } from "./alerts-fixtures.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";

isolateDomGlobals();

// Dynamic import: loading the ui barrel before happy-dom registers leaks globals into other files.
const loadDegraded = async () => ({
  ...(await import("../src/client/views/alerts/degraded-model.js")),
  ...(await import("../src/client/views/alerts/degraded.js")),
});

function withEmptyArrays(p: AlertsPayload): AlertsPayload {
  return { ...p, alerts: [], rules: [], silences: [] };
}

function avail(
  source: DataAvailability["source"],
  state: DataAvailability["state"],
  lastGoodAt: string | null,
  message: string | null,
): DataAvailability {
  return { source, state, lastGoodAt, message } as DataAvailability;
}

describe("formatLastGood", () => {
  test("null and unparseable input return 'time unknown' without throwing", async () => {
    const { formatLastGood } = await loadDegraded();
    expect(() => formatLastGood(null)).not.toThrow();
    expect(formatLastGood(null)).toBe("time unknown");
    expect(() => formatLastGood("not-a-date")).not.toThrow();
    expect(formatLastGood("not-a-date")).toBe("time unknown");
  });

  test("a valid ISO string returns a local HH:MM", async () => {
    const { formatLastGood } = await loadDegraded();
    const out = formatLastGood(FIXTURE_LAST_GOOD_AT);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
    expect(out).toBe(
      new Date(Date.parse(FIXTURE_LAST_GOOD_AT)).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  });
});

describe("sourceStatusHeadline / sourceStatusViews", () => {
  test("is total over AvailabilityState and names the source + last-good time", async () => {
    const { formatLastGood, sourceStatusHeadline } = await loadDegraded();
    const at = formatLastGood(FIXTURE_LAST_GOOD_AT);
    const mk = (state: DataAvailability["state"]) =>
      sourceStatusHeadline({
        label: "Alertmanager",
        availability: avail("alertmanager-alerts", state, FIXTURE_LAST_GOOD_AT, null),
      });
    expect(mk("stale")).toBe(`Alertmanager data is stale — last updated ${at}`);
    expect(mk("unavailable")).toBe(`Alertmanager unreachable — showing data as of ${at}`);
    expect(mk("not-configured")).toBe("Alertmanager is not configured");
    expect(mk("current")).toBe("Alertmanager data is current");
  });

  test("sourceStatusViews labels both sources in stable order, verbatim availability", async () => {
    const { sourceStatusViews } = await loadDegraded();
    const p = makeAlertsPayload({ scenario: "am-down" });
    const views = sourceStatusViews(p);
    expect(views.map((v) => v.label)).toEqual(["Alertmanager", "vmalert"]);
    expect(views[0]?.availability).toBe(p.alertmanager);
    expect(views[1]?.availability).toBe(p.vmalert);
  });
});

describe("degraded source discipline", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/client/views/alerts/degraded.tsx", import.meta.url)),
    "utf8",
  );

  test("imports no stylesheet", () => {
    expect(src).not.toMatch(/import\s+["'][^"']*\.css["']/);
  });

  test("never keys the render decision off an array length", () => {
    expect(src).not.toContain(".length");
  });
});

describeDom("SourceStatus / SourceStatusBanners", (dom) => {
  async function mountBanners(payload: AlertsPayload): Promise<HTMLElement> {
    const { createElement: h } = await import("react");
    const { SourceStatusBanners } = await loadDegraded();
    const { container } = await dom.mount(h(SourceStatusBanners, { payload }) as unknown as ReactElement);
    return container;
  }

  function banners(c: HTMLElement): HTMLElement[] {
    return [...c.querySelectorAll<HTMLElement>('[data-slot="callout"][data-availability]')];
  }

  test("a current source renders nothing", async () => {
    const c = await mountBanners(makeAlertsPayload({ scenario: "mixed" }));
    const group = c.querySelector("[data-source-status-group]")!;
    expect(group).not.toBeNull();
    expect(group.childElementCount).toBe(0); // collapses via empty:hidden — no empty bordered box
    expect(group.getAttribute("class")).toContain("empty:hidden");
    expect(banners(c).length).toBe(0);
    expect(c.querySelector('[role="status"]')).toBeNull();
  });

  test("SourceStatus returns null for a current source", async () => {
    const { SourceStatus } = await loadDegraded();
    const p = makeAlertsPayload({ scenario: "mixed" });
    expect(SourceStatus({ source: { label: "vmalert", availability: p.vmalert } })).toBeNull();
  });

  test("a non-current source renders a source-named unknown Callout (role=status, icon + headline + detail)", async () => {
    const c = await mountBanners(makeAlertsPayload({ scenario: "am-down" }));
    const [b] = banners(c);
    expect(banners(c).length).toBe(1);
    expect(b?.getAttribute("role")).toBe("status"); // polite, never a live alert
    expect(b?.getAttribute("data-availability")).toBe("unavailable");
    expect(b?.getAttribute("data-source")).toBe("alertmanager-alerts");
    expect(b?.getAttribute("data-status")).toBe("unknown");
    expect(b?.getAttribute("data-tone")).toBe("neutral");
    const icon = b?.querySelector('svg[data-slot="icon"]');
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("class")).toContain("lucide-circle-question-mark");
    const title = b?.querySelector('[data-slot="alert-title"]')?.textContent ?? "";
    expect(title).toContain("Alertmanager");
    expect(title).toContain("unreachable");
    expect(b?.querySelector("[data-source-status-detail]")?.textContent).toBe(
      "The upstream source could not be reached.",
    );
  });

  test("the last-good time is shown", async () => {
    const { formatLastGood } = await loadDegraded();
    const c = await mountBanners(makeAlertsPayload({ scenario: "stale" }));
    const [b] = banners(c);
    expect(b?.getAttribute("data-availability")).toBe("stale");
    expect(b?.textContent).toContain(formatLastGood(FIXTURE_LAST_GOOD_AT));
    expect(b?.textContent).toContain("stale");
  });

  test("empty alerts/silences/rules under a non-current source still show the banner (never silent-green)", async () => {
    for (const scenario of ["am-down", "vmalert-down", "stale"] as const) {
      const c = await mountBanners(withEmptyArrays(makeAlertsPayload({ scenario })));
      expect(banners(c).length).toBe(1);
    }
  });

  test("Alertmanager and vmalert degrade independently", async () => {
    const am = banners(await mountBanners(makeAlertsPayload({ scenario: "am-down" })));
    expect(am.length).toBe(1);
    expect(am[0]?.textContent).toContain("Alertmanager");
    expect(am[0]?.textContent).not.toContain("vmalert");

    const vm = banners(await mountBanners(makeAlertsPayload({ scenario: "vmalert-down" })));
    expect(vm.length).toBe(1);
    expect(vm[0]?.textContent).toContain("vmalert");
    expect(vm[0]?.textContent).not.toContain("Alertmanager");

    const base = makeAlertsPayload({ scenario: "mixed" });
    const both: AlertsPayload = {
      ...base,
      alertmanager: avail("alertmanager-alerts", "stale", FIXTURE_LAST_GOOD_AT, null),
      vmalert: avail("vmalert-rules", "not-configured", null, null),
    };
    const two = banners(await mountBanners(both));
    expect(two.map((b) => b.getAttribute("data-availability"))).toEqual(["stale", "not-configured"]);
    expect(two[1]?.textContent).toContain("vmalert is not configured");
    // message null -> no detail paragraph
    expect(two[0]?.querySelector("[data-source-status-detail]")).toBeNull();
    expect(two.map((b) => b.getAttribute("data-source"))).toEqual(["alertmanager-alerts", "vmalert-rules"]);
  });
});
