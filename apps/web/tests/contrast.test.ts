// apps/web/tests/contrast.test.ts — SC-02, REQ-A11Y-05: the rendered status badges, both themes.
//
// The browser fixture renders one TARGET_STATUS badge per state (tests/browser/fixture.tsx). For
// each, this reads the badge's computed text colour and its effective background — its own
// background when it paints one (the soft variant), the page background when it is transparent
// (the outline variant `suppressed` uses) — and asserts WCAG text contrast ≥ 4.5:1 (1.4.3) in BOTH
// themes. culori parses the oklch() values Chromium reports for theme.css's tokens. The token pairs
// themselves are held to AA by tokens-contrast.test.ts; this proves the composed badge.
//
// SELF-SKIPS when Chromium is not provisioned (see _harness.browserDescribe); throws at collection
// under PULSE_REQUIRE_BROWSER=1 (REQ-CI-01).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { parse, wcagContrast } from "culori";
import type { Browser, BrowserContext, Page } from "playwright-core";

import { STATUS_STATES } from "../src/shared/constants.js";
import {
  browserDescribe,
  buildFixturePage,
  FIXTURE_ENTRY,
  type FixturePage,
  type FixtureTheme,
  sharedBrowser,
} from "./browser/_harness.js";

const THEMES: readonly FixtureTheme[] = ["dark", "light"];
const SHOWCASE = "[data-fixture=status-showcase] [data-slot=status-badge]";

/** WCAG contrast ratio between two computed CSS colours. Chromium reports theme.css's tokens as
 *  `oklch(...)`, so colours are parsed with culori; an unparseable colour throws. */
function contrastRatio(a: string, b: string): number {
  const ca = parse(a);
  const cb = parse(b);
  if (ca === undefined || cb === undefined) throw new Error(`unparseable color: ${ca === undefined ? a : b}`);
  return wcagContrast(ca, cb);
}

interface BadgeColors {
  status: string;
  color: string;
  background: string;
}

browserDescribe()("browser: WCAG contrast of every status badge, both themes (SC-02, REQ-A11Y-05)", () => {
  let browser: Browser;
  let context: BrowserContext;
  const resolved = new Map<FixtureTheme, BadgeColors[]>();
  const fixtures: FixturePage[] = [];

  beforeAll(async () => {
    const built = await Promise.all(THEMES.map((theme) => buildFixturePage(FIXTURE_ENTRY, { theme })));
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
    context = await browser.newContext();
    for (let i = 0; i < THEMES.length; i += 1) {
      const fixture = built[i]!;
      fixtures.push(fixture);
      const page: Page = await context.newPage();
      await page.goto(fixture.url, { waitUntil: "networkidle" });
      await page.waitForSelector(SHOWCASE);
      // Evaluate from a locator (Playwright passes the elements in) rather than referencing
      // `document` — keeps this browser-suite file clear of the happy-dom meta-guard's DOM-usage trigger.
      const value = await page.locator(SHOWCASE).evaluateAll((badges) =>
        badges.map((badge) => {
          const style = getComputedStyle(badge);
          const transparent = style.backgroundColor === "rgba(0, 0, 0, 0)" || style.backgroundColor === "transparent";
          return {
            status: badge.getAttribute("data-status") ?? "",
            color: style.color,
            background: transparent ? getComputedStyle(badge.ownerDocument.body).backgroundColor : style.backgroundColor,
          };
        }),
      );
      resolved.set(THEMES[i]!, value);
    }
  }, 180_000);

  afterAll(async () => {
    await context?.close();
    for (const f of fixtures) f.stop();
  });

  for (const theme of THEMES) {
    test(`the showcase renders one badge per status (${theme})`, () => {
      expect(resolved.get(theme)!.map((b) => b.status)).toEqual([...STATUS_STATES]);
    });

    for (const state of STATUS_STATES) {
      test(`${state} — badge text on its background ≥ 4.5:1 (${theme})`, () => {
        const b = resolved.get(theme)!.find((x) => x.status === state)!;
        const ratio = contrastRatio(b.color, b.background);
        expect(ratio, `${theme}/${state} text = ${ratio.toFixed(2)} (color=${b.color} background=${b.background})`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
