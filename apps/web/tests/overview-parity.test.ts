// apps/web/tests/overview-parity.test.ts — smoke of the cut-over OverviewView composition (item 014).
// Replaces the legacy grid/alerts-strip/detail-panel DOM-parity lock: the real view renders the stat
// header, firing ribbon and grouped grid from ONE store snapshot, opens the shared-Drawer target
// drawer on selection (mirroring the store's compatibility selection), and in kiosk renders neither
// the drawer nor the grouping controls. Deep cycle/isolation/kiosk coverage lives in item 015.

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import type { ReactElement } from "react";
import { act } from "./react-render.js";

import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import type { OverviewPreferenceStorage } from "../src/client/views/overview/model.js";
import { OVERVIEW_PREFERENCES_KEY } from "../src/client/views/overview/model.js";
import { OverviewComposition, OverviewView } from "../src/client/views/overview/view.js";
import { FIXTURE_IDS } from "./fixtures/overview/expected.js";
import { makeOverviewSnapshot } from "./fixtures/overview/factory.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, renderWithStore } from "./dom.js";
import type { RenderResult } from "./dom.js";

isolateDomGlobals();

const VIEW_SOURCE = readFileSync(new URL("../src/client/views/overview/view.tsx", import.meta.url), "utf8");

/** A history transport that never settles: the drawer stays in its loading state, no network. */
const pendingFetch = (): Promise<never> => new Promise<never>(() => {});

function memoryStorage(initial: Record<string, string> = {}): OverviewPreferenceStorage & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
  };
}

function storeWith(query: Readonly<Record<string, string>> = {}): AppStore {
  const store = createAppStore({ storage: null, initialQuery: query });
  store.route.value = { path: "/overview", view: "overview", params: {}, query };
  return store;
}

const mounted: RenderResult[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

async function renderComposition(store: AppStore, storage: OverviewPreferenceStorage | null = null): Promise<RenderResult> {
  let result: RenderResult | undefined;
  await act(async () => {
    result = await renderWithStore(
      (props) => createElement(OverviewComposition, { ...props, storage, historyFetch: pendingFetch, onReload: () => {} }) as unknown as ReactElement,
      { store },
    );
  });
  mounted.push(result!);
  return result!;
}

function target(container: HTMLElement, drilldownId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-overview-target][data-target-id="${drilldownId}"]`);
  if (el === null) throw new Error(`no target trigger for ${drilldownId}`);
  return el;
}

describeDom("OverviewView — cut-over composition smoke (item 014)", () => {
  test("renders stats, ribbon and the grouped grid from the store snapshot", async () => {
    const store = storeWith();
    store.snapshot.value = makeOverviewSnapshot({ alerts: true });
    const rendered = await renderComposition(store);
    const root = rendered.container;

    expect(root.querySelector('[data-slot="overview-page"]')).not.toBeNull();
    expect(root.querySelector("[data-stat='hosts']")).not.toBeNull();
    expect(root.querySelector("[data-ribbon='desk']")).not.toBeNull();
    expect(root.querySelector("[role='grid']")).not.toBeNull();
    expect(root.querySelectorAll('[data-slot="overview-host"]').length).toBe(store.snapshot.value.hosts.length);
    expect(root.querySelector("[data-control='group-by']")).not.toBeNull();
    expect(root.querySelector("[data-control='sort-by']")).not.toBeNull();
    // No drawer without a selection.
    expect(root.ownerDocument.querySelector("[role='dialog']")).toBeNull();
    expect(store.selection.value).toBeNull();
  });

  test("the exported OverviewView renders the same composition through ViewProps only", async () => {
    const store = storeWith();
    store.snapshot.value = makeOverviewSnapshot();
    let result: RenderResult | undefined;
    await act(async () => {
      result = await renderWithStore(OverviewView, { store });
    });
    mounted.push(result!);
    expect(result!.container.querySelector("[role='grid']")).not.toBeNull();
  });

  test("selecting a target opens the drawer, mirrors store.selection, persists; close clears it", async () => {
    const store = storeWith();
    store.snapshot.value = makeOverviewSnapshot();
    const storage = memoryStorage();
    const rendered = await renderComposition(store, storage);
    const doc = rendered.container.ownerDocument;
    const id = FIXTURE_IDS.okHost;

    await act(async () => {
      target(rendered.container, id).click();
    });

    const drawer = doc.querySelector<HTMLElement>(`[data-drawer-target="${id}"]`);
    expect(drawer).not.toBeNull();
    expect(doc.querySelector("[role='dialog']")).not.toBeNull();
    const host = store.snapshot.value!.hosts.find((candidate) => candidate.drilldownId === id)!;
    expect(store.selection.value).toEqual({ kind: "host", host: host.name });
    expect(JSON.parse(storage.data.get(OVERVIEW_PREFERENCES_KEY)!).selectedTargetId).toBe(id);

    await act(async () => {
      doc.querySelector<HTMLElement>("button[aria-label='Close target details']")!.click();
    });
    expect(doc.querySelector("[role='dialog']")).toBeNull();
    expect(store.selection.value).toBeNull();
    expect(JSON.parse(storage.data.get(OVERVIEW_PREFERENCES_KEY)!).selectedTargetId).toBeNull();
  });

  test("kiosk renders no drawer or grouping controls even with a persisted selection", async () => {
    const store = storeWith({ kiosk: "1" });
    store.snapshot.value = makeOverviewSnapshot();
    const storage = memoryStorage({
      [OVERVIEW_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        groupBy: "class",
        sortBy: "status",
        collapsedGroupIds: [],
        selectedTargetId: FIXTURE_IDS.okHost,
      }),
    });
    const rendered = await renderComposition(store, storage);
    const root = rendered.container;

    expect(root.querySelector('[data-slot="overview-page"]')?.getAttribute("data-kiosk")).toBe("true");
    expect(root.querySelector("[data-control='group-by']")).toBeNull();
    expect(root.querySelector("[data-control='sort-by']")).toBeNull();
    expect(root.ownerDocument.querySelector("[role='dialog']")).toBeNull();
    // The stat header stays in kiosk (freshness itself is the shell's top-bar pill).
    expect(root.querySelector('section[aria-label="Estate statistics"]')).not.toBeNull();
    expect(root.querySelector("[data-ribbon='kiosk']")).not.toBeNull();
    expect(store.selection.value).toBeNull();
  });

  test("no snapshot renders the explicit loading state, never a blank grid", async () => {
    const store = storeWith();
    const rendered = await renderComposition(store);
    expect(rendered.container.querySelector("[data-surface='loading']")).not.toBeNull();
    expect(rendered.container.querySelector("[role='grid']")).toBeNull();
  });

  test("view.tsx performs no direct fetch, SSE subscription or API client call", () => {
    expect(VIEW_SOURCE).not.toMatch(/\bapiFetch\b|\bfetch\s*\(|EventSource|\/api\/overview/);
    // The view styles with token classes only: no stylesheet import.
    expect(VIEW_SOURCE).not.toMatch(/import\s+["'][^"']+\.css["']/);
  });
});
