// apps/web/tests/browser/timeline-grayscale.test.ts — REQ-A11Y-01 (08 §4.3).
//
// With the whole page forced to grayscale, every status the timeline view shows on the incident page —
// the lane tree rows, the lane legend, the swimlane severity rows and the lane plots themselves — must
// still read without colour: each status badge (lane rows, legend, swimlane heads) carries a
// non-empty GLYPH (the badge's icon shape) and text LABEL, distinct statuses carry distinct glyphs and
// labels, legend entries are distinct words, and each plotted lane is named
// with its worst-in-view status in words (partial / unmatched evidence also get dashed outlines).
// Run in BOTH themes.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";

import { browserDescribe } from "./_harness.js";
import { TIMELINE_THEMES, openTimelinePages, type TimelineBrowserSession } from "./timeline-browser.js";

interface DotRead {
  status: string | null;
  glyph: string;
  label: string;
}

/** Read the first StatusBadge under each element matching `sel`: its status, icon shape and visible text. */
async function readBadges(page: Page, sel: string): Promise<(DotRead & { owner: string | null })[]> {
  return page.evaluate(
    (s) =>
      Array.from(document.querySelectorAll(s)).map((el) => {
        const badge = el.querySelector('[data-slot="status-badge"]');
        return {
          owner: el.getAttribute("data-status") ?? el.getAttribute("data-severity"),
          status: badge?.getAttribute("data-status") ?? null,
          glyph: badge?.querySelector('svg[data-slot="icon"]')?.innerHTML.trim() ?? "",
          label: badge?.textContent?.trim() ?? "",
        };
      }),
    sel,
  );
}

function expectGlyphAndLabel(dots: readonly DotRead[]): void {
  expect(dots.length).toBeGreaterThan(0);
  for (const dot of dots) {
    expect(dot.status, JSON.stringify(dot)).toBeTruthy();
    expect(dot.glyph.length, `empty glyph: ${JSON.stringify(dot)}`).toBeGreaterThan(0);
    expect(dot.label.length, `empty label: ${JSON.stringify(dot)}`).toBeGreaterThan(0);
  }
}

/** One glyph and one label per status; distinct statuses never share either (the colour-free read). */
function expectDistinctPerStatus(dots: readonly DotRead[]): Map<string, DotRead> {
  const byStatus = new Map<string, DotRead>();
  for (const dot of dots) {
    const prior = byStatus.get(dot.status!);
    if (prior !== undefined) {
      expect(dot.glyph, `status ${dot.status} glyph varies`).toBe(prior.glyph);
      expect(dot.label, `status ${dot.status} label varies`).toBe(prior.label);
    } else byStatus.set(dot.status!, dot);
  }
  const reps = [...byStatus.values()];
  expect(new Set(reps.map((r) => r.glyph)).size, JSON.stringify(reps)).toBe(reps.length);
  expect(new Set(reps.map((r) => r.label)).size, JSON.stringify(reps)).toBe(reps.length);
  return byStatus;
}

browserDescribe()("browser: timeline view grayscale-distinct status, both themes (REQ-A11Y-01)", () => {
  let session: TimelineBrowserSession;

  beforeAll(async () => {
    session = await openTimelinePages({
      prepare: (page) => page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" }).then(() => {}),
    });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const theme of TIMELINE_THEMES) {
    test(`REQ-A11Y-01: the grayscale filter really applies to the incident page (${theme})`, async () => {
      const filter = await session.page("incident", theme).evaluate(() => getComputedStyle(document.documentElement).filter);
      expect(filter).toContain("grayscale");
    }, 60_000);

    test(`REQ-A11Y-01: lane tree rows read by glyph + label, one glyph and label per status (${theme})`, async () => {
      const rows = await readBadges(session.page("incident", theme), "[data-tree-row][data-status]");
      expectGlyphAndLabel(rows);
      for (const row of rows) expect(row.status, `row dot disagrees with row: ${JSON.stringify(row)}`).toBe(row.owner);
      const byStatus = expectDistinctPerStatus(rows);
      expect(byStatus.size, JSON.stringify([...byStatus])).toBeGreaterThanOrEqual(2);
      expect(byStatus.has("critical"), JSON.stringify([...byStatus])).toBe(true);
    }, 60_000);

    test(`REQ-A11Y-01: the lane legend entries are distinct words, status entries glyph + label (${theme})`, async () => {
      const page = session.page("incident", theme);
      const items = await page.evaluate(() =>
        Array.from(document.querySelectorAll('ul[aria-label="Status lane legend"] > li')).map((li) => li.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      );
      expect(items.length, JSON.stringify(items)).toBeGreaterThanOrEqual(5);
      for (const text of items) expect(text.length, JSON.stringify(items)).toBeGreaterThan(0);
      expect(new Set(items).size, `legend items repeat: ${JSON.stringify(items)}`).toBe(items.length);
      const dots = await readBadges(page, 'ul[aria-label="Status lane legend"] > li:has([data-slot="status-badge"])');
      expect(dots.length, JSON.stringify(dots)).toBe(4);
      expectGlyphAndLabel(dots);
      expectDistinctPerStatus(dots);
      for (const status of ["ok", "warning", "critical", "unknown"]) {
        expect(dots.some((d) => d.status === status), `legend missing ${status}: ${JSON.stringify(dots)}`).toBe(true);
      }
    }, 60_000);

    test(`REQ-A11Y-01: swimlane severity rows carry glyph + distinct text labels (${theme})`, async () => {
      const heads = await readBadges(session.page("incident", theme), '[data-slot="timeline-swim-head"][data-severity]');
      expectGlyphAndLabel(heads);
      const labels = heads.map((h) => h.label);
      expect(new Set(labels).size, `severity labels repeat: ${JSON.stringify(heads)}`).toBe(labels.length);
      // Heads render through the alert-severity map: each badge names its row's severity, and every
      // severity (info included, now with its own tone) has its own glyph.
      for (const h of heads) expect(h.status, JSON.stringify(heads)).toBe(h.owner);
      expect(new Set(heads.map((h) => h.glyph)).size, `severity glyphs repeat: ${JSON.stringify(heads)}`).toBe(heads.length);
      for (const word of ["Critical", "Warning", "Info", "Unknown severity"]) {
        expect(labels, JSON.stringify(heads)).toContain(word);
      }
    }, 60_000);

    test(`REQ-A11Y-01: lane plots name each lane's worst status in words; partial/unmatched get dashed outlines (${theme})`, async () => {
      const page = session.page("incident", theme);
      const read = await page.evaluate(() => {
        const lanes = Array.from(
          document.querySelectorAll('[data-slot="timeline-lanes"] svg[role="img"] g[data-lane][role="group"]'),
        ).map((g) => ({
          label: g.getAttribute("aria-label") ?? "",
          statuses: Array.from(new Set(Array.from(g.querySelectorAll("rect[data-status]")).map((r) => r.getAttribute("data-status")))),
        }));
        const rowTitles = Array.from(document.querySelectorAll("[data-tree-row][data-status]")).map((r) => ({
          status: r.getAttribute("data-status"),
          title: r.getAttribute("title") ?? "",
          text: r.querySelector('[data-slot="status-badge"]')?.textContent?.trim() ?? "",
        }));
        const dashed = (sel: string): string[] =>
          Array.from(document.querySelectorAll(sel)).map((el) => getComputedStyle(el).strokeDasharray);
        return {
          lanes,
          rowTitles,
          partialDash: dashed('[data-deco="partial"]'),
          unmatchedDash: dashed('[data-deco="unmatched"]'),
          partialRows: document.querySelectorAll('[data-tree-row][data-partial="true"]').length,
        };
      });
      const msg = JSON.stringify(read);
      // Every plotted lane is a named group whose name carries its worst-in-view status in words.
      expect(read.lanes.length, msg).toBeGreaterThan(0);
      for (const lane of read.lanes) expect(lane.label, msg).toMatch(/worst in view \S/);
      // Every tree row's title repeats that worded status (the visible, colour-free lane reading).
      for (const row of read.rowTitles) expect(row.title, msg).toContain(`worst in view: ${row.text}`);
      // Lanes whose worst status differs are distinguishable by name alone.
      const texts = new Set(read.rowTitles.map((r) => r.text));
      expect(texts.size, msg).toBeGreaterThanOrEqual(2);
      // Partial evidence and unmatched alert intervals are marked by dashed outlines, not colour.
      if (read.partialRows > 0) {
        expect(read.partialDash.length, msg).toBeGreaterThan(0);
        for (const d of read.partialDash) expect(d, msg).not.toBe("none");
      }
      expect(read.unmatchedDash.length, msg).toBeGreaterThan(0);
      for (const d of read.unmatchedDash) expect(d, msg).not.toBe("none");
    }, 60_000);
  }
});
