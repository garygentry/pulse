// apps/web/tests/browser/shell.test.ts — the app frame in Chromium (deck's AppShell over the view
// registry):
//   • the skip link is the first tab stop and moves focus to the single <main id="main">;
//   • the nav marks the active view aria-current and is operable by keyboard;
//   • below md the sidebar is a sheet: the top-bar toggle opens it, choosing a view closes it;
//   • kiosk renders no sidebar, toggle or preference controls, and is axe-clean in both themes;
// The desk axe run in both themes is axe.test.ts (same fixture).
//
// SELF-SKIPS when Chromium is not provisioned (see _harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";

import {
  browserDescribe,
  buildFixturePage,
  FIXTURE_ENTRY,
  type FixturePage,
  type FixtureTheme,
  sharedBrowser,
} from "./_harness.js";

const THEMES: readonly FixtureTheme[] = ["dark", "light"];

browserDescribe()("browser: app shell frame, keyboard, mobile sheet and kiosk", () => {
  let browser: Browser;
  const fixtures = new Map<FixtureTheme, FixturePage>();
  const opened: Page[] = [];

  beforeAll(async () => {
    const built = await Promise.all(THEMES.map((theme) => buildFixturePage(FIXTURE_ENTRY, { theme })));
    THEMES.forEach((theme, i) => fixtures.set(theme, built[i]!));
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
  }, 180_000);

  afterAll(async () => {
    for (const page of opened) await page.context().close();
    for (const f of fixtures.values()) f.stop();
  }, 60_000);

  async function open(theme: FixtureTheme, opts: { width?: number; query?: string } = {}): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: 900 } });
    const page = await context.newPage();
    opened.push(page);
    await page.goto(`${fixtures.get(theme)!.url}${opts.query ?? ""}`, { waitUntil: "networkidle" });
    await page.waitForSelector("main#main");
    return page;
  }

  test("the skip link is the first tab stop and focuses <main id=main>", async () => {
    const page = await open("light");
    expect(await page.locator("main").count()).toBe(1);
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => ({
      text: document.activeElement?.textContent ?? "",
      href: document.activeElement?.getAttribute("href") ?? "",
    }));
    expect(first).toEqual({ text: "Skip to content", href: "#main" });
    // Visible once focused (not clipped to 1px by sr-only).
    const box = await page.locator('[data-slot="skip-link"]').boundingBox();
    expect(box !== null && box.width > 20 && box.height > 10).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
  }, 60_000);

  test("the nav marks the active view and routes by keyboard", async () => {
    const page = await open("dark");
    const nav = page.getByRole("navigation", { name: "Views" });
    await expect(nav.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).resolves.toBe("page");
    await nav.getByRole("link", { name: "Engine" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.pathname === "/engine");
    await expect(nav.getByRole("link", { name: "Engine" }).getAttribute("aria-current")).resolves.toBe("page");
    expect(await nav.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
  }, 60_000);

  test("below md the sidebar is a sheet: the toggle opens it and choosing a view closes it", async () => {
    const page = await open("light", { width: 375 });
    expect(await page.getByRole("navigation", { name: "Views" }).count()).toBe(0);
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.waitFor();
    await sheet.getByRole("link", { name: "Alerts" }).click();
    await page.waitForFunction(() => location.pathname === "/alerts");
    await sheet.waitFor({ state: "detached" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }, 60_000);

  for (const theme of THEMES) {
    test(`kiosk: no sidebar or controls, wallboard density, zero wcag2a/aa violations (${theme})`, async () => {
      const page = await open(theme, { query: "?kiosk=1" });
      expect(await page.locator('[data-slot="kiosk-shell"][data-kiosk="1"]').count()).toBe(1);
      expect(await page.getByRole("navigation", { name: "Views" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Toggle navigation" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: /^(Theme|Density):/ }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.dataset["density"])).toBe("wallboard");
      const { AxeBuilder } = await import("@axe-core/playwright");
      const results = await new AxeBuilder({ page })
        .options({ resultTypes: ["violations"] })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      const summary = results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }));
      expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
    }, 60_000);
  }
});
