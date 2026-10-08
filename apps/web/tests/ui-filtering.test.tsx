// apps/web/tests/ui-filtering.test.tsx — ported from deck's `ui-filtering` suite (vendored `@/ui`).
//
// Deck stubs ResizeObserver, `matches(":modal")`, scrollIntoView and pointer capture per file;
// here `describeUi` installs the same stubs (`installUiStubs` in ./rtl.js).
import { describe, expect, it, jest, mock } from "bun:test";
import { useState } from "react";

import {
  ActiveFilters,
  FacetFilter,
  FilterBar,
  ResultCount,
  SearchInput,
  SegmentedControl,
  applyFilters,
  countActiveCriteria,
  describeActiveFilters,
  emptyCriteria,
  facetCounts,
  hasActiveCriteria,
  removeActiveFilter,
  toggleValue,
  useFacetFilters,
  type FacetOption,
  type FilterAccessors,
  type FilterCriteria,
} from "@/ui";

import { restoreRealTimers } from "./dom.js";
import { act, describeUi, render, renderHook, screen, userEvent, within } from "./rtl.js";

interface Row {
  name: string;
  kind?: string;
  tags: string[];
  hidden?: boolean;
}

const ROWS: Row[] = [
  { name: "Atlas", kind: "server", tags: ["prod"] },
  { name: "borealis", kind: "vm", tags: ["prod", "lab"] },
  { name: "cirrus", kind: "vm", tags: [], hidden: true },
  { name: "dune", tags: ["lab"] },
];

type F = "kind" | "tag";
const ACCESSORS: FilterAccessors<Row, F> = {
  text: (row) => [row.name, row.kind],
  facets: { kind: (row) => row.kind, tag: (row) => row.tags },
};

function criteria(query: string, facets: Partial<Record<F, string[]>> = {}): FilterCriteria<F> {
  return {
    query,
    facets: { kind: new Set(facets.kind ?? []), tag: new Set(facets.tag ?? []) },
  };
}
const names = (rows: readonly Row[]) => rows.map((row) => row.name);

describe("applyFilters (pure)", () => {
  it("returns every row, in order, for empty criteria", () => {
    const result = applyFilters(ROWS, emptyCriteria<F>(["kind", "tag"]), ACCESSORS);
    expect(names(result.rows)).toEqual(["Atlas", "borealis", "cirrus", "dune"]);
    expect(result).toMatchObject({ total: 4, hidden: 0 });
  });

  it("matches the query case-insensitively as a trimmed substring of any text field", () => {
    expect(names(applyFilters(ROWS, criteria("  aTL "), ACCESSORS).rows)).toEqual(["Atlas"]);
    expect(names(applyFilters(ROWS, criteria("VM"), ACCESSORS).rows)).toEqual(["borealis", "cirrus"]);
    expect(applyFilters(ROWS, criteria("nope"), ACCESSORS)).toMatchObject({ total: 4, hidden: 4 });
  });

  it("ORs values within a facet and ANDs across facets and the query", () => {
    expect(names(applyFilters(ROWS, criteria("", { kind: ["server", "vm"] }), ACCESSORS).rows)).toEqual([
      "Atlas",
      "borealis",
      "cirrus",
    ]);
    expect(names(applyFilters(ROWS, criteria("", { kind: ["vm"], tag: ["lab"] }), ACCESSORS).rows)).toEqual([
      "borealis",
    ]);
    expect(names(applyFilters(ROWS, criteria("bor", { tag: ["prod"] }), ACCESSORS).rows)).toEqual([
      "borealis",
    ]);
  });

  it("never matches a row without a value against a non-empty selection", () => {
    expect(names(applyFilters(ROWS, criteria("", { kind: ["server", "vm"] }), ACCESSORS).rows)).not.toContain(
      "dune",
    );
    expect(names(applyFilters(ROWS, criteria("", { tag: ["prod", "lab"] }), ACCESSORS).rows)).not.toContain(
      "cirrus",
    );
  });

  it("skips facets without an accessor and applies domain predicates (matchQuery, where)", () => {
    const accessors: FilterAccessors<Row, F> = {
      matchQuery: (row, q) => row.name.startsWith(q),
      where: (row) => row.hidden !== true,
    };
    const result = applyFilters(ROWS, criteria("", { kind: ["nothing"] }), accessors);
    expect(names(result.rows)).toEqual(["Atlas", "borealis", "dune"]);
    expect(names(applyFilters(ROWS, criteria("  D "), accessors).rows)).toEqual(["dune"]);
  });

  it("does not mutate its inputs", () => {
    const c = criteria("a", { tag: ["lab"] });
    const copy = [...ROWS];
    applyFilters(ROWS, c, ACCESSORS);
    expect(ROWS).toEqual(copy);
    expect([...c.facets.tag]).toEqual(["lab"]);
  });
});

describe("criteria helpers (pure)", () => {
  it("toggleValue copies the set", () => {
    const source = new Set(["a"]);
    expect([...toggleValue(source, "b")]).toEqual(["a", "b"]);
    expect([...toggleValue(source, "a")]).toEqual([]);
    expect([...source]).toEqual(["a"]);
  });

  it("hasActiveCriteria / countActiveCriteria ignore a blank query", () => {
    expect(hasActiveCriteria(criteria("   "))).toBe(false);
    expect(hasActiveCriteria(criteria("", { tag: ["x"] }))).toBe(true);
    expect(countActiveCriteria(criteria("q", { kind: ["a", "b"], tag: ["x"] }))).toBe(4);
  });

  it("facetCounts counts each item once per distinct value", () => {
    const counts = facetCounts(ROWS, (row) => [...row.tags, ...row.tags]);
    expect(Object.fromEntries(counts)).toEqual({ prod: 2, lab: 2 });
    expect(Object.fromEntries(facetCounts(ROWS, (row) => row.kind))).toEqual({ server: 1, vm: 2 });
  });

  it("describeActiveFilters lists the query then facet values; removeActiveFilter inverts one", () => {
    const c = criteria(" nginx ", { kind: ["vm"], tag: ["prod"] });
    const chips = describeActiveFilters(c, {
      facetLabels: { kind: "kind" },
      valueLabel: (facet, value) => (facet === "tag" ? value.toUpperCase() : value),
    });
    expect(chips.map((chip) => [chip.facet, chip.facetLabel, chip.label])).toEqual([
      [undefined, "search", "nginx"],
      ["kind", "kind", "vm"],
      ["tag", "tag", "PROD"],
    ]);
    expect(removeActiveFilter(c, chips[0]!).query).toBe("");
    expect([...removeActiveFilter(c, chips[2]!).facets.tag]).toEqual([]);
    expect([...c.facets.tag]).toEqual(["prod"]);
  });
});

describeUi("@/ui filtering", () => {
  describe("useFacetFilters", () => {
    it("toggles, clears and applies uncontrolled state", () => {
      const { result } = renderHook(() =>
        useFacetFilters<F>({ facets: ["kind", "tag"], initialFacets: { tag: ["lab"] } }),
      );
      expect(result.current.isActive).toBe(true);
      expect(names(result.current.apply(ROWS, ACCESSORS).rows)).toEqual(["borealis", "dune"]);

      act(() => result.current.toggle("kind", "vm"));
      expect(result.current.isSelected("kind", "vm")).toBe(true);
      expect(names(result.current.apply(ROWS, ACCESSORS).rows)).toEqual(["borealis"]);
      expect(result.current.activeCount).toBe(2);

      act(() => result.current.clear("tag"));
      expect(result.current.selected("tag").size).toBe(0);

      act(() => result.current.setQuery("cir"));
      expect(names(result.current.apply(ROWS, ACCESSORS).rows)).toEqual(["cirrus"]);

      act(() => result.current.remove({ value: "cir" }) /* deck: `facet: undefined` (exactOptionalPropertyTypes) */);
      expect(result.current.query).toBe("");

      act(() => result.current.clearAll());
      expect(result.current.isActive).toBe(false);
      expect(result.current.activeCount).toBe(0);
    });

    it("reports changes without owning state when controlled", () => {
      const onCriteriaChange = mock();
      const fixed = criteria("", { kind: ["vm"] });
      const { result } = renderHook(() =>
        useFacetFilters<F>({ facets: ["kind", "tag"], criteria: fixed, onCriteriaChange }),
      );
      act(() => result.current.toggle("kind", "server"));
      expect([...onCriteriaChange.mock.calls[0]![0].facets.kind]).toEqual(["vm", "server"]);
      expect([...result.current.selected("kind")]).toEqual(["vm"]);
    });
  });

  describe("<SearchInput>", () => {
    it("is a labelled searchbox with a clear button and Escape-to-clear", async () => {
      const user = userEvent.setup();
      const onValueChange = mock();
      render(<SearchInput label="Search hosts" placeholder="Search…" onValueChange={onValueChange} />);

      const box = screen.getByRole("searchbox", { name: "Search hosts" });
      expect(box.closest("[data-slot]")).toHaveAttribute("data-slot", "search-input");
      expect(screen.queryByRole("button", { name: "Clear Search hosts" })).toBeNull();

      await user.type(box, "db");
      expect(onValueChange).toHaveBeenLastCalledWith("db");

      await user.click(screen.getByRole("button", { name: "Clear Search hosts" }));
      expect(box).toHaveValue("");
      expect(box).toHaveFocus();
      expect(onValueChange).toHaveBeenLastCalledWith("");

      await user.type(box, "x{Escape}");
      expect(box).toHaveValue("");
      expect(onValueChange).toHaveBeenLastCalledWith("");
    });

    it("debounces onValueChange", () => {
      jest.useFakeTimers();
      try {
        const onValueChange = mock();
        render(<SearchInput label="Search" debounceMs={200} onValueChange={onValueChange} />);
        const box = screen.getByRole("searchbox", { name: "Search" });
        act(() => {
          box.focus();
        });
        // fireEvent-style change through React's onChange.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        act(() => {
          setter.call(box, "ng");
          box.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(box).toHaveValue("ng");
        expect(onValueChange).not.toHaveBeenCalled();
        act(() => {
          jest.advanceTimersByTime(200);
        });
        expect(onValueChange).toHaveBeenCalledTimes(1);
        expect(onValueChange).toHaveBeenCalledWith("ng");
      } finally {
        restoreRealTimers();
      }
    });

    it("focuses on '/' outside editable elements when the shortcut is enabled", async () => {
      const user = userEvent.setup();
      render(
        <>
          <input aria-label="Other" />
          <SearchInput label="Search" shortcut />
        </>,
      );
      const box = screen.getByRole("searchbox", { name: "Search" });
      expect(box).toHaveAttribute("aria-keyshortcuts", "/");
      await user.keyboard("/");
      expect(box).toHaveFocus();

      const other = screen.getByRole("textbox", { name: "Other" });
      await user.click(other);
      await user.keyboard("/");
      expect(other).toHaveFocus();
      expect(other).toHaveValue("/");
    });

    it("follows a controlled value", () => {
      const { rerender } = render(<SearchInput label="Search" value="a" onValueChange={() => {}} />);
      rerender(<SearchInput label="Search" value="" onValueChange={() => {}} />);
      expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    });
  });

  const STATES: FacetOption[] = [
    { value: "fresh", label: "Fresh", count: 3 },
    { value: "stale", label: "Stale", count: 1 },
    { value: "partial", label: "Partial", count: 0 },
    { value: "unreachable", label: "Unreachable", count: 2 },
    { value: "never", label: "Never collected", count: 1 },
  ];

  function Facet(props: { options: FacetOption[]; variant?: "popover" | "inline"; initial?: string[] }) {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(props.initial ?? []));
    return (
      <FacetFilter
        title="State"
        options={props.options}
        {...(props.variant === undefined ? {} : { variant: props.variant })}
        selected={selected}
        onSelectedChange={setSelected}
      />
    );
  }

  describe("<FacetFilter>", () => {
    it("popover: trigger names the facet and selected count; options are checkable", async () => {
      const user = userEvent.setup();
      render(<Facet options={STATES} initial={["stale"]} />);

      const trigger = screen.getByRole("button", { name: /State/ });
      expect(trigger).toHaveAttribute("data-slot", "facet-filter");
      expect(trigger).toHaveAccessibleName("State 1 selected");
      expect(trigger).toHaveAttribute("aria-expanded", "false");

      await user.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      const list = screen.getByRole("listbox", { name: "State" });
      // aria-selected is cmdk's cursor, so multiselectable would misreport the choices.
      expect(list).not.toHaveAttribute("aria-multiselectable");
      expect(list.closest("[data-slot]")).not.toBeNull();

      const fresh = within(list).getByRole("option", { name: /Fresh/ });
      expect(fresh).toHaveTextContent("3");
      expect(fresh).toHaveAttribute("aria-checked", "false");
      expect(within(list).getByRole("option", { name: /Stale/ })).toHaveAttribute("aria-checked", "true");

      await user.click(fresh);
      expect(within(list).getByRole("option", { name: /Fresh/ })).toHaveAttribute("aria-checked", "true");
      expect(trigger).toHaveAccessibleName("State 2 selected");

      await user.click(within(list).getByRole("option", { name: "Clear State filter" }));
      expect(trigger).toHaveAccessibleName("State");
    });

    it("popover: supports keyboard selection and typeahead search when searchable", async () => {
      const user = userEvent.setup();
      render(
        <FacetFilter
          title="Tag"
          searchable
          options={STATES}
          selected={new Set()}
          onSelectedChange={mock()}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Tag" }));
      const search = screen.getByRole("combobox", { name: "Filter Tag options" });
      await user.type(search, "unre");
      const list = screen.getByRole("listbox", { name: "Tag" });
      expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Unreachable2"]);
    });

    it("popover: Enter toggles the highlighted option", async () => {
      const user = userEvent.setup();
      const onSelectedChange = mock();
      render(
        <FacetFilter
          title="State"
          variant="popover"
          options={STATES}
          selected={new Set()}
          onSelectedChange={onSelectedChange}
        />,
      );
      await user.click(screen.getByRole("button", { name: "State" }));
      expect(screen.getByRole("listbox", { name: "State" })).toHaveFocus();
      await user.keyboard("{ArrowDown}{Enter}");
      expect(onSelectedChange).toHaveBeenCalledTimes(1);
      expect(onSelectedChange.mock.calls[0]![0].size).toBe(1);
    });

    it("inline (auto for ≤ 4 options): a labelled toolbar of aria-pressed toggles", async () => {
      const user = userEvent.setup();
      render(<Facet options={STATES.slice(0, 3)} initial={["fresh"]} />);

      const group = screen.getByRole("toolbar", { name: "State" });
      expect(group.closest('[data-slot="facet-filter"]')).not.toBeNull();
      const fresh = within(group).getByRole("button", { name: "Fresh 3" });
      const stale = within(group).getByRole("button", { name: "Stale 1" });
      expect(fresh).toHaveAttribute("aria-pressed", "true");
      expect(stale).toHaveAttribute("aria-pressed", "false");

      await user.click(stale);
      expect(stale).toHaveAttribute("aria-pressed", "true");
      await user.click(fresh);
      expect(fresh).toHaveAttribute("aria-pressed", "false");
    });
  });

  describe("<ActiveFilters>", () => {
    it("renders removable chips named 'Remove {facet} filter {value}' and Clear all", async () => {
      const user = userEvent.setup();
      const onRemove = mock();
      const onClearAll = mock();
      const filters = describeActiveFilters(criteria("db", { kind: ["vm"] }));
      render(<ActiveFilters filters={filters} onRemove={onRemove} onClearAll={onClearAll} />);

      const group = screen.getByRole("group", { name: "Active filters" });
      expect(group).toHaveAttribute("data-slot", "active-filters");
      await user.click(within(group).getByRole("button", { name: "Remove kind filter vm" }));
      expect(onRemove).toHaveBeenCalledWith(filters[1]);
      expect(within(group).getByRole("button", { name: "Remove search filter db" })).toBeTruthy();
      await user.click(within(group).getByRole("button", { name: "Clear all" }));
      expect(onClearAll).toHaveBeenCalledTimes(1);
    });

    it("renders nothing when no filter is active", () => {
      const { container } = render(<ActiveFilters filters={[]} onRemove={mock()} />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe("<ResultCount>", () => {
    it("is a polite status line with shown, total and hidden counts", () => {
      render(<ResultCount shown={3} total={10} noun="hosts" />);
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).toHaveAttribute("data-slot", "result-count");
      expect(status).toHaveTextContent("Showing 3 of 10 hosts; 7 hidden by filters.");
    });
  });

  describe("<FilterBar>", () => {
    it("is a named search landmark holding its slots", () => {
      render(
        <FilterBar
          label="Host filters"
          search={<SearchInput label="Search hosts" />}
          resultCount={<ResultCount shown={1} total={1} />}
        >
          <FacetFilter title="Kind" options={STATES.slice(0, 2)} selected={new Set()} onSelectedChange={mock()} />
        </FilterBar>,
      );
      const bar = screen.getByRole("search", { name: "Host filters" });
      expect(bar).toHaveAttribute("data-slot", "filter-bar");
      expect(within(bar).getByRole("searchbox", { name: "Search hosts" })).toBeTruthy();
      expect(within(bar).getByRole("toolbar", { name: "Kind" })).toBeTruthy();
      expect(within(bar).getByRole("status")).toHaveTextContent("Showing 1 of 1");
    });
  });

  describe("<SegmentedControl>", () => {
    function Demo({ onChange }: { onChange: (value: string) => void }) {
      const [value, setValue] = useState("a");
      return (
        <SegmentedControl
          label="Source"
          value={value}
          onValueChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
            { value: "c", label: "Gamma", disabled: true },
          ]}
        />
      );
    }

    it("is a named radiogroup with one checked radio that cannot be deselected", async () => {
      const user = userEvent.setup();
      const onChange = mock();
      render(<Demo onChange={onChange} />);

      const group = screen.getByRole("radiogroup", { name: "Source" });
      expect(group).toHaveAttribute("data-slot", "segmented-control");
      const alpha = within(group).getByRole("radio", { name: "Alpha" });
      const beta = within(group).getByRole("radio", { name: "Beta" });
      expect(alpha).toHaveAttribute("aria-checked", "true");
      expect(within(group).getByRole("radio", { name: "Gamma" })).toBeDisabled();

      await user.click(alpha);
      expect(onChange).not.toHaveBeenCalled();
      expect(alpha).toHaveAttribute("aria-checked", "true");

      await user.click(beta);
      expect(onChange).toHaveBeenCalledWith("b");
      expect(beta).toHaveAttribute("aria-checked", "true");
      expect(alpha).toHaveAttribute("aria-checked", "false");
    });

    it("puts keyShortcuts on every focusable radio, not on the group", async () => {
      const user = userEvent.setup();
      render(
        <SegmentedControl
          label="Time range"
          value="6h"
          keyShortcuts="[ ]"
          onValueChange={() => {}}
          options={[
            { value: "1h", label: "1h" },
            { value: "6h", label: "6h" },
          ]}
        />,
      );
      const group = screen.getByRole("radiogroup", { name: "Time range" });
      expect(group).not.toHaveAttribute("aria-keyshortcuts");
      for (const radio of within(group).getAllByRole("radio")) expect(radio).toHaveAttribute("aria-keyshortcuts", "[ ]");
      // The Tab stop (the checked radio) is the control that announces it.
      await user.tab();
      expect(within(group).getByRole("radio", { name: "6h" })).toHaveFocus();
      expect(document.activeElement).toHaveAttribute("aria-keyshortcuts", "[ ]");
    });

    it("sets no aria-keyshortcuts without keyShortcuts", () => {
      render(<Demo onChange={() => {}} />);
      for (const radio of screen.getAllByRole("radio")) expect(radio).not.toHaveAttribute("aria-keyshortcuts");
    });

    it("moves focus between options with the arrow keys", async () => {
      const user = userEvent.setup();
      render(<Demo onChange={mock()} />);
      await user.tab();
      expect(screen.getByRole("radio", { name: "Alpha" })).toHaveFocus();
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("radio", { name: "Beta" })).toHaveFocus();
    });
  });
});
