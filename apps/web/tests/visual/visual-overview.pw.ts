// Visual baselines for `/overview` (GitHub #4): 375/768/1280 × light/dark, the kiosk wallboard, and
// the shell itself (side nav + top bar) at 375 and 1280.
// Generated and verified on CI Linux only — see visual-kit.ts.

import { test } from "@playwright/test";

import {
  hideShell,
  open,
  prepare,
  settled,
  SKIP_REASON,
  snap,
  THEMES,
  VIEWPORTS,
  VISUALS,
  WALLBOARD,
} from "./visual-kit.js";

test.describe("overview visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const { theme, width } of VIEWPORTS) {
    test(`${width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, width });
      const root = page.locator('[data-slot="overview-page"]');
      await open(page, "/overview", root);
      await settled(root);
      await hideShell(page);
      await snap(page, `overview-${width}-${theme}.png`);
    });
  }
});

test.describe("overview wallboard visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const theme of THEMES) {
    test(`${WALLBOARD.width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, ...WALLBOARD });
      const root = page.locator('[data-slot="overview-kiosk-page"]');
      await open(page, "/overview?kiosk=1", root);
      await settled(root);
      await snap(page, `overview-wallboard-${theme}.png`, { fullPage: false });
    });
  }
});

// The shell itself (side nav + top bar, hidden in every other view capture): viewport-only, so the
// sticky chrome sits where a user sees it. At 375 the side nav is off-canvas; the top bar shows.
test.describe("overview shell visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const theme of THEMES) {
    for (const width of [375, 1280]) {
      test(`${width}px ${theme}`, async ({ page }) => {
        await prepare(page, { theme, width });
        const root = page.locator('[data-slot="overview-page"]');
        await open(page, "/overview", root);
        await settled(root);
        await snap(page, `overview-shell-${width}-${theme}.png`, { fullPage: false });
      });
    }
  }
});
