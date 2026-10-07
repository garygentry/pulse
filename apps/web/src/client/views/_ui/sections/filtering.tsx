import { useState, type ComponentProps } from "react";
import {
  ActiveFilters,
  FacetFilter,
  FilterBar,
  ResultCount,
  SearchInput,
  SegmentedControl,
  describeActiveFilters,
  facetCounts,
  useFacetFilters,
  type FacetOption,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

interface DemoHost {
  name: string;
  kind: string;
  state: string;
  tags: readonly string[];
}

const HOSTS: readonly DemoHost[] = [
  { name: "atlas", kind: "server", state: "fresh", tags: ["prod", "storage"] },
  { name: "borealis", kind: "server", state: "stale", tags: ["prod"] },
  { name: "cirrus", kind: "vm", state: "fresh", tags: ["lab"] },
  { name: "dune", kind: "vm", state: "unreachable", tags: ["lab", "gpu"] },
  { name: "ember", kind: "container", state: "partial", tags: ["prod"] },
  { name: "fjord", kind: "container", state: "fresh", tags: [] },
  { name: "gale", kind: "appliance", state: "never-collected", tags: ["network"] },
];

const STATE_LABELS: Record<string, string> = {
  fresh: "Fresh",
  stale: "Stale",
  partial: "Partial",
  unreachable: "Unreachable",
  "never-collected": "Never collected",
};

const TAGS = ["prod", "lab", "storage", "gpu", "network", "backup", "edge", "media", "dns"];

function options(
  values: readonly string[],
  counts: Map<string, number>,
  label: (value: string) => string = (value) => value,
): FacetOption[] {
  return values.map((value) => ({ value, label: label(value), count: counts.get(value) ?? 0 }));
}

const KIND_OPTIONS = options(
  ["server", "vm", "container", "appliance"],
  facetCounts(HOSTS, (host) => host.kind),
);
const STATE_OPTIONS = options(
  Object.keys(STATE_LABELS),
  facetCounts(HOSTS, (host) => host.state),
  (value) => STATE_LABELS[value] ?? value,
);
const TAG_OPTIONS = options(TAGS, facetCounts(HOSTS, (host) => host.tags));

type Facet = "kind" | "state" | "tag";

/** A fully wired bar: `useFacetFilters` + every §F component over demo rows. */
function WiredFilterBar({
  initialQuery,
  initialFacets,
}: {
  initialQuery?: string;
  initialFacets?: Partial<Record<Facet, string[]>>;
}) {
  const filters = useFacetFilters<Facet>({
    facets: ["kind", "state", "tag"],
    ...(initialQuery !== undefined ? { initialQuery } : {}),
    ...(initialFacets !== undefined ? { initialFacets } : {}),
  });
  const result = filters.apply(HOSTS, {
    text: (host) => [host.name, host.kind],
    facets: { kind: (host) => host.kind, state: (host) => host.state, tag: (host) => host.tags },
  });
  const chips = describeActiveFilters(filters.criteria, {
    facetLabels: { kind: "kind", state: "state", tag: "tag" },
    valueLabel: (facet, value) => (facet === "state" ? (STATE_LABELS[value] ?? value) : value),
  });

  return (
    <div className="flex w-full flex-col gap-3">
      <FilterBar
        label="Host filters"
        search={
          <SearchInput
            label="Search hosts"
            placeholder="Search hosts…"
            value={filters.query}
            onValueChange={filters.setQuery}
          />
        }
        activeFilters={
          <ActiveFilters filters={chips} onRemove={filters.remove} onClearAll={filters.clearAll} />
        }
        resultCount={<ResultCount shown={result.rows.length} total={result.total} noun="hosts" />}
      >
        <FacetFilter
          title="Kind"
          options={KIND_OPTIONS}
          selected={filters.selected("kind")}
          onSelectedChange={(next) => filters.setFacet("kind", next)}
        />
        <FacetFilter
          title="State"
          options={STATE_OPTIONS}
          selected={filters.selected("state")}
          onSelectedChange={(next) => filters.setFacet("state", next)}
        />
        <FacetFilter
          title="Tag"
          options={TAG_OPTIONS}
          selected={filters.selected("tag")}
          onSelectedChange={(next) => filters.setFacet("tag", next)}
        />
      </FilterBar>
      <ul className="flex flex-wrap gap-2 text-sm">
        {result.rows.map((host) => (
          <li key={host.name} className="rounded-md border border-border px-2 py-0.5 font-mono">
            {host.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FacetDemo({
  initial = [],
  ...props
}: Omit<ComponentProps<typeof FacetFilter>, "selected" | "onSelectedChange"> & {
  initial?: string[];
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initial));
  return <FacetFilter {...props} selected={selected} onSelectedChange={setSelected} />;
}

function SegmentedDemo({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("homelab-docs");
  return (
    <SegmentedControl
      label="Source"
      value={value}
      onValueChange={setValue}
      options={[
        { value: "homelab-docs", label: "homelab-docs" },
        { value: "runbooks", label: "runbooks" },
        { value: "archive", label: "archive", icon: "archive", disabled },
      ]}
    />
  );
}

function Filtering() {
  return (
    <>
      <Specimen label="FilterBar: empty (no active filters)">
        <WiredFilterBar />
      </Specimen>
      <Specimen label="FilterBar: with active filters (query, kind, state)">
        <WiredFilterBar
          initialQuery="a"
          initialFacets={{ kind: ["server", "vm"], state: ["fresh"] }}
        />
      </Specimen>
      <Specimen label="FilterBar: no results">
        <WiredFilterBar initialQuery="zzz" />
      </Specimen>
      <Specimen label="SearchInput: sr-only label, placeholder, / shortcut hint">
        <SearchInput label="Search services" placeholder="Search services…" shortcut rootClassName="w-72" />
      </Specimen>
      <Specimen label="SearchInput: visible label, with value (clear button), debounced">
        <SearchInput label="Filter tree" showLabel defaultValue="nginx" debounceMs={200} rootClassName="w-72" />
      </Specimen>
      <Specimen label="SearchInput: disabled">
        <SearchInput label="Search drift findings" placeholder="Search…" disabled rootClassName="w-72" />
      </Specimen>
      <Specimen label="FacetFilter popover: none selected / some selected / searchable (> 7 options)">
        <FacetDemo title="State" options={STATE_OPTIONS} variant="popover" />
        <FacetDemo title="State" options={STATE_OPTIONS} variant="popover" initial={["fresh", "stale"]} />
        <FacetDemo title="Tag" options={TAG_OPTIONS} initial={["prod", "lab", "gpu"]} />
      </Specimen>
      <Specimen label="FacetFilter inline (≤ 4 options): none selected / some selected / no counts">
        <FacetDemo title="Kind" options={KIND_OPTIONS} />
        <FacetDemo title="Kind" options={KIND_OPTIONS} initial={["vm", "container"]} />
        <FacetDemo
          title="Severity"
          options={[
            { value: "error", label: "Error", icon: "octagon-alert" },
            { value: "warning", label: "Warning", icon: "triangle-alert" },
            { value: "info", label: "Info", icon: "info" },
          ]}
          initial={["error"]}
        />
      </Specimen>
      <Specimen label="ActiveFilters: chips + Clear all / chips only / empty (renders nothing)">
        <ActiveFilters
          filters={[
            { id: "query", facetLabel: "search", value: "nginx", label: "nginx" },
            { id: "state:stale", facet: "state", facetLabel: "state", value: "stale", label: "Stale" },
            { id: "tag:prod", facet: "tag", facetLabel: "tag", value: "prod", label: "prod" },
          ]}
          onRemove={() => {}}
          onClearAll={() => {}}
        />
        <ActiveFilters
          filters={[{ id: "kind:vm", facet: "kind", facetLabel: "kind", value: "vm", label: "vm" }]}
          onRemove={() => {}}
        />
        <ActiveFilters filters={[]} onRemove={() => {}} onClearAll={() => {}} />
      </Specimen>
      <Specimen label="ResultCount: unfiltered / filtered / all hidden / with noun">
        <ResultCount shown={42} total={42} />
        <ResultCount shown={7} total={42} />
        <ResultCount shown={0} total={42} />
        <ResultCount shown={3} total={12} noun="services" />
      </Specimen>
      <Specimen label="SegmentedControl: default / with disabled option">
        <SegmentedDemo />
        <SegmentedDemo disabled />
      </Specimen>
    </>
  );
}

export const filtering: WorkbenchSectionDef = {
  id: "filtering",
  title: "Filtering & search",
  catalogue: "F",
  Demo: Filtering,
};
