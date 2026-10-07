// apps/web/tests/estate-coverage.test.ts — the coverage explorer tab (spec 04, 09 §5.3;
// REQ-COV-01..03, REQ-DEG-02, REQ-A11Y-01, I3). Renders CoverageExplorer directly (props-driven,
// 09 §2.1) over the makeEstatePayloadFixture wire envelope.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import type { ReactElement } from "react";
import type { CoverageEntry, WebCoverageArtifact } from "@pulse/renderer";
import type { DeclaredScrapeComparison, EstatePayload } from "@pulse/web-data/wire";

import {
  aggregateClassTotals,
  NO_RATIONALE,
  partitionComparisons,
  rationaleText,
  resolveArtifact,
  toComparisonList,
} from "../src/client/views/estate/coverage-model.js";
import { CoverageExplorer } from "../src/client/views/estate/coverage.js";
import { STATUS_LABEL } from "../src/client/a11y/index.js";
import { describeDom } from "./dom.js";
import {
  absentSection,
  currentAvailability,
  makeComparison,
  makeEstatePayloadFixture,
  presentSection,
} from "./factories/estate-payload.js";

const COVERAGE_SRC = new URL("../src/client/views/estate/coverage.tsx", import.meta.url);

function entry(name: string, over: Partial<CoverageEntry> = {}): CoverageEntry {
  return { kind: "host", name, collectionClass: "managed-linux", artifacts: [], suppressed: null, ...over };
}

function artifact(over: Partial<WebCoverageArtifact> = {}): WebCoverageArtifact {
  return {
    formatVersion: 2,
    bundleId: "b" as WebCoverageArtifact["bundleId"],
    covered: [],
    gaps: [],
    suppressed: [],
    ...over,
  };
}

/** Replace the production-shaped directional comparison list. */
function withComparisons(list: readonly DeclaredScrapeComparison[], payload = makeEstatePayloadFixture()): EstatePayload {
  return { ...payload, declaredVersusScraped: presentSection(list) };
}

const BOTH_DIRECTIONS: readonly DeclaredScrapeComparison[] = [
  makeComparison({ drilldownId: "host:hostA-managed", state: "matched" }),
  makeComparison({ drilldownId: "host:hostB-hyper", state: "matched" }),
  makeComparison({ drilldownId: "host:hostD-probe", scrapeTarget: null, state: "missing", message: "not scraped" }),
  makeComparison({ drilldownId: "host:ghost", scrapeTarget: "10.9.9.9:9100", state: "unexpected", message: "undeclared" }),
  makeComparison({ drilldownId: "host:hostC-nas", state: "unknown", message: "discovery down" }),
];

const bucket = (c: HTMLElement, id: string): HTMLElement =>
  c.querySelector(`[data-testid="estate-coverage-bucket"][data-bucket="${id}"]`) as HTMLElement;

const bodyRows = (el: Element): Element[] => [...el.querySelectorAll("tbody tr")];

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("toComparisonList preserves the wire array and maps an absent value to empty", () => {
  const arr = [makeComparison(), makeComparison({ state: "missing" })];
  expect(toComparisonList(arr)).toBe(arr);
  expect(toComparisonList([])).toEqual([]);
  expect(toComparisonList(null)).toEqual([]);
});

test("partitionComparisons splits both directions + matched/unknown", () => {
  const p = partitionComparisons(BOTH_DIRECTIONS);
  expect(p.missing.map((c) => c.drilldownId)).toEqual(["host:hostD-probe"]);
  expect(p.unexpected.map((c) => c.drilldownId)).toEqual(["host:ghost"]);
  expect(p.matched).toHaveLength(2);
  expect(p.unknown).toHaveLength(1);
});

test("aggregateClassTotals tallies each bucket by collectionClass and sums to total", () => {
  const cov = makeEstatePayloadFixture().coverage.value as WebCoverageArtifact;
  const totals = aggregateClassTotals(cov);
  const byClass = new Map(totals.map((t) => [t.collectionClass, t]));
  expect(byClass.get("managed-linux")).toMatchObject({ covered: 2, gaps: 1, suppressed: 0, total: 3 });
  expect(byClass.get("nas-api")).toMatchObject({ covered: 1, gaps: 0, suppressed: 1, total: 2 });
  expect(byClass.get("excluded")).toMatchObject({ covered: 0, gaps: 0, suppressed: 1, total: 1 });
  for (const t of totals) expect(t.covered + t.gaps + t.suppressed).toBe(t.total);
  const all = cov.covered.length + cov.gaps.length + cov.suppressed.length;
  expect(totals.reduce((n, t) => n + t.total, 0)).toBe(all);
  // Deterministic order by class name.
  expect(totals.map((t) => t.collectionClass)).toEqual([...totals.map((t) => t.collectionClass)].sort());
});

test("rationaleText is `class: rationale`, with a non-blank fallback when suppression is missing", () => {
  expect(rationaleText(entry("x", { suppressed: { class: "excluded", rationale: "gone" } }))).toBe("excluded: gone");
  expect(rationaleText(entry("x"))).toBe(NO_RATIONALE);
  const blank = entry("x", { suppressed: { class: "known-expected", rationale: "  " } });
  expect(rationaleText(blank)).toBe("known-expected: no rationale recorded");
});

test("resolveArtifact: absent / empty / present(current) / present(stale), stale-empty stays present", () => {
  const isEmpty = (v: readonly number[]): boolean => v.length === 0;
  expect(resolveArtifact(absentSection<readonly number[]>("old tree"), isEmpty)).toEqual({
    kind: "absent",
    message: "old tree",
  });
  expect(resolveArtifact(presentSection<readonly number[]>([]), isEmpty)).toEqual({ kind: "empty" });
  expect(resolveArtifact(presentSection<readonly number[]>([1]), isEmpty)).toMatchObject({ kind: "present", stale: false });
  const stale = currentAvailability({ state: "stale" });
  expect(resolveArtifact(presentSection<readonly number[]>([1], stale), isEmpty)).toMatchObject({ stale: true });
  expect(resolveArtifact(presentSection<readonly number[]>([], stale), isEmpty)).toMatchObject({
    kind: "present",
    stale: true,
  });
});

test("coverage.tsx adds no @pulse/core import", () => {
  const src = readFileSync(COVERAGE_SRC, "utf8");
  expect(src).not.toMatch(/from\s+["']@pulse\/core/);
});

test("coverage.tsx imports UI only through the @/ui barrel and ships no CSS", () => {
  const src = readFileSync(COVERAGE_SRC, "utf8");
  expect(src).not.toMatch(/ui\/kit\.js/);
  expect(src).not.toMatch(/from\s+["']@\/ui\//);
  expect(src).not.toMatch(/\.css["']/);
  expect(src).toMatch(/from\s+"@\/ui";/);
  expect(existsSync(new URL("../src/client/views/estate/coverage.css", import.meta.url))).toBe(false);
});

// ── DOM ──────────────────────────────────────────────────────────────────────

describeDom("estate: coverage explorer", (dom) => {
  test("renders covered / gaps / suppressed buckets with count badges and intrinsic statuses (REQ-COV-01)", async () => {
    const payload = makeEstatePayloadFixture();
    const cov = payload.coverage.value as WebCoverageArtifact;
    const { container, unmount } = await dom.mount(createElement(CoverageExplorer, { payload }) as ReactElement);
    try {
      const expected = { covered: "ok", gaps: "warning", suppressed: "suppressed" } as const;
      for (const id of ["covered", "gaps", "suppressed"] as const) {
        const b = bucket(container, id);
        expect(b).not.toBeNull();
        const rows = bodyRows(b);
        expect(rows).toHaveLength(cov[id].length);
        cov[id].forEach((e, i) => {
          const row = rows[i] as Element;
          expect(row.textContent).toContain(e.name);
          // Artifact COUNT badge per row.
          const count = row.querySelector("[data-artifacts]") as Element;
          expect(count.textContent).toBe(String(e.artifacts.length));
          // The full artifact list stays available as non-colour title text.
          expect(count.getAttribute("title")).toBe(e.artifacts.join("\n"));
          const chip = row.querySelector('[data-slot="status-badge"][data-status]') as Element;
          expect(chip.getAttribute("data-status")).toBe(expected[id]);
          expect(chip.textContent).toBe(STATUS_LABEL[expected[id]]);
          expect(chip.querySelector("svg")).not.toBeNull();
        });
      }
      // A gap is a warning, never critical.
      expect(container.querySelector('[data-status="critical"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  test("every suppressed row shows class + rationale; a null suppression renders the fallback", async () => {
    const payload = makeEstatePayloadFixture();
    const { container, unmount } = await dom.mount(createElement(CoverageExplorer, { payload }) as ReactElement);
    try {
      const text = bucket(container, "suppressed").textContent ?? "";
      expect(text).toContain("excluded: decommissioned host");
      expect(text).toContain("expected-churn: ephemeral backups");
    } finally {
      unmount();
    }

    const odd = makeEstatePayloadFixture({
      coverage: presentSection(artifact({ suppressed: [entry("orphan")] })),
    });
    const m = await dom.mount(createElement(CoverageExplorer, { payload: odd }) as ReactElement);
    try {
      const cell = m.container.querySelector("[data-rationale]") as Element;
      expect(cell.textContent).toBe(NO_RATIONALE);
    } finally {
      m.unmount();
    }
  });

  test("class totals render as a Badge summary table (REQ-COV-02)", async () => {
    const payload = makeEstatePayloadFixture();
    const { container, unmount } = await dom.mount(createElement(CoverageExplorer, { payload }) as ReactElement);
    try {
      const panel = container.querySelector('[data-testid="estate-coverage-class-totals"]') as HTMLElement;
      const rows = bodyRows(panel);
      const totals = aggregateClassTotals(payload.coverage.value as WebCoverageArtifact);
      expect(rows).toHaveLength(totals.length);
      const managed = rows.find((r) => r.textContent?.startsWith("managed-linux")) as Element;
      expect([...managed.querySelectorAll("td")].map((c) => c.textContent)).toEqual(["2", "1", "0", "3"]);
    } finally {
      unmount();
    }
  });

  test("headings: Coverage / Declared vs scraped are h2 sections; totals, buckets and diff tables are h3 sections", async () => {
    const payload = withComparisons(BOTH_DIRECTIONS);
    const cov = payload.coverage.value as WebCoverageArtifact;
    const { container, unmount } = await dom.mount(createElement(CoverageExplorer, { payload }) as ReactElement);
    try {
      const heading = (sec: Element): Element => {
        expect(sec.tagName).toBe("SECTION");
        const h = container.querySelector(`#${CSS.escape(sec.getAttribute("aria-labelledby") ?? "")}`) as Element;
        expect(h).not.toBeNull();
        return h;
      };
      const coverage = container.querySelector('[data-section="coverage"]') as Element;
      const diff = container.querySelector('[data-section="diff"]') as Element;
      expect(heading(coverage).tagName).toBe("H2");
      expect(heading(coverage).textContent).toBe("Coverage");
      expect(heading(diff).tagName).toBe("H2");
      expect(heading(diff).textContent).toBe("Declared vs scraped");

      const totals = coverage.querySelector('[data-testid="estate-coverage-class-totals"]') as Element;
      expect(heading(totals).tagName).toBe("H3");
      expect(heading(totals).textContent).toBe("Class totals");
      expect(totals.querySelector("table caption")?.textContent).toBe("Class totals");
      expect([...totals.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
        "Class",
        "Covered",
        "Gaps",
        "Suppressed",
        "Total",
      ]);

      const titles = { covered: "Covered", gaps: "Gaps", suppressed: "Suppressed" } as const;
      for (const id of ["covered", "gaps", "suppressed"] as const) {
        const b = bucket(container, id);
        expect(coverage.contains(b)).toBe(true);
        expect(heading(b).tagName).toBe("H3");
        expect(heading(b).textContent).toBe(`${titles[id]} (${cov[id].length})`);
        expect(b.querySelector("table caption")?.textContent).toBe(titles[id]);
        const cols = [...b.querySelectorAll("thead th")].map((th) => th.textContent);
        expect(cols).toEqual(
          id === "suppressed"
            ? ["Status", "Entity", "Kind", "Class", "Artifacts", "Rationale"]
            : ["Status", "Entity", "Kind", "Class", "Artifacts"],
        );
        // The bucket status badge sits beside the heading, outside the table.
        const badges = [...b.querySelectorAll('[data-slot="status-badge"][data-status]')];
        expect(badges.some((el) => el.closest("table") === null)).toBe(true);
      }

      const missing = diff.querySelector('[data-testid="estate-diff-missing"]') as Element;
      const unexpected = diff.querySelector('[data-testid="estate-diff-unexpected"]') as Element;
      expect(missing.getAttribute("data-direction")).toBe("missing");
      expect(unexpected.getAttribute("data-direction")).toBe("unexpected");
      expect(heading(missing).tagName).toBe("H3");
      expect(heading(missing).textContent).toBe("Missing — declared, not scraped (1)");
      expect(heading(unexpected).tagName).toBe("H3");
      expect(heading(unexpected).textContent).toBe("Unexpected — scraped, not declared (1)");
      // No legacy kit/estate classes in the migrated markup.
      expect(container.querySelector('[class*="pulse-"], [class*="estate-"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  test("class totals lead with estate-wide StatTiles summing every class", async () => {
    const payload = makeEstatePayloadFixture();
    const cov = payload.coverage.value as WebCoverageArtifact;
    const { container, unmount } = await dom.mount(createElement(CoverageExplorer, { payload }) as ReactElement);
    try {
      const panel = container.querySelector('[data-testid="estate-coverage-class-totals"]') as HTMLElement;
      const tiles = [...panel.querySelectorAll('[data-slot="stat-tile"]')].map((t) => [
        t.querySelector("dt")?.textContent,
        t.querySelector("dd")?.textContent,
      ]);
      const all = cov.covered.length + cov.gaps.length + cov.suppressed.length;
      expect(tiles).toEqual([
        ["Covered", String(cov.covered.length)],
        ["Gaps", String(cov.gaps.length)],
        ["Suppressed", String(cov.suppressed.length)],
        ["Total", String(all)],
      ]);
    } finally {
      unmount();
    }
  });

  test("diff shows BOTH directions as tables with matched/unknown as counts (REQ-COV-03)", async () => {
    const payload = withComparisons(BOTH_DIRECTIONS);
    const { container, unmount } = await dom.mount(createElement(CoverageExplorer, { payload }) as ReactElement);
    try {
      const missing = container.querySelector('[data-testid="estate-diff-missing"]') as HTMLElement;
      const unexpected = container.querySelector('[data-testid="estate-diff-unexpected"]') as HTMLElement;
      expect(bodyRows(missing)).toHaveLength(1);
      expect(missing.textContent).toContain("host:hostD-probe");
      expect(missing.textContent).toContain("none declared");
      expect(bodyRows(unexpected)).toHaveLength(1);
      expect(unexpected.textContent).toContain("host:ghost");
      expect(unexpected.textContent).toContain("10.9.9.9:9100");
      for (const t of [missing, unexpected]) {
        expect(t.querySelector('tbody [data-slot="status-badge"][data-status="warning"]')).not.toBeNull();
      }
      // matched/unknown never get rows — only header counts.
      expect(missing.textContent).not.toContain("host:hostA-managed");
      expect(unexpected.textContent).not.toContain("host:hostC-nas");
      const matched = container.querySelector('[data-testid="estate-diff-matched-count"] [data-status]') as Element;
      const unknown = container.querySelector('[data-testid="estate-diff-unknown-count"] [data-status]') as Element;
      expect(matched.getAttribute("data-status")).toBe("ok");
      expect(matched.textContent).toContain("2 matched");
      expect(unknown.getAttribute("data-status")).toBe("unknown");
      expect(unknown.textContent).toContain("1 unknown");
    } finally {
      unmount();
    }
  });

  test("a one-row wire list renders the directional table", async () => {
    const payload = makeEstatePayloadFixture({
      declaredVersusScraped: presentSection([makeComparison({ state: "missing", drilldownId: "host:solo" })]),
    });
    const { container, unmount } = await dom.mount(createElement(CoverageExplorer, { payload }) as ReactElement);
    try {
      const missing = container.querySelector('[data-testid="estate-diff-missing"]') as HTMLElement;
      expect(bodyRows(missing)).toHaveLength(1);
      expect(missing.textContent).toContain("host:solo");
      expect(container.querySelector('[data-testid="estate-diff-unexpected"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("absent coverage/diff render the 're-render' state; present-but-empty renders the distinct clean state (REQ-DEG-02)", async () => {
    const absent = makeEstatePayloadFixture({
      coverage: absentSection<never>("tree predates coverage"),
      declaredVersusScraped: absentSection<readonly DeclaredScrapeComparison[]>("vm discovery absent"),
    });
    const a = await dom.mount(createElement(CoverageExplorer, { payload: absent }) as ReactElement);
    try {
      const cov = a.container.querySelector('[data-section="coverage"]') as HTMLElement;
      const diff = a.container.querySelector('[data-section="diff"]') as HTMLElement;
      for (const [sec, reason] of [[cov, "tree predates coverage"], [diff, "vm discovery absent"]] as const) {
        const deg = sec.querySelector('[data-degrade="absent"]') as HTMLElement;
        expect(deg).not.toBeNull();
        expect(deg.textContent).toContain("re-render to populate");
        expect(deg.textContent).toContain(reason);
        expect(sec.querySelector('[data-degrade="clean"]')).toBeNull();
      }
      expect(a.container.querySelector('[data-testid="estate-coverage-bucket"]')).toBeNull();
      expect(a.container.querySelector('[data-status="ok"]')).toBeNull();
    } finally {
      a.unmount();
    }

    const empty = withComparisons([], makeEstatePayloadFixture({ coverage: presentSection(artifact()) }));
    const e = await dom.mount(createElement(CoverageExplorer, { payload: empty }) as ReactElement);
    try {
      const cov = e.container.querySelector('[data-section="coverage"]') as HTMLElement;
      const diff = e.container.querySelector('[data-section="diff"]') as HTMLElement;
      for (const sec of [cov, diff]) {
        expect(sec.querySelector('[data-degrade="clean"]')).not.toBeNull();
        expect(sec.querySelector('[data-degrade="absent"]')).toBeNull();
        expect(sec.textContent).not.toContain("re-render");
      }
    } finally {
      e.unmount();
    }
  });

  test("stale availability renders WITH a StaleNote and downgrades every ok glyph to unknown (I3)", async () => {
    for (const state of ["stale", "unavailable", "not-configured"] as const) {
      const avail = currentAvailability({ state, message: `coverage ${state}` });
      const base = withComparisons(BOTH_DIRECTIONS);
      const payload: EstatePayload = {
        ...base,
        coverage: presentSection(base.coverage.value as WebCoverageArtifact, avail),
        declaredVersusScraped: { ...base.declaredVersusScraped, availability: avail },
      };
      const { container, unmount } = await dom.mount(createElement(CoverageExplorer, { payload }) as ReactElement);
      try {
        // Still rendered, with a stale note per section.
        expect(bodyRows(bucket(container, "covered")).length).toBeGreaterThan(0);
        for (const sec of ["coverage", "diff"]) {
          const note = container.querySelector(`[data-section="${sec}"] [role=status][data-availability]`);
          expect(note?.getAttribute("data-availability")).toBe(state);
        }
        // No green ok glyph anywhere.
        expect(container.querySelector('[data-status="ok"]')).toBeNull();
        for (const chip of bucket(container, "covered").querySelectorAll('[data-slot="status-badge"]')) {
          expect(chip.getAttribute("data-status")).toBe("unknown");
        }
        const matched = container.querySelector('[data-testid="estate-diff-matched-count"] [data-status]') as Element;
        expect(matched.getAttribute("data-status")).toBe("unknown");
        expect(container.querySelector('[data-slot="stat-tile"][data-tone="ok"]')).toBeNull();
        // Non-ok glyphs are left intact.
        expect(bucket(container, "gaps").querySelector('[data-status="warning"]')).not.toBeNull();
      } finally {
        unmount();
      }
    }
  });
});
