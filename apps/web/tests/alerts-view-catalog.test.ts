// apps/web/tests/alerts-view-catalog.test.ts — the read-only alert-catalog tab (a DataTable over
// AlertsPayload.rules). DOM blocks use describeDom (tests/dom.ts), happy-dom per file; the health-map
// and source-grep blocks are pure.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import type { RuleState } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { describeDom } from "./dom.js";
import { makeAlertsPayload } from "./alerts-fixtures.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { stubVirtualViewport } from "./alerts-dom-helpers.js";

isolateDomGlobals();

const rules = makeAlertsPayload({ scenario: "mixed" }).rules;

describe("ruleHealthStatus", () => {
  // Dynamic import: loading the ui barrel before happy-dom registers leaks globals into other files.
  test("is total over the closed health union", async () => {
    const { ruleHealthStatus } = await import("../src/client/views/alerts/catalog/catalog-model.js");
    const { RULE_HEALTH_STATUS } = await import("../src/client/status/target-status.js");
    expect(ruleHealthStatus("healthy")).toBe("ok");
    expect(ruleHealthStatus("unhealthy")).toBe("critical");
    expect(ruleHealthStatus("unknown")).toBe("unknown");
    expect(Object.keys(RULE_HEALTH_STATUS).length).toBe(3);
  });

  test("row keys are unique and stable: no row index, an ordinal only for a repeated group+name", async () => {
    const { catalogRowKeys } = await import("../src/client/views/alerts/catalog/catalog-model.js");
    const rule = (group: string, name: string): RuleState => ({ ...rules[0]!, group, name });
    const keys = catalogRowKeys([rule("g", "A"), rule("g", "B"), rule("g", "A"), rule("h", "A")]);
    expect(new Set(keys).size).toBe(4);
    // Removing the first rule leaves the keys of rules that were not duplicates unchanged.
    const after = catalogRowKeys([rule("g", "B"), rule("g", "A"), rule("h", "A")]);
    expect(after[0]).toBe(keys[1]);
    expect(after[2]).toBe(keys[3]);
  });

  test("columns map name/group/family/state/health/lastEval in that order", async () => {
    const { CATALOG_COLUMNS } = await import("../src/client/views/alerts/catalog/CatalogTab.js");
    expect(CATALOG_COLUMNS.map((c) => c.header)).toEqual([
      "Rule",
      "Group",
      "Family",
      "State",
      "Health",
      "Last evaluation",
    ]);
    expect(CATALOG_COLUMNS.map((c) => c.id)).toEqual([
      "name",
      "group",
      "family",
      "state",
      "health",
      "lastEval",
    ]);
  });
});

describe("catalog source discipline", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/client/views/alerts/catalog/CatalogTab.tsx", import.meta.url)),
    "utf8",
  );

  test("never reorders or drops rows", () => {
    expect(src).not.toContain(".sort(");
    expect(src).not.toContain(".reverse(");
    expect(src).not.toContain(".filter(");
  });

  test("registers no keyboard shortcut and imports no keyboard module", () => {
    expect(src).not.toContain("registerShortcut");
    expect(src).not.toMatch(/import[^;]*keyboard/);
  });

  test("reads no store/router/availability and imports no CSS", () => {
    const imports = src.match(/^import[^;]*;/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const imp of imports) expect(imp).not.toMatch(/store|router|DataAvailability/);
    expect(src).not.toContain("DataAvailability");
    expect(src).not.toMatch(/import\s+["'][^"']*\.css["']/);
  });

  test("imports the library only through the @/ui barrel", () => {
    expect(src).not.toMatch(/ui\/kit\.js|ui\/icons\.js|\/viz\/|from\s+["']@\/ui\//);
    expect(src).toContain('from "@/ui"');
  });
});

describeDom("CatalogTab", (dom) => {
  async function mountCatalog(r: readonly RuleState[]): Promise<HTMLElement> {
    const { createElement: h } = await import("react");
    const { CatalogTab } = await import("../src/client/views/alerts/catalog/CatalogTab.js");
    const { container } = await dom.mount(h(CatalogTab, { rules: r }) as unknown as ReactElement);
    return container;
  }

  function table(c: HTMLElement): HTMLTableElement {
    const t = c.querySelector<HTMLTableElement>('[data-slot="data-table"] table');
    expect(t).not.toBeNull();
    return t!;
  }

  function bodyRows(c: HTMLElement): HTMLTableRowElement[] {
    return [...table(c).querySelectorAll<HTMLTableRowElement>("tbody tr")].filter(
      (r) => r.querySelector("th, td") !== null && r.getAttribute("aria-hidden") !== "true",
    );
  }

  function cells(r: HTMLTableRowElement): HTMLElement[] {
    return [...r.querySelectorAll<HTMLElement>("th, td")];
  }

  test("is a DataTable captioned 'Alert rules' with the six column headers in order", async () => {
    const c = await mountCatalog(rules);
    const t = table(c);
    expect(t.querySelector("caption")?.textContent).toBe("Alert rules");
    const region = t.closest('[role="region"]');
    expect(region?.getAttribute("aria-labelledby")).toBe(t.querySelector("caption")?.id ?? "missing");
    expect([...t.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "Rule",
      "Group",
      "Family",
      "State",
      "Health",
      "Last evaluation",
    ]);
  });

  test("renders one row per rule, incl. deadman and inactive rules, in input order", async () => {
    const c = await mountCatalog(rules);
    const rows = bodyRows(c);
    expect(rows.length).toBe(rules.length);
    expect(rows.length).toBe(5);
    const names = rows.map((r) => r.querySelector("[data-catalog-rule]")?.textContent);
    expect(names).toEqual(rules.map((r) => r.name));
    expect(names).toEqual(["HostDown", "DiskAlmostFull", "LoadHigh", "BackupTooOld", "Watchdog"]);
    // The rule name is the row header.
    expect(rows.map((r) => cells(r)[0]?.tagName)).toEqual(["TH", "TH", "TH", "TH", "TH"]);
    const watchdog = rows[4];
    expect(watchdog?.textContent).toContain("inactive");
    expect(watchdog?.textContent).toContain("meta");
    expect(watchdog?.textContent).toContain("deadman");
  });

  test("order follows the input exactly (no client reorder)", async () => {
    const reversed: RuleState[] = [];
    for (let i = rules.length - 1; i >= 0; i--) reversed.push(rules[i] as RuleState);
    const c = await mountCatalog(reversed);
    const names = bodyRows(c).map((r) => r.querySelector("[data-catalog-rule]")?.textContent);
    expect(names).toEqual(["Watchdog", "BackupTooOld", "LoadHigh", "DiskAlmostFull", "HostDown"]);
  });

  test("the deadman Badge (outline) appears only on the Watchdog row", async () => {
    const c = await mountCatalog(rules);
    const badges = c.querySelectorAll("[data-catalog-deadman]");
    expect(badges.length).toBe(1);
    const badge = badges[0];
    expect(badge?.getAttribute("data-slot")).toBe("badge");
    expect(badge?.getAttribute("data-variant")).toBe("outline");
    expect(badge?.textContent?.trim()).toBe("deadman");
    expect(badge?.closest("tr")).toBe(bodyRows(c)[4] ?? null);
  });

  test("health renders as a StatusBadge with data-status + aria-hidden icon + health word", async () => {
    const c = await mountCatalog(rules);
    const badges = bodyRows(c).map((r) => r.querySelector<HTMLElement>('[data-slot="status-badge"]'));
    expect(badges.map((b) => b?.getAttribute("data-status"))).toEqual([
      "ok",
      "ok",
      "unknown",
      "critical",
      "ok",
    ]);
    expect(badges.map((b) => b?.getAttribute("data-tone"))).toEqual(["ok", "ok", "neutral", "danger", "ok"]);
    expect(badges.map((b) => b?.textContent)).toEqual(["healthy", "healthy", "unknown", "unhealthy", "healthy"]);
    for (const b of badges) {
      const icon = b?.querySelector("svg");
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("lastError is shown only on the unhealthy rule, with the full text in title", async () => {
    const c = await mountCatalog(rules);
    const errors = c.querySelectorAll("[data-catalog-error]");
    expect(errors.length).toBe(1);
    expect(errors[0]?.textContent).toBe("query returned no data");
    expect(errors[0]?.getAttribute("title")).toBe("query returned no data");
    expect(errors[0]?.closest("tr")).toBe(bodyRows(c)[3] ?? null);
  });

  test("an unhealthy rule with a null lastError shows no error line", async () => {
    const r: RuleState = { ...(rules[3] as RuleState), lastError: null };
    const c = await mountCatalog([r]);
    expect(c.querySelectorAll("[data-catalog-error]").length).toBe(0);
  });

  test("a null lastEvaluationAt renders the em-dash placeholder", async () => {
    const c = await mountCatalog(rules);
    const lastCells = bodyRows(c).map((r) => {
      const all = cells(r);
      return all[all.length - 1]?.textContent;
    });
    expect(lastCells[2]).toBe("—");
    expect(lastCells[0]).toBe("2026-09-22T11:59:30.000Z");
    expect(lastCells[4]).toBe("2026-09-22T11:59:45.000Z");
  });

  test("renders no interactive affordance", async () => {
    const c = await mountCatalog(rules);
    expect(c.querySelectorAll("button, a, input, select, textarea, form").length).toBe(0);
  });

  test("a very large rule set virtualizes (a window of rows, full aria-rowcount)", async () => {
    const many: RuleState[] = Array.from({ length: 2000 }, (_, i) => ({
      ...(rules[i % rules.length] as RuleState),
      name: `Rule${i}`,
    }));
    const { DATA_TABLE_VIRTUALIZE_DEFAULTS } = await import("@/ui");
    const restore = stubVirtualViewport(DATA_TABLE_VIRTUALIZE_DEFAULTS.rowHeight.compact);
    let c: HTMLElement;
    try {
      c = await mountCatalog(many);
    } finally {
      restore();
    }
    const root = c.querySelector('[data-slot="data-table"]');
    expect(root?.hasAttribute("data-virtualized")).toBe(true);
    expect(table(c).getAttribute("aria-rowcount")).toBe(String(many.length + 1));
    expect(c.querySelectorAll("[data-catalog-rule]").length).toBeLessThan(300);
  });

  test("an empty slice renders the catalog-specific EmptyState, not a table", async () => {
    const c = await mountCatalog([]);
    expect(c.querySelector("table")).toBeNull();
    const empty = c.querySelector('[data-slot="empty-state"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("No rules");
    expect(empty?.textContent).toContain("No vmalert rules were reported.");
    expect(c.textContent ?? "").not.toContain("No rows");
  });
});
