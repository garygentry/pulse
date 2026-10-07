// apps/web/tests/browser/engine-grayscale.test.ts — REQ-A11Y-01 (08 §4.3).
//
// With the whole page forced to grayscale, every status the engine view shows — the verdict banner,
// the four component states (healthy / unreachable / unknown / not-configured) and every other
// status indicator on the degraded page — must still read without colour: each indicator carries a
// non-empty GLYPH and text LABEL, a glyph never stands for two statuses, and the four component
// states are distinct rendered pixels once colour is flattened. Run in BOTH themes.
//
// Two indicator kinds are read while the page is mid-migration: legacy StatusChips (the glyph is the
// unicode glyph) and `@/ui` StatusBadges (the glyph is the lucide icon). Engine `not-configured`
// shares the `unknown` status and is told apart by its `minus` icon and its word.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";

import { browserDescribe } from "./_harness.js";
import { ENGINE_THEMES, openEnginePages, type EngineBrowserSession } from "./engine-browser.js";

interface ChipRead {
  status: string | null;
  glyph: string;
  label: string;
  /** `data-presentation` of the nearest component/deadman header, if any. */
  presentation: string | null;
}

/** Every status indicator under `scope`: `@/ui` status badges and the verdict Callout (icon + word). */
async function readChips(page: Page, scope: string): Promise<ChipRead[]> {
  return page.evaluate(
    (sel) =>
      Array.from(
        document.querySelectorAll(`${sel} [data-slot="status-badge"], ${sel} [data-slot="callout"][role="status"][data-status]`),
      ).map((chip) => {
        const icon = /\blucide-[a-z0-9-]+/.exec(chip.querySelector("svg")?.getAttribute("class") ?? "")?.[0] ?? "";
        return {
          status: chip.getAttribute("data-status"),
          glyph: icon,
          label: (chip.querySelector("[data-verdict-word]") ?? chip).textContent?.trim() ?? "",
          presentation: chip.closest("[data-presentation]")?.getAttribute("data-presentation") ?? null,
        };
      }),
    scope,
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

/** A glyph never stands for two statuses (the colour-free read). Returns the statuses seen. */
function expectGlyphsIdentifyStatus(chips: readonly ChipRead[]): Set<string> {
  const statusByGlyph = new Map<string, string>();
  for (const chip of chips) {
    const prior = statusByGlyph.get(chip.glyph);
    if (prior !== undefined) expect(chip.status, `glyph ${chip.glyph} is shared by ${prior} and ${chip.status}`).toBe(prior);
    else statusByGlyph.set(chip.glyph, chip.status!);
  }
  return new Set(chips.map((c) => c.status!));
}

const COMPONENT_BADGES = '[data-region="components"] li[data-component] [data-presentation]';
const COMPONENT_KINDS = ["healthy", "unreachable", "unknown", "not-configured"] as const;

browserDescribe()("browser: engine view grayscale-distinct status, both themes (REQ-A11Y-01)", () => {
  let session: EngineBrowserSession;

  beforeAll(async () => {
    session = await openEnginePages({
      prepare: (page) => page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" }).then(() => {}),
    });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const theme of ENGINE_THEMES) {
    test(`REQ-A11Y-01: verdict banner reads by glyph + label (${theme})`, async () => {
      const page = session.page("degraded", theme);
      const verdict = await page.locator("[data-verdict]").first().getAttribute("data-verdict");
      expect(verdict).toBe("degraded");
      const chips = await readChips(page, "[data-verdict]");
      expectGlyphAndLabel(chips);
    }, 60_000);

    test(`REQ-A11Y-01: the four component states carry distinct glyphs + labels (${theme})`, async () => {
      const components = await readChips(session.page("degraded", theme), COMPONENT_BADGES);
      expectGlyphAndLabel(components);
      const presentations = new Set(components.map((c) => c.presentation));
      expect(presentations.size, JSON.stringify(components)).toBeGreaterThanOrEqual(4);
      for (const kind of COMPONENT_KINDS) {
        expect(presentations.has(kind), `missing presentation ${kind}: ${JSON.stringify(components)}`).toBe(true);
      }
      // One representative badge per state: four states, four glyphs, four labels.
      const byKind = new Map<string, ChipRead>();
      for (const c of components) if (c.presentation !== null && !byKind.has(c.presentation)) byKind.set(c.presentation, c);
      const reps = COMPONENT_KINDS.map((k) => byKind.get(k)!);
      expect(new Set(reps.map((r) => r.glyph)).size, JSON.stringify(reps)).toBe(4);
      expect(new Set(reps.map((r) => r.label)).size, JSON.stringify(reps)).toBe(4);
      expectGlyphsIdentifyStatus(components);
    }, 60_000);

    test(`REQ-A11Y-01: every status indicator on the page carries glyph + label, no glyph shared across statuses (${theme})`, async () => {
      const chips = await readChips(session.page("degraded", theme), "body");
      expectGlyphAndLabel(chips);
      const statuses = expectGlyphsIdentifyStatus(chips);
      // The engine page has no suppressed status: not-configured reads as unknown.
      for (const status of ["ok", "warning", "critical", "unknown"]) {
        expect(statuses.has(status), `missing status ${status}: ${JSON.stringify([...statuses])}`).toBe(true);
      }
    }, 60_000);

    test(`REQ-A11Y-01: distinct component states render as distinct pixels in grayscale (${theme})`, async () => {
      const page = session.page("degraded", theme);
      const shots: Buffer[] = [];
      for (const kind of COMPONENT_KINDS) {
        const badge = page.locator(`[data-region="components"] li[data-component] [data-presentation="${kind}"] [data-slot="status-badge"]`).first();
        shots.push(await badge.screenshot());
      }
      expect(shots.length).toBe(4);
      for (let a = 0; a < shots.length; a += 1) {
        for (let b = a + 1; b < shots.length; b += 1) {
          expect(shots[a]!.equals(shots[b]!), `component badges ${COMPONENT_KINDS[a]} and ${COMPONENT_KINDS[b]} are pixel-identical in grayscale`).toBe(false);
        }
      }
    }, 60_000);
  }
});
