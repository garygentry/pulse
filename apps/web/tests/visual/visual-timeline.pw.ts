// Visual baselines for `/timeline` (GitHub #4): 375/768/1280 × light/dark, plus the kiosk wallboard.
// CI Linux only — see visual-kit.ts.

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

test.describe("timeline visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const { theme, width } of VIEWPORTS) {
    test(`${width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, width });
      const root = page.locator('[data-slot="timeline-page"]');
      await open(page, "/timeline", root);
      await settled(root);
      await hideShell(page);
      await snap(page, `timeline-${width}-${theme}.png`);
    });
  }
});

test.describe("timeline wallboard visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const theme of THEMES) {
    test(`${WALLBOARD.width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, ...WALLBOARD });
      const root = page.locator('[data-slot="timeline-page"]');
      await open(page, "/timeline?kiosk=1", root);
      await settled(root);
      await snap(page, `timeline-wallboard-${theme}.png`, { fullPage: false });
    });
  }
});
