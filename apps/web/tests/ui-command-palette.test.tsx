// apps/web/tests/ui-command-palette.test.tsx — the `@/ui` CommandPalette pattern and its index adapter.
import { expect, it, mock } from "bun:test";
import { useState } from "react";

import { Button, CommandPalette, commandGroupsFromIndex, type CommandPaletteGroup } from "@/ui";

import type { PaletteEntry } from "../src/client/shell/command-index.js";
import { describeUi, render, screen, userEvent, waitFor } from "./rtl.js";

function groups(onSelect: (id: string) => void = () => {}): CommandPaletteGroup[] {
  return [
    {
      heading: "Views",
      items: [
        { id: "view:overview", label: "Overview", icon: "layout-grid", onSelect: () => onSelect("view:overview") },
        { id: "view:alerts", label: "Alerts", icon: "bell", onSelect: () => onSelect("view:alerts") },
      ],
    },
    {
      heading: "Hosts",
      items: [
        { id: "host:web-01", label: "web-01", hint: "Critical", onSelect: () => onSelect("host:web-01") },
        { id: "host:db-01", label: "db-01", keywords: ["postgres"], onSelect: () => onSelect("host:db-01") },
      ],
    },
  ];
}

/** A trigger button plus a controlled palette, as the shell will wire it. */
function Harness({ items }: { items: CommandPaletteGroup[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open palette</Button>
      <CommandPalette open={open} onOpenChange={setOpen} groups={items} title="Go to" emptyText="Nothing here" />
    </>
  );
}

const optionNames = () => screen.queryAllByRole("option").map((el) => el.textContent);

describeUi("@/ui CommandPalette", () => {
  it("opens as a dialog named by its title, with data-slot and grouped options", async () => {
    render(<Harness items={groups()} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open palette" }));
    const dialog = await screen.findByRole("dialog", { name: "Go to" });
    expect(dialog).toHaveAttribute("data-slot", "command-palette");
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(optionNames()).toEqual(["Overview", "Alerts", "web-01Critical", "db-01"]);
    expect(screen.getByRole("group", { name: "Hosts" })).toBeInTheDocument();
  });

  it("filters items on typed text, matching label, hint and keywords but not ids", async () => {
    render(<Harness items={groups()} />);
    await userEvent.click(screen.getByRole("button", { name: "Open palette" }));
    const input = await screen.findByRole("combobox");

    await userEvent.type(input, "web");
    await waitFor(() => expect(optionNames()).toEqual(["web-01Critical"]));

    await userEvent.clear(input);
    await userEvent.type(input, "postgres");
    await waitFor(() => expect(optionNames()).toEqual(["db-01"]));

    await userEvent.clear(input);
    await userEvent.type(input, "critical");
    await waitFor(() => expect(optionNames()).toEqual(["web-01Critical"]));

    await userEvent.clear(input);
    await userEvent.type(input, "host:");
    await waitFor(() => expect(optionNames()).toEqual([]));
  });

  it("ArrowDown + Enter runs the highlighted item's onSelect, then closes", async () => {
    const order: string[] = [];
    const onSelect = mock((id: string) => order.push(`select:${id}`));
    function Spy() {
      const [open, setOpen] = useState(true);
      return (
        <CommandPalette
          open={open}
          onOpenChange={(next) => {
            order.push(`open:${next}`);
            setOpen(next);
          }}
          groups={groups(onSelect)}
          title="Go to"
        />
      );
    }
    render(<Spy />);
    const input = await screen.findByRole("combobox");
    input.focus();

    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Alerts" })).toHaveAttribute("aria-selected", "true"),
    );
    await userEvent.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("view:alerts");
    expect(order).toEqual(["select:view:alerts", "open:false"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Escape closes the dialog and returns focus to the trigger", async () => {
    render(<Harness items={groups()} />);
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Go to" });

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows the empty text when nothing matches", async () => {
    render(<Harness items={groups()} />);
    await userEvent.click(screen.getByRole("button", { name: "Open palette" }));
    await userEvent.type(await screen.findByRole("combobox"), "zzzz");

    await waitFor(() => expect(screen.getByText("Nothing here")).toBeInTheDocument());
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

describeUi("commandGroupsFromIndex", () => {
  const index: PaletteEntry[] = [
    { kind: "view", id: "overview", label: "Overview", navPath: "/overview" },
    { kind: "alert", id: "fp1", label: "DiskFull", sublabel: "db-01", navPath: "/alerts/fp1" },
    { kind: "host", id: "web-01", label: "web-01", sublabel: "Critical", navPath: "/estate/host/web-01" },
    { kind: "service", id: "web-01/http", label: "http", sublabel: "web-01", navPath: "/estate/service/web-01/http" },
    { kind: "service", id: "web-02/http", label: "http", sublabel: "web-02", navPath: "/estate/service/web-02/http" },
    { kind: "view", id: "alerts", label: "Alerts", navPath: "/alerts" },
  ];

  it("maps index entries to kind groups in a fixed order, keeping entry order and unique ids", () => {
    const navigate = mock((_path: string) => {});
    const result = commandGroupsFromIndex(index, navigate);

    expect(result.map((g) => g.heading)).toEqual(["Views", "Hosts", "Services", "Alerts"]);
    expect(result.map((g) => g.items.map((i) => i.id))).toEqual([
      ["view:overview", "view:alerts"],
      ["host:web-01"],
      ["service:web-01/http", "service:web-02/http"],
      ["alert:fp1"],
    ]);
    const [views, hosts, services, alerts] = result;
    expect(views?.items[0]).toMatchObject({ label: "Overview", icon: "layout-grid" });
    expect(views?.items[0]).not.toHaveProperty("hint");
    expect(hosts?.items[0]).toMatchObject({ label: "web-01", hint: "Critical", icon: "server" });
    expect(services?.items[1]).toMatchObject({ label: "http", hint: "web-02", icon: "boxes" });
    expect(alerts?.items[0]).toMatchObject({ label: "DiskFull", hint: "db-01", icon: "bell" });

    services?.items[1]?.onSelect();
    expect(navigate).toHaveBeenCalledWith("/estate/service/web-02/http");
  });

  it("drops empty groups", () => {
    const viewsOnly = index.filter((e) => e.kind === "view");
    expect(commandGroupsFromIndex(viewsOnly, () => {}).map((g) => g.heading)).toEqual(["Views"]);
    expect(commandGroupsFromIndex([], () => {})).toEqual([]);
  });

  it("drives the palette: selecting an adapted entry navigates to its path", async () => {
    const navigate = mock((_path: string) => {});
    render(<CommandPalette open onOpenChange={() => {}} groups={commandGroupsFromIndex(index, navigate)} />);
    await userEvent.click(await screen.findByRole("option", { name: "DiskFull db-01" }));
    expect(navigate).toHaveBeenCalledWith("/alerts/fp1");
  });
});

describeUi("CommandPalette with caller-owned filtering", () => {
  const ranked: PaletteEntry[] = [
    { kind: "service", id: "web-01/api", label: "api", sublabel: "web-01", navPath: "/estate/service/web-01/api" },
    { kind: "host", id: "api-gw", label: "api-gw", sublabel: "OK", navPath: "/estate/host/api-gw" },
    { kind: "service", id: "web-02/api-v2", label: "api-v2", sublabel: "web-02", navPath: "/estate/service/web-02/api-v2" },
  ];

  it('groupOrder "entries" orders groups by their first entry, so the best match leads', () => {
    expect(commandGroupsFromIndex(ranked, () => {}, { groupOrder: "entries" }).map((g) => g.heading)).toEqual([
      "Services",
      "Hosts",
    ]);
    expect(commandGroupsFromIndex(ranked, () => {}).map((g) => g.heading)).toEqual(["Hosts", "Services"]);
  });

  it("shouldFilter={false} shows the given items in order and reports typed text through onSearchChange", async () => {
    const seen: string[] = [];
    function Controlled() {
      const [search, setSearch] = useState("");
      return (
        <CommandPalette
          open
          onOpenChange={() => {}}
          groups={commandGroupsFromIndex(ranked, () => {}, { groupOrder: "entries" })}
          search={search}
          onSearchChange={(next) => {
            seen.push(next);
            setSearch(next);
          }}
          shouldFilter={false}
        />
      );
    }
    render(<Controlled />);
    const input = await screen.findByRole("combobox");
    await userEvent.type(input, "zz");
    expect(input).toHaveValue("zz");
    expect(seen.at(-1)).toBe("zz");
    // Nothing matches "zz" by cmdk's filter, but the caller owns filtering: every item stays, in order.
    expect(optionNames()).toEqual(["apiweb-01", "api-v2web-02", "api-gwOK"]);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "api web-01" })).toHaveAttribute("aria-selected", "true"),
    );
  });
});
