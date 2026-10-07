// apps/web/tests/ui-collections.test.tsx — ported from deck's `ui-collections` suite (vendored `@/ui`).
import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";

import {
  CardGrid,
  DataTable,
  LinkTile,
  List,
  ListGroup,
  ListItem,
  ROW_LINK_SELECTOR,
  columnsFromOffsets,
  type ColumnDef,
} from "@/ui";

import { act, describeUi, render, screen, userEvent, within } from "./rtl.js";

// Deck's "workbench §E section" case is dropped: pulse does not vendor deck's `_ui` workbench.

describeUi("@/ui collections", () => {
  // ---------------------------------------------------------------------------
  // DataTable
  // ---------------------------------------------------------------------------

  interface Host {
    key: string;
    name: string;
    kind: string;
    declared: number;
    observed: number;
  }

  const HOSTS: Host[] = [
    { key: "nas-01", name: "nas-01", kind: "Bare metal", declared: 6, observed: 6 },
    { key: "pve-02", name: "pve-02", kind: "Hypervisor", declared: 12, observed: 10 },
  ];

  const GROUPED: ColumnDef<Host>[] = [
    { accessorKey: "name", header: "Host" },
    {
      id: "intent",
      header: "Declared intent",
      columns: [
        { accessorKey: "kind", header: "Kind" },
        { accessorKey: "declared", header: "Declared services", meta: { align: "end" } },
      ],
    },
    { id: "reality", header: "Observed reality", columns: [{ accessorKey: "observed", header: "Observed services" }] },
  ];

  const FLAT: ColumnDef<Host>[] = [
    { accessorKey: "name", header: "Host" },
    { accessorKey: "kind", header: "Kind" },
  ];

  describe("DataTable", () => {
    it("renders the caption and a focusable scroll region named by it", () => {
      render(<DataTable caption="Hosts" columns={FLAT} data={HOSTS} getRowId={(r) => r.key} />);
      const table = screen.getByRole("table", { name: "Hosts" });
      const region = screen.getByRole("region", { name: "Hosts" });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(region).toHaveAttribute("data-slot", "data-table");
      expect(region).toContainElement(table);
      expect(table.className).toContain("tabular-nums");
    });

    it("keeps a hidden caption for assistive tech", () => {
      render(<DataTable caption="Hosts" captionHidden columns={FLAT} data={HOSTS} getRowId={(r) => r.key} />);
      expect(screen.getByRole("table", { name: "Hosts" }).querySelector("caption")).toHaveClass("sr-only");
    });

    it("renders column groups as a two-row header with scope=colgroup and spans", () => {
      render(<DataTable caption="Hosts" columns={GROUPED} data={HOSTS} getRowId={(r) => r.key} />);
      const table = screen.getByRole("table");
      const headerRows = table.querySelectorAll("thead tr");
      expect(headerRows).toHaveLength(2);

      const declared = screen.getByRole("columnheader", { name: "Declared intent" });
      expect(declared).toHaveAttribute("scope", "colgroup");
      expect(declared).toHaveAttribute("colspan", "2");
      expect(screen.getByRole("columnheader", { name: "Observed reality" })).toHaveAttribute("scope", "colgroup");

      // The ungrouped leaf renders once, spanning both header rows.
      const host = screen.getAllByRole("columnheader", { name: "Host" });
      expect(host).toHaveLength(1);
      expect(host[0]).toHaveAttribute("scope", "col");
      expect(host[0]).toHaveAttribute("rowspan", "2");
      expect(headerRows[1]!.querySelectorAll("th")).toHaveLength(3);
      for (const th of headerRows[1]!.querySelectorAll("th")) expect(th).toHaveAttribute("scope", "col");

      // One <colgroup> per top-level column, spanning its leaves.
      expect([...table.querySelectorAll("colgroup")].map((c) => c.getAttribute("span"))).toEqual(["1", "2", "1"]);
    });

    it("makes the first cell a row header and, with rowLink, a link carrying data-row-link", () => {
      render(
        <DataTable caption="Hosts" columns={FLAT} data={HOSTS} getRowId={(r) => r.key} rowLink={(r) => `/hosts/${r.key}`} />,
      );
      const rowHeaders = screen.getAllByRole("rowheader");
      expect(rowHeaders).toHaveLength(2);
      expect(rowHeaders[0]).toHaveAttribute("scope", "row");
      const link = within(rowHeaders[0]!).getByRole("link", { name: "nas-01" });
      expect(link).toHaveAttribute("href", "/hosts/nas-01");
      expect(link).toHaveAttribute("data-row-link", "nas-01");
      expect(screen.getByRole("table").querySelectorAll(ROW_LINK_SELECTOR)).toHaveLength(2);
    });

    it("renders row links through linkAs", () => {
      const RouterLink = ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) => (
        <a href={`#${href}`} className={className} data-router="">
          {children}
        </a>
      );
      render(
        <DataTable caption="Hosts" columns={FLAT} data={HOSTS} getRowId={(r) => r.key} rowLink={(r) => r.key} linkAs={RouterLink} />,
      );
      const link = screen.getByRole("link", { name: "pve-02" });
      expect(link).toHaveAttribute("data-router");
      expect(link).toHaveAttribute("href", "#pve-02");
    });

    it("can opt out of row headers", () => {
      render(<DataTable caption="Hosts" columns={FLAT} data={HOSTS} getRowId={(r) => r.key} rowHeader={false} />);
      expect(screen.queryAllByRole("rowheader")).toHaveLength(0);
    });

    it("gives rows a focusable id for focus targeting", () => {
      render(<DataTable caption="Hosts" columns={FLAT} data={HOSTS} getRowId={(r) => r.key} rowDomId={(r) => `host-${r.key}`} />);
      const row = document.getElementById("host-pve-02");
      expect(row?.tagName).toBe("TR");
      expect(row).toHaveAttribute("tabindex", "-1");
    });

    it("shows a compact status row spanning every column when empty", () => {
      render(
        <DataTable
          caption="Hosts"
          columns={GROUPED}
          data={[]}
          getRowId={(r) => r.key}
          empty={{ title: "No hosts declared", description: "Add hosts to the estate." }}
        />,
      );
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent("No hosts declared");
      expect(status.closest("td")).toHaveAttribute("colspan", "4");
    });

    it("accepts a plain title for the empty row, with a default", () => {
      const { rerender } = render(<DataTable caption="Hosts" columns={FLAT} data={[]} getRowId={(r) => r.key} empty="Nothing here" />);
      expect(screen.getByRole("status")).toHaveTextContent("Nothing here");
      rerender(<DataTable caption="Hosts" columns={FLAT} data={[]} getRowId={(r) => r.key} />);
      expect(screen.getByRole("status")).toHaveTextContent("No rows to show");
    });

    it("marks its density", () => {
      render(<DataTable caption="Hosts" columns={FLAT} data={HOSTS} getRowId={(r) => r.key} density="comfortable" />);
      expect(screen.getByRole("region")).toHaveAttribute("data-density", "comfortable");
    });
  });

  // ---------------------------------------------------------------------------
  // List / ListItem / ListGroup
  // ---------------------------------------------------------------------------

  describe("List", () => {
    it("renders a ul (or ol) with list semantics and variant", () => {
      const { rerender } = render(
        <List aria-label="Rows">
          <ListItem title="One" />
        </List>,
      );
      const list = screen.getByRole("list", { name: "Rows" });
      expect(list.tagName).toBe("UL");
      expect(list).toHaveAttribute("data-variant", "plain");
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
      rerender(
        <List as="ol" variant="card" aria-label="Rows">
          <ListItem title="One" />
        </List>,
      );
      expect(screen.getByRole("list").tagName).toBe("OL");
      expect(screen.getByRole("list")).toHaveAttribute("data-variant", "card");
    });

    it("renders the item slots", () => {
      render(
        <List>
          <ListItem leading={<span>L</span>} title="Title" description="Desc" meta={<span>5 min</span>} actions={<button type="button">Act</button>} />
        </List>,
      );
      const item = screen.getByRole("listitem");
      expect(item).toHaveTextContent("LTitleDesc5 minAct");
      expect(item).toHaveAttribute("data-slot", "list-item");
    });

    it("href: one whole-row link, described by the description, actions stay separate", () => {
      render(
        <List>
          <ListItem href="/a" title="Alert A" description="Disk full" actions={<button type="button">Silence</button>} />
        </List>,
      );
      const link = screen.getByRole("link", { name: "Alert A" });
      expect(link).toHaveAttribute("href", "/a");
      expect(link).toHaveAccessibleDescription("Disk full");
      const action = screen.getByRole("button", { name: "Silence" });
      expect(link).not.toContainElement(action);
    });

    it("selected: aria-current on the link or button, else the row", () => {
      render(
        <List>
          <ListItem href="/a" title="A" selected current="page" />
          <ListItem onSelect={() => {}} title="B" selected />
          <ListItem title="C" selected />
          <ListItem href="/d" title="D" />
        </List>,
      );
      expect(screen.getByRole("link", { name: "A" })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("button", { name: "B" })).toHaveAttribute("aria-current", "true");
      expect(screen.getByText("C").closest("li")).toHaveAttribute("aria-current", "true");
      expect(screen.getByRole("link", { name: "D" })).not.toHaveAttribute("aria-current");
    });

    it("onSelect: a whole-row button", async () => {
      const onSelect = mock();
      render(
        <List>
          <ListItem onSelect={onSelect} title="Pick me" />
        </List>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Pick me" }));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("passes id and tabIndex through for programmatic focus", () => {
      render(
        <List>
          <ListItem id="finding-1" tabIndex={-1} title="Finding" />
        </List>,
      );
      const li = document.getElementById("finding-1");
      expect(li?.tagName).toBe("LI");
      expect(li).toHaveAttribute("tabindex", "-1");
    });
  });

  describe("ListGroup", () => {
    it("is a section named by its heading, at the requested level, with a count", () => {
      render(
        <ListGroup heading="Critical" level={3} count={2}>
          <List>
            <ListItem title="x" />
          </List>
        </ListGroup>,
      );
      const heading = screen.getByRole("heading", { level: 3 });
      expect(heading).toHaveTextContent("Critical2");
      const region = screen.getByRole("region");
      expect(region).toHaveAttribute("aria-labelledby", heading.id);
    });
  });

  // ---------------------------------------------------------------------------
  // LinkTile / CardGrid
  // ---------------------------------------------------------------------------

  describe("LinkTile", () => {
    it("is one link wrapping everything, with nothing interactive nested", () => {
      render(<LinkTile href="/svc" icon="link" title="Jellyfin" description="Media" status={<span>Up</span>} meta={<span>2 min</span>} />);
      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "/svc");
      expect(link).toHaveAttribute("data-slot", "link-tile");
      expect(link).toHaveTextContent("JellyfinMediaUp2 min");
      // Named by the title alone; the rest describes it.
      expect(link).toHaveAccessibleName("Jellyfin");
      expect(link).toHaveAccessibleDescription("Media Up 2 min");
      expect(link.querySelectorAll("a, button, input, [tabindex]")).toHaveLength(0);
      expect(link).not.toHaveAttribute("target");
    });

    it("external: new tab, safe rel, and an sr-only note", () => {
      render(<LinkTile href="https://example.com" external title="Docs" />);
      const link = screen.getByRole("link", { name: "Docs (opens in new tab)" });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("uses linkAs for internal links", () => {
      const RouterLink = ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) => (
        <a href={`#${href}`} className={className} data-router="">
          {children}
        </a>
      );
      render(<LinkTile href="/svc" title="Svc" linkAs={RouterLink} />);
      expect(screen.getByRole("link")).toHaveAttribute("data-router");
    });

    it("disabled: an article, not focusable, no aria-disabled, with its reason", () => {
      render(<LinkTile href="/svc" disabled disabledReason="No URL declared" title="Photos" />);
      expect(screen.queryByRole("link")).toBeNull();
      const article = screen.getByRole("article");
      expect(article).not.toHaveAttribute("aria-disabled");
      expect(article).not.toHaveAttribute("tabindex");
      expect(article).toHaveTextContent("No URL declared");
    });
  });

  describe("CardGrid", () => {
    it("wraps each card in a list item, named by its heading", () => {
      render(
        <CardGrid heading="Media" count={2}>
          <LinkTile href="/a" title="A" />
          <LinkTile href="/b" title="B" />
        </CardGrid>,
      );
      const heading = screen.getByRole("heading", { level: 2 });
      expect(screen.getByRole("region", { name: "Media 2" })).toHaveAttribute("data-slot", "card-grid");
      const list = screen.getByRole("list");
      expect(list).toHaveAttribute("aria-labelledby", heading.id);
      expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    });

    it("keeps a keyed card's element (and its focus) when the order changes", () => {
      const cards = (order: string[]) => (
        <CardGrid aria-label="Cards">
          {order.map((id) => (
            <LinkTile key={id} href={`/${id}`} title={id.toUpperCase()} />
          ))}
        </CardGrid>
      );
      const { rerender } = render(cards(["a", "b"]));
      const b = screen.getByRole("link", { name: "B" });
      b.focus();
      rerender(cards(["b", "a"]));
      expect(screen.getByRole("link", { name: "B" })).toBe(b);
      expect(b).toHaveFocus();
    });

    it("uses aria-label without a heading", () => {
      render(
        <CardGrid aria-label="Integrations">
          <LinkTile href="/a" title="A" />
        </CardGrid>,
      );
      expect(screen.getByRole("list", { name: "Integrations" })).toBeInTheDocument();
    });

    it("navigable: arrow keys move between cards (one row in jsdom: ←/→ step, End jumps)", async () => {
      const user = userEvent.setup();
      render(
        <CardGrid aria-label="Cards" navigable>
          <LinkTile href="/a" title="A" />
          <LinkTile href="/b" title="B" />
          <LinkTile href="/c" title="C" />
        </CardGrid>,
      );
      act(() => screen.getByRole("link", { name: "A" }).focus());
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("link", { name: "B" })).toHaveFocus();
      await user.keyboard("{End}");
      expect(screen.getByRole("link", { name: "C" })).toHaveFocus();
      await user.keyboard("{ArrowLeft}");
      expect(screen.getByRole("link", { name: "B" })).toHaveFocus();
    });
  });
});

describe("columnsFromOffsets", () => {
  it("counts the items sharing the first row", () => {
    expect(columnsFromOffsets([])).toBe(1);
    expect(columnsFromOffsets([0])).toBe(1);
    expect(columnsFromOffsets([0, 0, 0, 120, 120])).toBe(3);
    expect(columnsFromOffsets([10, 10.4, 200])).toBe(2);
    expect(columnsFromOffsets([0, 100, 200])).toBe(1);
  });
});
