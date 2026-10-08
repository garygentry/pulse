// apps/web/tests/estate-coverage-artifacts.test.tsx — the coverage tables' artifact count is a
// keyboard-reachable Popover listing the artifacts, not a `title` tooltip (issue #12).
import { expect, it } from "bun:test";
import type { CoverageEntry, WebCoverageArtifact } from "@pulse/renderer";

import { CoverageExplorer } from "../src/client/views/estate/coverage.js";
import { makeEstatePayloadFixture, presentSection } from "./factories/estate-payload.js";
import { describeUi, render, screen, userEvent, waitFor, within } from "./rtl.js";

function entry(name: string, artifacts: string[]): CoverageEntry {
  return { kind: "host", name, collectionClass: "managed-linux", artifacts, suppressed: null };
}

function payload() {
  const coverage: WebCoverageArtifact = {
    formatVersion: 2,
    bundleId: "b" as WebCoverageArtifact["bundleId"],
    covered: [entry("web-01", ["scrape/web-01.yml", "gatus/web-01.yml", "alerts/web-01.yml"]), entry("db-01", ["scrape/db-01.yml"])],
    gaps: [entry("nas-01", [])],
    suppressed: [],
  };
  return { ...makeEstatePayloadFixture(), coverage: presentSection(coverage) };
}

describeUi("estate coverage: artifact count", () => {
  it("is a button that opens a popover listing the artifacts; Escape returns focus to it", async () => {
    render(<CoverageExplorer payload={payload()} />);
    const trigger = screen.getByRole("button", { name: "3 artifacts for web-01" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("title");

    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const popover = await screen.findByRole("dialog", { name: "Artifacts for web-01" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const list = within(popover).getByRole("list", { name: "Artifacts for web-01" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "scrape/web-01.yml",
      "gatus/web-01.yml",
      "alerts/web-01.yml",
    ]);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("reaches the trigger with Tab and opens it with Space; one artifact reads singular", async () => {
    render(<CoverageExplorer payload={payload()} />);
    const first = screen.getByRole("button", { name: "3 artifacts for web-01" });
    first.focus();
    // The next artifact trigger is the next Tab stop in the covered table.
    await userEvent.tab();
    const single = screen.getByRole("button", { name: "1 artifact for db-01" });
    expect(single).toHaveFocus();
    await userEvent.keyboard(" ");
    const popover = await screen.findByRole("dialog", { name: "Artifacts for db-01" });
    expect(within(popover).getByRole("listitem")).toHaveTextContent("scrape/db-01.yml");
  });

  it("an entry with no artifacts shows a plain count, not a control", () => {
    render(<CoverageExplorer payload={payload()} />);
    const row = screen.getByRole("row", { name: /nas-01/ });
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(within(row).getAllByRole("cell")[4]).toHaveTextContent("0 artifacts");
  });
});
