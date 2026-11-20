// Visual baselines for the push sections on `/connect`: 375/768/1280 × light/dark, with a pairing code
// outstanding (the page QR carries the one-time code and the countdown reads 9:30 under the frozen clock)
// and with two paired devices listed (one delivered, one failed). The connect-link, push-status and
// pairing-token routes are stubbed, so the captures do not depend on the server's push configuration.
// Placeholder values only. CI Linux only — see visual-kit.ts.

import { expect, test, type Page, type Route } from "@playwright/test";

import { FROZEN_NOW, hideShell, open, prepare, settled, SKIP_REASON, snap, VIEWPORTS, VISUALS } from "./visual-kit.js";

const BASE_URL = "https://pulse.example.com";
const CONNECT_LINK = "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com";
const PAIR_LINK = `${CONNECT_LINK}&pair=AAAAAAAAAAAAAAAAAAAAAA`;
/** The issued code's expiry: 9 min 30 s after the frozen browser clock, so the countdown reads 9:30. */
const EXPIRES_AT = new Date(FROZEN_NOW.getTime() + 9 * 60_000 + 30_000).toISOString();

const minutesBefore = (minutes: number): string => new Date(FROZEN_NOW.getTime() - minutes * 60_000).toISOString();

const DEVICES = [
  {
    id: "dev_AAAAAAAAAAA",
    displayName: "Ops iPhone",
    pairedAt: minutesBefore(3 * 24 * 60),
    seenAt: minutesBefore(20),
    environment: "production",
    preferences: { critical: true, warning: true, info: false },
    tokenSuffix: "abcdef",
    lastDelivery: { outcome: "delivered", at: minutesBefore(5), reason: null },
  },
  {
    id: "dev_AAAAAAAAAAB",
    displayName: "Test iPad",
    pairedAt: minutesBefore(24 * 60),
    seenAt: minutesBefore(90),
    environment: "sandbox",
    preferences: { critical: true, warning: false, info: false },
    tokenSuffix: "fedcba",
    lastDelivery: { outcome: "failed", at: minutesBefore(45), reason: "BadDeviceToken" },
  },
] as const;

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

/** Stub the connect link, the push status and the web pairing-token issue. After the issue the status
 *  reports the code as outstanding, as the server would. */
async function stubConnectPush(page: Page): Promise<void> {
  let outstanding: { expiresAt: string } | null = null;
  await page.route("**/api/connect-link", (route) => json(route, { configured: { link: CONNECT_LINK, baseUrl: BASE_URL }, refusal: null }));
  await page.route("**/api/push/status", (route) =>
    json(route, { state: "configured", devices: DEVICES, outstanding, maxDevices: 20 }),
  );
  await page.route("**/api/push/pairing-tokens", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    outstanding = { expiresAt: EXPIRES_AT };
    return json(route, { link: PAIR_LINK, expiresAt: EXPIRES_AT }, 201);
  });
}

test.describe("connect push visual baselines", () => {
  test.skip(!VISUALS, SKIP_REASON);
  for (const { theme, width } of VIEWPORTS) {
    test(`token outstanding ${width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, width });
      await stubConnectPush(page);
      const root = page.locator('[data-slot="connect-page"][data-region="usable"]');
      await open(page, "/connect", root);
      const pair = page.locator('[data-slot="connect-push-pair"]');
      await expect(pair).toBeVisible({ timeout: 30_000 });
      await pair.getByRole("button", { name: "Pair a device" }).click();
      await expect(root.getByRole("img", { name: PAIR_LINK })).toBeVisible();
      await expect(pair.getByText("Pairing code active — expires in 9:30")).toBeVisible();
      await settled(root);
      await hideShell(page);
      await snap(page, `connect-push-outstanding-${width}-${theme}.png`);
    });

    test(`devices listed ${width}px ${theme}`, async ({ page }) => {
      await prepare(page, { theme, width });
      await stubConnectPush(page);
      const root = page.locator('[data-slot="connect-page"][data-region="usable"]');
      await open(page, "/connect", root);
      const devices = page.locator('[data-slot="connect-push-devices"]');
      await expect(devices.getByRole("listitem")).toHaveCount(DEVICES.length, { timeout: 30_000 });
      await settled(root);
      await hideShell(page);
      await snap(page, `connect-push-devices-${width}-${theme}.png`);
    });
  }
});
