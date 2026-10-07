// apps/web/tests/ui-data-table-virtualize.test.tsx — DataTable `virtualize` and its `scrollToIndex` handle.
//
// happy-dom has no layout: the viewport's geometry is stubbed (offsetHeight/clientHeight/scrollHeight,
// which the virtualizer reads) and `scrollTo` fires `scroll` on the next task, as a browser does.
import { afterEach, beforeEach, expect, it, mock } from "bun:test";
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

describeUi("@/ui DataTable virtualize", () => {
  const undo: (() => void)[] = [];

  beforeEach(() => {
    const proto = (globalThis as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
    const isViewport = (el: HTMLElement) => el.getAttribute("data-slot") === "data-table-viewport";
    const stubs: Record<string, (el: HTMLElement) => number> = {
      offsetHeight: () => VIEWPORT_HEIGHT,
      clientHeight: () => VIEWPORT_HEIGHT,
      // Header row plus every data row at 36px.
      scrollHeight: (el) => Number(el.querySelector("table")?.getAttribute("aria-rowcount") ?? 0) * 36,
    };
    for (const [name, value] of Object.entries(stubs)) {
      const original = Object.getOwnPropertyDescriptor(proto, name);
      Object.defineProperty(proto, name, {
        configurable: true,
        get(this: HTMLElement) {
          return isViewport(this) ? value(this) : (original?.get?.call(this) ?? 0);
        },
      });
      undo.push(() => {
        if (original !== undefined) Object.defineProperty(proto, name, original);
        else delete (proto as unknown as Record<string, unknown>)[name];
      });
    }
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
