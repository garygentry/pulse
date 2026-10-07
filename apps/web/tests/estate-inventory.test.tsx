// apps/web/tests/estate-inventory.test.tsx — the inventory hosts→services tree + secondary sections.
// Renders the Inventory surface directly (props-driven) over the makeEstatePayloadFixture envelope and
// queries it by role / name / aria-* / data-* only.

import { expect, test } from "bun:test";
import type {
  CoverageEntry,
  WebCoverageArtifact,
  WebEstateHostV2,
  WebEstateServiceV2,
} from "@pulse/renderer";
import type { AvailabilitySection, EstatePayload } from "@pulse/web-data/wire";

import {
  buildTreeRows,
  classifyHostCoverage,
  CLASS_GROUPS,
  findOrphanedServices,
} from "../src/client/views/estate/inventory-model.js";
import { Inventory } from "../src/client/views/estate/inventory.js";
import type { InventoryProps } from "../src/client/views/estate/inventory.js";
import type { PathRouter } from "../src/client/router.js";
import { act, describeUi, fireEvent, render, screen, userEvent, within } from "./rtl.js";
import { absentSection, makeEstatePayloadFixture, presentSection } from "./factories/estate-payload.js";

/** A recording router stub — Inventory only ever calls navigate. */
function makeRouter(): { router: PathRouter; calls: string[] } {
  const calls: string[] = [];
  const router = { navigate: (p: string) => void calls.push(p) } as unknown as PathRouter;
  return { router, calls };
}

function propsFrom(payload: EstatePayload, over: Partial<InventoryProps> = {}): InventoryProps {
  return {
    estate: payload.estate,
    liveTargets: payload.liveTargets,
    coverage: payload.coverage,
    matchedIds: null,
    router: makeRouter().router,
    ...over,
  };
}

const tree = (): HTMLElement => screen.getByRole("tree", { name: "Declared estate" });
const item = (name: string): HTMLElement => within(tree()).getByRole("treeitem", { name });
const queryItem = (name: string): HTMLElement | null => within(tree()).queryByRole("treeitem", { name });
/** The row hook (`data-testid` + data-*) inside a treeitem's own row, not its nested group. */
const rowOf = (treeitem: HTMLElement): HTMLElement =>
  [...treeitem.children].find((c) => c.hasAttribute("data-tree-row")) as HTMLElement;
const hookOf = (treeitem: HTMLElement): HTMLElement => rowOf(treeitem).querySelector("[data-testid]") as HTMLElement;
const treeitemOf = (el: Element): HTMLElement => el.closest('[role="treeitem"]') as HTMLElement;
const hostRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="estate-host-row"]')];
const serviceRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-testid="estate-service-row"]'),
];
const indicator = (row: HTMLElement, kind: "coverage" | "live"): HTMLElement =>
  row.querySelector(`[data-slot="status-badge"][data-indicator="${kind}"]`) as HTMLElement;

function coverageArtifact(buckets: {
  covered?: string[];
  gaps?: string[];
  suppressed?: string[];
}): AvailabilitySection<WebCoverageArtifact> {
  const entry = (name: string): CoverageEntry => ({
    kind: "host",
    name,
    collectionClass: "managed-linux",
    artifacts: [],
    suppressed: null,
  });
  return presentSection<WebCoverageArtifact>({
    formatVersion: 2,
    bundleId: "b" as WebCoverageArtifact["bundleId"],
    covered: (buckets.covered ?? []).map(entry),
    gaps: (buckets.gaps ?? []).map(entry),
    suppressed: (buckets.suppressed ?? []).map(entry),
  });
}

/** Clone a fixture service with a new identity. */
function cloneService(base: WebEstateServiceV2, host: string, name: string): WebEstateServiceV2 {
  return {
    ...base,
    host,
    name,
    drilldownId: `svc:${host}/${name}` as WebEstateServiceV2["drilldownId"],
  };
}

describeUi("estate: inventory tree", () => {
  test("a TreeView 'Declared estate': class groups (level 1, expanded) in CLASS_GROUPS order, hosts collapsed", () => {
    const payload = makeEstatePayloadFixture();
    render(<Inventory {...propsFrom(payload)} />);
    const present = new Set(payload.estate.hosts.map((x) => x.collectionClass));
    const groups = CLASS_GROUPS.filter((g) => present.has(g.class));
    const topLevel = within(tree())
      .getAllByRole("treeitem")
      .filter((el) => el.getAttribute("aria-level") === "1");
    expect(topLevel.map((el) => hookOf(el).getAttribute("data-class"))).toEqual(groups.map((g) => g.class));
    for (const g of groups) {
      expect(item(g.label)).toHaveAttribute("aria-expanded", "true");
      expect(hookOf(item(g.label))).toHaveAttribute("data-testid", "estate-group-row");
    }
    expect(hostRows().length).toBe(payload.estate.hosts.length);
    for (const host of hostRows()) expect(treeitemOf(host)).toHaveAttribute("aria-level", "2");
    // Hosts collapsed by default — no service rows at first paint.
    expect(serviceRows().length).toBe(0);
    expect(item("hostA-managed")).toHaveAttribute("aria-expanded", "false");
    // Host rows render the class label from the fixed map, not a parsed name.
    expect(item("hostB-hyper").textContent).toContain("Hypervisor API");
    // The tree sits in a level-2 'Hosts' section inside the estate-tree region.
    expect(screen.getByRole("heading", { level: 2, name: "Hosts" })).not.toBeNull();
    expect(tree().closest('[data-region="estate-tree"]')).not.toBeNull();
  });

  test("ArrowRight expands a host to its nested services (level 3); ArrowLeft collapses it", async () => {
    const user = userEvent.setup();
    render(<Inventory {...propsFrom(makeEstatePayloadFixture())} />);
    act(() => item("hostA-managed").focus());
    await user.keyboard("{ArrowRight}");
    expect(item("hostA-managed")).toHaveAttribute("aria-expanded", "true");
    const nested = within(item("hostA-managed")).getAllByRole("treeitem");
    expect(nested.map((el) => hookOf(el).getAttribute("data-service"))).toEqual(["grafana", "loki"]);
    for (const el of nested) {
      expect(el).toHaveAttribute("aria-level", "3");
      expect(hookOf(el)).toHaveAttribute("data-host", "hostA-managed");
    }
    await user.keyboard("{ArrowLeft}");
    expect(item("hostA-managed")).toHaveAttribute("aria-expanded", "false");
    expect(serviceRows().length).toBe(0);
  });

  test("absent coverage ⇒ every host reads 'Coverage unknown' and none reads 'Covered' (I3)", () => {
    const payload = makeEstatePayloadFixture({ coverage: absentSection<never>() });
    render(<Inventory {...propsFrom(payload)} />);
    expect(hostRows().length).toBe(payload.estate.hosts.length);
    for (const row of hostRows()) {
      expect(row.textContent).toContain("Coverage unknown");
      expect(row.textContent).not.toContain("Covered");
      expect(indicator(row, "coverage")).toHaveAttribute("data-status", "unknown");
    }
    for (const host of payload.estate.hosts) {
      expect(classifyHostCoverage(host, payload.coverage)).toBe("unknown");
    }
  });

  test("coverage bucket precedence is suppressed → gap → covered → unknown", () => {
    const cov = coverageArtifact({
      suppressed: ["s"],
      gaps: ["s", "g"],
      covered: ["s", "g", "c"],
    });
    expect(classifyHostCoverage({ name: "s" }, cov)).toBe("suppressed");
    expect(classifyHostCoverage({ name: "g" }, cov)).toBe("gap");
    expect(classifyHostCoverage({ name: "c" }, cov)).toBe("covered");
    expect(classifyHostCoverage({ name: "nowhere" }, cov)).toBe("unknown");
  });

  test("present coverage renders labelled badges; gap maps to warning, not critical", () => {
    const payload = makeEstatePayloadFixture({
      coverage: coverageArtifact({ covered: ["hostA-managed"], gaps: ["hostB-hyper"], suppressed: ["hostE-excluded"] }),
    });
    render(<Inventory {...propsFrom(payload)} />);
    const badge = (n: string) => indicator(hookOf(item(n)), "coverage");
    expect(badge("hostA-managed")).toHaveAttribute("data-status", "ok");
    expect(badge("hostA-managed").textContent).toContain("Covered");
    expect(badge("hostB-hyper")).toHaveAttribute("data-status", "warning");
    expect(badge("hostB-hyper").textContent).toContain("Coverage gap");
    expect(badge("hostE-excluded")).toHaveAttribute("data-status", "suppressed");
    expect(badge("hostD-probe")).toHaveAttribute("data-status", "unknown");
  });

  test("zero hosts renders the explicit 'No hosts declared' EmptyState", () => {
    const base = makeEstatePayloadFixture();
    const payload = makeEstatePayloadFixture({ estate: { ...base.estate, hosts: [], services: [] } });
    const { container } = render(<Inventory {...propsFrom(payload)} />);
    const hosts = screen.getByRole("region", { name: "Hosts" });
    expect(within(hosts).getByRole("status").textContent).toContain("No hosts declared");
    expect(screen.queryByRole("tree")).toBeNull();
    // Secondary sections still render below.
    expect(container.querySelector('[data-region="estate-secondary"]')).not.toBeNull();
  });

  test("a search with no surviving entity renders 'No matching hosts or services'", () => {
    const payload = makeEstatePayloadFixture();
    render(<Inventory {...propsFrom(payload, { matchedIds: new Set(["nothing"]) })} />);
    expect(screen.queryByRole("tree")).toBeNull();
    const hosts = screen.getByRole("region", { name: "Hosts" });
    expect(within(hosts).getByRole("status").textContent).toContain("No matching hosts or services");
  });

  test("a host with zero services is a leaf (no aria-expanded); ArrowRight is a no-op", async () => {
    const user = userEvent.setup();
    render(<Inventory {...propsFrom(makeEstatePayloadFixture())} />);
    const b = item("hostB-hyper");
    expect(b).not.toHaveAttribute("aria-expanded");
    expect(b.textContent).toContain("0 services");
    act(() => b.focus());
    await user.keyboard("{ArrowRight}");
    expect(serviceRows().length).toBe(0);
  });

  test("every host/service row shows provenance file:line as text plus coverage + live badges with data-status", async () => {
    const user = userEvent.setup();
    const payload = makeEstatePayloadFixture();
    render(<Inventory {...propsFrom(payload)} />);
    act(() => item("hostA-managed").focus());
    await user.keyboard("{ArrowRight}");
    act(() => item("hostC-nas").focus());
    await user.keyboard("{ArrowRight}");
    const rows = [...hostRows(), ...serviceRows()];
    expect(rows.length).toBe(payload.estate.hosts.length + payload.estate.services.length);
    for (const row of rows) {
      expect(row.querySelector("[data-provenance-ref]")).not.toBeNull();
      expect(indicator(row, "coverage")?.getAttribute("data-status")).toBeTruthy();
      expect(indicator(row, "live")?.getAttribute("data-status")).toBeTruthy();
    }
    const grafana = hookOf(item("grafana"));
    const prov = payload.estate.services[0]!.provenance;
    expect(grafana.querySelector("[data-provenance-ref]")!.textContent).toBe(`${prov.file}:${prov.line}`);
    // Tree rows hold no interactive elements: the copy chip lives on entity pages and tables.
    expect(tree().querySelectorAll("button, a, input").length).toBe(0);
  });

  test("a live-less entity never shows live OK (I3)", () => {
    render(<Inventory {...propsFrom(makeEstatePayloadFixture({ liveTargets: [] }))} />);
    for (const row of hostRows()) {
      expect(indicator(row, "live").getAttribute("data-status")).not.toBe("ok");
      expect(indicator(row, "live").textContent).toMatch(/^Live /);
    }
  });

  test("click / Enter deep-link to the entity routes; Enter on a group toggles it", async () => {
    const user = userEvent.setup();
    const { router, calls } = makeRouter();
    render(<Inventory {...propsFrom(makeEstatePayloadFixture(), { router })} />);
    await user.click(within(item("hostA-managed")).getByText("hostA-managed"));
    expect(calls).toEqual(["/estate/host/hostA-managed"]);
    // The click also opened the branch (TreeView toggles a branch it activates).
    expect(item("hostA-managed")).toHaveAttribute("aria-expanded", "true");
    act(() => item("loki").focus());
    await user.keyboard("{Enter}");
    expect(calls[1]).toBe("/estate/service/hostA-managed/loki");
    expect(calls.length).toBe(2);
    // Enter on a group toggles it instead of navigating.
    act(() => item("Managed Linux").focus());
    await user.keyboard("{Enter}");
    expect(calls.length).toBe(2);
    expect(item("Managed Linux")).toHaveAttribute("aria-expanded", "false");
    expect(queryItem("hostA-managed")).toBeNull();
  });

  test("a click on a host's chevron toggles it without navigating", async () => {
    const user = userEvent.setup();
    const { router, calls } = makeRouter();
    render(<Inventory {...propsFrom(makeEstatePayloadFixture(), { router })} />);
    const chevron = (name: string) =>
      rowOf(item(name)).firstElementChild as HTMLElement;
    await user.click(chevron("hostA-managed"));
    expect(item("hostA-managed")).toHaveAttribute("aria-expanded", "true");
    expect(calls).toEqual([]);
    await user.click(chevron("hostA-managed"));
    expect(item("hostA-managed")).toHaveAttribute("aria-expanded", "false");
    expect(calls).toEqual([]);
    // A leaf's first child is a spacer, not a chevron: clicking there still navigates.
    await user.click(chevron("hostB-hyper"));
    expect(calls).toEqual(["/estate/host/hostB-hyper"]);
    // The next ordinary click navigates again (the chevron flag does not leak).
    await user.click(within(item("hostA-managed")).getByText("hostA-managed"));
    expect(calls).toEqual(["/estate/host/hostB-hyper", "/estate/host/hostA-managed"]);
  });

  test("the tree is a single Tab stop; ↓ and End move focus across treeitems", async () => {
    const user = userEvent.setup();
    render(<Inventory {...propsFrom(makeEstatePayloadFixture())} />);
    const items = within(tree()).getAllByRole("treeitem");
    expect(items.length).toBeGreaterThan(1);
    expect(items.filter((el) => el.getAttribute("tabindex") === "0").length).toBe(1);
    act(() => items[0]!.focus());
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    expect(items[1]).toHaveAttribute("tabindex", "0");
    await user.keyboard("{End}");
    expect(items[items.length - 1]).toHaveFocus();
    // The fallback key path (fireEvent on the treeitem) reaches the same handler.
    fireEvent.keyDown(items[items.length - 1]!, { key: "Home" });
    expect(items[0]).toHaveFocus();
  });

  test("matchedIds keeps matches and force-expands a matched service's ancestors", () => {
    const matchedIds = new Set(["svc:hostA-managed/loki"]);
    render(<Inventory {...propsFrom(makeEstatePayloadFixture(), { matchedIds })} />);
    expect(hostRows().map((el) => el.getAttribute("data-host"))).toEqual(["hostA-managed"]);
    expect(item("hostA-managed")).toHaveAttribute("aria-expanded", "true");
    expect(serviceRows().map((el) => el.getAttribute("data-service"))).toEqual(["loki"]);
  });

  test("an orphaned service goes to the 'Orphaned services' Callout, never the tree", () => {
    const base = makeEstatePayloadFixture();
    const orphan = cloneService(base.estate.services[0]!, "ghost-host", "phantom");
    const payload = makeEstatePayloadFixture({
      estate: { ...base.estate, services: [...base.estate.services, orphan] },
    });
    expect(findOrphanedServices(payload.estate.hosts, payload.estate.services)).toEqual([orphan]);
    render(<Inventory {...propsFrom(payload)} />);
    const note = screen.getByTestId("estate-orphans");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveAttribute("data-slot", "callout");
    expect(note.textContent).toContain("Orphaned services");
    expect(note.textContent).toContain('phantom (declared host "ghost-host" not found)');
    expect(note.querySelector("button[data-provenance-file]")).not.toBeNull();
    expect(tree().textContent).not.toContain("phantom");
  });

  test("a malformed live target becomes an inline error row while declared siblings render", () => {
    const base = makeEstatePayloadFixture();
    const malformed = { state: "healthy", availability: null } as unknown as EstatePayload["liveTargets"][number];
    const payload = makeEstatePayloadFixture({ liveTargets: [...base.liveTargets, malformed] });
    render(<Inventory {...propsFrom(payload)} />);
    expect(screen.getByTestId("estate-error-row").textContent).toContain("Malformed live target entry");
    expect(hostRows().length).toBe(base.estate.hosts.length);
    expect(item("hostA-managed")).not.toBeNull();
  });

  test("a malformed host becomes an inline error row while siblings render", () => {
    const base = makeEstatePayloadFixture();
    const broken = { ...base.estate.hosts[0]!, name: "bad", collectionClass: "mystery" } as unknown as WebEstateHostV2;
    const payload = makeEstatePayloadFixture({
      estate: { ...base.estate, hosts: [...base.estate.hosts, broken] },
    });
    render(<Inventory {...propsFrom(payload)} />);
    const err = screen.getByTestId("estate-error-row");
    expect(err.querySelector('[data-status="critical"]')).not.toBeNull();
    expect(err.textContent).toContain("Malformed host entry");
    expect(hostRows().length).toBe(base.estate.hosts.length);
  });
});

describeUi("estate: inventory relationships", () => {
  test("channels / routing / suppressions are Tabs + DataTables in a level-2 'Relationships' Section", async () => {
    const user = userEvent.setup();
    const payload = makeEstatePayloadFixture();
    const { container } = render(<Inventory {...propsFrom(payload)} />);
    const secondary = container.querySelector('[data-region="estate-secondary"]') as HTMLElement;
    expect(secondary).toHaveAttribute("data-slot", "section");
    expect(within(secondary).getByRole("heading", { level: 2, name: "Relationships" })).not.toBeNull();
    expect(tree().contains(secondary)).toBe(false);
    const tablist = within(secondary).getByRole("tablist", { name: "Estate relationships" });
    expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Channels",
      "Routing overrides",
      "Suppressions",
    ]);

    const channels = within(secondary).getByRole("tabpanel");
    expect(channels).toHaveAttribute("data-panel", "channels");
    const channelTable = within(channels).getByRole("table", { name: "Channels" });
    for (const c of payload.estate.channels) {
      expect(within(channelTable).getByText(c.name)).not.toBeNull();
      expect(tree().textContent).not.toContain(c.name);
    }
    expect(channelTable.querySelector("button[data-provenance-file]")).not.toBeNull();

    await user.click(within(tablist).getByRole("tab", { name: "Suppressions" }));
    const suppressions = within(secondary).getByRole("tabpanel");
    expect(suppressions).toHaveAttribute("data-panel", "suppressions");
    const supTable = within(suppressions).getByRole("table", { name: "Suppressions" });
    for (const s of payload.estate.suppressions) {
      expect(supTable.textContent).toContain(s.rationale);
      expect(tree().textContent).not.toContain(s.rationale);
    }

    await user.click(within(tablist).getByRole("tab", { name: "Routing overrides" }));
    const routing = within(secondary).getByRole("tabpanel");
    expect(routing).toHaveAttribute("data-panel", "routing");
    expect(within(routing).getByRole("table", { name: "Routing overrides" })).not.toBeNull();
  });

  test("an empty relationship table shows its own empty text", () => {
    const base = makeEstatePayloadFixture();
    const payload = makeEstatePayloadFixture({ estate: { ...base.estate, channels: [] } });
    render(<Inventory {...propsFrom(payload)} />);
    expect(screen.getByRole("tabpanel").textContent).toContain("No channels declared");
  });
});

test("buildTreeRows nests by service.host only — no name parsing", () => {
  const base = makeEstatePayloadFixture().estate;
  const hostA = base.hosts.find((x) => x.name === "hostA-managed")!;
  const hostC = base.hosts.find((x) => x.name === "hostC-nas")!;
  // A service whose NAME mimics hostC but whose declared host is hostA nests under hostA.
  const trap = cloneService(base.services[0]!, "hostA-managed", "hostC-nas-exporter");
  const rows = buildTreeRows({
    hosts: [hostC, hostA],
    services: [trap],
    expandedGroups: new Set(CLASS_GROUPS.map((g) => g.class)),
    expandedHosts: new Set([hostA.drilldownId, hostC.drilldownId]),
    matchedIds: null,
  });
  expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual([
    "group:group:managed-linux",
    "host:host:hostA-managed",
    "service:svc:hostA-managed/hostC-nas-exporter",
    "group:group:nas-api",
    "host:host:hostC-nas",
  ]);
  const c = rows.find((r) => r.kind === "host" && r.id === hostC.drilldownId);
  expect(c?.kind === "host" && c.serviceCount).toBe(0);
});
