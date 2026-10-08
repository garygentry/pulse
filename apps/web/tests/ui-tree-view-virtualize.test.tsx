// apps/web/tests/ui-tree-view-virtualize.test.tsx — TreeView `virtualize`: the threshold opt-in, the
// ARIA tree contract on flat, windowed treeitems (level / set size / position from the model), keyboard
// moves, `*` and type-ahead reaching rows that are not rendered, and expand/collapse while windowed.
//
// happy-dom has no layout: the viewport's geometry is stubbed (offsetHeight/clientHeight/scrollHeight,
// which the virtualizer reads), each treeitem measures ROW_HEIGHT through `getBoundingClientRect`, and
// `scrollTo` fires `scroll` on the next task, as a browser does.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { useState } from "react";

import { TREE_VIEW_VIRTUALIZE_DEFAULTS, TreeView, type TreeViewProps } from "@/ui";

import { act, describeUi, render, screen, userEvent, waitFor } from "./rtl.js";

interface Node {
  id: string;
  name: string;
  children?: Node[];
}

const HOSTS = 50;
const SERVICES = 20;
const pad = (n: number) => String(n).padStart(2, "0");

/** 50 hosts × 20 services: 1,050 rows with every host open. */
const NODES: Node[] = Array.from({ length: HOSTS }, (_, h) => ({
  id: `host-${pad(h)}`,
  name: `host-${pad(h)}`,
  children: Array.from({ length: SERVICES }, (_, s) => ({ id: `host-${pad(h)}/svc-${pad(s)}`, name: `svc-${pad(s)}` })),
}));
const ALL_HOSTS = NODES.map((n) => n.id);
const LAST_ID = `host-${pad(HOSTS - 1)}/svc-${pad(SERVICES - 1)}`;

const accessors = {
  getId: (n: Node) => n.id,
  getLabel: (n: Node) => n.name,
  getChildren: (n: Node) => n.children,
};

const VIEWPORT_HEIGHT = 320;
const ROW_HEIGHT = 32;

const tree = () => screen.getByRole("tree", { name: "Estate" });
const rendered = () => screen.getAllByRole("treeitem");
const byId = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-tree-id="${id}"]`);
const focusedId = () => (document.activeElement as HTMLElement | null)?.getAttribute("data-tree-id") ?? null;

/** Stubbed layout height of a viewport's content: rendered rows plus spacers. */
function contentHeight(viewport: Element): number {
  let total = 0;
  for (const li of viewport.querySelectorAll<HTMLElement>("ul[role=tree] > li")) {
    total += li.getAttribute("data-slot") === "tree-view-spacer" ? Number.parseFloat(li.style.height) || 0 : ROW_HEIGHT;
  }
  return total;
}

/** Where the row `id` starts in the stubbed layout (px from the top of the list), or -1. */
function offsetOf(id: string): number {
  let offset = 0;
  for (const li of document.querySelectorAll<HTMLElement>('[data-slot="tree-view-viewport"] ul[role=tree] > li')) {
    if (li.getAttribute("data-tree-id") === id) return offset;
    offset += li.getAttribute("data-slot") === "tree-view-spacer" ? Number.parseFloat(li.style.height) || 0 : ROW_HEIGHT;
  }
  return -1;
}

/** A fixed `performance.now`, advanced by hand, for the type-ahead window. */
function fixedClock(): { advance: (ms: number) => void; restore: () => void } {
  const realNow = performance.now.bind(performance);
  let clock = 1_000;
  performance.now = () => clock;
  return {
    advance: (ms) => {
      clock += ms;
    },
    restore: () => {
      performance.now = realNow;
    },
  };
}

function Tree(props: Partial<TreeViewProps<Node>> & { initial?: Iterable<string> }) {
  const { initial = ALL_HOSTS, ...rest } = props;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initial));
  return (
    <TreeView
      aria-label="Estate"
      nodes={NODES}
      {...accessors}
      expanded={expanded}
      onExpandedChange={setExpanded}
      virtualize
      {...rest}
    />
  );
}

describeUi("@/ui TreeView virtualize", () => {
  const undo: (() => void)[] = [];

  beforeEach(() => {
    const proto = (globalThis as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
    const isViewport = (el: HTMLElement) => el.getAttribute("data-slot") === "tree-view-viewport";
    const stubs: Record<string, (el: HTMLElement) => number | undefined> = {
      offsetHeight: (el) => (isViewport(el) ? VIEWPORT_HEIGHT : undefined),
      clientHeight: (el) => (isViewport(el) ? VIEWPORT_HEIGHT : undefined),
      scrollHeight: (el) => (isViewport(el) ? contentHeight(el) : undefined),
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
    const getRect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const rect = getRect.call(this);
      if (this.getAttribute("role") !== "treeitem") return rect;
      return { ...rect.toJSON(), height: ROW_HEIGHT, bottom: rect.top + ROW_HEIGHT, toJSON: () => ({}) } as DOMRect;
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
  }, 30_000);

  it("opts in: without `virtualize`, or below the threshold, every visible row renders nested", () => {
    const five = ALL_HOSTS.slice(0, 5); // 50 hosts + 5 × 20 services = 150 visible rows
    const { unmount } = render(<Tree initial={five} virtualize={false} />);
    expect(rendered()).toHaveLength(150);
    expect(screen.getAllByRole("group")).toHaveLength(5);
    expect(tree().closest("[data-slot=tree-view]")).not.toHaveAttribute("data-virtualized");
    unmount();

    // Under the default threshold of 300: still every row, nested.
    expect(TREE_VIEW_VIRTUALIZE_DEFAULTS.threshold).toBe(300);
    const below = render(<Tree initial={five} />);
    expect(rendered()).toHaveLength(150);
    expect(tree().closest("[data-slot=tree-view]")).not.toHaveAttribute("data-virtualized");
    below.unmount();

    // A lower threshold: the same 150 rows are windowed.
    render(<Tree initial={five} virtualize={{ threshold: 150 }} />);
    expect(tree().closest("[data-slot=tree-view]")).toHaveAttribute("data-virtualized");
    expect(rendered().length).toBeLessThan(40);
  }, 30_000);

  it("at the threshold renders a bounded window of flat treeitems over spacers", () => {
    render(<Tree />);
    expect(tree().closest("[data-slot=tree-view]")).toHaveAttribute("data-virtualized");
    const count = rendered().length;
    expect(count).toBeGreaterThan(5);
    expect(count).toBeLessThan(40);
    expect(screen.queryByRole("group")).toBeNull();
    // The spacers stand in for every row that is not rendered.
    const viewport = document.querySelector('[data-slot="tree-view-viewport"]')!;
    expect(contentHeight(viewport)).toBe(HOSTS * (SERVICES + 1) * ROW_HEIGHT);
  }, 30_000);

  it("gives rendered rows aria-level, aria-setsize, aria-posinset and aria-expanded from the model", () => {
    render(<Tree />);
    const host = byId("host-00")!;
    expect(host).toHaveAttribute("aria-level", "1");
    expect(host).toHaveAttribute("aria-setsize", String(HOSTS));
    expect(host).toHaveAttribute("aria-posinset", "1");
    expect(host).toHaveAttribute("aria-expanded", "true");
    const service = byId("host-00/svc-04")!;
    expect(service).toHaveAttribute("aria-level", "2");
    expect(service).toHaveAttribute("aria-setsize", String(SERVICES));
    expect(service).toHaveAttribute("aria-posinset", "5");
    expect(service).not.toHaveAttribute("aria-expanded");
    expect(service).toHaveAccessibleName("svc-04");
  }, 30_000);

  it("keeps the tab stop rendered and moves focus with ↓ across the window's edge", async () => {
    const user = userEvent.setup();
    render(<Tree />);
    expect(rendered().filter((el) => el.tabIndex === 0).map((el) => el.dataset.treeId)).toEqual(["host-00"]);
    act(() => byId("host-00")!.focus());
    for (let i = 0; i < 45; i += 1) await user.keyboard("{ArrowDown}");
    // Row 45: host-02 (index 42), then its services 0..2.
    expect(focusedId()).toBe("host-02/svc-02");
    expect(rendered().length).toBeLessThan(45);
  }, 30_000);

  it("End and Home reach the last and first rows though they are not rendered", async () => {
    const user = userEvent.setup();
    render(<Tree />);
    act(() => byId("host-00")!.focus());
    expect(byId(LAST_ID)).toBeNull();
    await user.keyboard("{End}");
    await waitFor(() => expect(focusedId()).toBe(LAST_ID));
    const last = byId(LAST_ID)!;
    expect(last).toHaveAttribute("aria-posinset", String(SERVICES));
    expect(last).toHaveAttribute("tabindex", "0");
    await user.keyboard("{ArrowUp}");
    expect(focusedId()).toBe(`host-${pad(HOSTS - 1)}/svc-${pad(SERVICES - 2)}`);
    await user.keyboard("{Home}");
    await waitFor(() => expect(focusedId()).toBe("host-00"));
  }, 30_000);

  it("← from a service steps to its unrendered parent; → steps back into the first child", async () => {
    const user = userEvent.setup();
    render(<Tree />);
    act(() => byId("host-00")!.focus());
    await user.keyboard("{End}");
    await waitFor(() => expect(focusedId()).toBe(LAST_ID));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(focusedId()).toBe(`host-${pad(HOSTS - 1)}`));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(focusedId()).toBe(`host-${pad(HOSTS - 1)}/svc-00`));
  }, 30_000);

  it("type-ahead jumps to an unrendered row by label", async () => {
    // A fixed clock: under load, keystrokes must not fall outside the type-ahead window.
    const clock = fixedClock();
    try {
      const user = userEvent.setup();
      render(<Tree />);
      act(() => byId("host-00")!.focus());
      expect(byId("host-37")).toBeNull();
      await user.keyboard("host-37");
      await waitFor(() => expect(focusedId()).toBe("host-37"));
      // After a pause a new search starts: the next row starting with "s".
      clock.advance(1_000);
      await user.keyboard("s");
      await waitFor(() => expect(focusedId()).toBe("host-37/svc-00"));
    } finally {
      clock.restore();
    }
  }, 30_000);

  it("collapse and expand update the window, positions and the reachable end", async () => {
    const user = userEvent.setup();
    render(<Tree virtualize={{ threshold: 40 }} />);
    act(() => byId("host-00")!.focus());
    await user.keyboard("{ArrowLeft}"); // collapse host-00
    expect(byId("host-00")).toHaveAttribute("aria-expanded", "false");
    expect(byId("host-00/svc-00")).toBeNull();
    // host-01 now follows host-00 directly; its position in the set is unchanged.
    await user.keyboard("{ArrowDown}");
    expect(focusedId()).toBe("host-01");
    expect(byId("host-01")).toHaveAttribute("aria-posinset", "2");
    await user.keyboard("{ArrowUp}{ArrowRight}");
    expect(byId("host-00")).toHaveAttribute("aria-expanded", "true");
    expect(byId("host-00/svc-00")).not.toBeNull();
  }, 30_000);

  it("* expands every sibling host, virtualizing the tree, and End then reaches the last service", async () => {
    const user = userEvent.setup();
    render(<Tree initial={[]} />);
    expect(tree().closest("[data-slot=tree-view]")).not.toHaveAttribute("data-virtualized");
    act(() => byId("host-00")!.focus());
    await user.keyboard("*");
    expect(tree().closest("[data-slot=tree-view]")).toHaveAttribute("data-virtualized");
    expect(byId("host-00")).toHaveAttribute("aria-expanded", "true");
    // The layout switch remounted the rows; focus came back to the row that had it.
    await waitFor(() => expect(focusedId()).toBe("host-00"));
    await user.keyboard("{End}");
    await waitFor(() => expect(focusedId()).toBe(LAST_ID));
    expect(rendered().length).toBeLessThan(60);
  }, 30_000);

  it("* in an already-virtualized tree keeps the focused row in view as rows open above it", async () => {
    const clock = fixedClock();
    try {
      const user = userEvent.setup();
      // Hosts 40–49 open: 50 + 200 = 250 rows, past a threshold of 40.
      render(<Tree initial={ALL_HOSTS.slice(40)} virtualize={{ threshold: 40 }} />);
      act(() => byId("host-00")!.focus());
      await user.keyboard("host-30");
      await waitFor(() => expect(focusedId()).toBe("host-30"));
      const viewport = document.querySelector<HTMLElement>('[data-slot="tree-view-viewport"]')!;
      // Opens hosts 0–39: 30 × 20 rows land above host-30.
      await user.keyboard("*");
      expect(byId("host-30")).toHaveAttribute("aria-expanded", "true");
      expect(focusedId()).toBe("host-30");
      await waitFor(() => {
        const top = offsetOf("host-30");
        expect(top).toBe(30 * (SERVICES + 1) * ROW_HEIGHT);
        expect(top).toBeGreaterThanOrEqual(viewport.scrollTop);
        expect(top + ROW_HEIGHT).toBeLessThanOrEqual(viewport.scrollTop + VIEWPORT_HEIGHT);
      });
    } finally {
      clock.restore();
    }
  }, 30_000);

  it("j and k extend a live type-ahead search, and move focus outside one", async () => {
    const clock = fixedClock();
    try {
      const user = userEvent.setup();
      const names = ["alpha", "app-jellyfin", "app-kafka", "bravo"];
      render(
        <TreeView
          aria-label="Estate"
          nodes={names.map((name) => ({ id: name, name }))}
          {...accessors}
          virtualize={{ threshold: 1 }}
        />,
      );
      act(() => byId("alpha")!.focus());
      await user.keyboard("app-k");
      expect(focusedId()).toBe("app-kafka");
      clock.advance(1_000);
      await user.keyboard("app-j");
      expect(focusedId()).toBe("app-jellyfin");
      // Outside a search, j and k are movement keys again.
      clock.advance(1_000);
      await user.keyboard("j");
      expect(focusedId()).toBe("app-kafka");
      clock.advance(1_000);
      await user.keyboard("k");
      expect(focusedId()).toBe("app-jellyfin");
    } finally {
      clock.restore();
    }
  }, 30_000);

  it("focus that left the tree to nowhere is not pulled back when the layout switches", () => {
    const view = (expanded: readonly string[]) => (
      <TreeView aria-label="Estate" nodes={NODES} {...accessors} expanded={new Set(expanded)} virtualize />
    );
    const { rerender } = render(view([]));
    act(() => byId("host-00")!.focus());
    // Blur with no relatedTarget while the row is still in the document (a click on the page).
    act(() => byId("host-00")!.blur());
    rerender(view(ALL_HOSTS));
    expect(tree().closest("[data-slot=tree-view]")).toHaveAttribute("data-virtualized");
    expect(document.activeElement?.getAttribute("role")).not.toBe("treeitem");
  }, 30_000);

  it("Enter on a windowed row activates it", async () => {
    const user = userEvent.setup();
    const selected: string[] = [];
    render(<Tree onSelect={(node) => selected.push(node.id)} />);
    act(() => byId("host-00")!.focus());
    await user.keyboard("{End}");
    await waitFor(() => expect(focusedId()).toBe(LAST_ID));
    await user.keyboard("{Enter}");
    expect(selected).toEqual([LAST_ID]);
  });
});
