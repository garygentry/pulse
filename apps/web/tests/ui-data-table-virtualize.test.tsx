// apps/web/tests/ui-data-table-virtualize.test.tsx — DataTable `virtualize` and its `scrollToIndex` handle.
//
// happy-dom has no layout: the viewport's geometry is stubbed (offsetHeight/clientHeight/scrollHeight,
// which the virtualizer reads), each data row's `getBoundingClientRect().height` (which it measures)
// is 36px or, for a "Tall" row, TALL_ROW_HEIGHT, and `scrollTo` fires `scroll` on the next task, as a browser does.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createRef } from "react";

import { DataTable, ROW_LINK_SELECTOR, type ColumnDef, type DataTableHandle } from "@/ui";

import { act, describeUi, render, screen, userEvent, waitFor, within } from "./rtl.js";

interface Host {
  key: string;
  kind: string;
}

const COLUMNS: ColumnDef<Host>[] = [
  { accessorKey: "key", header: "Host" },
  { accessorKey: "kind", header: "Kind" },
];

const hosts = (count: number): Host[] =>
  Array.from({ length: count }, (_, i) => ({ key: `host-${i}`, kind: i % 2 === 0 ? "VM" : "Bare metal" }));

/** Viewport height in px: 10 rows of the default 36px compact row height. */
const VIEWPORT_HEIGHT = 360;
/** The stubbed height of a row whose kind is "Tall" (a second line of text). */
const TALL_ROW_HEIGHT = 56;

/** A body row's stubbed layout height: a spacer's inline height, a data row's measured height. */
function bodyRowHeight(tr: Element): number {
  if (tr.getAttribute("data-slot") === "data-table-spacer") {
    return Number.parseFloat((tr.firstElementChild as HTMLElement | null)?.style.height ?? "0") || 0;
  }
  return tr.textContent?.includes("Tall") === true ? TALL_ROW_HEIGHT : 36;
}

/** Where `tr` starts in the stubbed layout, in px from the top of the body. */
function bodyOffset(tr: Element): number {
  let offset = 0;
  for (let sibling = tr.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
    offset += bodyRowHeight(sibling);
  }
  return offset;
}

/** The stubbed layout height of the whole body: rendered rows plus spacers. */
const bodyHeight = (root: Element): number =>
  Array.from(root.querySelectorAll("tbody > tr")).reduce((sum, tr) => sum + bodyRowHeight(tr), 0);

describeUi("@/ui DataTable virtualize", () => {
  const undo: (() => void)[] = [];

  beforeEach(() => {
    const proto = (globalThis as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
    const isViewport = (el: HTMLElement) => el.getAttribute("data-slot") === "data-table-viewport";
    const isDataRow = (el: HTMLElement) => el.tagName === "TR" && el.hasAttribute("data-row-index");
    const stubs: Record<string, (el: HTMLElement) => number | undefined> = {
      offsetHeight: (el) => (isViewport(el) ? VIEWPORT_HEIGHT : undefined),
      clientHeight: (el) => (isViewport(el) ? VIEWPORT_HEIGHT : undefined),
      // Every rendered row and spacer, at their stubbed heights.
      scrollHeight: (el) => (isViewport(el) ? bodyHeight(el) : undefined),
    };
    for (const [name, value] of Object.entries(stubs)) {
      const original = Object.getOwnPropertyDescriptor(proto, name);
      Object.defineProperty(proto, name, {
        configurable: true,
        get(this: HTMLElement) {
          return value(this) ?? original?.get?.call(this) ?? 0;
        },
      });
      undo.push(() => {
        if (original !== undefined) Object.defineProperty(proto, name, original);
        else delete (proto as unknown as Record<string, unknown>)[name];
      });
    }
    // Each newly observed element is reported once, on the next task, as a browser's first
    // ResizeObserver notification is: rows rendered while scrolling are measured this way.
    const win = document.defaultView as unknown as { ResizeObserver?: unknown };
    const realObserver = win.ResizeObserver;
    win.ResizeObserver = class {
      private readonly targets = new Set<Element>();
      constructor(private readonly callback: (entries: { target: Element }[]) => void) {}
      observe(target: Element) {
        this.targets.add(target);
        setTimeout(() => {
          if (this.targets.has(target)) this.callback([{ target }]);
        }, 0);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    };
    undo.push(() => {
      win.ResizeObserver = realObserver;
    });
    const getRect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const rect = getRect.call(this);
      if (!isDataRow(this)) return rect;
      const height = bodyRowHeight(this);
      return { ...rect.toJSON(), height, bottom: rect.top + height, toJSON: () => ({}) } as DOMRect;
    };
    undo.push(() => {
      proto.getBoundingClientRect = getRect;
    });
    const scrollTo = proto.scrollTo;
    proto.scrollTo = function (this: HTMLElement, ...args: Parameters<HTMLElement["scrollTo"]>) {
      const before = this.scrollTop;
      (scrollTo as (...a: unknown[]) => void).apply(this, args);
      if (this.scrollTop === before) return;
      const view = this.ownerDocument.defaultView as unknown as { Event: typeof Event };
      setTimeout(() => this.dispatchEvent(new view.Event("scroll")), 0);
    } as HTMLElement["scrollTo"];
    undo.push(() => {
      proto.scrollTo = scrollTo;
    });
  });

  afterEach(() => {
    while (undo.length > 0) undo.pop()!();
  });

  const dataRows = () => screen.getAllByRole("row").filter((row) => row.closest("tbody") !== null);
  const rowIndexes = () => dataRows().map((row) => Number(row.getAttribute("aria-rowindex")));
  const viewport = () => document.querySelector<HTMLElement>('[data-slot="data-table-viewport"]')!;

  it("renders exactly as an unvirtualized table below the threshold", () => {
    const data = hosts(50);
    const plain = render(<DataTable caption="Hosts" columns={COLUMNS} data={data} getRowId={(r) => r.key} />);
    const virtual = render(<DataTable caption="Hosts" columns={COLUMNS} data={data} getRowId={(r) => r.key} virtualize />);
    const html = (el: HTMLElement) => el.innerHTML.replace(/id="[^"]*"|aria-labelledby="[^"]*"/g, "");
    expect(html(virtual.container)).toBe(html(plain.container));
    expect(within(virtual.container).getAllByRole("row")).toHaveLength(51);
    expect(virtual.container.querySelector('[data-slot="data-table-viewport"]')).toBeNull();
    expect(virtual.container.querySelector("[aria-rowcount]")).toBeNull();
  });

  it("honours a custom threshold", () => {
    render(
      <DataTable caption="Hosts" columns={COLUMNS} data={hosts(50)} getRowId={(r) => r.key} virtualize={{ threshold: 20 }} />,
    );
    expect(viewport()).not.toBeNull();
    expect(dataRows().length).toBeLessThan(50);
  });

  it("renders a window of rows with aria-rowcount and aria-rowindex above the threshold", () => {
    render(<DataTable caption="Hosts" columns={COLUMNS} data={hosts(1000)} getRowId={(r) => r.key} virtualize />);

    const vp = viewport();
    expect(vp).toHaveAttribute("role", "region");
    expect(vp).toHaveAccessibleName("Hosts");
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "1001");
    // The header row is row 1.
    expect(within(screen.getByRole("table")).getAllByRole("row")[0]).toHaveAttribute("aria-rowindex", "1");

    const indexes = rowIndexes();
    expect(indexes.length).toBeGreaterThan(9);
    expect(indexes.length).toBeLessThan(40);
    expect(indexes).toEqual(Array.from({ length: indexes.length }, (_, i) => i + 2));
    expect(screen.getByRole("rowheader", { name: "host-0" })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: "host-999" })).toBeNull();
    // A spacer below the window keeps the scroll height of every row.
    expect(vp.querySelectorAll('[data-slot="data-table-spacer"]')).toHaveLength(1);
  });

  it("scrollToIndex renders a far row inside the window", async () => {
    const ref = createRef<DataTableHandle>();
    render(<DataTable ref={ref} caption="Hosts" columns={COLUMNS} data={hosts(1000)} getRowId={(r) => r.key} virtualize />);

    act(() => ref.current!.scrollToIndex(900));

    await waitFor(() => expect(screen.getByRole("rowheader", { name: "host-900" })).toBeInTheDocument());
    expect(screen.getByRole("rowheader", { name: "host-900" }).closest("tr")).toHaveAttribute("aria-rowindex", "902");
    expect(screen.queryByRole("rowheader", { name: "host-0" })).toBeNull();
    expect(viewport().scrollTop).toBeGreaterThan(0);
    expect(rowIndexes().length).toBeLessThan(40);
    // Spacers above and below the window.
    expect(viewport().querySelectorAll('[data-slot="data-table-spacer"]')).toHaveLength(2);
  });

  it("scrollToIndex scrolls the row into view without virtualize", () => {
    const ref = createRef<DataTableHandle>();
    render(<DataTable ref={ref} caption="Hosts" columns={COLUMNS} data={hosts(20)} getRowId={(r) => r.key} />);
    const row = screen.getByRole("rowheader", { name: "host-12" }).closest("tr")!;
    const scrollIntoView = mock();
    row.scrollIntoView = scrollIntoView;

    ref.current!.scrollToIndex(12, { align: "center" });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("Tab across the window boundary scrolls the next row link in", async () => {
    render(
      <DataTable
        caption="Hosts"
        columns={COLUMNS}
        data={hosts(1000)}
        getRowId={(r) => r.key}
        rowLink={(r) => `/hosts/${r.key}`}
        virtualize
      />,
    );
    const initialLast = Math.max(...rowIndexes()) - 2;
    const first = screen.getByRole("link", { name: "host-0" });
    act(() => first.focus());

    const target = initialLast + 15;
    for (let i = 1; i <= target; i += 1) {
      await userEvent.tab();
      expect(document.activeElement).toHaveAttribute("data-row-link", `host-${i}`);
    }

    expect(viewport().scrollTop).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "host-0" })).toBeNull();
    // The window moved with focus: the next rows are rendered for the next Tab.
    expect(screen.getByRole("link", { name: `host-${target + 1}` })).toHaveAttribute("href", `/hosts/host-${target + 1}`);
    expect(viewport().querySelectorAll(ROW_LINK_SELECTOR).length).toBeLessThan(40);
  });

  it("keeps the focused row rendered when the window scrolls away from it", async () => {
    const ref = createRef<DataTableHandle>();
    render(
      <DataTable
        ref={ref}
        caption="Hosts"
        columns={COLUMNS}
        data={hosts(1000)}
        getRowId={(r) => r.key}
        rowLink={(r) => `/hosts/${r.key}`}
        virtualize
      />,
    );
    const link = screen.getByRole("link", { name: "host-3" });
    act(() => link.focus());

    act(() => ref.current!.scrollToIndex(500, { align: "start" }));

    await waitFor(() => expect(screen.getByRole("link", { name: "host-500" })).toBeInTheDocument());
    expect(document.activeElement).toBe(link);
    expect(link.closest("tr")).toHaveAttribute("aria-rowindex", "5");
    expect(screen.queryByRole("link", { name: "host-4" })).toBeNull();
  });
  it("keeps the focused row rendered and focused when rows are inserted above it", () => {
    const props = {
      caption: "Hosts",
      columns: COLUMNS,
      getRowId: (r: Host) => r.key,
      rowLink: (r: Host) => `/hosts/${r.key}`,
      virtualize: true,
    } as const;
    const data = hosts(1000);
    const { rerender } = render(<DataTable {...props} data={data} />);
    const link = screen.getByRole("link", { name: "host-3" });
    act(() => link.focus());
    expect(document.activeElement).toBe(link);

    // A live re-sort: 200 new rows land above host-3, moving it far past the window.
    const inserted: Host[] = Array.from({ length: 200 }, (_, i) => ({ key: `new-${i}`, kind: "VM" }));
    rerender(<DataTable {...props} data={[...inserted, ...data]} />);

    expect(screen.getByRole("link", { name: "host-3" })).toBe(link);
    expect(link.isConnected).toBe(true);
    expect(document.activeElement).toBe(link);
    expect(link.closest("tr")).toHaveAttribute("aria-rowindex", String(1 + 203 + 1));
    // The row at its old index is the new data, not a stale stand-in for it.
    expect(screen.getByRole("link", { name: "new-3" })).toBeInTheDocument();
    expect(rowIndexes().length).toBeLessThan(40);
  });

  it("stays virtualized just below the threshold and falls back below the exit bound", () => {
    const props = { caption: "Hosts", columns: COLUMNS, getRowId: (r: Host) => r.key, virtualize: true } as const;
    const { rerender, container } = render(<DataTable {...props} data={hosts(300)} />);
    const vp = viewport();
    expect(vp).not.toBeNull();

    // threshold - 1: still the same (mounted) viewport.
    rerender(<DataTable {...props} data={hosts(299)} />);
    expect(viewport()).toBe(vp);
    // At the exit bound, floor(300 * 0.8) = 240: still virtualized.
    rerender(<DataTable {...props} data={hosts(240)} />);
    expect(viewport()).toBe(vp);
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "241");

    // Below the exit bound: the plain table.
    rerender(<DataTable {...props} data={hosts(239)} />);
    expect(container.querySelector('[data-slot="data-table-viewport"]')).toBeNull();
    expect(container.querySelector("[aria-rowcount]")).toBeNull();
    expect(within(container).getAllByRole("row")).toHaveLength(240);

    // Back up, but under the threshold: stays plain (no latch).
    rerender(<DataTable {...props} data={hosts(299)} />);
    expect(container.querySelector('[data-slot="data-table-viewport"]')).toBeNull();
    rerender(<DataTable {...props} data={hosts(300)} />);
    expect(container.querySelector('[data-slot="data-table-viewport"]')).not.toBeNull();
  });

  describe("rows of varying height", () => {
    /** Every `every`-th row (from 0) is "Tall": TALL_ROW_HEIGHT instead of 36px. */
    const mixed = (count: number, every: number): Host[] =>
      Array.from({ length: count }, (_, i) => ({ key: `host-${i}`, kind: i % every === 0 ? "Tall" : "VM" }));
    const row = (name: string) => screen.getByRole("rowheader", { name }).closest("tr")!;

    it("places rows and spacers by measured height as the window scrolls", async () => {
      const data = mixed(1000, 3);
      const realHeight = (r: Host) => (r.kind === "Tall" ? TALL_ROW_HEIGHT : 36);
      const realOffset = (index: number) => data.slice(0, index).reduce((sum, r) => sum + realHeight(r), 0);
      render(<DataTable caption="Hosts" columns={COLUMNS} data={data} getRowId={(r) => r.key} virtualize />);

      // Scroll down in steps shorter than the viewport, so every row passes through the window
      // (and is measured) on the way.
      for (let top = 200; top <= 2400; top += 200) {
        await act(async () => {
          viewport().scrollTop = top;
          viewport().dispatchEvent(new Event("scroll"));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }

      const rendered = dataRows();
      expect(screen.queryByRole("rowheader", { name: "host-0" })).toBeNull();
      // The spacer above the window is the real height of the rows it stands in for, so each
      // rendered row starts where it would in an unvirtualized table.
      for (const tr of rendered) {
        expect(bodyOffset(tr)).toBe(realOffset(Number(tr.getAttribute("aria-rowindex")) - 2));
      }
      // The scroll height counts measured rows at their real height and the rest at the estimate.
      const last = Number(rendered.at(-1)!.getAttribute("aria-rowindex")) - 2;
      expect(bodyHeight(viewport())).toBe(realOffset(last + 1) + (data.length - last - 1) * 36);
    });

    it("scrollToIndex lands a far row at the top, below tall rows", async () => {
      const ref = createRef<DataTableHandle>();
      render(<DataTable ref={ref} caption="Hosts" columns={COLUMNS} data={mixed(1000, 3)} getRowId={(r) => r.key} virtualize />);

      act(() => ref.current!.scrollToIndex(600, { align: "start" }));

      await waitFor(() => expect(screen.getByRole("rowheader", { name: "host-600" })).toBeInTheDocument());
      await waitFor(() => expect(bodyOffset(row("host-600"))).toBe(viewport().scrollTop));
      expect(row("host-600")).toHaveAttribute("aria-rowindex", "602");
      expect(rowIndexes().length).toBeLessThan(40);
    });

    it("scrollToIndex lands a row at the bottom edge when tall rows above it are measured late", async () => {
      const ref = createRef<DataTableHandle>();
      // Every row near the target is tall: the estimate puts the target ~200px too high.
      render(<DataTable ref={ref} caption="Hosts" columns={COLUMNS} data={mixed(1000, 1)} getRowId={(r) => r.key} virtualize />);

      act(() => ref.current!.scrollToIndex(500, { align: "end" }));

      await waitFor(() => expect(screen.getByRole("rowheader", { name: "host-500" })).toBeInTheDocument());
      await waitFor(() => {
        const target = row("host-500");
        expect(bodyOffset(target) + bodyRowHeight(target)).toBe(viewport().scrollTop + VIEWPORT_HEIGHT);
      });
    });

    it("keyboard focus across the window keeps landing on the next tall row", async () => {
      render(
        <DataTable
          caption="Hosts"
          columns={COLUMNS}
          data={mixed(1000, 2)}
          getRowId={(r) => r.key}
          rowLink={(r) => `/hosts/${r.key}`}
          virtualize
        />,
      );
      act(() => screen.getByRole("link", { name: "host-0" }).focus());
      for (let i = 1; i <= 40; i += 1) {
        await userEvent.tab();
        expect(document.activeElement).toHaveAttribute("data-row-link", `host-${i}`);
      }
      const focused = document.activeElement!.closest("tr")!;
      const top = bodyOffset(focused);
      // The focused row is fully inside the viewport.
      expect(top).toBeGreaterThanOrEqual(viewport().scrollTop);
      expect(top + bodyRowHeight(focused)).toBeLessThanOrEqual(viewport().scrollTop + VIEWPORT_HEIGHT);
    });
  });

  it("focusable={false} drops the scroll region's tab stop, plain and virtualized", () => {
    const props = { caption: "Hosts", columns: COLUMNS, getRowId: (r: Host) => r.key, focusable: false } as const;
    const { rerender } = render(<DataTable {...props} data={hosts(3)} />);
    expect(screen.getByRole("region", { name: "Hosts" })).not.toHaveAttribute("tabindex");
    rerender(<DataTable {...props} data={hosts(400)} virtualize />);
    const viewport = screen.getByRole("region", { name: "Hosts" });
    expect(viewport).toHaveAttribute("data-slot", "data-table-viewport");
    expect(viewport).not.toHaveAttribute("tabindex");
  });
});
