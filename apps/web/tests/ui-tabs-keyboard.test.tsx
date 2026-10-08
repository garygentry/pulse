// apps/web/tests/ui-tabs-keyboard.test.tsx — the keyboard contract of the Radix tabs.
//
// The shared `Tabs` primitive (`@/ui`, Radix Tabs) in both activation modes, then the two views that
// use it: alerts (Firing / Catalog / Silences, automatic activation: an arrow key selects and
// navigates) and estate (Inventory / Coverage / Findings, manual activation: arrows move focus, Enter
// or Space selects). Asserted through roles and ARIA state only:
//   • the tablist is one tab stop: the selected tab has tabindex 0, the others -1 (roving tabindex);
//   • ArrowRight/ArrowLeft move to the next/previous tab and wrap at the ends; Home/End go to the
//     first/last; a disabled tab is skipped;
//   • automatic activation selects the focused tab and shows its panel; manual activation only moves
//     focus until Enter or Space;
//   • Tab from the tablist moves into the selected panel.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { useState, type ReactElement } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui";
import { createPathRouter, routesFromViews, type PathRouter } from "../src/client/router.js";
import { createAppStore, type AppStore } from "../src/client/store/index.js";
import AlertsView from "../src/client/views/alerts/view.js";
import EstateView from "../src/client/views/estate/view.js";
import { VIEWS } from "../src/client/views/registry.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { makeAlertsPayload, makeHistoryPayload } from "./alerts-fixtures.js";
import { makeEstatePayloadFixture } from "./factories/estate-payload.js";
import { act, describeUi, render, screen, userEvent, waitFor, within } from "./rtl.js";

isolateDomGlobals();

function Demo({
  activationMode,
  disabled,
  initial = "one",
}: {
  activationMode?: "automatic" | "manual";
  disabled?: boolean;
  initial?: string;
}): ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <Tabs value={value} onValueChange={setValue} {...(activationMode !== undefined ? { activationMode } : {})}>
      <TabsList aria-label="Demo sections">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two" disabled={disabled === true}>
          Two
        </TabsTrigger>
        <TabsTrigger value="three">Three</TabsTrigger>
      </TabsList>
      <TabsContent value="one">Panel one</TabsContent>
      <TabsContent value="two">Panel two</TabsContent>
      <TabsContent value="three">Panel three</TabsContent>
    </Tabs>
  );
}

/** The tablist the current test drives (estate nests a second tablist inside Inventory). */
let list = "Demo sections";
const tablist = (): HTMLElement => screen.getByRole("tablist", { name: list });
const tab = (name: string): HTMLElement => within(tablist()).getByRole("tab", { name });

/** Each tab of the tablist as `name:aria-selected:tabindex`; the selected tab is the one tab stop. */
function tabStops(): string[] {
  return within(tablist())
    .getAllByRole("tab")
    .map((t) => `${t.textContent?.trim()}:${t.getAttribute("aria-selected")}:${t.getAttribute("tabindex")}`);
}

/** Roving tabindex: `selected` is aria-selected with tabindex 0; every other tab is -1 and unselected.
 *  (Before the first focus Radix keeps the tablist itself as the tab stop, which forwards focus to
 *  the selected tab; see the first test. This holds from the first focus on.) */
function expectRovingStop(selected: string): void {
  const names = within(tablist()).getAllByRole("tab").map((t) => t.textContent?.trim());
  expect(tabStops()).toEqual(names.map((n) => (n === selected ? `${n}:true:0` : `${n}:false:-1`)));
}

/** What has focus, as `role "name"` (plain strings: jest-dom's focus matcher dumps the window on failure). */
function focused(): string {
  const el = document.activeElement as HTMLElement | null;
  if (el === null || el === document.body) return "body";
  const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
  const labelledBy = el.getAttribute("aria-labelledby");
  const name = labelledBy !== null ? document.getElementById(labelledBy)?.textContent?.trim() : el.textContent?.trim();
  return `${role} "${name ?? ""}"`;
}

describeUi("Tabs primitive: Radix keyboard contract", () => {
  beforeEach(() => {
    list = "Demo sections";
  });

  test("a labelled tablist that is one tab stop: Tab lands on the selected tab, which controls the panel", async () => {
    const user = userEvent.setup();
    render(<Demo initial="three" />);
    const list = screen.getByRole("tablist", { name: "Demo sections" });
    expect(list.getAttribute("aria-orientation")).toBe("horizontal");
    // No tab is in the Tab order yet: the tablist is the stop and forwards focus to the selected tab.
    expect(tabStops()).toEqual(["One:false:-1", "Two:false:-1", "Three:true:-1"]);
    await user.tab();
    expect(focused()).toBe('tab "Three"');
    expectRovingStop("Three");
    const panel = screen.getByRole("tabpanel", { name: "Three" });
    expect(panel.textContent).toBe("Panel three");
    expect(tab("Three").getAttribute("aria-controls")).toBe(panel.id);
  });

  test("automatic activation (the default): arrows move focus AND select, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.tab();
    expect(focused()).toBe('tab "One"');

    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe('tab "Two"');
    expectRovingStop("Two");
    expect(screen.getByRole("tabpanel", { name: "Two" }).textContent).toBe("Panel two");

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(focused()).toBe('tab "One"'); // wrapped past the last tab
    expectRovingStop("One");

    await user.keyboard("{ArrowLeft}");
    expect(focused()).toBe('tab "Three"'); // wrapped before the first tab
    expectRovingStop("Three");
  });

  test("Home and End go to the first and last tab", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.tab();
    await user.keyboard("{End}");
    expect(focused()).toBe('tab "Three"');
    expectRovingStop("Three");
    await user.keyboard("{Home}");
    expect(focused()).toBe('tab "One"');
    expectRovingStop("One");
  });

  test("a disabled tab is skipped", async () => {
    const user = userEvent.setup();
    render(<Demo disabled />);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe('tab "Three"');
    expectRovingStop("Three");
  });

  test("manual activation: arrows move focus only; Enter or Space selects", async () => {
    const user = userEvent.setup();
    render(<Demo activationMode="manual" />);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe('tab "Two"');
    expect(tab("One").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "One" })).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expectRovingStop("Two");
    expect(screen.getByRole("tabpanel", { name: "Two" })).toBeInTheDocument();

    await user.keyboard("{End}");
    expect(focused()).toBe('tab "Three"');
    expect(tab("Two").getAttribute("aria-selected")).toBe("true");
    await user.keyboard(" ");
    expectRovingStop("Three");
  });

  test("the selected panel is the next tab stop after the tablist; inactive panels are hidden", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    // happy-dom applies no UA stylesheet, so user-event would also tab into `hidden` panels; assert
    // the attributes a browser's Tab order follows instead.
    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(panels.map((p) => `${p.hidden ? "hidden" : "shown"}:${p.getAttribute("tabindex")}`)).toEqual([
      "hidden:0",
      "shown:0",
      "hidden:0",
    ]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tab("Two").id);
  });
});

// ── the views ─────────────────────────────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

describeUi("Tabs in the views: alerts (automatic) and estate (manual)", () => {
  let routers: PathRouter[] = [];

  beforeEach(() => {
    globalThis.fetch = (() =>
      Promise.resolve({ json: () => Promise.resolve(makeHistoryPayload({ kind: "ready" })) })) as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const r of routers) r.stop();
    routers = [];
    globalThis.fetch = originalFetch;
  });

  /** A store and router on `path`, wired as main.tsx wires them (the router writes store.route). */
  function wire(path: string): { store: AppStore; router: PathRouter } {
    const win = (globalThis as unknown as { window: Window }).window;
    win.history.replaceState({}, "", path);
    const router = createPathRouter({ routes: routesFromViews(VIEWS), fallback: "/overview", win });
    routers.push(router);
    const store = createAppStore({ storage: null, initialQuery: router.current().query });
    store.route.value = router.current();
    router.subscribe((m) => {
      store.route.value = m;
    });
    return { store, router };
  }

  test("alerts: arrows select Firing/Catalog/Silences, wrap, Home/End, and each selection navigates", async () => {
    list = "Alert triage views";
    const { store, router } = wire("/alerts");
    store.alerts.value = makeAlertsPayload({ scenario: "mixed" });
    const user = userEvent.setup();
    await act(async () => {
      render(<AlertsView store={store} router={router} />);
    });
    expect(screen.getByRole("tablist", { name: "Alert triage views" })).toBeInTheDocument();
    act(() => tab("Firing").focus());
    expectRovingStop("Firing");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(router.current().query["tab"]).toBe("catalog"));
    expect(focused()).toBe('tab "Catalog"');
    expectRovingStop("Catalog");
    expect(screen.getByRole("tabpanel", { name: "Catalog" })).toBeInTheDocument();

    await user.keyboard("{End}");
    await waitFor(() => expect(router.current().query["tab"]).toBe("silences"));
    expect(focused()).toBe('tab "Silences"');
    expectRovingStop("Silences");

    await user.keyboard("{ArrowRight}"); // wraps to Firing, the default tab (no ?tab)
    await waitFor(() => expect(router.current().query["tab"]).toBeUndefined());
    expect(focused()).toBe('tab "Firing"');
    expectRovingStop("Firing");

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(router.current().query["tab"]).toBe("silences"));
    await user.keyboard("{Home}");
    await waitFor(() => expect(router.current().query["tab"]).toBeUndefined());
    expect(focused()).toBe('tab "Firing"');
    expect(screen.getByRole("tabpanel", { name: "Firing" })).toBeInTheDocument();
  });

  test("estate: arrows move focus without navigating; Enter selects and navigates", async () => {
    list = "Estate sections";
    const { store, router } = wire("/estate");
    store.estate.value = makeEstatePayloadFixture();
    const user = userEvent.setup();
    await act(async () => {
      render(<EstateView store={store} router={router} />);
    });
    expect(screen.getByRole("tablist", { name: "Estate sections" })).toBeInTheDocument();
    act(() => tab("Inventory").focus());
    expectRovingStop("Inventory");
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe('tab "Coverage"');
    expect(tab("Inventory").getAttribute("aria-selected")).toBe("true");
    expect(router.current().query["tab"]).toBeUndefined();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.current().query["tab"]).toBe("coverage"));
    expectRovingStop("Coverage");
    expect(screen.getByRole("tabpanel", { name: "Coverage" })).toBeInTheDocument();

    await user.keyboard("{End}");
    expect(focused()).toBe('tab "Findings"');
    await user.keyboard("{ArrowRight}"); // wraps to Inventory
    expect(focused()).toBe('tab "Inventory"');
    expect(tab("Coverage").getAttribute("aria-selected")).toBe("true");
    await user.keyboard(" ");
    await waitFor(() => expect(router.current().query["tab"] ?? "inventory").toBe("inventory"));
    expectRovingStop("Inventory");
  });
});
