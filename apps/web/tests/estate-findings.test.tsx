// apps/web/tests/estate-findings.test.tsx — the findings tab. Renders FindingsTab directly
// (props-driven) over the makeEstatePayloadFixture wire envelope; the router is a recording stub.
// DOM assertions query by role / name / aria-* / data-* only.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AvailabilitySection } from "@pulse/web-data/wire";
import type { WebFindingsArtifact } from "@pulse/renderer";

import { mountAnnouncer } from "../src/client/a11y/announcer.js";
import type { PathRouter } from "../src/client/router.js";
import { FindingsTab } from "../src/client/views/estate/findings.js";
import {
  bucketBySeverity,
  compareBySeverity,
  distinctCodes,
  filterFindings,
  formatLocation,
  SEVERITY_PRESENTATION,
  SEVERITY_RANK,
} from "../src/client/views/estate/findings-model.js";
import type { Finding } from "../src/client/views/estate/findings-model.js";
import type { EstateQuery } from "../src/client/views/estate/types.js";
import { act, describeUi, render, screen, userEvent, within } from "./rtl.js";
import { absentSection, currentAvailability, makeEstatePayloadFixture, presentSection } from "./factories/estate-payload.js";

const FINDINGS_SRC = new URL("../src/client/views/estate/findings.tsx", import.meta.url);

const Q: EstateQuery = { tab: "findings", q: "", sev: "", code: "" };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    severity: "info",
    code: "web_unsafe_provenance",
    file: "hosts/a.yml",
    path: "hosts[0].name",
    message: "m",
    fix: "f",
    ...over,
  };
}

function artifact(findings: Finding[]): WebFindingsArtifact {
  return { formatVersion: 2, bundleId: "b" as WebFindingsArtifact["bundleId"], findings };
}

/** Scrambled wire order: sorted by FILE (as the wire does), not by severity. */
const SCRAMBLED: Finding[] = [
  finding({ file: "a.yml", severity: "info", message: "info-a" }),
  finding({ file: "b.yml", severity: "error", message: "error-b" }),
  finding({ file: "c.yml", severity: "warning", message: "warning-c" }),
  finding({ file: "d.yml", severity: "info", message: "info-d" }),
  finding({ file: "e.yml", severity: "error", message: "error-e", code: "web_url_userinfo_removed" }),
  finding({ file: "f.yml", severity: "warning", message: "warning-f", path: "" }),
];

function recordingRouter(): { router: PathRouter; calls: string[] } {
  const calls: string[] = [];
  const router = { navigate: (p: string) => void calls.push(p) } as unknown as PathRouter;
  return { router, calls };
}

const table = (): HTMLElement => screen.getByRole("table", { name: "Findings" });
/** Body rows of the findings table (the header row holds columnheaders, not cells). */
const bodyRows = (): HTMLElement[] =>
  within(table())
    .getAllByRole("row")
    .filter((r) => within(r).queryAllByRole("cell").length > 0);
const cellsOf = (row: HTMLElement): HTMLElement[] => within(row).getAllByRole("cell");
const messages = (): string[] => bodyRows().map((r) => cellsOf(r)[3]!.textContent ?? "");

async function waitForText(read: () => string | null, want: string, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (read() === want) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

const politeText = (): string | null =>
  (globalThis as { document: Document }).document.querySelector('#pulse-a11y-announcer [aria-live="polite"]')
    ?.textContent ?? null;

const filterBar = (): HTMLElement => screen.getByRole("search", { name: "Filter findings" });
const severitySelect = (): HTMLElement => within(filterBar()).getByRole("combobox", { name: "Severity" });
const codeSelect = (): HTMLElement => within(filterBar()).getByRole("combobox", { name: "Code" });

/** Open a Select from its trigger and pick an option from the portalled listbox. */
async function choose(trigger: HTMLElement, option: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(trigger);
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name: option }));
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("SEVERITY_RANK orders error < warning < info; compareBySeverity follows it", () => {
  expect(SEVERITY_RANK).toEqual({ error: 0, warning: 1, info: 2 });
  expect(compareBySeverity(finding({ severity: "error" }), finding({ severity: "info" }))).toBeLessThan(0);
  expect(compareBySeverity(finding({ severity: "info" }), finding({ severity: "warning" }))).toBeGreaterThan(0);
  expect(compareBySeverity(finding({ severity: "warning" }), finding({ severity: "warning" }))).toBe(0);
});

test("bucketBySeverity re-sorts a scrambled input error → warning → info, stable within a severity", () => {
  const input = [...SCRAMBLED];
  const out = bucketBySeverity(input);
  expect(out.map((f) => f.message)).toEqual(["error-b", "error-e", "warning-c", "warning-f", "info-a", "info-d"]);
  // Never mutates its input.
  expect(input).toEqual(SCRAMBLED);
  expect(out).not.toBe(input);
});

test("formatLocation is `file · path`, or file alone when path is ''", () => {
  expect(formatLocation(finding({ file: "hosts/web.yaml", path: "spec.scrape.port" }))).toBe(
    "hosts/web.yaml · spec.scrape.port",
  );
  expect(formatLocation(finding({ file: "hosts/web.yaml", path: "" }))).toBe("hosts/web.yaml");
});

test("filterFindings applies both axes; '' means no filter; unknown values match nothing", () => {
  expect(filterFindings(SCRAMBLED, Q)).toHaveLength(6);
  expect(filterFindings(SCRAMBLED, { ...Q, sev: "error" }).map((f) => f.message)).toEqual(["error-b", "error-e"]);
  expect(filterFindings(SCRAMBLED, { ...Q, code: "web_url_userinfo_removed" }).map((f) => f.message)).toEqual([
    "error-e",
  ]);
  expect(filterFindings(SCRAMBLED, { ...Q, sev: "warning", code: "web_url_userinfo_removed" })).toEqual([]);
  expect(filterFindings(SCRAMBLED, { ...Q, sev: "bogus" })).toEqual([]);
});

test("distinctCodes de-duplicates in first-seen order", () => {
  expect(distinctCodes(SCRAMBLED)).toEqual(["web_unsafe_provenance", "web_url_userinfo_removed"]);
});

test("severity presentation uses distinct glyphs, text labels, and existing status tokens", () => {
  const icons = Object.values(SEVERITY_PRESENTATION).map((p) => p.icon);
  expect(new Set(icons).size).toBe(3);
  expect(SEVERITY_PRESENTATION.error).toEqual({ label: "Error", icon: "circle-alert", token: "critical" });
  expect(SEVERITY_PRESENTATION.warning.token).toBe("warning");
  expect(SEVERITY_PRESENTATION.info.token).toBe("unknown");
});

test("findings.tsx never uses StatusChip/StatusDot/STATUS_LABEL or the provenance chip", () => {
  const src = readFileSync(FINDINGS_SRC, "utf8");
  expect(src).not.toMatch(/ui\/kit\.js/);
  expect(src).not.toMatch(/from "@\/ui\//);
  expect(src).not.toMatch(/\.css"/);
  for (const banned of ["StatusChip", "StatusDot", "STATUS_LABEL", "ProvenanceChip", "provenance-chip"]) {
    expect(src.includes(`import { ${banned}`) || new RegExp(`<${banned}\\b`).test(src)).toBe(false);
  }
  expect(src).not.toMatch(/from "\.\/provenance-chip\.js"/);
  expect(src).not.toMatch(/from "@pulse\/core"/);
});

// ── DOM ──────────────────────────────────────────────────────────────────────

describeUi("estate: findings tab", () => {
  const mountTab = (findings: AvailabilitySection<WebFindingsArtifact>, query: EstateQuery = Q, router?: PathRouter) =>
    render(<FindingsTab findings={findings} query={query} router={router ?? recordingRouter().router} />);

  test("renders a level-2 'Findings' section with one row per finding: severity, code, location, message, fix", () => {
    const payload = makeEstatePayloadFixture();
    const wire = payload.findings.value!.findings;
    mountTab(payload.findings);
    const heading = screen.getByRole("heading", { level: 2, name: "Findings" });
    const region = heading.closest("section") as HTMLElement;
    expect(region.getAttribute("data-testid")).toBe("estate-findings");
    expect(region.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Severity",
      "Code",
      "Location",
      "Message",
      "Fix",
    ]);
    const rows = bodyRows();
    expect(rows).toHaveLength(wire.length);
    const cells = cellsOf(rows[0]!);
    expect(cells).toHaveLength(5);
    const sev = cells[0]!.querySelector("[data-severity]") as HTMLElement;
    expect(sev.getAttribute("data-severity")).toBe("error");
    expect(sev.getAttribute("data-slot")).toBe("status-badge");
    expect(sev.querySelector("svg")).not.toBeNull();
    expect(sev.textContent).toBe("Error");
    expect(cells[1]!.textContent).toBe("web_unsafe_provenance");
    expect(cells[1]!.querySelector("[data-code]")?.getAttribute("data-code")).toBe("web_unsafe_provenance");
    expect(cells[2]!.querySelector("[data-location]")!.textContent).toBe("hosts/hostA.yml · hosts[0].name");
    expect(cells[3]!.textContent).toBe("provenance escaped the estate root");
    expect(cells[4]!.textContent).toBe("re-render with 'pulse render'");
    // No filter active → no result count.
    expect(within(filterBar()).queryByRole("status")).toBeNull();
  });

  test("severity badges take tone/glyph from the alert-severity map and carry data-severity + data-status", () => {
    mountTab(presentSection(artifact(SCRAMBLED)));
    const badges = [...table().querySelectorAll<HTMLElement>("[data-slot=status-badge][data-severity]")];
    const by = new Map(badges.map((b) => [b.getAttribute("data-severity"), b]));
    expect([...by.keys()].sort()).toEqual(["error", "info", "warning"]);
    const expectBadge = (sev: string, tone: string, status: string, label: string): void => {
      const b = by.get(sev)!;
      expect(b.getAttribute("data-tone")).toBe(tone);
      expect(b.getAttribute("data-status")).toBe(status);
      expect(b.textContent).toBe(label);
    };
    expectBadge("error", "danger", "critical", "Error");
    expectBadge("warning", "warn", "warning", "Warning");
    expectBadge("info", "info", "unknown", "Info");
    // Each severity has its own glyph shape.
    const glyphs = new Set([...by.values()].map((b) => b.querySelector("svg")!.innerHTML));
    expect(glyphs.size).toBe(3);
  });

  test("location is plain text with no provenance chip and no :line; empty path shows file alone", () => {
    const payload = makeEstatePayloadFixture();
    const { container } = mountTab(payload.findings);
    expect(container.querySelector("[data-provenance-file]")).toBeNull();
    expect(within(table()).queryAllByRole("button")).toHaveLength(0);
    const locs = [...table().querySelectorAll("[data-location]")].map((el) => el.textContent);
    expect(locs).toContain("services/grafana.yml");
    for (const loc of locs) expect(loc).not.toMatch(/:\d+/);
    expect(container.textContent ?? "").not.toMatch(/\.ya?ml:\d+/);
  });

  test("a scrambled wire array renders error → warning → info, stable within a severity", () => {
    mountTab(presentSection(artifact(SCRAMBLED)));
    expect(messages()).toEqual(["error-b", "error-e", "warning-c", "warning-f", "info-a", "info-d"]);
    const sevs = bodyRows().map((r) => r.querySelector("[data-severity]")!.getAttribute("data-severity"));
    expect(sevs).toEqual(["error", "error", "warning", "warning", "info", "info"]);
  });

  test("the filters are two labelled selects in a 'Filter findings' bar, defaulting to All", async () => {
    mountTab(presentSection(artifact(SCRAMBLED)));
    expect(severitySelect().getAttribute("data-testid")).toBe("estate-findings-sev");
    expect(codeSelect().getAttribute("data-testid")).toBe("estate-findings-code");
    expect(severitySelect().textContent).toBe("All severities");
    expect(codeSelect().textContent).toBe("All codes");

    const user = userEvent.setup();
    await user.click(codeSelect());
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "All codes",
      "web_unsafe_provenance",
      "web_url_userinfo_removed",
    ]);
    await user.keyboard("{Escape}");
  });

  test("?sev= and ?code= are read from the query into the selects, filter rows, and show a result count", () => {
    const q: EstateQuery = { ...Q, sev: "error", code: "web_url_userinfo_removed" };
    mountTab(presentSection(artifact(SCRAMBLED)), q);
    expect(severitySelect().textContent).toBe("Error");
    expect(codeSelect().textContent).toBe("web_url_userinfo_removed");
    expect(messages()).toEqual(["error-e"]);
    // Plain text, not a second live region: navigateFilter announces each change.
    const count = filterBar().querySelector("[data-result-count]");
    expect(count?.textContent).toBe("Showing 1 of 6 findings; 5 hidden by filters.");
    expect(within(filterBar()).queryByRole("status") === null).toBe(true);
  });

  test("choosing a filter navigates with the FULL query rebuilt and announces", async () => {
    mountAnnouncer();
    const { router, calls } = recordingRouter();
    const q: EstateQuery = { tab: "findings", q: "web", sev: "", code: "web_unsafe_provenance" };
    mountTab(presentSection(artifact(SCRAMBLED)), q, router);

    await choose(severitySelect(), "Warning");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!, "http://x");
    expect(url.pathname).toBe("/estate");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tab: "findings",
      q: "web",
      sev: "warning",
      code: "web_unsafe_provenance",
    });
    await waitForText(politeText, "Findings severity filter: warning");
    expect(politeText()).toBe("Findings severity filter: warning");

    // "All codes" maps back to the empty filter: the code param leaves the URL.
    await choose(codeSelect(), "All codes");
    expect(calls).toHaveLength(2);
    const url2 = new URL(calls[1]!, "http://x");
    expect(Object.fromEntries(url2.searchParams)).toEqual({ tab: "findings", q: "web" });
    await waitForText(politeText, "Findings code filter cleared");
    expect(politeText()).toBe("Findings code filter cleared");
  });

  test("a filter matching nothing shows the distinct 'no matches' state with a Clear-filters action", async () => {
    const { router, calls } = recordingRouter();
    const q: EstateQuery = { ...Q, sev: "warning", code: "web_url_userinfo_removed" };
    const { container } = mountTab(presentSection(artifact(SCRAMBLED)), q, router);
    const noMatch = container.querySelector('[data-testid="estate-findings-no-matches"]') as HTMLElement;
    expect(noMatch).not.toBeNull();
    expect(noMatch.getAttribute("data-status")).toBe("unknown");
    expect(within(noMatch).getByText("No findings match the current filter")).toBeDefined();
    expect(container.querySelector('[data-degrade="clean"]')).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(filterBar().querySelector("[data-result-count]")?.textContent).toBe("Showing 0 of 6 findings; 6 hidden by filters.");
    await act(async () => {
      within(noMatch).getByRole("button", { name: "Clear filters" }).click();
    });
    expect(calls).toEqual(["/estate?tab=findings"]);
  });

  test("findings.value===null shows the 're-render to populate' absent state, distinct from clean", () => {
    const absent = mountTab(absentSection<WebFindingsArtifact>("no findings artifact in this tree"));
    const el = absent.container.querySelector('[data-degrade="absent"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.textContent).toContain("re-render to populate");
    expect(el.textContent).toContain("no findings artifact in this tree");
    expect(absent.container.querySelector('[data-degrade="clean"]')).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Findings" })).toBeDefined();
    expect(screen.queryByText(/No findings/)).toBeNull();
    absent.unmount();

    const clean = mountTab(presentSection(artifact([])));
    const cl = clean.container.querySelector('[data-degrade="clean"]') as HTMLElement;
    expect(cl).not.toBeNull();
    expect(cl.textContent).toContain("No findings");
    expect(clean.container.querySelector('[data-degrade="absent"]')).toBeNull();
    expect(screen.queryByRole("search", { name: "Filter findings" })).toBeNull();
  });

  test("a stale or unavailable availability renders findings WITH a StaleNote", () => {
    for (const state of ["stale", "unavailable"] as const) {
      const section = presentSection(artifact(SCRAMBLED), currentAvailability({ state, message: "last render is old" }));
      const { container, unmount } = mountTab(section);
      const note = container.querySelector("[role=status][data-availability]") as HTMLElement;
      expect(note).not.toBeNull();
      expect(note.getAttribute("data-availability")).toBe(state);
      expect(bodyRows()).toHaveLength(SCRAMBLED.length);
      unmount();
    }
    // Current data carries no stale note.
    const cur = mountTab(presentSection(artifact(SCRAMBLED)));
    expect(cur.container.querySelector("[role=status][data-availability]")).toBeNull();
  });

  test("stale-but-empty never shows the reassuring clean state", () => {
    const section = presentSection(artifact([]), currentAvailability({ state: "stale", message: "old" }));
    const { container } = mountTab(section);
    expect(container.querySelector('[data-degrade="clean"]')).toBeNull();
    expect(container.querySelector("[role=status][data-availability]")).not.toBeNull();
    const empty = container.querySelector('[data-testid="estate-findings-stale-empty"]') as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.getAttribute("data-status")).toBe("unknown");
    expect(within(empty).getByText("No findings in the last available render")).toBeDefined();
    // Filters still render (no result count: nothing to filter).
    expect(within(filterBar()).queryByRole("status")).toBeNull();
  });
});
