// apps/web/tests/browser/estate.test.ts — estate-explorer browser suite (09 §7, REQ-A11Y-01).
//
// Renders the REAL estate view + shell (estate-fixture.tsx) over the reference-estate-derived
// EstatePayload and runs the three design-system browser checks against estate content, in BOTH
// themes and across every estate surface (inventory / coverage / findings tabs, host + service
// entity pages):
//
//   1. axe — @axe-core/playwright withTags(["wcag2a","wcag2aa"]) → zero violations.
//   2. grayscale distinctness — with colour removed, every [data-status] inside the estate view
//      carries a glyph + a text label, and no two status values collapse to the same read
//      (`[data-slot=status-badge]` badges, `[data-severity]` findings badges).
//   3. 375px reflow — the estate chrome + tree/tables/chips reflow without horizontal scroll.
//
// Mirrors axe.test.ts / grayscale.test.ts / reflow.test.ts. SELF-SKIPS when Chromium is not
// provisioned (see _harness.browserDescribe); THROWS at collection under PULSE_REQUIRE_BROWSER=1.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

import { browserDescribe, buildFixturePage, type FixturePage, type FixtureTheme, sharedBrowser } from "./_harness.js";

const ESTATE_FIXTURE_ENTRY = resolve(import.meta.dir, "estate-fixture.tsx");
const THEMES: readonly FixtureTheme[] = ["dark", "light"];

/** Every estate surface, each with the selector that proves it rendered (reference estate names). */
const ROUTES = [
  { name: "inventory", route: "/estate", ready: '[data-testid="estate-host-row"]' },
  { name: "coverage", route: "/estate?tab=coverage", ready: '[data-testid="estate-coverage-bucket"]' },
  { name: "findings", route: "/estate?tab=findings", ready: '[data-testid="estate-findings"] tbody tr' },
  { name: "host page", route: "/estate/host/harbor-web-01", ready: '[data-testid="estate-entity"][data-kind="host"]' },
  {
    name: "service page",
    route: "/estate/service/harbor-web-01/frigate",
    ready: '[data-testid="estate-entity"][data-kind="service"]',
  },
] as const;

type EstateRoute = (typeof ROUTES)[number];

/** Target-status badges (findings severity badges are checked on their own below). */
const STATUS_BADGE = '[data-testid="estate-view"] [data-slot="status-badge"][data-status]:not([data-severity])';

browserDescribe()("browser: estate view — axe, grayscale, 375px reflow, both themes (REQ-A11Y-01)", () => {
  let browser: Browser;
  let desktop: BrowserContext;
  let mobile: BrowserContext;
  const fixtures = new Map<FixtureTheme, FixturePage>();

  beforeAll(async () => {
    // Build BEFORE launching Chromium — see _harness.buildFixturePage (avoids the resolver/launch race).
    const built = await Promise.all(THEMES.map((theme) => buildFixturePage(ESTATE_FIXTURE_ENTRY, { theme })));
    THEMES.forEach((theme, i) => fixtures.set(theme, built[i]!));
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
    desktop = await browser.newContext();
    mobile = await browser.newContext({ viewport: { width: 375, height: 812 } });
  }, 180_000);

  afterAll(async () => {
    await desktop?.close();
    await mobile?.close();
    for (const f of fixtures.values()) f.stop();
  }, 60_000);

  /** Open `r` in `theme` on a fresh page; the caller closes it. */
  async function open(context: BrowserContext, theme: FixtureTheme, r: EstateRoute): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`${fixtures.get(theme)!.url}?route=${encodeURIComponent(r.route)}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(r.ready);
    return page;
  }

  for (const theme of THEMES) {
    for (const r of ROUTES) {
      test(`axe: zero wcag2a/wcag2aa violations — ${r.name} (${theme})`, async () => {
        const { AxeBuilder } = await import("@axe-core/playwright");
        const page = await open(desktop, theme, r);
        try {
          const results = await new AxeBuilder({ page }).options({ resultTypes: ["violations"] }).withTags(["wcag2a", "wcag2aa"]).analyze();
          const summary = results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }));
          expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
          // One page heading per surface: "Estate" on the landing, the entity name on entity pages.
          expect(await page.locator('[data-slot="estate-page"] h1').count()).toBe(1);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`grayscale: every [data-status] carries glyph + label, states stay distinct — ${r.name} (${theme})`, async () => {
        const page = await open(desktop, theme, r);
        try {
          // Force TOTAL colour loss over the whole page.
          await page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" });
          const rows = await page.evaluate(() => {
            const view = document.querySelector('[data-testid="estate-view"]');
            if (view === null) return [];
            return Array.from(view.querySelectorAll("[data-status]")).map((el) => {
              // The glyph is the lucide icon's shape name (`lucide-circle-check`, …).
              const svg = el.querySelector("svg");
              const glyph = /\blucide-[a-z0-9-]+/.exec(svg?.getAttribute("class") ?? "")?.[0] ?? "";
              const label = el.textContent?.trim() ?? "";
              const badge = el.getAttribute("data-slot") === "status-badge" && !el.hasAttribute("data-severity");
              const kind = badge ? (el.getAttribute("data-variant") ?? "soft") : "other";
              return { status: el.getAttribute("data-status") ?? "", kind, glyph, hasIcon: svg !== null, label };
            });
          });
          expect(rows.length).toBeGreaterThan(0);

          for (const row of rows) {
            expect(row.status, JSON.stringify(row)).toBeTruthy();
            expect(row.glyph.length > 0 || row.hasIcon, `no glyph/icon: ${JSON.stringify(row)}`).toBe(true);
            expect(row.label.length, `no text label: ${JSON.stringify(row)}`).toBeGreaterThan(0);
          }

          // Within each badge variant, two different status values never share a glyph — the state
          // is recoverable from shape alone, without colour.
          for (const kind of new Set(rows.map((x) => x.kind).filter((k) => k !== "other"))) {
            const glyphByStatus = new Map<string, Set<string>>();
            for (const row of rows.filter((x) => x.kind === kind)) {
              const set = glyphByStatus.get(row.status) ?? new Set<string>();
              set.add(row.glyph);
              glyphByStatus.set(row.status, set);
            }
            const statuses = [...glyphByStatus.keys()];
            for (let a = 0; a < statuses.length; a += 1) {
              for (let b = a + 1; b < statuses.length; b += 1) {
                const shared = [...glyphByStatus.get(statuses[a]!)!].filter((g) =>
                  glyphByStatus.get(statuses[b]!)!.has(g),
                );
                expect(shared, `${kind} states ${statuses[a]} and ${statuses[b]} share a glyph`).toEqual([]);
              }
            }
          }

          // Findings severity (not a TargetStatus) obeys the same rule: glyph + label, distinct per severity.
          const severities = await page.evaluate(() =>
            Array.from(document.querySelectorAll("[data-slot=status-badge][data-severity]")).map((el) => ({
              severity: el.getAttribute("data-severity") ?? "",
              icon: el.querySelector("svg")?.innerHTML ?? "",
              label: el.textContent?.trim() ?? "",
            })),
          );
          const iconBySeverity = new Map<string, string>();
          const labelBySeverity = new Map<string, string>();
          for (const s of severities) {
            expect(s.label.length, `empty severity label: ${JSON.stringify(s)}`).toBeGreaterThan(0);
            expect(s.icon.length, `severity has no glyph: ${JSON.stringify(s)}`).toBeGreaterThan(0);
            iconBySeverity.set(s.severity, s.icon);
            labelBySeverity.set(s.severity, s.label);
          }
          // Each severity has its own glyph shape AND its own label.
          expect(new Set(iconBySeverity.values()).size).toBe(iconBySeverity.size);
          expect(new Set(labelBySeverity.values()).size).toBe(labelBySeverity.size);
          if (r.name === "findings") expect(iconBySeverity.size).toBeGreaterThan(1);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`grayscale: distinct status values render pixel-distinct — ${r.name} (${theme})`, async () => {
        const page = await open(desktop, theme, r);
        try {
          await page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" });
          // One representative status-badge glyph per distinct status value.
          const statuses = await page.evaluate(
            (sel) => Array.from(new Set(Array.from(document.querySelectorAll(sel)).map((el) => el.getAttribute("data-status") ?? ""))),
            STATUS_BADGE,
          );
          if (r.name === "inventory" || r.name === "coverage") expect(statuses.length).toBeGreaterThan(1);
          const shots: Buffer[] = [];
          for (const status of statuses) {
            const glyph = page.locator(`${STATUS_BADGE}[data-status="${status}"] svg`).first();
            shots.push(await glyph.screenshot());
          }
          for (let a = 0; a < shots.length; a += 1) {
            for (let b = a + 1; b < shots.length; b += 1) {
              expect(
                shots[a]!.equals(shots[b]!),
                `${statuses[a]} and ${statuses[b]} glyphs are pixel-identical in grayscale`,
              ).toBe(false);
            }
          }
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`reflow: no horizontal scroll or clipped status text at 375px — ${r.name} (${theme})`, async () => {
        const page = await open(mobile, theme, r);
        try {
          const result = await page.evaluate(() => {
            const el = document.documentElement;
            const clipped: string[] = [];
            // The badge's label/detail spans truncate with an ellipsis when squeezed.
            const sel = '[data-testid="estate-view"] [data-slot="status-badge"] > span';
            for (const node of Array.from(document.querySelectorAll(sel))) {
              const e = node as HTMLElement;
              if (e.scrollWidth > e.clientWidth + 1) {
                clipped.push(`"${e.textContent?.trim()}" scrollWidth=${e.scrollWidth} clientWidth=${e.clientWidth}`);
              }
            }
            return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, clipped };
          });
          // 1px sub-pixel slack; the view must not open a real horizontal scroll region.
          expect(
            result.scrollWidth,
            `documentElement overflows: scrollWidth=${result.scrollWidth} clientWidth=${result.clientWidth}`,
          ).toBeLessThanOrEqual(result.clientWidth + 1);
          expect(result.clipped, `truncated status content at 375px:\n${result.clipped.join("\n")}`).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }
});
