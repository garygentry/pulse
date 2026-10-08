// Visual baselines for `/alerts` (GitHub #4): the Firing, Catalog and Silences tabs and the alert
// detail pane, at 375/768/1280 × light/dark, plus the kiosk wallboard. CI Linux only — see visual-kit.ts.

import { expect, test } from "@playwright/test";

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

const TABS = [
  { tab: "firing", path: "/alerts" },
  { tab: "catalog", path: "/alerts?tab=catalog" },
  { tab: "silences", path: "/alerts?tab=silences" },
] as const;

for (const { tab, path } of TABS) {
  test.describe(`alerts ${tab} visual baselines`, () => {
    test.skip(!VISUALS, SKIP_REASON);
    for (const { theme, width } of VIEWPORTS) {
      test(`${width}px ${theme}`, async ({ page }) => {
        await prepare(page, { theme, width });
        const root = page.locator('[data-slot="alerts-page"]');
        await open(page, path, root);
        await expect(root.getByRole("tab", { selected: true })).toHaveAttribute("data-tab", tab);
        await settled(root);
        await hideShell(page);
        await snap(page, `alerts-${tab}-${width}-${theme}.png`);
      });
    }
  });
}

test.describe("alerts detail visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const { theme, width } of VIEWPORTS) {
    test(`${width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, width });
      const root = page.locator('[data-slot="alerts-page"]');
      await open(page, "/alerts", root);
      await settled(root);
      await root.getByRole("button", { name: "HypervisorUnreachable" }).first().click();
      await expect(page).toHaveURL(/[?&]sel=/);
      const detail = page.getByRole("heading", { name: "HypervisorUnreachable" }).last();
      await expect(detail).toBeVisible();
      await settled(page.locator("body"));
      await hideShell(page);
      await snap(page, `alerts-detail-${width}-${theme}.png`, { fullPage: false });
    });
  }
});

test.describe("alerts wallboard visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const theme of THEMES) {
    test(`${WALLBOARD.width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, ...WALLBOARD });
      const root = page.locator('[data-slot="alerts-page"]');
      await open(page, "/alerts?kiosk=1", root);
      await settled(root);
      await snap(page, `alerts-wallboard-${theme}.png`, { fullPage: false });
    });
  }
});
