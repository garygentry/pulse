// apps/web/tests/estate-boundary.test.ts — estate unexpected-exception containment (estate-explorer
// item 005; spec 07 §5, 09 §6.4). Wrapped in describeDom so happy-dom is registered per file.

import { expect, test } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";

import { mountAnnouncer } from "../src/client/a11y/announcer.js";
import { createPathRouter } from "../src/client/router.js";
import type { PathRouter } from "../src/client/router.js";
import { DataTable } from "../src/client/ui/index.js";
import type { ColumnDef } from "../src/client/ui/index.js";
import { RegionErrorBoundary, safeCell, safeNavigate } from "../src/client/views/estate/error-boundary.js";
import { describeDom } from "./dom.js";

const SECRET = "internal /srv/pulse/secret.ts:17 boom";

function Thrower(): ReactElement {
  throw new Error(SECRET);
}

async function waitFor(read: () => string | null, want: string, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (read() === want) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Read the live document via globalThis at call time (see progress.md item 004). */
const assertiveText = (): string | null =>
  (globalThis as { document: Document }).document.querySelector('#pulse-a11y-announcer [aria-live="assertive"]')
    ?.textContent ?? null;

describeDom("estate error boundary", (dom) => {
  test("a throwing child renders a localized card naming the region; a sibling region still renders", async () => {
    mountAnnouncer();
    const tree = createElement(
      "div",
      null,
      createElement(RegionErrorBoundary, { region: "coverage table", children: createElement(Thrower, null) }),
      createElement(RegionErrorBoundary, { region: "inventory tree", children: createElement("p", { id: "sibling" }, "hosts ok") }),
    ) as ReactElement;
    const { container, unmount } = await dom.mount(tree);
    await new Promise((r) => setTimeout(r, 0));

    const card = container.querySelector('[data-region-error="coverage table"]');
    expect(card).not.toBeNull();
    expect(card!.getAttribute("data-status")).toBe("critical");
    expect(card!.querySelector("svg")).not.toBeNull();
    expect(card!.textContent).toContain("This coverage table could not be displayed.");
    expect(card!.textContent).toContain("The rest of the estate view is unaffected.");
    expect(container.querySelector("#sibling")?.textContent).toBe("hosts ok");
    expect(container.querySelectorAll("[data-region-error]").length).toBe(1);

    const want = "The coverage table could not be displayed.";
    await waitFor(assertiveText, want);
    expect(assertiveText()).toBe(want);
    unmount();
  });

  test("the error card never renders the caught error's message or stack", async () => {
    const { container, unmount } = await dom.mount(
      createElement(RegionErrorBoundary, { region: "entity page", children: createElement(Thrower, null) }) as ReactElement,
    );
    await new Promise((r) => setTimeout(r, 0));
    const text = container.textContent ?? "";
    expect(text).toContain("This entity page could not be displayed.");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("secret.ts");
    expect(container.innerHTML).not.toContain("boom");
    unmount();
  });

  test("a healthy boundary renders its children untouched", async () => {
    const { container, unmount } = await dom.mount(
      createElement(RegionErrorBoundary, { region: "findings table", children: createElement("span", { id: "kid" }, "fine") }) as ReactElement,
    );
    expect(container.querySelector("#kid")?.textContent).toBe("fine");
    expect(container.querySelector("[data-region-error]")).toBeNull();
    unmount();
  });

  test("safeCell turns a throwing cell into an inline error marker; the DataTable renders its other rows", async () => {
    interface Row {
      readonly name: string;
      readonly bad: boolean;
    }
    const rows: readonly Row[] = [
      { name: "alpha", bad: false },
      { name: "bravo", bad: true },
      { name: "charlie", bad: false },
    ];
    const nameCell = safeCell((r: Row) => {
      if (r.bad) throw new Error(SECRET);
      return r.name;
    });
    const columns: ColumnDef<Row>[] = [{ id: "name", header: "Name", cell: ({ row }) => nameCell(row.original) }];
    const { container, unmount } = await dom.mount(
      createElement(DataTable<Row>, { columns, data: rows, caption: "Rows", getRowId: (r: Row) => r.name }) as ReactElement,
    );
    const bodyRows = container.querySelectorAll("tbody tr");
    expect(bodyRows.length).toBe(3);
    expect(bodyRows[0]!.textContent).toContain("alpha");
    expect(bodyRows[2]!.textContent).toContain("charlie");
    const marker = bodyRows[1]!.querySelector("[data-cell-error]");
    expect(marker).not.toBeNull();
    expect(marker!.getAttribute("data-status")).toBe("critical");
    expect(marker!.querySelector("svg")).not.toBeNull();
    expect(marker!.textContent).toContain("error");
    expect(container.textContent).not.toContain(SECRET);
    unmount();
  });

  test("safeCell passes a healthy cell's output through unchanged", () => {
    const wrapped = safeCell((n: number) => `v${n}`);
    expect(wrapped(3)).toBe("v3");
  });

  test("safeNavigate does not throw when the route is unregistered", () => {
    const win = (globalThis as { window: Window }).window;
    win.history.replaceState({}, "", "/estate");
    const router = createPathRouter({ routes: [{ pattern: "/estate", view: "estate" }], fallback: "/estate", win });
    expect(() => safeNavigate(router, "/alerts/does-not-exist")).not.toThrow();
    expect(() => safeNavigate(router, "/alerts/none")).not.toThrow();
    router.stop();
  });

  test("safeNavigate swallows a router whose navigate throws", () => {
    const throwing: PathRouter = {
      current: () => ({ view: "estate", path: "/estate", params: {}, query: {} }) as ReturnType<PathRouter["current"]>,
      navigate: () => {
        throw new Error("no such route");
      },
      subscribe: () => () => {},
      stop: () => {},
    };
    expect(() => safeNavigate(throwing, "/alerts/does-not-exist")).not.toThrow();
  });
});
