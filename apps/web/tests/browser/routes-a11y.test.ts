// apps/web/tests/browser/routes-a11y.test.ts — every route, end to end, in Chromium.
//
// Boots the real dev server (`scripts/dev.ts --mock degraded-mix`, the production server over the
// in-process mock engine, with a development client build, so React StrictMode's double effects run
// too) and, for every route and tab in both themes at desk and wallboard density:
//   • waits for the view's `[data-slot$="-page"]` root, with exactly one <h1> and one <main>;
//   • checks the active nav item is `aria-current="page"`;
//   • runs axe (wcag2a + wcag2aa) and expects zero violations.
// Then the keyboard path: the skip link is the first tab stop and moves focus to <main>, and the
// sidebar nav routes by keyboard. The per-view suites hold their own fixtures and states; this one
// proves the composed app on live mock data.
//
// SELF-SKIPS when Chromium is not provisioned (see _harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

import { browserDescribe, sharedBrowser } from "./_harness.js";

const DEV_SCRIPT = resolve(import.meta.dir, "../../scripts/dev.ts");
/** Pins the mock scenario start, so the VM/Alertmanager/vmalert bodies are the same on every run.
 *  It does not pin the app's "now": rendered ages and Gatus results still follow the real clock. */
const CLOCK = "2026-01-01T12:00:00Z";

/** Every route and tab, with the nav item that should be current there. */
const ROUTES: readonly { path: string; nav: string }[] = [
  { path: "/overview", nav: "Overview" },
  { path: "/alerts", nav: "Alerts" },
  { path: "/alerts?tab=catalog", nav: "Alerts" },
  { path: "/alerts?tab=silences", nav: "Alerts" },
  { path: "/timeline", nav: "Timeline" },
  { path: "/estate", nav: "Estate" },
  { path: "/estate?tab=coverage", nav: "Estate" },
  { path: "/estate?tab=findings", nav: "Estate" },
  { path: "/engine", nav: "Engine" },
];

/** The wallboards checked for a kiosk side gutter, and the least gutter they keep (the wallboard
 *  `p-4` is 20px; 16px is the desk outlet's). The estate entity pages share the estate page root. */
const KIOSK_ROUTES = [
  "/overview",
  "/alerts",
  "/timeline",
  "/engine",
  "/estate",
  "/estate/host/harbor-hv-01",
  "/estate/service/harbor-web-01/portal-web",
] as const;
const KIOSK_GUTTER_PX = 16;

const MODES = [
  { theme: "light", density: "desk" },
  { theme: "dark", density: "desk" },
  { theme: "light", density: "wallboard" },
  { theme: "dark", density: "wallboard" },
] as const;

browserDescribe()("browser: every route is axe-clean in both themes at desk and wallboard density", () => {
  let dev: ReturnType<typeof Bun.spawn> | null = null;
  let base = "";
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    dev = Bun.spawn(["bun", DEV_SCRIPT, "--mock", "degraded-mix", "--port", "0", "--clock", CLOCK], {
      stdout: "pipe",
      stderr: "ignore",
    });
    // `[dev] server listening on http://<host>:<port>  mock=<scenario>` carries the bound port.
    const decoder = new TextDecoder();
    let seen = "";
    const reader = (dev.stdout as ReadableStream<Uint8Array>).getReader();
    while (base === "") {
      const { value, done } = await reader.read();
      if (done) throw new Error(`dev server exited before listening:\n${seen}`);
      seen += decoder.decode(value);
      const match = /server listening on (http:\/\/[^\s]+)/.exec(seen);
      if (match !== null) base = match[1]!;
    }
    // Keep draining stdout so the child never blocks on a full pipe.
    void (async () => {
      while (!(await reader.read()).done);
    })();
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
  }, 240_000);

  afterAll(async () => {
    for (const context of contexts) await context.close();
    dev?.kill("SIGTERM");
    await dev?.exited;
  }, 60_000);

  async function open(mode: (typeof MODES)[number]): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    contexts.push(context);
    await context.addInitScript(
      ([theme, density]) => {
        localStorage.setItem("pulse.web.theme", theme);
        localStorage.setItem("pulse.web.density", density);
      },
      [mode.theme, mode.density] as const,
    );
    return context.newPage();
  }

  async function visit(page: Page, path: string): Promise<void> {
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main [data-slot$="-page"]', { timeout: 30_000 });
    // Let lazy regions (history, charts) settle before scanning.
    await page.waitForLoadState("networkidle");
  }

  for (const mode of MODES) {
    test(`all routes: one h1, current nav item, zero wcag2a/aa violations (${mode.theme}, ${mode.density})`, async () => {
      const { AxeBuilder } = await import("@axe-core/playwright");
      const page = await open(mode);
      const failures: string[] = [];
      for (const route of ROUTES) {
        await visit(page, route.path);
        const shape = await page.evaluate(() => ({
          h1: document.querySelectorAll("h1").length,
          main: document.querySelectorAll("main").length,
          dark: document.documentElement.classList.contains("dark"),
          density: document.documentElement.dataset["density"] ?? null,
          current: document.querySelector('nav [aria-current="page"]')?.textContent?.trim() ?? null,
        }));
        expect(shape, route.path).toMatchObject({ h1: 1, main: 1, dark: mode.theme === "dark", density: mode.density });
        expect(shape.current, `${route.path}: current nav item`).toContain(route.nav);
        const results = await new AxeBuilder({ page }).options({ resultTypes: ["violations"] }).withTags(["wcag2a", "wcag2aa"]).analyze();
        for (const v of results.violations) {
          failures.push(`${route.path}: ${v.id} ${JSON.stringify(v.nodes.slice(0, 3).map((n) => n.target))}`);
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    }, 300_000);
  }

  // Kiosk drops the shell's outlet padding (full-bleed page fit), so each wallboard page brings its
  // own side gutter. A view that forgets it sits flush at x=0 (GitHub #48: alerts; #58: estate).
  test("kiosk: every wallboard page keeps a side gutter at 1920px", async () => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    contexts.push(context);
    const page = await context.newPage();
    const flush: string[] = [];
    for (const path of KIOSK_ROUTES) {
      await visit(page, `${path}?kiosk=1`);
      // An entity route measures its rendered entity page, not a loading or not-found stand-in.
      if (path.startsWith("/estate/")) await page.waitForSelector('[data-testid="estate-entity"]', { timeout: 30_000 });
      const edges = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('main [data-slot$="-page"]')!;
        const r = root.getBoundingClientRect();
        const cs = getComputedStyle(root);
        return {
          left: r.left + parseFloat(cs.paddingLeft),
          right: document.documentElement.clientWidth - (r.right - parseFloat(cs.paddingRight)),
        };
      });
      if (edges.left < KIOSK_GUTTER_PX || edges.right < KIOSK_GUTTER_PX) flush.push(`${path}: ${JSON.stringify(edges)}`);
    }
    // What the kiosk outlet renders in place of a page root (the view chunk's loading/error state, a
    // page error fallback) gets the same gutter from <main>.
    const standIns = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const probe = (attrs: Record<string, string>): number => {
        const el = document.createElement("div");
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        el.textContent = "probe";
        main.append(el);
        const left = parseFloat(getComputedStyle(el).paddingLeft);
        el.remove();
        return left;
      };
      return {
        loading: probe({ "data-slot": "loading-state" }),
        error: probe({ "data-slot": "alerts-page", "data-state": "error" }),
        page: probe({ "data-slot": "alerts-page" }),
      };
    });
    expect(standIns.loading).toBeGreaterThanOrEqual(KIOSK_GUTTER_PX);
    expect(standIns.error).toBeGreaterThanOrEqual(KIOSK_GUTTER_PX);
    expect(standIns.page).toBe(0); // a page root brings its own gutter; the outlet adds none
    expect(flush, flush.join("\n")).toEqual([]);
  }, 120_000);

  test("keyboard: the skip link leads to <main>, and the nav routes by keyboard", async () => {
    const page = await open(MODES[0]);
    await visit(page, "/overview");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("#main");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");

    const alerts = page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Alerts" });
    await alerts.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector('main [data-slot="alerts-page"]');
    expect(new URL(page.url()).pathname).toBe("/alerts");
    expect(await alerts.getAttribute("aria-current")).toBe("page");
  }, 120_000);
});
