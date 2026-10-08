// Visual baselines for `/estate` (GitHub #4): the Inventory, Coverage and Findings tabs and the host
// and service entity pages, at 375/768/1280 × light/dark. CI Linux only — see visual-kit.ts.

import { test } from "@playwright/test";

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

const PAGES = [
  { name: "inventory", path: "/estate", root: "estate-view" },
  { name: "coverage", path: "/estate?tab=coverage", root: "estate-view" },
  { name: "findings", path: "/estate?tab=findings", root: "estate-view" },
  { name: "host", path: "/estate/host/harbor-hv-01", root: "estate-entity" },
  { name: "service", path: "/estate/service/harbor-web-01/portal-web", root: "estate-entity" },
] as const;

for (const { name, path, root: testId } of PAGES) {
  test.describe(`estate ${name} visual baselines`, () => {
    test.skip(!VISUALS, SKIP_REASON);
    for (const { theme, width } of VIEWPORTS) {
      test(`${width}px ${theme}`, async ({ page }) => {
        await prepare(page, { theme, width });
        const root = page.getByTestId(testId);
        await open(page, path, root);
        await settled(root);
        await hideShell(page);
        await snap(page, `estate-${name}-${width}-${theme}.png`);
      });
    }
  });
}
