// apps/web/tests/ui-data-table-virtualize.test.tsx — ported from deck's apps/web/test (v0.5.0) to bun
// test + happy-dom (tests/rtl.ts); the vendored DataTable is deck's file.
//
// DataTable `virtualize` and its `scrollToIndex` handle.
//
// jsdom has no layout: the viewport's geometry is stubbed (offsetHeight/clientHeight/scrollHeight,
// which the virtualizer reads), each data row's `getBoundingClientRect().height` (which it measures)
// is 36px or, for a "Tall" row, TALL_ROW_HEIGHT, the header is `theadHeight` tall, and `scrollTo`
// fires `scroll` on the next task, as a browser does. No test waits on wall-clock time: a
// `scrollToIndex` promise resolves once the row is rendered and in place.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createRef, useRef } from "react";

import {
  DataTable,
  ROW_LINK_SELECTOR,
  useListNavigation,
  type ColumnDef,
  type DataTableHandle,
  type DataTableVirtualizeOptions,
} from "@/ui";

import { act, cleanup, describeUi, render, screen, userEvent, within } from "./rtl.js";


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

/** Viewport height in px: 10 rendered (36px) rows. */
const VIEWPORT_HEIGHT = 360;
/** The stubbed height of a row whose kind is "Tall" (a second line of text). */
const TALL_ROW_HEIGHT = 56;
/** The estimate for a row not yet measured: theme.css's compact cell height (no stylesheet in jsdom). */
const COMPACT_ESTIMATE = 32;
/**
 * Budget for the tests that walk the keyboard across the window (dozens of `userEvent.tab()` presses,
 * each a React commit over the virtualized rows). They wait on nothing — no timers, no wall clock —
 * so their run time is pure CPU: ~1 s on CI, but several seconds on a loaded 2-core host, where
 * bun's 5 s default timed them out. The budget scales that CPU bound; it hides no race.
 */
const KEYBOARD_WALK_TIMEOUT_MS = 30_000;
/** The stubbed height of the table header (0 unless a test sets it). */
let theadHeight = 0;

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

/**
 * Restore `proto[name]` exactly as it was: put back its own property, or delete the one a stub
 * added, so the inherited method shows through again. (Assigning the saved method back would leave
 * an own property behind that shadows a later suite's stub of the inherited method.)
 */
function restoreOwn(proto: object, name: string, own: PropertyDescriptor | undefined): void {
  if (own !== undefined) Object.defineProperty(proto, name, own);
  else delete (proto as Record<string, unknown>)[name];
}

describeUi("@/ui DataTable virtualize", () => {
  const undo: (() => void)[] = [];

  beforeEach(() => {
    theadHeight = 0;
    const proto = (globalThis as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
    const isViewport = (el: HTMLElement) => el.getAttribute("data-slot") === "data-table" && el.hasAttribute("data-virtualized");
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
    const ownGetRect = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const rect = getRect.call(this);
      const header = this.tagName === "THEAD" && theadHeight > 0;
      if (!header && !isDataRow(this)) return rect;
      const height = header ? theadHeight : bodyRowHeight(this);
      const { x, y, top, left, right, width } = rect;
      return { x, y, top, left, right, width, height, bottom: top + height, toJSON: () => ({}) } as DOMRect;
    };
    undo.push(() => {
      restoreOwn(proto, "getBoundingClientRect", ownGetRect);
    });
    // jsdom has no Element#scrollTo: set the (clamped) scrollTop, as a browser does.
    const ownScrollTo = Object.getOwnPropertyDescriptor(proto, "scrollTo");
    proto.scrollTo = function (this: HTMLElement, ...args: unknown[]) {
      const before = this.scrollTop;
      const [first, second] = args;
      const top =
        typeof first === "object" && first !== null
          ? (first as ScrollToOptions).top
          : typeof second === "number"
            ? second
            : undefined;
      if (top !== undefined) this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
      if (this.scrollTop === before) return;
      const view = this.ownerDocument.defaultView as unknown as { Event: typeof Event };
      setTimeout(() => this.dispatchEvent(new view.Event("scroll")), 0);
    } as HTMLElement["scrollTo"];
    undo.push(() => {
      restoreOwn(proto, "scrollTo", ownScrollTo);
    });
  });

  afterEach(() => {
    cleanup();
    while (undo.length > 0) undo.pop()!();
  });

  const dataRows = () => screen.getAllByRole("row").filter((row) => row.closest("tbody") !== null);
  const rowIndexes = () => dataRows().map((row) => Number(row.getAttribute("aria-rowindex")));
  const viewport = () => document.querySelector<HTMLElement>('[data-slot="data-table"][data-virtualized]')!;
  const isVirtualized = (container: HTMLElement) => container.querySelector("[data-virtualized]") !== null;
  /** Lets queued tasks (scroll events, first ResizeObserver reports) run. */
  const flushTasks = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  /**
   * Calls the handle as an event handler does: React commits the updates the call schedules
   * when the handler returns (here, the `act` scope), then the caller awaits the promise.
   */
  async function viaHandle<R>(call: () => Promise<R>): Promise<R> {
    let pending!: Promise<R>;
    act(() => {
      pending = call();
    });
    let value!: R;
    await act(async () => {
      value = await pending;
    });
    return value;
  }
  const linkProps = {
    caption: "Hosts",
    columns: COLUMNS,
    getRowId: (r: Host) => r.key,
    rowLink: (r: Host) => `/hosts/${r.key}`,
  } as const;

  it("renders exactly as an unvirtualized table below the threshold", () => {
    const data = hosts(50);
    const plain = render(<DataTable caption="Hosts" columns={COLUMNS} data={data} getRowId={(r) => r.key} />);
    const virtual = render(<DataTable caption="Hosts" columns={COLUMNS} data={data} getRowId={(r) => r.key} virtualize />);
    const html = (el: HTMLElement) => el.innerHTML.replace(/id="[^"]*"|aria-labelledby="[^"]*"/g, "");
    expect(html(virtual.container)).toBe(html(plain.container));
    expect(within(virtual.container).getAllByRole("row")).toHaveLength(51);
    expect(isVirtualized(virtual.container)).toBe(false);
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

  describe("scrollToIndex and focusIndex", () => {
    it("resolves once a far row is rendered inside the window", async () => {
      const ref = createRef<DataTableHandle>();
      render(<DataTable ref={ref} caption="Hosts" columns={COLUMNS} data={hosts(1000)} getRowId={(r) => r.key} virtualize />);

      // The caller's own sequence: await the call, then use the row (no polling).
      await viaHandle(() => ref.current!.scrollToIndex(900));

      expect(screen.getByRole("rowheader", { name: "host-900" }).closest("tr")).toHaveAttribute("aria-rowindex", "902");
      expect(screen.queryByRole("rowheader", { name: "host-0" })).toBeNull();
      expect(viewport().scrollTop).toBeGreaterThan(0);
      expect(rowIndexes().length).toBeLessThan(40);
      // Spacers above and below the window.
      expect(viewport().querySelectorAll('[data-slot="data-table-spacer"]')).toHaveLength(2);
    });

    it("focusIndex focuses a far row's link, virtualized and plain", async () => {
      const ref = createRef<DataTableHandle>();
      const { rerender } = render(<DataTable ref={ref} {...linkProps} data={hosts(1000)} virtualize />);

      expect(await viaHandle(() => ref.current!.focusIndex(900))).toBe(true);
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-900");

      rerender(<DataTable ref={ref} {...linkProps} data={hosts(20)} virtualize />);
      expect(await viaHandle(() => ref.current!.focusIndex(12))).toBe(true);
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-12");
      expect(await viaHandle(() => ref.current!.focusIndex(50))).toBe(false);
    });

    it("settles in commits, not wall-clock time (no timer or scroll event needed)", async () => {
      vi.useFakeTimers();
      try {
        const ref = createRef<DataTableHandle>();
        // Every row is tall: the estimate puts the target far too high, so it must re-aim.
        const tall = Array.from({ length: 1000 }, (_, i) => ({ key: `host-${i}`, kind: "Tall" }));
        render(<DataTable ref={ref} caption="Hosts" columns={COLUMNS} data={tall} getRowId={(r) => r.key} virtualize />);

        await viaHandle(() => ref.current!.scrollToIndex(500, { align: "end" }));

        const target = screen.getByRole("rowheader", { name: "host-500" }).closest("tr")!;
        expect(bodyOffset(target) + bodyRowHeight(target)).toBe(viewport().scrollTop + VIEWPORT_HEIGHT);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reserves the header height only when the header is sticky", async () => {
      theadHeight = 36;
      const ref = createRef<DataTableHandle>();
      const props = { caption: "Hosts", columns: COLUMNS, getRowId: (r: Host) => r.key, virtualize: true, captionHidden: true } as const;
      const { rerender } = render(<DataTable ref={ref} {...props} data={hosts(1000)} />);
      // The header's height reaches the virtualizer in a layout effect.
      await flushTasks();

      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));
      const row = () => screen.getByRole("rowheader", { name: "host-500" }).closest("tr")!;
      // Sticky: the row starts right below the header, which covers the top 36px.
      expect(viewport().scrollTop).toBe(theadHeight + bodyOffset(row()) - theadHeight);

      cleanup();
      render(<DataTable ref={ref} {...props} stickyHeader={false} data={hosts(1000)} />);
      await flushTasks();
      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));
      // Not sticky: the header scrolled away, so the row starts at the very top.
      expect(viewport().scrollTop).toBe(theadHeight + bodyOffset(row()));
      void rerender;
    });

    it("scrolls only a plain table's own region, clear of its sticky header", () => {
      theadHeight = 36;
      const ref = createRef<DataTableHandle>();
      const pageScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const props = { caption: "Hosts", columns: COLUMNS, getRowId: (r: Host) => r.key, captionHidden: true } as const;
      const { rerender } = render(<DataTable ref={ref} {...props} data={hosts(20)} />);
      const root = document.querySelector<HTMLElement>('[data-slot="data-table"]')!;
      // A bounded root: 100px tall over 20 rows.
      Object.defineProperty(root, "clientHeight", { configurable: true, value: 100 });
      Object.defineProperty(root, "scrollHeight", { configurable: true, value: 36 + 20 * 36 });
      root.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect;
      const rootScroll = vi.fn();
      root.scrollTo = rootScroll as HTMLElement["scrollTo"];
      // Row 12 sits below the 36px header and twelve 36px rows.
      const row = screen.getByRole("rowheader", { name: "host-12" }).closest("tr")!;
      row.getBoundingClientRect = () => ({ top: 36 + 12 * 36, height: 36 }) as DOMRect;

      void ref.current!.scrollToIndex(12, { align: "start" });
      expect(rootScroll).toHaveBeenLastCalledWith({ top: 12 * 36 });
      void ref.current!.scrollToIndex(12, { align: "center" });
      expect(rootScroll).toHaveBeenLastCalledWith({ top: 12 * 36 - (100 - 36 - 36) / 2 });
      void ref.current!.scrollToIndex(12, { align: "end" });
      expect(rootScroll).toHaveBeenLastCalledWith({ top: 36 + 13 * 36 - 100 });

      rerender(<DataTable ref={ref} {...props} stickyHeader={false} data={hosts(20)} />);
      void ref.current!.scrollToIndex(12, { align: "start" });
      expect(rootScroll).toHaveBeenLastCalledWith({ top: 36 + 12 * 36 });
      expect(pageScroll).not.toHaveBeenCalled();
      pageScroll.mockRestore();
    });

    describe("on a plain table as tall as its rows (not a scroll container)", () => {
      const intoView = vi.fn();
      // The happy-dom window is installed per file in beforeAll, so the prototype is read per test.
      const protoOf = () => (globalThis as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
      let proto: HTMLElement;
      let original: PropertyDescriptor | undefined;
      beforeEach(() => {
        proto = protoOf();
        intoView.mockClear();
        original = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
        proto.scrollIntoView = intoView as HTMLElement["scrollIntoView"];
      });
      afterEach(() => {
        restoreOwn(proto, "scrollIntoView", original);
      });

      it("scrollToIndex scrolls the row into the page instead of the root", async () => {
        const ref = createRef<DataTableHandle>();
        render(<DataTable ref={ref} {...linkProps} data={hosts(20)} />);
        const root = document.querySelector<HTMLElement>('[data-slot="data-table"]')!;
        const rootScroll = vi.fn();
        root.scrollTo = rootScroll as HTMLElement["scrollTo"];
        // jsdom: scrollHeight == clientHeight, as for an unbounded root.
        expect(root.scrollHeight).toBe(root.clientHeight);

        await viaHandle(() => ref.current!.scrollToIndex(12, { align: "start" }));

        expect(intoView).toHaveBeenCalledWith({ block: "start" });
        expect(intoView.mock.contexts.at(-1)).toBe(screen.getByRole("rowheader", { name: "host-12" }).closest("tr"));
        expect(rootScroll).not.toHaveBeenCalled();
      });

      it("focusIndex leaves the focused link visible", async () => {
        const ref = createRef<DataTableHandle>();
        render(<DataTable ref={ref} {...linkProps} data={hosts(20)} />);

        expect(await viaHandle(() => ref.current!.focusIndex(19))).toBe(true);

        const link = screen.getByRole("link", { name: "host-19" });
        expect(document.activeElement).toBe(link);
        expect(intoView.mock.contexts).toContain(link);
        expect(intoView).toHaveBeenLastCalledWith({ block: "nearest" });
      });
    });

    it("focusIndex does not focus when a newer call supersedes its scroll", async () => {
      const ref = createRef<DataTableHandle>();
      render(<DataTable ref={ref} {...linkProps} data={hosts(1000)} virtualize />);
      const link = screen.getByRole("link", { name: "host-3" });
      act(() => link.focus());

      let focused!: Promise<boolean>;
      let scrolled!: Promise<void>;
      act(() => {
        // host-4 stays rendered (the focused row's neighbour), so a stale focus would land.
        focused = ref.current!.focusIndex(4);
        scrolled = ref.current!.scrollToIndex(900, { align: "start" });
      });
      let result: boolean | undefined;
      await act(async () => {
        result = await focused;
        await scrolled;
      });

      expect(result).toBe(false);
      expect(document.activeElement).toBe(link);
      // The newer scroll stands.
      const target = screen.getByRole("link", { name: "host-900" }).closest("tr")!;
      expect(bodyOffset(target)).toBe(viewport().scrollTop);
    });

    it("focusIndex does not focus when a user scroll cancels it", async () => {
      const ref = createRef<DataTableHandle>();
      render(<DataTable ref={ref} {...linkProps} data={hosts(1000)} virtualize />);
      const link = screen.getByRole("link", { name: "host-3" });
      act(() => link.focus());

      let focused!: Promise<boolean>;
      act(() => {
        focused = ref.current!.focusIndex(900);
        // A wheel gesture before the scroll settled.
        viewport().dispatchEvent(new Event("wheel", { bubbles: true }));
      });
      let result: boolean | undefined;
      await act(async () => {
        result = await focused;
      });

      expect(result).toBe(false);
      expect(document.activeElement).toBe(link);
    });
  });

  describe("keyboard with sparse cell controls (isNavigable)", () => {
    const at = (r: Host) => Number(r.key.slice("host-".length));
    const pingColumns: ColumnDef<Host>[] = [
      { accessorKey: "key", header: "Host" },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (at(row.original) % 5 === 0 ? <button type="button">Ping {row.original.key}</button> : null),
      },
    ];

    it("Tab and Shift+Tab reach the next and previous row with a control, outside the window", async () => {
      const ref = createRef<DataTableHandle>();
      render(
        <DataTable
          ref={ref}
          caption="Hosts"
          columns={pingColumns}
          getRowId={(r) => r.key}
          data={hosts(1000)}
          virtualize={{ overscan: 0, isNavigable: (r) => at(r) % 5 === 0 }}
        />,
      );
      act(() => screen.getByRole("button", { name: "Ping host-5" }).focus());
      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));

      await userEvent.tab();
      expect(document.activeElement).toHaveTextContent("Ping host-10");

      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));
      await userEvent.tab({ shift: true });
      expect(document.activeElement).toHaveTextContent("Ping host-5");
    });

    it("mixed rows: links on some, actions on others", async () => {
      const ref = createRef<DataTableHandle>();
      const hasLink = (r: Host) => at(r) % 10 === 0;
      const hasAction = (r: Host) => at(r) % 10 === 5;
      const columns: ColumnDef<Host>[] = [
        { accessorKey: "key", header: "Host" },
        {
          id: "actions",
          header: "Actions",
          cell: ({ row }) => (hasAction(row.original) ? <button type="button">Restart {row.original.key}</button> : null),
        },
      ];
      render(
        <DataTable
          ref={ref}
          {...linkProps}
          columns={columns}
          rowLink={(r) => (hasLink(r) ? `/hosts/${r.key}` : undefined)}
          data={hosts(1000)}
          virtualize={{ overscan: 0, isNavigable: (r) => hasLink(r) || hasAction(r) }}
        />,
      );
      act(() => screen.getByRole("link", { name: "host-0" }).focus());
      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));

      await userEvent.tab();
      expect(document.activeElement).toHaveTextContent("Restart host-5");
      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));
      await userEvent.tab();
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-10");
      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));
      await userEvent.tab({ shift: true });
      expect(document.activeElement).toHaveTextContent("Restart host-5");

      // focusIndex on a row without a link focuses its control.
      expect(await viaHandle(() => ref.current!.focusIndex(15))).toBe(true);
      expect(document.activeElement).toHaveTextContent("Restart host-15");
    });
  });

  describe("keyboard across the window", () => {
    it("keeps the focused row and its neighbours rendered when the window scrolls away", async () => {
      const ref = createRef<DataTableHandle>();
      render(<DataTable ref={ref} {...linkProps} data={hosts(1000)} virtualize />);
      const link = screen.getByRole("link", { name: "host-3" });
      act(() => link.focus());

      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));

      expect(screen.getByRole("link", { name: "host-500" })).toBeInTheDocument();
      expect(document.activeElement).toBe(link);
      expect(link.closest("tr")).toHaveAttribute("aria-rowindex", "5");
      expect(screen.getByRole("link", { name: "host-2" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "host-4" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "host-5" })).toBeNull();

      // Tab and Shift+Tab go to the logical neighbours, not into the far window.
      await userEvent.tab();
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-4");
      await userEvent.tab({ shift: true });
      await userEvent.tab({ shift: true });
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-2");
    });

    it.each<[string, DataTableVirtualizeOptions]>([
      ["the default overscan", {}],
      ["overscan 0", { overscan: 0 }],
    ])("Tab and Shift+Tab walk every row across the window edge with %s", async (_, options) => {
      render(<DataTable {...linkProps} data={hosts(1000)} virtualize={options} />);
      act(() => screen.getByRole("link", { name: "host-0" }).focus());

      for (let i = 1; i <= 30; i += 1) {
        await userEvent.tab();
        expect(document.activeElement).toHaveAttribute("data-row-link", `host-${i}`);
      }
      expect(viewport().scrollTop).toBeGreaterThan(0);
      expect(screen.queryByRole("link", { name: "host-0" })).toBeNull();
      for (let i = 29; i >= 0; i -= 1) {
        await userEvent.tab({ shift: true });
        expect(document.activeElement).toHaveAttribute("data-row-link", `host-${i}`);
      }
      expect(viewport().querySelectorAll(ROW_LINK_SELECTOR).length).toBeLessThan(40);
    }, KEYBOARD_WALK_TIMEOUT_MS);

    it("Tab walks every control of rows with several, at overscan 0", async () => {
      const columns: ColumnDef<Host>[] = [
        { accessorKey: "key", header: "Host" },
        {
          id: "actions",
          header: "Actions",
          cell: ({ row }) => (
            <>
              <button type="button">Ping {row.original.key}</button>
              <button type="button">Restart {row.original.key}</button>
            </>
          ),
        },
      ];
      render(<DataTable {...linkProps} columns={columns} data={hosts(1000)} virtualize={{ overscan: 0 }} />);
      act(() => screen.getByRole("link", { name: "host-0" }).focus());

      for (let i = 0; i < 15; i += 1) {
        await userEvent.tab();
        expect(document.activeElement).toHaveTextContent(`Ping host-${i}`);
        await userEvent.tab();
        expect(document.activeElement).toHaveTextContent(`Restart host-${i}`);
        await userEvent.tab();
        expect(document.activeElement).toHaveAttribute("data-row-link", `host-${i + 1}`);
      }
    }, KEYBOARD_WALK_TIMEOUT_MS);

    it("pins the nearest row with a link, past rows without one", async () => {
      const ref = createRef<DataTableHandle>();
      // Only every fifth row links.
      render(
        <DataTable
          ref={ref}
          {...linkProps}
          rowLink={(r) => (Number(r.key.slice(5)) % 5 === 0 ? `/hosts/${r.key}` : undefined)}
          data={hosts(1000)}
          virtualize={{ overscan: 0 }}
        />,
      );
      act(() => screen.getByRole("link", { name: "host-5" }).focus());
      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));

      await userEvent.tab();
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-10");
    });

    it("useListNavigation reaches the first and last rows through focusEdge and focusIndex", async () => {
      const data = hosts(1000);
      function NavigableTable() {
        const tableRef = useRef<DataTableHandle>(null);
        const containerRef = useRef<HTMLDivElement>(null);
        useListNavigation({
          getItems: () => containerRef.current?.querySelectorAll<HTMLElement>(ROW_LINK_SELECTOR) ?? [],
          focusEdge: (edge) => void tableRef.current?.focusIndex(edge === "first" ? 0 : data.length - 1),
        });
        return (
          <div ref={containerRef}>
            <DataTable ref={tableRef} {...linkProps} data={data} virtualize={{ overscan: 0 }} />
          </div>
        );
      }
      render(<NavigableTable />);
      act(() => screen.getByRole("link", { name: "host-0" }).focus());
      const press = async (keys: string) => {
        await userEvent.keyboard(keys);
        await flushTasks();
      };

      await press("{End}");
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-999");
      await press("{Home}");
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-0");
      await press("G");
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-999");
      await press("{ArrowUp}");
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-998");
      await press("gg");
      expect(document.activeElement).toHaveAttribute("data-row-link", "host-0");
      for (let i = 1; i <= 15; i += 1) {
        await press("{ArrowDown}");
        expect(document.activeElement).toHaveAttribute("data-row-link", `host-${i}`);
      }
    });

    it("keeps the focused row rendered and focused when rows are inserted above it", () => {
      const data = hosts(1000);
      const { rerender } = render(<DataTable {...linkProps} data={data} virtualize />);
      const link = screen.getByRole("link", { name: "host-3" });
      act(() => link.focus());
      expect(document.activeElement).toBe(link);

      // A live re-sort: 200 new rows land above host-3, moving it far past the window.
      const inserted: Host[] = Array.from({ length: 200 }, (_, i) => ({ key: `new-${i}`, kind: "VM" }));
      rerender(<DataTable {...linkProps} data={[...inserted, ...data]} virtualize />);

      expect(screen.getByRole("link", { name: "host-3" })).toBe(link);
      expect(link.isConnected).toBe(true);
      expect(document.activeElement).toBe(link);
      expect(link.closest("tr")).toHaveAttribute("aria-rowindex", String(1 + 203 + 1));
      // The row at its old index is the new data, not a stale stand-in for it.
      expect(screen.getByRole("link", { name: "new-3" })).toBeInTheDocument();
      expect(rowIndexes().length).toBeLessThan(40);
    });

    it("unpins a row that lost focus without a blur (it was removed)", async () => {
      const ref = createRef<DataTableHandle>();
      const data = hosts(1000);
      const { rerender } = render(<DataTable ref={ref} {...linkProps} data={data} virtualize />);
      act(() => screen.getByRole("link", { name: "host-3" }).focus());
      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "start" }));
      expect(screen.getByRole("link", { name: "host-3" })).toBeInTheDocument();

      // Live data drops the focused row, then brings it back.
      rerender(<DataTable ref={ref} {...linkProps} data={data.filter((r) => r.key !== "host-3")} virtualize />);
      expect(document.activeElement).not.toHaveAttribute("data-row-link");
      rerender(<DataTable ref={ref} {...linkProps} data={data} virtualize />);

      expect(screen.queryByRole("link", { name: "host-3" })).toBeNull();
      expect(screen.getByRole("link", { name: "host-500" })).toBeInTheDocument();
    });
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
    expect(isVirtualized(container)).toBe(false);
    expect(container.querySelector("[aria-rowcount]")).toBeNull();
    expect(within(container).getAllByRole("row")).toHaveLength(240);

    // Back up, but under the threshold: stays plain (no latch).
    rerender(<DataTable {...props} data={hosts(299)} />);
    expect(isVirtualized(container)).toBe(false);
    rerender(<DataTable {...props} data={hosts(300)} />);
    expect(isVirtualized(container)).toBe(true);
  });

  it("never virtualizes an empty table: a threshold below 1 still shows the empty state", () => {
    const props = { caption: "Hosts", columns: COLUMNS, getRowId: (r: Host) => r.key, virtualize: { threshold: 0 } } as const;
    const { rerender, container } = render(<DataTable {...props} data={[]} empty="No hosts yet" />);
    expect(isVirtualized(container)).toBe(false);
    expect(screen.getByText("No hosts yet")).toBeInTheDocument();
    // The threshold is clamped to 1: one row virtualizes.
    rerender(<DataTable {...props} data={hosts(1)} empty="No hosts yet" />);
    expect(isVirtualized(container)).toBe(true);
  });

  it("puts className on the data-table root, the scroll region, on both paths", () => {
    const props = { caption: "Hosts", columns: COLUMNS, getRowId: (r: Host) => r.key, className: "col-span-2 max-h-64", virtualize: true } as const;
    const { rerender, container } = render(<DataTable {...props} data={hosts(20)} />);
    const plainRoot = container.querySelector('[data-slot="data-table"]')!;
    expect(plainRoot).toHaveClass("col-span-2", "max-h-64");
    expect(plainRoot).toBe(screen.getByRole("region", { name: "Hosts" }));

    rerender(<DataTable {...props} data={hosts(400)} />);
    const root = container.querySelector('[data-slot="data-table"]')!;
    expect(root).toHaveAttribute("data-virtualized");
    expect(root).toHaveClass("col-span-2", "max-h-64");
    // The caller's bound replaces the default one.
    expect(root).not.toHaveClass("max-h-[70vh]");
    expect(root).toBe(screen.getByRole("region", { name: "Hosts" }));
    expect(container.firstElementChild).toBe(root);
  });

  describe("row height", () => {
    afterEach(() => {
      document.documentElement.style.removeProperty("--table-compact-cell-h");
      document.documentElement.style.removeProperty("--table-cell-h");
    });

    /**
     * The height the trailing spacer gives each row below the window: the estimate (within a
     * pixel: a row measured taller, 36px, and then left behind by the shrinking window counts too).
     */
    const trailingEstimate = (count: number) => {
      const spacers = viewport().querySelectorAll<HTMLElement>('[data-slot="data-table-spacer"] td');
      const last = Math.max(...rowIndexes()) - 2;
      return Number.parseFloat(spacers[spacers.length - 1]!.style.height) / (count - last - 1);
    };

    it.each([
      ["compact", "--table-compact-cell-h", COMPACT_ESTIMATE],
      ["comfortable", "--table-cell-h", 44],
    ] as const)("%s rows follow the density token: no forced height, the token as estimate", (density, token, fallback) => {
      const props = { caption: "Hosts", columns: COLUMNS, getRowId: (r: Host) => r.key, density, virtualize: true } as const;
      render(<DataTable {...props} data={hosts(1000)} />);
      for (const tr of dataRows()) expect(tr.style.height).toBe("");
      // Without a stylesheet, theme.css's default token value.
      expect(trailingEstimate(1000)).toBeCloseTo(fallback, 0);
      cleanup();

      // The operator's compact density tightens the token: the estimate follows it.
      document.documentElement.style.setProperty(token, "1.75rem");
      render(<DataTable {...props} data={hosts(1000)} />);
      for (const tr of dataRows()) expect(tr.style.height).toBe("");
      expect(trailingEstimate(1000)).toBeCloseTo(28, 0);
    });

    it("an explicit rowHeight sets each row's height and the estimate", () => {
      render(
        <DataTable caption="Hosts" columns={COLUMNS} data={hosts(1000)} getRowId={(r) => r.key} virtualize={{ rowHeight: 40 }} />,
      );
      for (const tr of dataRows()) expect(tr.style.height).toBe("40px");
      expect(trailingEstimate(1000)).toBe(40);
    });
  });

  it("scrolling does not rescan every row (stable item keys, indexed row ids)", async () => {
    const count = 20_000;
    // Rows measure what they are estimated at, so a scroll changes no size: what is left is
    // the work done per render.
    document.documentElement.style.setProperty("--table-compact-cell-h", "36px");
    render(<DataTable {...linkProps} data={hosts(count)} virtualize />);
    act(() => screen.getByRole("link", { name: "host-3" }).focus());
    const lookups = vi.spyOn(Map.prototype, "get");
    const scans = vi.spyOn(Array.prototype, "findIndex");
    try {
      for (let top = 400; top <= 2000; top += 400) {
        await act(async () => {
          viewport().scrollTop = top;
          viewport().dispatchEvent(new Event("scroll"));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      // An unstable key re-measures all 20,000 rows on every scroll render.
      expect(lookups.mock.calls.length).toBeLessThan(count / 2);
      expect(scans.mock.contexts.filter((array) => (array as unknown[]).length >= count)).toEqual([]);
    } finally {
      document.documentElement.style.removeProperty("--table-compact-cell-h");
      lookups.mockRestore();
      scans.mockRestore();
    }
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
      expect(bodyHeight(viewport())).toBe(realOffset(last + 1) + (data.length - last - 1) * COMPACT_ESTIMATE);
    });

    it("scrollToIndex lands a far row at the top, below tall rows", async () => {
      const ref = createRef<DataTableHandle>();
      render(<DataTable ref={ref} caption="Hosts" columns={COLUMNS} data={mixed(1000, 3)} getRowId={(r) => r.key} virtualize />);

      await viaHandle(() => ref.current!.scrollToIndex(600, { align: "start" }));

      expect(bodyOffset(row("host-600"))).toBe(viewport().scrollTop);
      expect(row("host-600")).toHaveAttribute("aria-rowindex", "602");
      expect(rowIndexes().length).toBeLessThan(40);
    });

    it("scrollToIndex lands a row at the bottom edge among tall rows", async () => {
      const ref = createRef<DataTableHandle>();
      // Every row near the target is tall: the estimate puts the target ~200px too high.
      render(<DataTable ref={ref} caption="Hosts" columns={COLUMNS} data={mixed(1000, 1)} getRowId={(r) => r.key} virtualize />);

      await viaHandle(() => ref.current!.scrollToIndex(500, { align: "end" }));

      const target = row("host-500");
      expect(bodyOffset(target) + bodyRowHeight(target)).toBe(viewport().scrollTop + VIEWPORT_HEIGHT);
    });

    it("scrollToIndex keeps aiming at the same row when rows are inserted above it meanwhile", async () => {
      const ref = createRef<DataTableHandle>();
      const props = { caption: "Hosts", columns: COLUMNS, getRowId: (r: Host) => r.key, virtualize: true } as const;
      const data = mixed(1000, 3);
      const { rerender } = render(<DataTable ref={ref} {...props} data={data} />);

      let scrolled!: Promise<void>;
      act(() => {
        scrolled = ref.current!.scrollToIndex(600, { align: "start" });
        // A live update lands 30 rows above the target before the scroll settles.
        const inserted: Host[] = Array.from({ length: 30 }, (_, i) => ({ key: `new-${i}`, kind: "VM" }));
        rerender(<DataTable ref={ref} {...props} data={[...inserted, ...data]} />);
      });
      await scrolled;

      expect(bodyOffset(row("host-600"))).toBe(viewport().scrollTop);
      expect(row("host-600")).toHaveAttribute("aria-rowindex", "632");
    });

    it("a scrolling key cancels scrollToIndex's re-aim, so the user's scroll stands", async () => {
      const ref = createRef<DataTableHandle>();
      render(<DataTable ref={ref} caption="Hosts" columns={COLUMNS} data={mixed(1000, 3)} getRowId={(r) => r.key} virtualize />);

      // PageDown right after the call, before the scroll has rendered (and re-aimed): the
      // browser scrolls the viewport by a page from where scrollToIndex put it.
      let scrolled!: Promise<void>;
      act(() => {
        scrolled = ref.current!.scrollToIndex(600, { align: "start" });
        viewport().focus();
      });
      const userTop = viewport().scrollTop + VIEWPORT_HEIGHT;
      await act(async () => {
        const view = document.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent };
        viewport().dispatchEvent(new view.KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
        viewport().scrollTop = userTop;
        viewport().dispatchEvent(new Event("scroll"));
        // The cancelled call still resolves.
        await scrolled;
      });
      await flushTasks();
      await flushTasks();
      // Not pulled back up to the target. (It may sit a little lower: rows above the viewport
      // measured taller, and the library shifts the offset to keep the content in place.)
      expect(viewport().scrollTop).toBeGreaterThanOrEqual(userTop);
    });

    it("keyboard focus across the window keeps landing on the next tall row", async () => {
      render(<DataTable {...linkProps} data={mixed(1000, 2)} virtualize />);
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
    }, KEYBOARD_WALK_TIMEOUT_MS);
  });

  it("focusable={false} drops the scroll region's tab stop, plain and virtualized", () => {
    const props = { caption: "Hosts", columns: COLUMNS, getRowId: (r: Host) => r.key, focusable: false } as const;
    const { rerender } = render(<DataTable {...props} data={hosts(3)} />);
    expect(screen.getByRole("region", { name: "Hosts" })).not.toHaveAttribute("tabindex");
    rerender(<DataTable {...props} data={hosts(400)} virtualize />);
    const region = screen.getByRole("region", { name: "Hosts" });
    expect(region).toHaveAttribute("data-virtualized");
    expect(region).not.toHaveAttribute("tabindex");
  });
});
