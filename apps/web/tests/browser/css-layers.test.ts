// apps/web/tests/browser/css-layers.test.ts — the cascade-layer contract, measured in Chromium.
//
// styles/app.css is Tailwind's entry, with its layers `theme, base, components, utilities`. Probe
// rules are injected into the page's existing layers, so the assertions exercise the order the real
// bundle establishes:
//   • Preflight (`base`) applies everywhere: a plain <ul> loses its user-agent indent and marker;
//   • a utility beats a MORE specific `base` or `components` rule;
//   • the body sits on the theme background in the theme's font, and the `.dark` class re-themes it;
//   • inline code/kbd sit a step below the text around them (13px in 14px desk text, 16px in 18px
//     wallboard text), without shrinking again inside a <pre>.
//
// SELF-SKIPS when Chromium is not provisioned (see _harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";

import {
  browserDescribe,
  buildFixturePage,
  FIXTURE_ENTRY,
  type FixturePage,
  sharedBrowser,
} from "./_harness.js";

browserDescribe()("browser: cascade layers (Preflight, components, utilities)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let fixture: FixturePage;
  let page: Page;

  beforeAll(async () => {
    fixture = await buildFixturePage(FIXTURE_ENTRY, { theme: "light" });
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-fixture=status-showcase] [data-slot=status-badge]");
    await page.locator("body").evaluate((body) => {
      body.insertAdjacentHTML(
        "beforeend",
        '<div id="layer-probes"><ul id="plain-ul"><li>x</li></ul>' +
          '<p id="layer-probe" class="layer-probe">x</p></div>',
      );
    });
  }, 180_000);

  afterAll(async () => {
    await context?.close();
    fixture?.stop();
  });

  const css = (selector: string, property: string): Promise<string> =>
    page.locator(selector).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

  test("Preflight applies to all markup: a plain list has no user-agent indent or marker", async () => {
    expect(await css("#plain-ul", "padding-left")).toBe("0px");
    expect(await css("#plain-ul", "list-style-type")).toBe("none");
  });

  test("a utility-layer class beats more specific base and components rules", async () => {
    await page.addStyleTag({
      content:
        "@layer base { #layer-probes p#layer-probe { padding-right: 3px; } } " +
        "@layer components { #layer-probes p#layer-probe { padding-left: 5px; } } " +
        "@layer utilities { .layer-probe { padding-right: 7px; padding-left: 7px; } }",
    });
    expect(await css("#layer-probe", "padding-right")).toBe("7px");
    expect(await css("#layer-probe", "padding-left")).toBe("7px");
  });

  test("the body uses the theme background and Geist, and .dark re-themes it", async () => {
    const read = (): Promise<[string, string]> =>
      page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.background = "var(--background)";
        document.body.append(probe);
        const token = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return [getComputedStyle(document.body).backgroundColor, token];
      });
    const [lightBody, lightToken] = await read();
    expect(lightBody).toBe(lightToken);
    expect(await css("body", "font-family")).toContain("Geist Variable");
    // App registers the Geist faces (styles/fonts.ts); the file really loads from the fixture server.
    const loaded = await page.evaluate(async () => {
      await document.fonts.load('16px "Geist Variable"', "Pulse");
      return [...document.fonts].some((f) => f.family.includes("Geist Variable") && f.status === "loaded");
    });
    expect(loaded).toBe(true);

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    const [darkBody, darkToken] = await read();
    expect(darkBody).toBe(darkToken);
    expect(darkBody).not.toBe(lightBody);
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  });

  test("inline code and kbd are 13/14 of the surrounding text (16/18 on the wallboard); code in a pre keeps the pre's size", async () => {
    await page.locator("body").evaluate((body) => {
      body.insertAdjacentHTML(
        "beforeend",
        '<div id="mono-probes"><p style="font-size:14px">a <code id="probe-code">x</code> <kbd id="probe-kbd">K</kbd></p>' +
          '<pre id="probe-pre" style="font-size:12px"><code id="probe-pre-code">y</code></pre></div>',
      );
    });
    expect(await css("#probe-code", "font-size")).toBe("13px");
    expect(await css("#probe-kbd", "font-size")).toBe("13px");
    expect(await css("#probe-pre-code", "font-size")).toBe("12px");

    await page.evaluate(() => {
      document.documentElement.dataset["density"] = "wallboard";
      document.querySelector<HTMLElement>("#mono-probes p")!.style.fontSize = "18px";
    });
    expect(await css("#probe-code", "font-size")).toBe("16px");
    await page.evaluate(() => {
      delete document.documentElement.dataset["density"];
      document.querySelector("#mono-probes")!.remove();
    });
  });
});
