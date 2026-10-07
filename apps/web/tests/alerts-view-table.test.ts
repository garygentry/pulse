// apps/web/tests/alerts-view-table.test.ts — firing triage table (DataTable) + column defs.
// DOM blocks are wrapped in describeDom (tests/dom.ts) so happy-dom is registered per file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ActiveAlert, AlertsPayload } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { formatAge, formatTarget, summaryText } from "../src/client/views/alerts/table/columns-model.js";
import { triageColumns } from "../src/client/views/alerts/table/columns.js";
import { TRIAGE_ROW_HEIGHT } from "../src/client/views/alerts/table/TriageTable.js";
import { firingRows } from "../src/client/views/alerts/model.js";
import { describeDom } from "./dom.js";
import { stubVirtualViewport } from "./alerts-dom-helpers.js";
import { FIXTURE_FINGERPRINTS, FIXTURE_NOW, makeAlertsPayload } from "./alerts-fixtures.js";

const F = FIXTURE_FINGERPRINTS;
const payload: AlertsPayload = makeAlertsPayload({ scenario: "mixed" });
const rows = firingRows(payload);

function byFp(fp: string): ActiveAlert {
  const a = rows.find((x) => x.fingerprint === fp);
  if (a === undefined) throw new Error(`fixture alert ${fp} missing`);
  return a;
}

describe("triageColumns", () => {
  test("columns are severity, name, target, age, summary, receivers, state in order", () => {
    expect(triageColumns.map((c) => c.id)).toEqual([
      "severity",
      "name",
      "target",
      "age",
      "summary",
      "receivers",
      "state",
    ]);
    expect(triageColumns.map((c) => c.header)).toEqual([
      "Severity",
      "Alert",
      "Target",
      "Age",
      "Summary",
      "Receivers",
      "State",
    ]);
  });
});

describe("cell helpers", () => {
  const now = Date.parse(FIXTURE_NOW);
  test("formatAge uses coarse s/m/h/d buckets", () => {
    expect(formatAge("2026-09-22T11:59:15.000Z", now)).toBe("45s");
    expect(formatAge("2026-09-22T11:30:00.000Z", now)).toBe("30m");
    expect(formatAge("2026-09-22T09:00:00.000Z", now)).toBe("3h");
    expect(formatAge("2026-09-19T12:00:00.000Z", now)).toBe("3d");
    expect(formatAge("2026-09-22T12:00:30.000Z", now)).toBe("0s"); // future clock skew clamps
  });

  test("formatAge returns '—' for an unparseable timestamp", () => {
    expect(formatAge("not-a-timestamp", now)).toBe("—");
    expect(formatAge("", now)).toBe("—");
  });

  test("formatTarget is kind:id or '—' for null", () => {
    expect(formatTarget({ kind: "host", id: "web-01" })).toBe("host:web-01");
    expect(formatTarget(null)).toBe("—");
  });

  test("summaryText prefers summary, falls back to description, else '—'", () => {
    expect(summaryText(byFp(F.hostDown))).toBe("web-01 is not reporting heartbeats");
    expect(summaryText(byFp(F.backupAge))).toBe("The last successful backup is older than 26 hours.");
    expect(summaryText(byFp(F.loadHigh))).toBe("—");
  });
});

describeDom("TriageTable", (dom) => {
  const live: (() => void)[] = [];
  afterEach(() => {
    while (live.length > 0) live.pop()!();
  });

  async function mountTable(
    tableRows: readonly ActiveAlert[],
    opts: { sourcesCurrent?: boolean; filtersExcludeAll?: boolean; onOpenAlert?: (fp: string) => void } = {},
  ): Promise<HTMLElement> {
    const { createElement: h, createRef } = await import("react");
    const { signal } = await import("@preact/signals-core");
    const { TriageTable } = await import("../src/client/views/alerts/table/TriageTable.js");
    const { container, unmount } = await dom.mount(
      h(TriageTable, {
        rows: tableRows,
        selectedIndex: signal(-1),
        onOpenAlert: opts.onOpenAlert ?? (() => {}),
        sourcesCurrent: opts.sourcesCurrent ?? true,
        ...(opts.filtersExcludeAll !== undefined ? { filtersExcludeAll: opts.filtersExcludeAll } : {}),
        containerRef: createRef<HTMLDivElement>(),
      }) as unknown as ReactElement,
    );
    live.push(unmount);
    return container;
  }

  const bodyRows = (c: HTMLElement): HTMLTableRowElement[] =>
    [...c.querySelectorAll<HTMLTableRowElement>("tbody tr")].filter((tr) => tr.getAttribute("aria-hidden") !== "true");
  const badge = (cell: Element): HTMLElement => cell.querySelector<HTMLElement>('[data-slot="status-badge"][data-status]')!;
  const iconOf = (el: Element): string => el.querySelector('svg[data-slot="icon"]')?.getAttribute("class") ?? "";

  test("is a DataTable captioned 'Firing alerts' with PRD-order headers and one row per alert, in payload order", async () => {
    const container = await mountTable(rows);
    const table = container.querySelector('[data-slot="data-table"]')!;
    expect(table.getAttribute("role")).toBe("region");
    expect(container.querySelector("caption")!.textContent).toBe("Firing alerts");
    const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headers).toEqual(["Severity", "Alert", "Target", "Age", "Summary", "Receivers", "State"]);
    for (const th of container.querySelectorAll("thead th")) expect(th.getAttribute("scope")).toBe("col");
    expect(bodyRows(container).map((tr) => tr.getAttribute("data-row-id"))).toEqual(rows.map((a) => a.fingerprint));
    const opens = [...container.querySelectorAll("[data-triage-open]")];
    expect(opens.map((b) => b.getAttribute("data-triage-open"))).toEqual(rows.map((a) => a.fingerprint));
    for (const b of opens) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("type")).toBe("button");
    }
    expect(opens[0]!.textContent).toBe("HostDown");
    // Not virtualized below the threshold, but the scroll region is still bounded.
    expect(table.hasAttribute("data-virtualized")).toBe(false);
    expect(table.getAttribute("class")).toContain("max-h-[70vh]");
  });

  test("severity and state cells are status badges with data-status + icon + text label", async () => {
    const container = await mountTable(rows);
    const cells = [...bodyRows(container)[0]!.querySelectorAll("td")];
    const sev = badge(cells[0]!);
    expect(sev.getAttribute("data-status")).toBe("critical");
    expect(sev.getAttribute("data-severity")).toBe("critical");
    expect(sev.getAttribute("data-tone")).toBe("danger");
    expect(sev.textContent).toBe("critical");
    expect(sev.querySelector('svg[data-slot="icon"]')!.getAttribute("aria-hidden")).toBe("true");
    const state = badge(cells[6]!);
    expect(state.getAttribute("data-status")).toBe("critical");
    expect(state.textContent).toBe("firing");
    expect(iconOf(state)).not.toContain("lucide-bell");
    // Row text for target / age / summary / receivers.
    expect(cells[2]!.textContent).toBe("host:web-01");
    expect(cells[3]!.textContent).toBe(formatAge(byFp(F.hostDown).startsAt));
    expect(cells[4]!.textContent).toBe("web-01 is not reporting heartbeats");
    expect(cells[5]!.textContent).toBe("pager, chat");
  });

  test("info severity uses the info tone (ALERT_SEVERITY), not unknown", async () => {
    const container = await mountTable(rows);
    const idx = rows.findIndex((a) => a.severity === "info");
    expect(idx).toBeGreaterThanOrEqual(0);
    const sev = badge(bodyRows(container)[idx]!.querySelectorAll("td")[0]!);
    expect(sev.getAttribute("data-status")).toBe("info");
    expect(sev.getAttribute("data-tone")).toBe("info");
    expect(sev.textContent).toBe("info");
  });

  test("a firing info alert's State badge takes the info tone; data-status keeps the TargetStatus hook", async () => {
    const info = { ...rows.find((a) => a.severity === "info")!, state: "firing" as const };
    const container = await mountTable([info]);
    const state = badge(bodyRows(container)[0]!.querySelectorAll("td")[6]!);
    expect(state.getAttribute("data-tone")).toBe("info");
    expect(state.getAttribute("data-status")).toBe("unknown");
    expect(state.textContent).toBe("firing");
  });

  test("silenced/inhibited rows are present and marked (suppressed status + bell icon + literal state word)", async () => {
    const container = await mountTable(rows);
    const trs = bodyRows(container);
    for (const fp of [F.backupAge, F.loadHigh]) {
      const idx = rows.findIndex((a) => a.fingerprint === fp);
      expect(idx).toBeGreaterThanOrEqual(0);
      const stateBadge = badge(trs[idx]!.querySelectorAll("td")[6]!);
      expect(stateBadge.getAttribute("data-status")).toBe("suppressed");
      expect(stateBadge.getAttribute("data-variant")).toBe("outline");
      expect(iconOf(stateBadge)).toContain("lucide-bell");
      expect(stateBadge.textContent).toBe(byFp(fp).state);
    }
  });

  test("null target, unparseable startsAt and empty receivers render '—'", async () => {
    const container = await mountTable(rows);
    const trs = bodyRows(container);
    const orphan = trs[rows.findIndex((a) => a.fingerprint === F.unattributed)]!.querySelectorAll("td");
    expect(orphan[2]!.textContent).toBe("—");
    expect(orphan[3]!.textContent).toBe("—");
    const backup = trs[rows.findIndex((a) => a.fingerprint === F.backupAge)]!.querySelectorAll("td");
    expect(backup[5]!.textContent).toBe("—");
  });

  test("a delegated click on a row-open control opens that alert", async () => {
    const opened: string[] = [];
    const container = await mountTable(rows, { onOpenAlert: (fp) => opened.push(fp) });
    const btn = container.querySelector<HTMLButtonElement>(`[data-triage-open="${F.diskFull}"]`)!;
    btn.click();
    // A click on a non-open cell does not open anything.
    (container.querySelector("tbody td") as HTMLElement).click();
    expect(opened).toEqual([F.diskFull]);
  });

  test("empty + sources current → 'No firing alerts'", async () => {
    const empty = makeAlertsPayload({ scenario: "empty-healthy" });
    expect(firingRows(empty)).toHaveLength(0);
    const container = await mountTable(firingRows(empty), { sourcesCurrent: true });
    const state = container.querySelector('[data-slot="empty-state"]')!;
    expect(state.getAttribute("role")).toBe("status");
    expect(state.textContent).toContain("No firing alerts");
    expect(container.textContent).not.toContain("No rows");
    expect(container.querySelector("table")).toBeNull();
  });

  test("empty + degraded source → non-committal 'Firing alerts unavailable' (not all-clear)", async () => {
    const container = await mountTable([], { sourcesCurrent: false });
    expect(container.textContent).toContain("Firing alerts unavailable");
    expect(container.textContent).not.toContain("No firing alerts");
    expect(container.textContent).not.toContain("healthy.");
  });

  test("empty because of the filters → 'No alerts match these filters' (never the all-clear)", async () => {
    const container = await mountTable([], { sourcesCurrent: true, filtersExcludeAll: true });
    expect(container.textContent).toContain("No alerts match these filters");
    expect(container.textContent).not.toContain("No firing alerts");
    expect(container.textContent).not.toContain("Firing alerts unavailable");
  });

  test("renders without any fetch", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error("no fetch expected"));
    }) as unknown as typeof fetch;
    try {
      await mountTable(rows);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(0);
  });
});

describeDom("TriageTable virtualization", (dom) => {
  let restore: (() => void) | null = null;
  const live: (() => void)[] = [];
  beforeEach(() => {
    restore = stubVirtualViewport(TRIAGE_ROW_HEIGHT);
  });
  afterEach(() => {
    while (live.length > 0) live.pop()!();
    restore?.();
    restore = null;
  });

  async function mountMany(count: number): Promise<HTMLElement> {
    const { createElement: h, createRef } = await import("react");
    const { signal } = await import("@preact/signals-core");
    const { TriageTable } = await import("../src/client/views/alerts/table/TriageTable.js");
    const base = byFp(F.hostDown);
    const many: ActiveAlert[] = Array.from({ length: count }, (_, i) => ({ ...base, fingerprint: `fp-${i}`, name: `Alert ${i}` }));
    const { container, unmount } = await dom.mount(
      h(TriageTable, {
        rows: many,
        selectedIndex: signal(-1),
        onOpenAlert: () => {},
        sourcesCurrent: true,
        containerRef: createRef<HTMLDivElement>(),
      }) as unknown as ReactElement,
    );
    live.push(unmount);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return container;
  }

  test("5,000 rows render a window (<300 row controls) with aria-rowcount and a bounded sticky-header region", async () => {
    const container = await mountMany(5000);
    const root = container.querySelector('[data-slot="data-table"][data-virtualized]')!;
    expect(root).not.toBeNull();
    const viewport = root.querySelector('[data-slot="data-table-viewport"]')!;
    expect(viewport.getAttribute("role")).toBe("region");
    expect(viewport.getAttribute("class")).toContain("max-h-[70vh]");
    expect(root.querySelector("table")!.getAttribute("aria-rowcount")).toBe("5001");
    const controls = container.querySelectorAll("[data-triage-open]");
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.length).toBeLessThan(300);
    expect(controls[0]!.getAttribute("data-triage-open")).toBe("fp-0");
    // Header cells stick to the top of the table's own scroll region.
    for (const th of root.querySelectorAll("thead th")) expect(th.getAttribute("class")).toContain("sticky");
    expect(TRIAGE_ROW_HEIGHT).toBe(36);
  });

  test("virtualizes at the default 300-row threshold, not below it", async () => {
    const at = await mountMany(300);
    expect(at.querySelector('[data-slot="data-table"][data-virtualized]')).not.toBeNull();
    expect(at.querySelectorAll("[data-triage-open]").length).toBeLessThan(300);
    const below = await mountMany(299);
    expect(below.querySelector('[data-slot="data-table"]')!.hasAttribute("data-virtualized")).toBe(false);
    expect(below.querySelectorAll("[data-triage-open]").length).toBe(299);
  });
});
