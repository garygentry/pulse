// Visual baselines for `/engine` (GitHub #4): 375/768/1280 × light/dark. The Pulse web app version
// carries the build id and is masked. CI Linux only — see visual-kit.ts.

import { expect, test } from "@playwright/test";

import {
  hideShell,
  open,
  prepare,
  settled,
  SKIP_REASON,
  snap,
  VIEWPORTS,
  VISUALS,
} from "./visual-kit.js";

test.describe("engine visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const { theme, width } of VIEWPORTS) {
    test(`${width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, width });
      const root = page.locator('[data-slot="engine-page"]:not([data-region="loading"])');
      await open(page, "/engine", root);
      await settled(root);
      // Every trend chart has drawn (five curated engine series, fed by visual-kit's history route).
      await expect(root.locator("canvas")).toHaveCount(5);
      await hideShell(page);
      await snap(page, `engine-${width}-${theme}.png`);
    });
  }
});
