// Visual baselines for `/connect`: 375/768/1280 × light/dark, in the usable state (a configured link:
// code, link text and source) and the refused state (a configured address a phone cannot use). The
// connect-link route is stubbed, so the captures do not depend on the server's configuration.
// CI Linux only — see visual-kit.ts.

import { expect, test, type Page } from "@playwright/test";

import { hideShell, open, prepare, settled, SKIP_REASON, snap, VIEWPORTS, VISUALS } from "./visual-kit.js";

const CONNECT_LINK_ROUTE = "**/api/connect-link";
const USABLE = {
  configured: { link: "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com", baseUrl: "https://pulse.example.com" },
  refusal: null,
};
const REFUSED = { configured: null, refusal: { reason: "not-https", envVar: "PULSE_WEB_EXTERNAL_URL" } };

/** Answer the connect-link request with `body`, whatever address the server was started with. */
async function stubConnectLink(page: Page, body: unknown): Promise<void> {
  await page.route(CONNECT_LINK_ROUTE, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) }),
  );
}

test.describe("connect visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const { theme, width } of VIEWPORTS) {
    test(`usable ${width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, width });
      await stubConnectLink(page, USABLE);
      const root = page.locator('[data-slot="connect-page"][data-region="usable"]');
      await open(page, "/connect", root);
      await settled(root);
      await expect(root.getByRole("img", { name: USABLE.configured.link })).toBeVisible();
      await hideShell(page);
      await snap(page, `connect-usable-${width}-${theme}.png`);
    });

    test(`refused ${width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, width });
      await stubConnectLink(page, REFUSED);
      const root = page.locator('[data-slot="connect-page"][data-region="refused"]');
      await open(page, "/connect", root);
      await settled(root);
      await expect(root.getByRole("alert")).toBeVisible();
      await hideShell(page);
      await snap(page, `connect-refused-${width}-${theme}.png`);
    });
  }
});
