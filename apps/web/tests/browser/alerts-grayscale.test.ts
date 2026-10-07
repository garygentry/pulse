// apps/web/tests/browser/alerts-grayscale.test.ts — grayscale-distinct statuses on the alerts view.
//
// With the whole page forced to grayscale, every status the alerts view shows — severity and state in
// the firing table, the degraded-source notice, rule health in the catalog — must still read without
// colour: each status badge carries a non-empty GLYPH (its lucide icon) and text LABEL, distinct statuses carry distinct glyphs, and badges
// of distinct statuses are distinct rendered pixels once colour is flattened.
// Run in BOTH themes.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";

import { browserDescribe } from "./_harness.js";
import { ALERTS_THEMES, openAlertsPages, type AlertsBrowserSession } from "./alerts-browser.js";

interface ChipRead {
  status: string | null;
  glyph: string;
  label: string;
}

/** Status presentations under `scope`: `@/ui` StatusBadges and status Callouts. */
const STATUS_SELECTOR = ['[data-slot="status-badge"][data-status]', '[data-slot="callout"][data-status]'];

async function readChips(page: Page, scope: string): Promise<ChipRead[]> {
  return page.evaluate(
    ({ sel, selectors }) =>
      Array.from(document.querySelectorAll(selectors.map((s) => `${sel} ${s}`).join(", "))).map((chip) => {
        const slot = chip.getAttribute("data-slot");
        const icon = /\blucide-[a-z0-9-]+/.exec(chip.querySelector("svg")?.getAttribute("class") ?? "")?.[0] ?? "";
        const label = slot === "callout" ? chip.querySelector('[data-slot="alert-title"]')?.textContent : chip.textContent;
        return { status: chip.getAttribute("data-status"), glyph: icon, label: label?.trim() ?? "" };
      }),
    { sel: scope, selectors: STATUS_SELECTOR },
  );
}

function expectGlyphAndLabel(chips: readonly ChipRead[]): void {
  expect(chips.length).toBeGreaterThan(0);
  for (const chip of chips) {
    expect(chip.status, JSON.stringify(chip)).toBeTruthy();
    expect(chip.glyph.length, `empty glyph: ${JSON.stringify(chip)}`).toBeGreaterThan(0);
    expect(chip.label.length, `empty label: ${JSON.stringify(chip)}`).toBeGreaterThan(0);
  }
}

/** One glyph per status: distinct statuses never share a glyph (the colour-free read). */
function expectDistinctGlyphs(chips: readonly ChipRead[]): Map<string, string> {
  const glyphByStatus = new Map<string, string>();
  for (const chip of chips) {
    const prior = glyphByStatus.get(chip.status!);
    if (prior !== undefined) expect(chip.glyph, `status ${chip.status} glyph varies`).toBe(prior);
    else glyphByStatus.set(chip.status!, chip.glyph);
  }
  const glyphs = [...glyphByStatus.values()];
  expect(new Set(glyphs).size, JSON.stringify([...glyphByStatus])).toBe(glyphs.length);
  return glyphByStatus;
}

browserDescribe()("browser: alerts view grayscale-distinct status, both themes", () => {
  let session: AlertsBrowserSession;

  beforeAll(async () => {
    session = await openAlertsPages({
      prepare: (page) => page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" }).then(() => {}),
    });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const theme of ALERTS_THEMES) {
    test(`firing table severity + state chips carry glyph + label (${theme})`, async () => {
      const chips = await readChips(session.page("mixed", theme), "[data-triage-table]");
      expectGlyphAndLabel(chips);
      const glyphs = expectDistinctGlyphs(chips);
      // The firing/silenced/inhibited mix spans critical, warning, info (its own tone) and suppressed.
      for (const status of ["critical", "warning", "info", "suppressed"]) expect(glyphs.has(status)).toBe(true);
      // Suppressed rows keep the bell marker.
      expect(glyphs.get("suppressed")).toBe("lucide-bell");
      const labels = chips.map((c) => c.label);
      for (const state of ["firing", "silenced", "inhibited"]) expect(labels).toContain(state);
    }, 60_000);

    test(`distinct statuses render as distinct pixels in grayscale (${theme})`, async () => {
      const page = session.page("mixed", theme);
      const seen = new Set<string>();
      const shots: Buffer[] = [];
      const chips = page.locator('[data-triage-table] [data-slot="status-badge"][data-status]');
      const count = await chips.count();
      for (let i = 0; i < count; i += 1) {
        const status = await chips.nth(i).getAttribute("data-status");
        if (status === null || seen.has(status)) continue;
        seen.add(status);
        shots.push(await chips.nth(i).screenshot());
      }
      expect(shots.length).toBeGreaterThanOrEqual(4);
      for (let a = 0; a < shots.length; a += 1) {
        for (let b = a + 1; b < shots.length; b += 1) {
          expect(shots[a]!.equals(shots[b]!), `status chips ${a} and ${b} are pixel-identical in grayscale`).toBe(false);
        }
      }
    }, 60_000);

    test(`degraded source notice reads by glyph + source-named label (${theme})`, async () => {
      const chips = await readChips(session.page("am-down", theme), "[data-source-status-group]");
      expectGlyphAndLabel(chips);
      expect(chips.every((c) => c.status === "unknown")).toBe(true);
      expect(chips.some((c) => c.label.includes("Alertmanager"))).toBe(true);
    }, 60_000);

    test(`catalog rule health chips carry glyph + health word (${theme})`, async () => {
      const chips = await readChips(session.page("catalog", theme), '[role="tabpanel"][data-tab="catalog"]');
      expectGlyphAndLabel(chips);
      expectDistinctGlyphs(chips);
      for (const chip of chips) expect(["healthy", "unhealthy", "unknown"]).toContain(chip.label);
    }, 60_000);
  }
});
