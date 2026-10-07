// apps/web/tests/estate-search.test.ts — estate search filter + controlled SearchBox (spec 06 §4, 09).
// filterEstate is pure; the SearchBox cases run under describeDom (happy-dom registered per file).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import type { ReactElement } from "react";

import { SearchBox, useFilteredEstate } from "../src/client/views/estate/search.js";
import { filterEstate } from "../src/client/views/estate/search-model.js";
import type { FilteredEstate } from "../src/client/views/estate/search-model.js";
import { makeWebEstateModelV2 } from "./factories/estate-bundle.js";
import { describeDom } from "./dom.js";
import { setInputValue } from "./react-render.js";

const names = (xs: readonly { name: string }[]): string[] => xs.map((x) => x.name);

describeDom("estate search", (dom) => {
  test("empty / whitespace query is unfiltered with identity-preserved collections", () => {
    const model = makeWebEstateModelV2();
    for (const q of ["", "   ", "\t\n"]) {
      const r = filterEstate(model, q);
      expect(r.isFiltered).toBe(false);
      expect(r.query).toBe("");
      expect(r.hosts).toBe(model.hosts);
      expect(r.services).toBe(model.services);
      expect(r.channels).toBe(model.channels);
      expect(r.routingOverrides).toBe(model.routingOverrides);
      expect(r.suppressions).toBe(model.suppressions);
    }
  });

  test("matches host name, collectionClass, and provenance.file case-insensitively", () => {
    const model = makeWebEstateModelV2();
    expect(names(filterEstate(model, "HOSTB").hosts)).toEqual(["hostB-hyper"]);
    expect(names(filterEstate(model, "Hypervisor-API").hosts)).toEqual(["hostB-hyper"]);
    const byFile = filterEstate(model, "HOSTS/hostD.YML");
    expect(names(byFile.hosts)).toEqual(["hostD-probe"]);
    expect(byFile.isFiltered).toBe(true);
    expect(byFile.query).toBe("hosts/hostd.yml");
  });

  test("matches services by name, kind, and provenance.file", () => {
    const model = makeWebEstateModelV2();
    expect(names(filterEstate(model, "Grafana").services)).toEqual(["grafana"]);
    expect(names(filterEstate(model, "LOGS").services)).toEqual(["loki"]);
    expect(names(filterEstate(model, "services/restic.yml").services)).toEqual(["restic"]);
  });

  test("a query matching only a service retains that service's parent host", () => {
    const model = makeWebEstateModelV2();
    const r = filterEstate(model, "loki");
    expect(names(r.services)).toEqual(["loki"]);
    expect(names(r.hosts)).toEqual(["hostA-managed"]);
  });

  test("a host match does not pull in its non-matching services", () => {
    const r = filterEstate(makeWebEstateModelV2(), "managed-linux");
    expect(names(r.hosts)).toEqual(["hostA-managed"]);
    expect(r.services).toEqual([]);
  });

  test("matches channels by name, kind, and provenance.file", () => {
    const model = makeWebEstateModelV2();
    expect(names(filterEstate(model, "OPS-EMAIL").channels)).toEqual(["ops-email"]);
    expect(names(filterEstate(model, "chat").channels)).toEqual(["ops-chat"]);
    expect(names(filterEstate(model, "channels/ops.yml").channels)).toEqual(["ops-chat", "ops-email"]);
  });

  test("matches routing overrides by severity, channels, and provenance.file", () => {
    const model = makeWebEstateModelV2();
    expect(filterEstate(model, "CRITICAL").routingOverrides).toHaveLength(1);
    expect(filterEstate(model, "ops-email").routingOverrides).toHaveLength(1);
    expect(filterEstate(model, "routing/overrides").routingOverrides).toHaveLength(1);
    expect(filterEstate(model, "zzz-nothing").routingOverrides).toHaveLength(0);
  });

  test("matches suppressions by target, class, rationale, and provenance.file", () => {
    const model = makeWebEstateModelV2();
    const targets = (r: FilteredEstate): string[] => r.suppressions.map((s) => s.target);
    expect(targets(filterEstate(model, "hostc-nas/RESTIC"))).toEqual(["hostC-nas/restic"]);
    expect(targets(filterEstate(model, "Expected-Churn"))).toEqual(["hostC-nas/restic"]);
    expect(targets(filterEstate(model, "DECOMMISSIONED"))).toEqual(["hostE-excluded"]);
    expect(targets(filterEstate(model, "suppressions/hosts.yml"))).toEqual(["hostE-excluded"]);
  });

  test("empty fields never match and a no-hit query filters every collection to []", () => {
    const model = makeWebEstateModelV2({
      channels: [{ name: "", kind: "", credential: null, options: null, provenance: { file: "", path: "", line: 1, col: 1 } }],
    } as never);
    const r = filterEstate(model, "qqq-no-such-entity");
    expect(r.isFiltered).toBe(true);
    expect([r.hosts, r.services, r.channels, r.routingOverrides, r.suppressions].every((c) => c.length === 0)).toBe(true);
  });

  test("a 320-host filter recomputation stays within the DOM regression budget", () => {
    const base = makeWebEstateModelV2();
    const seed = base.hosts[0]!;
    const hosts = Array.from({ length: 320 }, (_, i) => ({
      ...seed,
      name: `scale-host-${i}`,
      drilldownId: `host:scale-host-${i}` as typeof seed.drilldownId,
    }));
    const model = makeWebEstateModelV2({ hosts, services: [] });
    const started = performance.now();
    const result = filterEstate(model, "scale-host-319");
    const elapsed = performance.now() - started;
    expect(result.hosts.map((host) => host.name)).toEqual(["scale-host-319"]);
    expect(elapsed).toBeLessThan(100);
  });

  test("an empty estate filters to empty collections", () => {
    const empty = makeWebEstateModelV2({ hosts: [], services: [], channels: [], routingOverrides: [], suppressions: [] });
    const r = filterEstate(empty, "host");
    expect(r.hosts).toEqual([]);
    expect(r.services).toEqual([]);
  });

  test("SearchBox renders a controlled search input and emits every change via onQueryChange", async () => {
    const seen: string[] = [];
    const { container, unmount } = await dom.mount(
      createElement(SearchBox, { value: "graf", onQueryChange: (next: string) => seen.push(next) }) as ReactElement,
    );
    expect(container.querySelector('[role="search"]')).not.toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input.value).toBe("graf");
    expect(input.getAttribute("aria-label")).toBe("Search estate");
    const win = input.ownerDocument.defaultView as unknown as { Event: typeof Event };
    for (const next of ["grafa", "grafan", ""]) {
      setInputValue(input, next);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
    expect(seen).toEqual(["grafa", "grafan", ""]);
    // No result summary without resultCount.
    expect(container.querySelector('[role="status"]')).toBeNull();
    unmount();
  });

  test("SearchBox holds no query state (no useState/useReducer, no navigation)", () => {
    const src = readFileSync(new URL("../src/client/views/estate/search.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/useState|useReducer|useSignal/);
    expect(src).not.toMatch(/navigate\(/);
  });

  test("SearchBox shows a polite live match count only when resultCount is set and value non-empty", async () => {
    const noop = (): void => {};
    const one = await dom.mount(createElement(SearchBox, { value: "loki", onQueryChange: noop, resultCount: 1 }) as ReactElement);
    const status = one.container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("1 match");
    one.unmount();

    const many = await dom.mount(
      createElement(SearchBox, { value: "host", onQueryChange: noop, resultCount: 3, "aria-label": "Filter" }) as ReactElement,
    );
    expect(many.container.querySelector('[role="status"]')?.textContent).toBe("3 matches");
    expect(many.container.querySelector("input")?.getAttribute("aria-label")).toBe("Filter");
    many.unmount();

    const blank = await dom.mount(createElement(SearchBox, { value: "  ", onQueryChange: noop, resultCount: 0 }) as ReactElement);
    expect(blank.container.querySelector('[role="status"]')).toBeNull();
    blank.unmount();
  });

  test("useFilteredEstate memoizes on (model identity, query) and yields null without a model", async () => {
    const model = makeWebEstateModelV2();
    const results: (FilteredEstate | null)[] = [];
    const Probe = (p: { m: typeof model | null; q: string; tick: number }): null => {
      results.push(useFilteredEstate(p.m, p.q));
      return null;
    };
    const { render } = await import("./react-render.js");
    const { container, unmount } = await dom.mount(createElement(Probe, { m: model, q: "loki", tick: 0 }) as ReactElement);
    render(createElement(Probe, { m: model, q: "loki", tick: 1 }), container);
    render(createElement(Probe, { m: model, q: "grafana", tick: 2 }), container);
    render(createElement(Probe, { m: null, q: "grafana", tick: 3 }), container);
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBe(results[0]!);
    expect(results[2]).not.toBe(results[0]!);
    expect(names(results[2]!.services)).toEqual(["grafana"]);
    expect(results[3]).toBeNull();
    unmount();
  });
});
