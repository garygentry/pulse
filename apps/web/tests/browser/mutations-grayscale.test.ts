// apps/web/tests/browser/mutations-grayscale.test.ts — REQ-A11Y-04, REQ-UX-04 (10 §6; 09 §5.3, §9.1).
//
// With the whole page forced to grayscale, the three action-state badges (acked / pending / failed) must
// still read without colour: each carries a distinct GLYPH (lucide icon) and a distinct visible LABEL,
// and the three render as distinct pixels once colour is flattened. Contrast is measured on the real
// computed colours (a filter does not change computed style): every badge's text on its fill, and the
// primary / secondary / danger ActionButton text on its fill (translucent fills composited over the
// backgrounds beneath them) is ≥ 4.5:1 (WCAG AA, normal text).
// Run in BOTH themes.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { converter, parse } from "culori";
import type { Page } from "playwright-core";

import { browserDescribe } from "./_harness.js";
import { MUTATIONS_THEMES, openMutationsPages, type MutationsBrowserSession } from "./mutations-browser.js";

const AA_TEXT = 4.5;

interface BadgeRead {
  state: string | null;
  glyph: string;
  label: string;
}

function readBadges(page: Page): Promise<BadgeRead[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-state] > [data-slot="status-badge"]')).map((badge) => ({
      state: badge.parentElement!.getAttribute("data-state"),
      glyph: Array.from(badge.querySelector("svg")?.classList ?? [])
        .find((c) => c.startsWith("lucide-") && c !== "lucide-icon") ?? "",
      label: badge.textContent?.trim() ?? "",
    })),
  );
}

type Rgb = readonly [number, number, number];

/** Computed foreground + background of every element matching `selector` (opaque rgb only). */
function readPairs(page: Page, selector: string): Promise<Array<{ what: string; fg: string; bg: string }>> {
  return page.evaluate((sel) =>
    Array.from(document.querySelectorAll<HTMLElement>(sel)).map((el) => {
      const cs = getComputedStyle(el);
      return { what: `${el.className} "${el.textContent?.trim() ?? ""}"`, fg: cs.color, bg: cs.backgroundColor };
    }), selector);
}

/**
 * Computed foreground plus the background stack (the element, then each ancestor up to <html>) of every
 * element matching `selector`, for elements whose fill may be translucent.
 */
function readStacks(page: Page, selector: string): Promise<Array<{ what: string; fg: string; bgs: string[] }>> {
  return page.evaluate((sel) =>
    Array.from(document.querySelectorAll<HTMLElement>(sel)).map((el) => {
      const bgs: string[] = [];
      for (let n: HTMLElement | null = el; n !== null; n = n.parentElement) bgs.push(getComputedStyle(n).backgroundColor);
      return { what: `${el.getAttribute("data-variant") ?? ""} "${el.textContent?.trim() ?? ""}"`, fg: getComputedStyle(el).color, bgs };
    }), selector);
}

const toRgb = converter("rgb");

/** Source-over composite of `top` onto the opaque `under`. */
function over(top: string, under: Rgb): Rgb {
  const c = toRgb(parse(top));
  if (c === undefined) throw new Error(`unparseable colour: ${top}`);
  const a = c.alpha ?? 1;
  const ch = [c.r, c.g, c.b].map((v) => Math.min(255, Math.max(0, v * 255)));
  return [0, 1, 2].map((i) => ch[i]! * a + under[i]! * (1 - a)) as unknown as Rgb;
}

/** The opaque colour seen behind an element: its background stack composited bottom-up over white canvas. */
function effectiveBg(bgs: readonly string[]): Rgb {
  return [...bgs].reverse().reduce<Rgb>((acc, bg) => over(bg, acc), [255, 255, 255]);
}

/** Parse a computed colour (rgb() or the oklch() theme tokens resolve to) into 0–255 channels. */
function parseRgb(css: string): Rgb {
  const c = toRgb(parse(css));
  if (c === undefined) throw new Error(`unparseable colour: ${css}`);
  if (c.alpha !== undefined && c.alpha !== 1) throw new Error(`translucent colour: ${css}`);
  const clamp = (v: number): number => Math.min(255, Math.max(0, v * 255));
  return [clamp(c.r), clamp(c.g), clamp(c.b)];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

browserDescribe()("browser: action-state badges read without colour and meet AA, both themes (REQ-A11Y-04, REQ-UX-04)", () => {
  let session: MutationsBrowserSession;

  beforeAll(async () => {
    session = await openMutationsPages({
      prepare: (page) => page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" }).then(() => {}),
    });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const theme of MUTATIONS_THEMES) {
    test(`acked / pending / failed badges differ by glyph and label under grayscale (${theme}) (REQ-A11Y-04, REQ-UX-04)`, async () => {
      const page = await session.fresh("badges", theme);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).filter)).toBe("grayscale(1)");
      const badges = await readBadges(page);
      expect(badges.map((b) => b.state)).toEqual(["acked", "pending", "failed"]);
      for (const b of badges) {
        expect(b.glyph, `no glyph: ${JSON.stringify(b)}`).not.toBe("");
        expect(b.label, `no label: ${JSON.stringify(b)}`).not.toBe("");
      }
      expect(new Set(badges.map((b) => b.glyph)).size).toBe(3);
      expect(new Set(badges.map((b) => b.label)).size).toBe(3);
      expect(badges.map((b) => b.glyph)).toEqual(["lucide-circle-check", "lucide-clock", "lucide-circle-alert"]);
      expect(badges.map((b) => b.label)).toEqual(["Acknowledged", "Pending", "Failed"]);
    }, 60_000);

    test(`the three badges are distinct pixels in grayscale (${theme}) (REQ-A11Y-04)`, async () => {
      const page = await session.fresh("badges", theme);
      const loc = page.locator('[data-state] > [data-slot="status-badge"]');
      const shots: Buffer[] = [];
      for (let i = 0; i < 3; i += 1) shots.push(await loc.nth(i).screenshot());
      for (let a = 0; a < shots.length; a += 1) {
        for (let b = a + 1; b < shots.length; b += 1) {
          expect(shots[a]!.equals(shots[b]!), `badges ${a} and ${b} are pixel-identical in grayscale`).toBe(false);
        }
      }
    }, 60_000);

    test(`badge text on fill meets AA (≥ 4.5:1) in ${theme} theme (REQ-A11Y-04)`, async () => {
      const page = await session.fresh("badges", theme);
      const pairs = await readPairs(page, '[data-state] > [data-slot="status-badge"]');
      expect(pairs.length).toBe(3);
      for (const p of pairs) {
        const ratio = contrast(parseRgb(p.fg), parseRgb(p.bg));
        expect(ratio, `${p.what}: ${p.fg} on ${p.bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }, 60_000);

    test(`primary / secondary / danger ActionButtons meet AA in ${theme} theme (REQ-A11Y-04)`, async () => {
      const page = await session.fresh("badges", theme);
      const variants = await page.locator('[data-slot="button"]').evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-variant")));
      expect(variants).toEqual(["default", "outline", "destructive"]);
      const stacks = await readStacks(page, '[data-slot="button"]');
      expect(stacks.length).toBe(3);
      for (const p of stacks) {
        const bg = effectiveBg(p.bgs);
        const ratio = contrast(over(p.fg, bg), bg);
        expect(ratio, `${p.what}: ${p.fg} on ${p.bgs.join(" / ")} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }, 60_000);
  }
});
