// apps/web/tests/alerts-view.test.ts — the integrated /alerts view: page frame, URL-driven tabs,
// facets, detail pane, keyboard and the render-fault boundary. Mounts the real default export against
// a fixture-seeded store and a real path router on /alerts. describeDom registers happy-dom for this file only;
// isolateDomGlobals restores globalThis afterwards (readdir-order leak, see alerts-dom-isolation.ts).

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import type { AlertsPayload } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import type { PathRouter } from "../src/client/router.js";
import { describeDom } from "./dom.js";
import { installUiStubs } from "./rtl.js";
import { activeTabPanel, alertsTab, detailDialog, eventually, facetToggles, selectTab } from "./alerts-dom-helpers.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload, makeHistoryPayload } from "./alerts-fixtures.js";

isolateDomGlobals();

const originalFetch = globalThis.fetch;

describeDom("AlertsView (integrated)", (dom) => {
  let restoreStubs: (() => void) | null = null;
  beforeAll(() => {
    restoreStubs = installUiStubs();
  });
  afterAll(() => {
    restoreStubs?.();
  });
  interface Mounted {
    container: HTMLElement;
    router: PathRouter;
    store: AppStore;
    unmount(): void;
  }

  let live: Mounted[] = [];

  beforeEach(() => {
    // History (the only on-demand fetch) must never reach the network.
    globalThis.fetch = (() =>
      Promise.resolve({ json: () => Promise.resolve(makeHistoryPayload({ kind: "ready" })) })) as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const m of live) {
      m.unmount();
      m.router.stop();
    }
    live = [];
    globalThis.fetch = originalFetch;
  });

  function win(): Window {
    return (globalThis as unknown as { window: Window }).window;
  }

  async function flush(): Promise<void> {
    // React schedules signal-driven re-renders; give the scheduler a few real ticks.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 10));
  }

  async function setup(
    search: string,
    payload: AlertsPayload | null = makeAlertsPayload({ scenario: "mixed" }),
    storeOverride?: AppStore,
  ): Promise<Mounted> {
    const { createElement: h } = await import("react");
    const { createPathRouter } = await import("../src/client/router.js");
    const { default: AlertsView } = await import("../src/client/views/alerts/view.js");
    win().history.replaceState({}, "", "/alerts" + search);
    const router = createPathRouter({
      routes: [
        { pattern: "/alerts", view: "alerts" },
        { pattern: "/", view: "overview" },
      ],
      fallback: "/",
      win: win(),
    });
    const store = storeOverride ?? createAppStore({ storage: null, initialQuery: {} });
    if (storeOverride === undefined) store.alerts.value = payload;
    const { container, unmount } = await dom.mount(h(AlertsView, { store, router }) as unknown as ReactElement);
    await flush();
    const m: Mounted = { container, router, store, unmount };
    live.push(m);
    return m;
  }

  function query(m: Mounted): Readonly<Record<string, string>> {
    return m.router.current().query;
  }

  function press(m: Mounted, key: string): void {
    const doc = m.container.ownerDocument;
    const view = doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent };
    doc.dispatchEvent(new view.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  const TAB_NAMES = { firing: "Firing", catalog: "Catalog", silences: "Silences" } as const;

  function tabButton(m: Mounted, id: keyof typeof TAB_NAMES): HTMLElement {
    const el = alertsTab(m.container, TAB_NAMES[id]);
    expect(el).not.toBeNull();
    return el!;
  }

  function panelFor(m: Mounted, id: keyof typeof TAB_NAMES): HTMLElement {
    const panel = activeTabPanel(m.container);
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("data-tab")).toBe(id);
    return panel!;
  }

  function page(m: Mounted): HTMLElement {
    const root = m.container.querySelector<HTMLElement>('[data-slot="alerts-page"]');
    expect(root).not.toBeNull();
    return root!;
  }

  test("the page root is data-slot=alerts-page with exactly one h1 'Alerts' above the tabs", async () => {
    const m = await setup("");
    const root = page(m);
    const h1s = m.container.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0]!.textContent).toBe("Alerts");
    expect(root.contains(h1s[0]!)).toBe(true);
    const tablist = root.querySelector('[role="tablist"]')!;
    expect(h1s[0]!.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No legacy class hooks on the frame.
    expect(m.container.innerHTML).not.toMatch(/pulse-view-alert[s]|pulse-tab[s]|pulse-skeleto[n]/);
  });

  test("renders the Firing/Catalog/Silences Radix tablist with an aria-label; firing is the default panel", async () => {
    const m = await setup("");
    const tablist = m.container.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("Alert triage views");
    expect(tablist?.getAttribute("data-slot")).toBe("tabs-list");
    const tabs = [...m.container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(["Firing", "Catalog", "Silences"]);
    // Each trigger carries a decorative icon beside its text.
    for (const t of tabs) expect(t.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const panel = panelFor(m, "firing");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabButton(m, "firing").id);
    expect(tabButton(m, "firing").getAttribute("aria-controls")).toBe(panel.id);
    expect(tabButton(m, "firing").getAttribute("aria-selected")).toBe("true");
    expect(tabButton(m, "catalog").getAttribute("aria-selected")).toBe("false");
    // Only one visible panel; the inactive ones render nothing.
    expect(m.container.querySelectorAll('[role="tabpanel"]:not([hidden])').length).toBe(1);
    for (const hidden of m.container.querySelectorAll('[role="tabpanel"][hidden]')) {
      expect(hidden.childElementCount).toBe(0);
    }
  });

  test("each active tab controls a correctly labelled tabpanel", async () => {
    for (const id of ["firing", "catalog", "silences"] as const) {
      const m = await setup(id === "firing" ? "" : `?tab=${id}`);
      const tab = tabButton(m, id);
      expect(tab.getAttribute("aria-selected")).toBe("true");
      const panel = panelFor(m, id);
      expect(tab.getAttribute("aria-controls")).toBe(panel.id);
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
    }
  });

  test("the firing panel composes banners, facet bar, keyboard hints and the triage table", async () => {
    const m = await setup("", makeAlertsPayload({ scenario: "am-down" }));
    const panel = panelFor(m, "firing");
    const order = [
      "[data-source-status-group]",
      '[role="search"][aria-label="Alert filters"]',
      '[role="note"][aria-label="Keyboard shortcuts"]',
      "[data-triage-table]",
    ].map((sel) => {
      const el = panel.querySelector(sel);
      expect(el).not.toBeNull();
      return [...panel.querySelectorAll("*")].indexOf(el!);
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(panel.querySelector('[data-slot="callout"][data-availability="unavailable"]')).not.toBeNull();
    // The filter bar's count reflects the firing rows (none filtered out).
    const total = panel.querySelectorAll("[data-triage-open]").length;
    expect(panel.querySelector('[data-slot="result-count"]')!.textContent).toBe(
      `Showing ${total} of ${total} firing alerts; 0 hidden by filters.`,
    );
  });

  test("the tab query selects catalog/silences panels; unknown values fall back to firing", async () => {
    const payload = makeAlertsPayload({ scenario: "mixed" });
    const cat = await setup("?tab=catalog", payload);
    const catPanel = panelFor(cat, "catalog");
    expect(catPanel.querySelector("[data-triage-table]")).toBeNull();
    expect(cat.container.querySelector("[data-triage-table]")).toBeNull();
    expect(catPanel.querySelector("caption")?.textContent).toBe("Alert rules");
    expect(catPanel.textContent).toContain(payload.rules[0]!.name);

    const sil = await setup("?tab=silences", payload);
    const silPanel = panelFor(sil, "silences");
    expect(silPanel.querySelector("caption")?.textContent).toBe("Active silences");
    expect(silPanel.querySelector("code")).not.toBeNull();
    // The view wires the gated expire action, so the Actions column is present.
    expect([...silPanel.querySelectorAll("thead th")].map((th) => th.textContent)).toContain("Actions");

    const bogus = await setup("?tab=nonsense", payload);
    panelFor(bogus, "firing");
    expect(tabButton(bogus, "firing").getAttribute("aria-selected")).toBe("true");
  });

  test("clicking a tab navigates (other keys and kiosk preserved, firing by omission)", async () => {
    const m = await setup("?kiosk=1&sev=critical&sel=" + FIXTURE_FINGERPRINTS.hostDown);
    selectTab(tabButton(m, "catalog"));
    await flush();
    expect(query(m)).toEqual({ kiosk: "1", sev: "critical", sel: FIXTURE_FINGERPRINTS.hostDown, tab: "catalog" });
    panelFor(m, "catalog");
    expect(tabButton(m, "catalog").getAttribute("aria-selected")).toBe("true");

    selectTab(tabButton(m, "firing"));
    await flush();
    expect(query(m)).toEqual({ kiosk: "1", sev: "critical", sel: FIXTURE_FINGERPRINTS.hostDown });
    panelFor(m, "firing");
  });

  test("the tabs are controlled by the URL: navigation and back/forward re-select the tab", async () => {
    const m = await setup("");
    selectTab(tabButton(m, "silences"));
    await flush();
    expect(query(m)).toEqual({ tab: "silences" });
    panelFor(m, "silences");

    const PopEvent = (win() as unknown as { Event: typeof Event }).Event;
    win().history.back();
    win().dispatchEvent(new PopEvent("popstate"));
    await flush();
    expect(query(m)).toEqual({});
    expect(tabButton(m, "firing").getAttribute("aria-selected")).toBe("true");
    panelFor(m, "firing");

    win().history.forward();
    win().dispatchEvent(new PopEvent("popstate"));
    await flush();
    expect(query(m)).toEqual({ tab: "silences" });
    expect(tabButton(m, "silences").getAttribute("aria-selected")).toBe("true");
    panelFor(m, "silences");

    // A programmatic navigation (e.g. a deep link) selects the tab too.
    m.router.navigate("/alerts?tab=catalog");
    await flush();
    expect(tabButton(m, "catalog").getAttribute("aria-selected")).toBe("true");
    panelFor(m, "catalog");
  });

  test("arrow keys move focus between tab triggers (roving focus) and select by navigation", async () => {
    const m = await setup("");
    const firing = tabButton(m, "firing");
    firing.focus();
    const view = firing.ownerDocument.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent };
    firing.dispatchEvent(new view.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await flush();
    expect(document.activeElement).toBe(tabButton(m, "catalog"));
    expect(query(m)).toEqual({ tab: "catalog" });
    expect(tabButton(m, "catalog").getAttribute("aria-selected")).toBe("true");
  });

  test("opening a row sets sel (preserving tab-less facets + rotate); closing clears only sel", async () => {
    const m = await setup("?rotate=30&state=firing");
    const open = m.container.querySelector<HTMLElement>(`[data-triage-open="${FIXTURE_FINGERPRINTS.hostDown}"]`);
    expect(open).not.toBeNull();
    open!.click();
    await flush();
    expect(query(m)).toEqual({ rotate: "30", state: "firing", sel: FIXTURE_FINGERPRINTS.hostDown });
    const dialog = detailDialog();
    expect(dialog).not.toBeNull();

    const close = dialog!.querySelector<HTMLElement>('button[aria-label="Close alert details"]');
    expect(close).not.toBeNull();
    close!.click();
    await flush();
    expect(query(m)).toEqual({ rotate: "30", state: "firing" });
    expect(detailDialog()).toBeNull();
  });

  test("one Escape closes the pane with exactly one navigation and focus returns to the row control", async () => {
    const m = await setup("?state=firing");
    const open = m.container.querySelector<HTMLElement>(`[data-triage-open="${FIXTURE_FINGERPRINTS.hostDown}"]`)!;
    open.focus();
    open.click();
    await eventually(() => {
      const dialog = detailDialog();
      if (dialog === null || !dialog.contains(document.activeElement)) throw new Error("detail Sheet not open/focused");
    }, 15_000);
    const dialog = detailDialog()!;

    const navigations: string[] = [];
    const navigate = m.router.navigate.bind(m.router);
    m.router.navigate = ((path: string, ...rest: unknown[]) => {
      navigations.push(path);
      return (navigate as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof m.router.navigate;
    // Escape inside the Sheet: the Sheet's own handler and the triage shortcut both see it.
    const view = document.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent };
    dialog.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await eventually(() => {
      if (detailDialog() !== null) throw new Error("detail Sheet still open");
      const again = m.container.querySelector<HTMLElement>(`[data-triage-open="${FIXTURE_FINGERPRINTS.hostDown}"]`);
      if (document.activeElement !== again) throw new Error("focus not returned to the row control");
    }, 15_000);
    await flush();
    expect(navigations).toEqual(["/alerts?state=firing"]);
    expect(query(m)).toEqual({ state: "firing" });
  }, 40_000);

  test("a facet toggle filters rows and rewrites only facet keys (tab/sel/kiosk preserved)", async () => {
    const m = await setup("?kiosk=1&sel=" + FIXTURE_FINGERPRINTS.hostDown);
    const before = m.container.querySelectorAll("[data-triage-table] [data-triage-open]").length;
    const chip = facetToggles(m.container, "Severity").find((b) => b.textContent?.includes("critical"));
    expect(chip).toBeDefined();
    chip!.click();
    await flush();
    expect(query(m)).toEqual({ kiosk: "1", sel: FIXTURE_FINGERPRINTS.hostDown, sev: "critical" });
    const after = [...m.container.querySelectorAll("[data-triage-table] [data-triage-open]")];
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(before);
    expect(chip!.getAttribute("aria-pressed")).toBe("true");
    expect(m.container.querySelector('[data-slot="result-count"]')!.textContent).toBe(
      `Showing ${after.length} of ${before} firing alerts; ${before - after.length} hidden by filters.`,
    );
    // The active value is listed as a removable chip; removing it rewrites only the facet keys.
    const remove = m.container.querySelector<HTMLButtonElement>('[aria-label="Remove Severity filter critical"]')!;
    remove.click();
    await flush();
    expect(query(m)).toEqual({ kiosk: "1", sel: FIXTURE_FINGERPRINTS.hostDown });
    expect(m.container.querySelectorAll("[data-triage-table] [data-triage-open]").length).toBe(before);
  });

  test("DetailPane is mounted once at view level and opens from a deep-linked sel", async () => {
    const m = await setup("?sel=" + FIXTURE_FINGERPRINTS.hostDown);
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    expect(detailDialog()?.querySelector("[data-detail-body] section[aria-labelledby]")).not.toBeNull();
  });

  test("payload null renders a LoadingState inside the same page root with the one h1, never a crash", async () => {
    const m = await setup("", null);
    const root = page(m);
    expect(m.container.querySelectorAll("h1").length).toBe(1);
    expect(root.querySelector("h1")?.textContent).toBe("Alerts");
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();
    const panel = panelFor(m, "firing");
    expect(panel.getAttribute("aria-busy")).toBe("true");
    const loading = panel.querySelector('[data-slot="loading-state"]');
    expect(loading?.getAttribute("role")).toBe("status");
    expect(loading?.getAttribute("aria-busy")).toBe("true");
    expect(m.container.querySelector("[data-triage-table]")).toBeNull();
  });

  test("browser history restores URL-derived facets and the open pane", async () => {
    const m = await setup("");
    const severity = facetToggles(m.container, "Severity").find((button) => button.textContent?.includes("critical"))!;
    severity.click();
    await flush();
    m.container.querySelector<HTMLElement>(`[data-triage-open="${FIXTURE_FINGERPRINTS.hostDown}"]`)!.click();
    await flush();
    expect(query(m)).toEqual({ sev: "critical", sel: FIXTURE_FINGERPRINTS.hostDown });
    expect(detailDialog()).not.toBeNull();

    win().history.back();
    const BackEvent = (win() as unknown as { Event: typeof Event }).Event;
    win().dispatchEvent(new BackEvent("popstate"));
    await flush();
    expect(query(m)).toEqual({ sev: "critical" });
    expect(detailDialog()).toBeNull();
    expect(severity.getAttribute("aria-pressed")).toBe("true");

    win().history.forward();
    const ForwardEvent = (win() as unknown as { Event: typeof Event }).Event;
    win().dispatchEvent(new ForwardEvent("popstate"));
    await flush();
    expect(query(m)).toEqual({ sev: "critical", sel: FIXTURE_FINGERPRINTS.hostDown });
    expect(detailDialog()).not.toBeNull();
  });

  test("the router subscription is disposed on unmount", async () => {
    const m = await setup("");
    m.unmount();
    const afterUnmount = m.container.innerHTML;
    m.router.navigate(`/alerts?sel=${FIXTURE_FINGERPRINTS.diskFull}`);
    await flush();
    expect(m.container.innerHTML).toBe(afterUnmount);
  });

  test("installTriageKeyboard is live while mounted and disposed on unmount", async () => {
    const m = await setup("?sel=" + FIXTURE_FINGERPRINTS.hostDown);
    press(m, "Escape");
    await flush();
    expect(query(m).sel).toBeUndefined();

    m.unmount();
    m.router.navigate("/alerts?sel=" + FIXTURE_FINGERPRINTS.diskFull);
    press(m, "Escape");
    await flush();
    expect(query(m).sel).toBe(FIXTURE_FINGERPRINTS.diskFull);
  });

  test("a render fault degrades to the PageErrorBoundary fallback (logged, shell unaffected)", async () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const faulty = new Proxy(store, {
      get(target, key, recv) {
        if (key === "alerts") {
          return {
            get value(): never {
              throw new Error("boom");
            },
          };
        }
        return Reflect.get(target, key, recv) as unknown;
      },
    });
    const errors: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const m = await setup("", null, faulty);
      const fallback = m.container.querySelector('[data-slot="page-error-boundary"]');
      expect(fallback).not.toBeNull();
      expect(fallback!.querySelector("h1")?.textContent).toBe("The alerts view hit a rendering error");
      expect(fallback!.textContent).toContain("Reload to try again — other views are unaffected.");
      expect(fallback!.textContent).not.toContain("boom");
      expect(m.container.querySelector('[role="tablist"]')).toBeNull();
    } finally {
      console.error = origError;
    }
    expect(errors.some((args) => args[0] === "[alerts-view] render fault")).toBe(true);
  });
});
