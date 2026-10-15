// apps/web/tests/browser/harness.test.ts — REQ-TEST-03 (10 §12.1).
//
// Two halves in one file: a Chromium-free unit block (plain `describe`) that exercises
// `renderFixtureShell` (pure), and a gated block (`browserDescribe()`) that boots the built page
// under Chromium and asserts the theme flows all the way through to
// the `.dark` class on `<html>`. When Chromium is absent the second half self-skips
// distinctly via `browserDescribe()` (BROWSER_SKIP_MESSAGE once per process) — REQ-OBS-03.
//
// SELF-SKIPS when Chromium is not provisioned (see _harness.browserDescribe).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";

import {
  browserDescribe,
  buildFixturePage,
  createSharedBrowser,
  FIXTURE_ENTRY,
  renderFixtureShell,
  type FixturePage,
  sharedBrowser,
} from "./_harness.js";

describe("harness: renderFixtureShell (unit, Chromium-free)", () => {
  test("REQ-TEST-03: renderFixtureShell marks the requested theme (dark)", () => {
    const html = renderFixtureShell("main.js", "main.css", "dark");
    expect(html).toContain(`<html lang="en" class="dark" style="color-scheme: dark">`);
  });

  test("REQ-TEST-03: renderFixtureShell marks the requested theme (light)", () => {
    const html = renderFixtureShell("main.js", "main.css", "light");
    expect(html).toContain(`<html lang="en" style="color-scheme: light">`);
  });

  test("REQ-TEST-03: renderFixtureShell links the stylesheet when one exists", () => {
    const html = renderFixtureShell("a.js", "a.css", "dark");
    expect(html).toContain(`<link rel="stylesheet" href="/a.css" />`);
    expect(html).toContain(`<script type="module" src="/a.js"></script>`);
  });

  test("REQ-TEST-03: renderFixtureShell omits the <link> when cssName is null", () => {
    const html = renderFixtureShell("a.js", null, "dark");
    expect(html).not.toContain("<link");
    expect(html).toContain(`<script type="module" src="/a.js"></script>`);
  });
});

describe("harness: createSharedBrowser (unit, Chromium-free)", () => {
  class FakeBrowser {
    connected = true;
    private readonly listeners: (() => void)[] = [];
    isConnected(): boolean {
      return this.connected;
    }
    on(_event: "disconnected", listener: () => void): this {
      this.listeners.push(listener);
      return this;
    }
    crash(): void {
      this.connected = false;
      for (const listener of this.listeners) listener();
    }
  }

  test("shares one launch, and relaunches once the browser disconnects (a crash)", async () => {
    const launched: FakeBrowser[] = [];
    let relaunches = 0;
    const get = createSharedBrowser(
      async () => {
        const browser = new FakeBrowser();
        launched.push(browser);
        return browser;
      },
      () => {
        relaunches += 1;
      },
    );
    const first = await get();
    expect(await get()).toBe(first);
    expect(launched.length).toBe(1);

    first.crash();
    const second = await get();
    expect(second).not.toBe(first);
    expect(second.isConnected()).toBe(true);
    expect(await get()).toBe(second);
    expect(launched.length).toBe(2);
    expect(relaunches).toBe(1);
  });

  test("a failed launch is not cached: the next call launches again", async () => {
    let calls = 0;
    const get = createSharedBrowser(async () => {
      calls += 1;
      if (calls === 1) throw new Error("launch failed");
      return new FakeBrowser();
    });
    await expect(get()).rejects.toThrow("launch failed");
    expect((await get()).isConnected()).toBe(true);
    expect(calls).toBe(2);
  });
});

browserDescribe()("harness: buildFixturePage end-to-end (browser)", () => {
  let browser: Browser;
  let darkPage: Page;
  let lightPage: Page;
  let darkFixture: FixturePage;
  let lightFixture: FixturePage;

  beforeAll(async () => {
    // Build BEFORE launching Chromium.
    darkFixture = await buildFixturePage(FIXTURE_ENTRY, { theme: "dark" });
    lightFixture = await buildFixturePage(FIXTURE_ENTRY, { theme: "light" });
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
    const context = await browser.newContext();
    darkPage = await context.newPage();
    lightPage = await context.newPage();
    await darkPage.goto(darkFixture.url, { waitUntil: "networkidle" });
    await lightPage.goto(lightFixture.url, { waitUntil: "networkidle" });
  }, 120_000);

  afterAll(async () => {
    await darkPage?.context().close();
    darkFixture?.stop();
    lightFixture?.stop();
  }, 60_000);

  test("REQ-TEST-03: the built page reports the requested theme (dark)", async () => {
    const [dark, scheme] = await darkPage.evaluate(() => [
      document.documentElement.classList.contains("dark"),
      document.documentElement.style.colorScheme,
    ]);
    expect(dark).toBe(true);
    expect(scheme).toBe("dark");
  }, 60_000);

  test("REQ-TEST-03: the built page reports the requested theme (light)", async () => {
    const [dark, scheme] = await lightPage.evaluate(() => [
      document.documentElement.classList.contains("dark"),
      document.documentElement.style.colorScheme,
    ]);
    expect(dark).toBe(false);
    expect(scheme).toBe("light");
  }, 60_000);
});
