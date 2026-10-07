// apps/web/tests/browser/overview-grayscale.test.ts — REQ-A11Y-01/03, C-03 (08-testing-strategy.md §5.3, §5.6).
//
// Renders the fixed 100-host × 300-service envelope (every status present) in BOTH themes at a fixed
// 1280×900 viewport and proves the five statuses never read by colour alone:
//   (1) each status has a rendered host trigger or service chip carrying a visible non-empty glyph, a
//       visible non-empty label and a non-empty accessible name that names the status; distinct
//       statuses carry distinct glyphs and pairwise-distinct labels;
//   (2) archives `overview-100-hosts-{dark,light}.png` (full-page, captured BEFORE any grayscale
//       filter) into $PULSE_SCREENSHOT_DIR, else a directory under os.tmpdir() — never inside the repo;
//   (3) a second capture under `html { filter: grayscale(1) }` (the repository's existing grayscale
//       mechanism, see grayscale.test.ts) keeps one representative status chip per status pairwise
//       pixel-distinct;
//   (4) computed foreground/background pairs of every status chip glyph and label satisfy WCAG AA for
//       their text size (4.5:1, or 3:1 for large text), and the overview status border cues (host
//       `border-inline-start-color`, service chip border colour) reach 3:1 against the adjacent
//       background (WCAG 1.4.11). Failures are collected and reported together; thresholds are fixed.
//
// Screenshot review/sign-off is a HUMAN post-loop action (08 §5.3, C-03): this suite only PRODUCES the
// archived images and logs their absolute paths; it adds no snapshot/pixel-diff library and holds no
// baseline.
//
// The WCAG relative-luminance helper is inlined (contrast.test.ts has the same hand-rolled helper but
// it is a test file, not an importable module). No dependency.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); throws at collection under
// PULSE_REQUIRE_BROWSER=1. Pages/contexts/fixture servers are closed in afterAll (08 §5.6).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { converter, parse } from "culori";
import type { Browser } from "playwright-core";

import { browserDescribe, type FixturePage, type FixtureTheme } from "./_harness.js";
import {
  buildOverviewFixtures,
  launchOverviewBrowser,
  openOverviewPage,
  OVERVIEW_HOST_TRIGGERS,
  OVERVIEW_SERVICE_CHIPS,
  OVERVIEW_THEMES,
  stopOverviewFixtures,
  type OverviewPageHandle,
} from "./overview-browser.js";

const STATUSES = ["ok", "warning", "critical", "unknown", "suppressed"] as const;
const VIEWPORT = { width: 1280, height: 900 } as const;
/** Repo root: four levels up from apps/web/tests/browser. */
const REPO_ROOT = resolve(import.meta.dir, "../../../..");

function screenshotDir(): string {
  const fromEnv = process.env["PULSE_SCREENSHOT_DIR"];
  const dir = fromEnv !== undefined && fromEnv !== "" ? resolve(fromEnv) : join(tmpdir(), "pulse-overview-screenshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ── WCAG 2.x contrast (inline; culori only parses the computed colour, which may be oklch()) ──────

type Rgba = [number, number, number, number];

const toRgb = converter("rgb");

function parseColor(css: string): Rgba {
  const c = toRgb(parse(css));
  if (c === undefined) throw new Error(`unparseable computed color: ${css}`);
  const clamp = (v: number): number => Math.min(255, Math.max(0, v * 255));
  return [clamp(c.r), clamp(c.g), clamp(c.b), c.alpha ?? 1];
}

function luminance([r, g, b]: Rgba): number {
  const chan = (c: number): number => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite a (possibly translucent) foreground over an opaque background. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

/** In-page read of one text part: its colour, font and the stack of ancestor backgrounds (self first). */
interface TextRead {
  key: string;
  color: string;
  fontSizePx: number;
  fontWeight: number;
  backgrounds: string[];
}
interface BorderRead {
  key: string;
  border: string;
  backgrounds: string[];
}

/** Resolve the effective opaque background from a self-first stack of computed background colours. */
function effectiveBackground(stack: readonly string[]): Rgba {
  // Composite from the root (opaque white canvas fallback) down to the element.
  let bg: Rgba = [255, 255, 255, 1];
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const c = parseColor(stack[i]!);
    if (c[3] === 0) continue;
    bg = over(c, bg);
  }
  return bg;
}

browserDescribe()("browser: overview grayscale, archived screenshots and AA contrast, both themes (08 §5.3)", () => {
  let fixtures: Map<FixtureTheme, FixturePage> | undefined;
  let browser: Browser | undefined;
  const handles = new Map<FixtureTheme, OverviewPageHandle>();

  beforeAll(async () => {
    fixtures = await buildOverviewFixtures();
    browser = await launchOverviewBrowser();
    for (const theme of OVERVIEW_THEMES) {
      handles.set(theme, await openOverviewPage(browser, fixtures, { theme, mode: "envelope", viewport: VIEWPORT }));
    }
  }, 180_000);

  afterAll(async () => {
    try {
      for (const handle of handles.values()) await handle.close();
    } finally {
      stopOverviewFixtures(fixtures);
    }
  }, 60_000);

  for (const theme of OVERVIEW_THEMES) {
    test(`archives overview-100-hosts-${theme}.png before any grayscale filter (${theme})`, async () => {
      const page = handles.get(theme)!.page;
      const dir = screenshotDir();
      expect(isInside(REPO_ROOT, dir), `screenshot dir ${dir} is inside the repo ${REPO_ROOT}`).toBe(false);
      const filtered = await page.evaluate(() => getComputedStyle(document.documentElement).filter);
      expect(filtered, "grayscale filter must not be applied before the archive capture").toBe("none");
      const path = join(dir, `overview-100-hosts-${theme}.png`);
      await page.screenshot({ path, fullPage: true });
      console.log(`overview screenshot archived: ${path}`);
      expect(statSync(path).isFile()).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }, 60_000);

    test(`every status has a target with visible glyph, label and accessible name (${theme})`, async () => {
      const page = handles.get(theme)!.page;
      const reads: Array<{ status: string; glyph: string; label: string; aria: string }> = [];
      for (const status of STATUSES) {
        const target = page
          .locator(`${OVERVIEW_HOST_TRIGGERS}[data-status="${status}"], ${OVERVIEW_SERVICE_CHIPS}[data-status="${status}"]`)
          .first();
        expect(await target.count(), `no host trigger or service chip with data-status=${status}`).toBe(1);
        const chip = target.locator(`[data-slot="status-badge"][data-status="${status}"]`).first();
        // The @/ui StatusBadge: a lucide `svg[data-slot="icon"]` glyph then the label as its first child span.
        const glyphEl = chip.locator('svg[data-slot="icon"]').first();
        const labelEl = chip.locator(":scope > span").first();
        expect(await glyphEl.isVisible(), `glyph not visible for ${status}`).toBe(true);
        expect(await labelEl.isVisible(), `label not visible for ${status}`).toBe(true);
        // The glyph's identity is its lucide icon class (a glyph never stands for two statuses).
        const glyph = /\blucide-[a-z0-9-]+/.exec((await glyphEl.getAttribute("class")) ?? "")?.[0] ?? "";
        const label = ((await labelEl.textContent()) ?? "").trim();
        const aria = ((await target.getAttribute("aria-label")) ?? "").trim();
        expect(glyph.length, `empty glyph for ${status}`).toBeGreaterThan(0);
        expect(label.length, `empty label for ${status}`).toBeGreaterThan(0);
        expect(aria.length, `empty aria-label for ${status}`).toBeGreaterThan(0);
        expect(aria.toLowerCase(), `aria-label for ${status} does not name the status`).toContain(label.toLowerCase());
        reads.push({ status, glyph, label, aria });
      }
      expect(new Set(reads.map((r) => r.glyph)).size, JSON.stringify(reads)).toBe(STATUSES.length);
      expect(new Set(reads.map((r) => r.label)).size, JSON.stringify(reads)).toBe(STATUSES.length);
    }, 60_000);

    test(`stat-header status badges: distinct icon + label per status, AA label contrast (${theme})`, async () => {
      const page = handles.get(theme)!.page;
      const reads = await page.evaluate((statuses) => {
        const stackOf = (el: Element | null): string[] => {
          const out: string[] = [];
          for (let n = el; n !== null; n = n.parentElement) out.push(getComputedStyle(n).backgroundColor);
          return out;
        };
        return statuses.map((status) => {
          const badge = document.querySelector(`[data-stat="hosts"] [data-slot="status-badge"][data-status="${status}"]`);
          const icon = badge?.querySelector("svg") ?? null;
          const label = badge?.querySelector("span") ?? null;
          const cs = label === null ? null : getComputedStyle(label);
          return {
            status,
            found: badge !== null,
            icon: icon === null ? "" : (icon.getAttribute("class") ?? "").split(/\s+/).filter((c) => c.startsWith("lucide-")).join(" "),
            iconVisible: icon !== null && icon.getBoundingClientRect().width > 0,
            label: (label?.textContent ?? "").trim(),
            color: cs?.color ?? "",
            fontSizePx: cs === null ? 0 : parseFloat(cs.fontSize),
            fontWeight: cs === null ? 0 : Number(cs.fontWeight),
            backgrounds: stackOf(label),
          };
        });
      }, [...STATUSES]);
      const failures: string[] = [];
      for (const r of reads) {
        expect(r.found, `no stat-header badge for ${r.status}`).toBe(true);
        expect(r.iconVisible, `no visible icon for ${r.status}`).toBe(true);
        expect(r.label.length, `empty label for ${r.status}`).toBeGreaterThan(0);
        const bg = effectiveBackground(r.backgrounds);
        const fg = over(parseColor(r.color), bg);
        const ratio = contrast(fg, bg);
        if (ratio < 4.5) failures.push(`${theme}: stat ${r.status} label ${ratio.toFixed(2)}:1 < 4.5:1`);
      }
      // Never colour alone: an icon never stands for two statuses, and labels differ.
      expect(new Set(reads.map((r) => r.icon)).size, JSON.stringify(reads.map((r) => r.icon))).toBe(STATUSES.length);
      expect(new Set(reads.map((r) => r.label.replace(/^\S+\s/, ""))).size).toBe(STATUSES.length);
      expect(failures, failures.join("\n")).toEqual([]);
    }, 60_000);

    test(`status chips stay pairwise pixel-distinct under grayscale (${theme})`, async () => {
      const page = handles.get(theme)!.page;
      const style = await page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" });
      try {
        const shots: Buffer[] = [];
        for (const status of STATUSES) {
          const chip = page
            .locator(`${OVERVIEW_SERVICE_CHIPS}[data-status="${status}"] [data-slot="status-badge"][data-status="${status}"]`)
            .first();
          expect(await chip.count(), `no service status chip for ${status}`).toBe(1);
          shots.push(await chip.screenshot());
        }
        for (let a = 0; a < shots.length; a += 1) {
          for (let b = a + 1; b < shots.length; b += 1) {
            expect(
              shots[a]!.equals(shots[b]!),
              `${STATUSES[a]} and ${STATUSES[b]} chips are pixel-identical in grayscale (${theme})`,
            ).toBe(false);
          }
        }
      } finally {
        await style.evaluate((el) => (el as Element).remove());
      }
    }, 60_000);

    test(`status text and border cues meet WCAG AA / 1.4.11 contrast (${theme})`, async () => {
      const page = handles.get(theme)!.page;
      const { texts, borders } = await page.evaluate(
        ({ statuses, hostSel, chipSel }) => {
          const stackOf = (el: Element | null): string[] => {
            const out: string[] = [];
            for (let n = el; n !== null; n = n.parentElement) out.push(getComputedStyle(n).backgroundColor);
            return out;
          };
          const texts: Array<{ key: string; color: string; fontSizePx: number; fontWeight: number; backgrounds: string[] }> = [];
          const borders: Array<{ key: string; border: string; backgrounds: string[] }> = [];
          for (const status of statuses) {
            for (const [kind, sel] of [["host", hostSel], ["service", chipSel]] as const) {
              const chip = document.querySelector(`${sel}[data-status="${status}"] [data-slot="status-badge"][data-status="${status}"]`);
              if (chip === null) continue;
              // Glyph = the lucide svg (stroke is currentColor, so its computed `color` is the drawn
              // colour); label = the badge's first child span.
              for (const part of ["glyph", "label"] as const) {
                const el = chip.querySelector(part === "glyph" ? 'svg[data-slot="icon"]' : ":scope > span");
                if (el === null) continue;
                const cs = getComputedStyle(el);
                texts.push({
                  key: `${kind} ${status} chip ${part}`,
                  color: cs.color,
                  fontSizePx: parseFloat(cs.fontSize),
                  fontWeight: Number(cs.fontWeight),
                  backgrounds: stackOf(el),
                });
              }
            }
            const host = document.querySelector(`[data-slot="overview-page"] [data-slot="overview-host"][data-status="${status}"]`);
            if (host !== null) {
              borders.push({
                key: `overview-host ${status} border-inline-start`,
                border: getComputedStyle(host).borderInlineStartColor,
                backgrounds: stackOf(host.parentElement),
              });
            }
            const svc = document.querySelector(`[data-slot="overview-page"] [data-slot="overview-chip"][data-status="${status}"]`);
            if (svc !== null) {
              borders.push({
                key: `overview-chip ${status} border`,
                border: getComputedStyle(svc).borderTopColor,
                backgrounds: stackOf(svc.parentElement),
              });
            }
          }
          return { texts, borders };
        },
        { statuses: [...STATUSES], hostSel: OVERVIEW_HOST_TRIGGERS, chipSel: OVERVIEW_SERVICE_CHIPS },
      );

      // Every status must have been measured (host or service chip text, host and chip border).
      for (const status of STATUSES) {
        expect(texts.some((t: TextRead) => t.key.includes(` ${status} chip label`)), `no chip label measured for ${status}`).toBe(true);
        expect(borders.some((b: BorderRead) => b.key === `overview-host ${status} border-inline-start`)).toBe(true);
        expect(borders.some((b: BorderRead) => b.key === `overview-chip ${status} border`)).toBe(true);
      }

      const failures: string[] = [];
      const fmt = (c: Rgba): string => `rgb(${c.slice(0, 3).map((v) => Math.round(v)).join(", ")})`;
      for (const t of texts as TextRead[]) {
        const bg = effectiveBackground(t.backgrounds);
        const fg = over(parseColor(t.color), bg);
        const large = t.fontSizePx >= 24 || (t.fontSizePx >= 18.66 && t.fontWeight >= 700);
        const required = large ? 3 : 4.5;
        const ratio = contrast(fg, bg);
        if (ratio < required) {
          failures.push(
            `${theme}: ${t.key} fg ${fmt(fg)} on bg ${fmt(bg)} = ${ratio.toFixed(2)}:1 < ${required}:1 (${t.fontSizePx}px/${t.fontWeight})`,
          );
        }
      }
      for (const b of borders as BorderRead[]) {
        const bg = effectiveBackground(b.backgrounds);
        const border = over(parseColor(b.border), bg);
        const ratio = contrast(border, bg);
        if (ratio < 3) failures.push(`${theme}: ${b.key} ${fmt(border)} vs adjacent bg ${fmt(bg)} = ${ratio.toFixed(2)}:1 < 3:1`);
      }
      expect(failures, failures.join("\n")).toEqual([]);
    }, 60_000);
  }
});
