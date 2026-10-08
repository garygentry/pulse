// Visual baselines for the dev-only `/_ui` component workbench (GitHub #4): one capture per catalogue
// section (the whole page is too tall for one image at 375px), at 375/768/1280 × light/dark.
// CI Linux only — see visual-kit.ts.

import { expect, test } from "@playwright/test";

import {
  hideShell,
  open,
  prepare,
  SKIP_REASON,
  snap,
  stableHeight,
  VIEWPORTS,
  VISUALS,
} from "./visual-kit.js";

/** Section anchors in page order (src/client/views/_ui/sections/index.ts). */
const SECTIONS = [
  "primitives", "overlays", "foundations", "status", "scaffolding", "content",
  "collections", "filtering", "command-palette", "viz", "hooks",
] as const;

for (const id of SECTIONS) {
  test.describe(`ui workbench ${id} visual baselines`, () => {
    test.skip(!VISUALS, SKIP_REASON);
    for (const { theme, width } of VIEWPORTS) {
      test(`${width}px ${theme}`, async ({ page }) => {
        await prepare(page, { theme, width });
        const root = page.locator('[data-slot="ui-workbench-page"]');
        await open(page, `/_ui`, root);
        await hideShell(page);
        const section = root.locator(`[id="${id}"]`);
        await expect(section).toBeVisible();
        // Size the viewport to the section first: capturing an element taller than the viewport
        // resizes the page, which re-runs measuring components (ShowMore, LogOutput autoscroll), and
        // the two consecutive captures never match.
        if (id === "viz") await expect(section.locator("canvas")).toHaveCount(2); // lazy uPlot charts
        const height = await stableHeight(section);
        await page.setViewportSize({ width, height: Math.max(900, height + 96) });
        await snap(page, `workbench-${id}-${width}-${theme}.png`, { target: section });
      });
    }
  });
}
