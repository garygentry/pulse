// apps/web/tests/ui-workbench.test.tsx — the dev-only `/_ui` workbench renders every section, and
// the shell hosts dev-only views by URL without listing them in the side nav.
import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import type { ComponentType } from "react";

import type { ViewDefinition, ViewProps } from "../src/shared/registry.js";
import { createPathRouter, type PathRouter } from "../src/client/router.js";
import { Shell } from "../src/client/shell/index.js";
import { createAppStore, type AppStore } from "../src/client/store/index.js";
import UiWorkbenchView from "../src/client/views/_ui/view.js";
import { SECTIONS } from "../src/client/views/_ui/sections/index.js";

import { describeUi, render, screen, waitFor, within } from "./rtl.js";

// happy-dom has no canvas 2D context; the lazy TimeSeriesChart specimens get a no-op uPlot.
class NoopUPlot {
  setSize(): void {}
  destroy(): void {}
}
mock.module("uplot", () => ({ default: NoopUPlot }));

let router: PathRouter | null = null;
// The scaffolding section's error boundaries render a deliberately failing child; React and the
// boundaries report it on console.error. Keep the expected noise out of the test output.
let consoleError: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError?.mockRestore();
  consoleError = null;
  router?.stop();
  router = null;
});

function setup(view: string): { store: AppStore; router: PathRouter } {
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.route.value = { path: `/${view}`, view, params: {}, query: {} };
  router = createPathRouter({
    routes: [
      { pattern: "/overview", view: "overview" },
      { pattern: "/_ui", view: "_ui" },
    ],
    fallback: "/overview",
  });
  return { store, router };
}

function stub(id: string, label: string, nav?: { order: number }): ViewDefinition {
  return {
    id,
    label,
    load: async () => (() => <div data-view={id}>{label} body</div>) as ComponentType<ViewProps>,
    ...(nav !== undefined ? { nav } : {}),
  };
}

describeUi("ui workbench page", () => {
  it("renders a PageHeader h1, one h2 Section per component family, and a 5,000-row virtualized table", () => {
    const ctx = setup("_ui");
    const { container } = render(<UiWorkbenchView store={ctx.store} router={ctx.router} />);

    expect(container.querySelector('[data-slot="ui-workbench-page"]')).not.toBeNull();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["UI workbench"]);
    expect(container.querySelector('[data-slot="page-header"]')).toContainElement(h1s[0] ?? null);

    expect(SECTIONS.length).toBeGreaterThanOrEqual(10);
    for (const section of SECTIONS) {
      const el = container.querySelector(`section#${section.id}`);
      expect(el, section.id).not.toBeNull();
      expect(el).toHaveAttribute("data-slot", "section");
      const heading = within(el as HTMLElement).getAllByRole("heading", { level: 2 })[0];
      expect(heading?.textContent).toContain(section.title);
      expect(el).toHaveAttribute("aria-labelledby", heading?.id ?? "");
    }

    // The virtualized DataTable specimen: 5,000 rows, only a window rendered.
    const table = screen.getByRole("table", { name: /5,000, virtualized/ });
    expect(table).toHaveAttribute("aria-rowcount", "5001");
    expect(within(table).getAllByRole("row").length).toBeLessThan(200);
  }, 30_000); // renders the whole workbench (hundreds of components)

  it("the theme toggle writes the store's theme", async () => {
    const ctx = setup("_ui");
    ctx.store.theme.value = "light";
    const { userEvent } = await import("./rtl.js");
    const { container } = render(<UiWorkbenchView store={ctx.store} router={ctx.router} />);
    const header = container.querySelector('[data-slot="page-header"]') as HTMLElement;
    await userEvent.click(within(header).getByRole("radio", { name: "dark" }));
    expect(ctx.store.theme.peek()).toBe("dark");
  }, 30_000);
});

describeUi("shell hosts dev-only views", () => {
  it("renders a dev view by URL but keeps it out of the side nav", async () => {
    const ctx = setup("_ui");
    render(
      <Shell
        store={ctx.store}
        router={ctx.router}
        views={[stub("overview", "Overview", { order: 0 })]}
        devViews={[stub("_ui", "UI workbench")]}
        reloadOnce={() => {}}
        buildId="workbench-test"
      />,
    );
    await waitFor(() => expect(document.querySelector('[data-view="_ui"]')).not.toBeNull());
    const nav = screen.getByRole("navigation", { name: "Views" });
    expect(nav.textContent).toContain("Overview");
    expect(nav.textContent).not.toContain("UI workbench");
  });

  it("without devViews an unknown /_ui route falls back to the first view (unchanged)", async () => {
    const ctx = setup("_ui");
    render(
      <Shell
        store={ctx.store}
        router={ctx.router}
        views={[stub("overview", "Overview", { order: 0 })]}
        reloadOnce={() => {}}
        buildId="workbench-test"
      />,
    );
    await waitFor(() => expect(document.querySelector('[data-view="overview"]')).not.toBeNull());
    expect(document.querySelector('[data-view="_ui"]')).toBeNull();
  });
});
