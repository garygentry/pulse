// apps/web/tests/ui-tree-view.test.tsx — ported from deck's `ui-tree-view` suite (vendored `@/ui`).
import { describe, expect, it, mock } from "bun:test";
import { useState } from "react";

import {
  TreeView,
  ancestorIds,
  filterTreeNodes,
  textPredicate,
  visibleTreeRows,
  type TreeViewProps,
} from "@/ui";

import { act, describeUi, render, screen, userEvent, within } from "./rtl.js";

interface Node {
  path: string;
  name: string;
  children?: Node[];
}

// Same shape as the sources manifest tree (dirs first, then files).
const TREE: Node[] = [
  {
    path: "docs",
    name: "docs",
    children: [
      { path: "docs/guide.md", name: "guide.md" },
      { path: "docs/img", name: "img", children: [{ path: "docs/img/logo.png", name: "logo.png" }] },
    ],
  },
  { path: "empty", name: "empty", children: [] },
  { path: "readme.md", name: "readme.md" },
];

const accessors = {
  getId: (n: Node) => n.path,
  getLabel: (n: Node) => n.name,
  getChildren: (n: Node) => n.children,
  isLeaf: (n: Node) => n.children === undefined,
};

type Props = Partial<TreeViewProps<Node>>;

function renderTree(props: Props = {}) {
  const onSelect = mock((_node: Node) => {});
  const utils = render(<TreeView aria-label="Files" nodes={TREE} {...accessors} {...props} onSelect={onSelect} />);
  return { ...utils, onSelect };
}

const item = (name: string) => screen.getByRole("treeitem", { name });
const names = () => screen.getAllByRole("treeitem").map((el) => el.getAttribute("data-tree-id"));

describe("tree logic", () => {
  it("filters to matches plus ancestors, and auto-expands the ancestors", () => {
    const result = filterTreeNodes(TREE, accessors, textPredicate("logo", (n: Node) => n.name));
    expect(result.matchCount).toBe(1);
    expect([...result.autoExpanded].sort()).toEqual(["docs", "docs/img"]);
    const rows = visibleTreeRows(result.entries, result.autoExpanded);
    expect(rows.map((r) => r.entry.id)).toEqual(["docs", "docs/img", "docs/img/logo.png"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(rows[2]!.parentId).toBe("docs/img");
  });

  it("gives each visible row its position among its siblings, from the model", () => {
    const rows = visibleTreeRows(filterTreeNodes(TREE, accessors).entries, new Set(["docs"]));
    expect(rows.map((r) => [r.entry.id, r.posInSet, r.setSize])).toEqual([
      ["docs", 1, 3],
      ["docs/guide.md", 1, 2],
      ["docs/img", 2, 2],
      ["empty", 2, 3],
      ["readme.md", 3, 3],
    ]);
  });

  it("keeps a matching branch's whole subtree", () => {
    const result = filterTreeNodes(TREE, accessors, (n) => n.name === "docs");
    expect(result.entries.map((e) => e.id)).toEqual(["docs"]);
    expect(result.entries[0]!.children.map((e) => e.id)).toEqual(["docs/guide.md", "docs/img"]);
    expect(result.autoExpanded.size).toBe(0);
  });

  it("treats blank text as no filter, and finds ancestors", () => {
    expect(textPredicate("  ", (n: Node) => n.name)).toBeUndefined();
    const all = filterTreeNodes(TREE, accessors);
    expect(all.entries).toHaveLength(3);
    expect(all.entries[1]!.leaf).toBe(false); // an empty folder is still a branch
    expect(ancestorIds(all.entries, "docs/img/logo.png")).toEqual(["docs/img", "docs"]);
    expect(ancestorIds(all.entries, "readme.md")).toEqual([]);
  });
});

describeUi("@/ui TreeView", () => {
  describe("TreeView semantics", () => {
    it("renders tree / treeitem / group with levels, set sizes and expansion state", () => {
      renderTree({ defaultExpanded: ["docs"] });
      const tree = screen.getByRole("tree", { name: "Files" });
      expect(tree.closest("[data-slot]")).toHaveAttribute("data-slot", "tree-view");
      const docs = item("docs");
      expect(docs).toHaveAttribute("aria-level", "1");
      expect(docs).toHaveAttribute("aria-expanded", "true");
      expect(docs).toHaveAttribute("aria-setsize", "3");
      expect(docs).toHaveAttribute("aria-posinset", "1");
      const group = within(docs).getByRole("group");
      expect(within(group).getByRole("treeitem", { name: "guide.md" })).toHaveAttribute("aria-level", "2");
      expect(item("img")).toHaveAttribute("aria-expanded", "false");
      expect(item("empty")).toHaveAttribute("aria-expanded", "false");
      expect(item("readme.md")).not.toHaveAttribute("aria-expanded");
      // Collapsed children are not rendered.
      expect(screen.queryByRole("treeitem", { name: "logo.png" })).toBeNull();
    });

    it("describes each treeitem with its row meta; rows without meta get no description", () => {
      renderTree({
        defaultExpanded: ["docs"],
        renderMeta: (n) => (n.children === undefined ? <span>file · {n.name.length} chars</span> : null),
      });
      expect(item("readme.md")).toHaveAccessibleDescription("file · 9 chars");
      expect(item("guide.md")).toHaveAccessibleDescription("file · 8 chars");
      expect(item("docs")).not.toHaveAttribute("aria-describedby");
      // The meta never joins the accessible name.
      expect(screen.getByRole("treeitem", { name: "readme.md" })).toBeInTheDocument();
    });

    it("names a branch by its own label, not its descendants", () => {
      renderTree({ defaultExpanded: ["docs"] });
      expect(item("docs")).toHaveAccessibleName("docs");
    });

    it("marks the selected node with aria-selected and aria-current, and makes it the tab stop", () => {
      renderTree({ defaultExpanded: ["docs"], selectedId: "docs/guide.md" });
      const guide = item("guide.md");
      expect(guide).toHaveAttribute("aria-selected", "true");
      expect(guide).toHaveAttribute("aria-current", "true");
      expect(item("readme.md")).toHaveAttribute("aria-selected", "false");
      expect(item("docs")).not.toHaveAttribute("aria-selected"); // branches are not selectable by default
      expect(screen.getAllByRole("treeitem").filter((el) => el.tabIndex === 0)).toEqual([guide]);
    });

    it("indents with a CSS variable, not inline padding", () => {
      renderTree({ defaultExpanded: ["docs"] });
      const row = item("guide.md").querySelector<HTMLElement>("[data-tree-row]")!;
      expect(row.style.getPropertyValue("--tree-depth")).toBe("1");
      expect(row.style.paddingLeft).toBe("");
    });

    it("shows an EmptyState when nothing matches the filter", () => {
      renderTree({ filter: "zzz", empty: "No files match ‘zzz’" });
      expect(screen.queryByRole("tree")).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent("No files match ‘zzz’");
    });
  });

  describe("TreeView interaction", () => {
    it("click toggles a branch and selects a leaf", async () => {
      const user = userEvent.setup();
      const { onSelect } = renderTree();
      await user.click(screen.getByText("docs"));
      expect(item("docs")).toHaveAttribute("aria-expanded", "true");
      await user.click(screen.getByText("guide.md"));
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: "docs/guide.md" }));
      await user.click(screen.getByText("docs"));
      expect(item("docs")).toHaveAttribute("aria-expanded", "false");
    });

    it("↑/↓ and Home/End move focus through visible items", async () => {
      const user = userEvent.setup();
      renderTree({ defaultExpanded: ["docs"] });
      act(() => item("docs").focus());
      await user.keyboard("{ArrowDown}");
      expect(item("guide.md")).toHaveFocus();
      await user.keyboard("{ArrowDown}{ArrowDown}");
      expect(item("empty")).toHaveFocus();
      await user.keyboard("{End}");
      expect(item("readme.md")).toHaveFocus();
      await user.keyboard("{Home}");
      expect(item("docs")).toHaveFocus();
      await user.keyboard("{ArrowUp}");
      expect(item("docs")).toHaveFocus(); // clamps
    });

    it("→ expands, then steps into the first child; ← collapses, or steps to the parent", async () => {
      const user = userEvent.setup();
      renderTree();
      act(() => item("docs").focus());
      await user.keyboard("{ArrowRight}");
      expect(item("docs")).toHaveAttribute("aria-expanded", "true");
      expect(item("docs")).toHaveFocus();
      await user.keyboard("{ArrowRight}");
      expect(item("guide.md")).toHaveFocus();
      await user.keyboard("{ArrowLeft}");
      expect(item("docs")).toHaveFocus();
      await user.keyboard("{ArrowLeft}");
      expect(item("docs")).toHaveAttribute("aria-expanded", "false");
      expect(names()).toEqual(["docs", "empty", "readme.md"]);
    });

    it("Enter selects a leaf and toggles a branch; Space toggles a branch and selects a leaf", async () => {
      const user = userEvent.setup();
      const { onSelect } = renderTree();
      act(() => item("docs").focus());
      await user.keyboard("{Enter}");
      expect(item("docs")).toHaveAttribute("aria-expanded", "true");
      await user.keyboard(" ");
      expect(item("docs")).toHaveAttribute("aria-expanded", "false");
      act(() => item("readme.md").focus());
      await user.keyboard("{Enter}");
      expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ path: "readme.md" }));
      onSelect.mockClear();
      await user.keyboard(" ");
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: "readme.md" }));
    });

    it("the last focused item becomes the tab stop", async () => {
      const user = userEvent.setup();
      renderTree();
      act(() => item("docs").focus());
      await user.keyboard("{End}");
      expect(item("readme.md")).toHaveAttribute("tabindex", "0");
      expect(item("docs")).toHaveAttribute("tabindex", "-1");
    });

    it("selectBranches: activating a branch selects it too", async () => {
      const user = userEvent.setup();
      const { onSelect } = renderTree({ selectBranches: true });
      expect(item("docs")).toHaveAttribute("aria-selected", "false");
      act(() => item("docs").focus());
      await user.keyboard("{Enter}");
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: "docs" }));
      expect(item("docs")).toHaveAttribute("aria-expanded", "true");
    });

    it("ignores keys from outside the tree", async () => {
      const user = userEvent.setup();
      render(
        <>
          <input aria-label="Filter" />
          <TreeView aria-label="Files" nodes={TREE} {...accessors} />
        </>,
      );
      act(() => screen.getByRole("textbox").focus());
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("textbox")).toHaveFocus();
    });
  });

  describe("TreeView filtering and control", () => {
    it("auto-expands ancestors of matches; a branch can still be collapsed while filtering", async () => {
      const user = userEvent.setup();
      renderTree({ filter: "logo" });
      expect(names()).toEqual(["docs", "docs/img", "docs/img/logo.png"]);
      expect(item("docs")).toHaveAttribute("aria-expanded", "true");
      await user.click(screen.getByText("img"));
      expect(item("img")).toHaveAttribute("aria-expanded", "false");
      expect(names()).toEqual(["docs", "docs/img"]);
    });

    it("accepts a predicate (e.g. matching the path, like the sources tree)", () => {
      renderTree({ filter: (n: Node) => n.path.includes("guide") });
      expect(names()).toEqual(["docs", "docs/guide.md"]);
    });

    it("restores the user's own expansion when the filter clears", () => {
      const { rerender } = render(<TreeView aria-label="Files" nodes={TREE} {...accessors} filter="logo" />);
      expect(names()).toContain("docs/img/logo.png");
      rerender(<TreeView aria-label="Files" nodes={TREE} {...accessors} filter="" />);
      expect(names()).toEqual(["docs", "empty", "readme.md"]);
    });

    it("controlled expanded: reports changes and renders what it is given", async () => {
      const user = userEvent.setup();
      const onExpandedChange = mock();
      function Controlled() {
        const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(["docs"]));
        return (
          <TreeView
            aria-label="Files"
            nodes={TREE}
            {...accessors}
            expanded={expanded}
            onExpandedChange={(next) => {
              onExpandedChange(next);
              setExpanded(next);
            }}
          />
        );
      }
      render(<Controlled />);
      expect(item("docs")).toHaveAttribute("aria-expanded", "true");
      act(() => item("img").focus());
      await user.keyboard("{ArrowRight}");
      expect([...(onExpandedChange.mock.calls[0]![0] as Set<string>)].sort()).toEqual(["docs", "docs/img"]);
      expect(item("logo.png")).toBeInTheDocument();
    });
  });
});
