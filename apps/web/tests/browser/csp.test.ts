// apps/web/tests/browser/csp.test.ts — the Content-Security-Policy holds in a real browser (issue #2).
//
// Builds the client in PRODUCTION mode (`build-client.ts --minify`, the image's build) and, once
// more, in development mode, serves each through the production router (tests/browser/csp-server.ts:
// auth mode proxy-header over the mock engine, so the write dialogs exist), and in Chromium:
//   • proves the capture works — a deliberately non-nonced <style> is reported, then cleared;
//   • loads every route and tab (plus kiosk, an entity page, an unknown path) at desk width in both
//     themes, and checks the hashed pre-paint script ran (no flash fallback) and the inert chunk-css
//     data island is present and parseable;
//   • opens the surfaces that create DOM at runtime: the command palette, the theme menu, the alert
//     detail pane and its Silence / Acknowledge dialogs, the Expire confirm, the Propose edit dialog,
//     the Findings Severity / Code Selects, the coverage artifacts Popover, an error fallback and its Retry, the density menu, a tooltip, the uPlot charts (Engine, Timeline detail), and the mobile sheet;
// and asserts ZERO `securitypolicyviolation` events and zero CSP console messages throughout.
// Also checks every runtime <style> (react-remove-scroll's scroll lock, the Radix Select viewport,
// and — in the dev run's /_ui workbench — the Radix ScrollArea viewport) carries the style nonce.
//
// SELF-SKIPS when Chromium is not provisioned (see _harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";

import { browserDescribe, sharedBrowser } from "./_harness.js";
import { CSP_SERVER_IDENTITY_HEADER, CSP_SERVER_LISTENING } from "./csp-server.js";

const BUILD_CLIENT = resolve(import.meta.dir, "../../scripts/build-client.ts");
const CSP_SERVER = resolve(import.meta.dir, "csp-server.ts");

/** Every route and tab the production app serves, plus kiosk, entity pages, and the SPA fallback. */
const ROUTES = [
  "/overview",
  "/overview?kiosk=1",
  "/alerts",
  "/alerts?tab=catalog",
  "/alerts?tab=silences",
  "/timeline",
  "/estate",
  "/estate?tab=coverage",
  "/estate?tab=findings",
  "/estate/host/harbor-app-02",
  "/engine",
  "/no-such-route",
] as const;

/** A console message that reports a CSP block (Chromium and Firefox wording). */
const CSP_CONSOLE = /content[ -]security[ -]policy/i;

interface Served {
  mode: "production" | "development";
  base: string;
  proc: ReturnType<typeof Bun.spawn>;
  dir: string;
}

/** Build the client into a temp dir (subprocess: the in-process bundler is unreliable under bun test). */
function buildClient(mode: Served["mode"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pulse-csp-${mode}-`));
  const args = mode === "production" ? ["--minify", "--sourcemap", "none"] : [];
  const proc = Bun.spawnSync({ cmd: ["bun", BUILD_CLIENT, "--outdir", dir, ...args], stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`build-client (${mode}) exited ${proc.exitCode}\n${proc.stderr.toString()}`);
  return dir;
}

/** Start csp-server.ts over `dir` and resolve with its URL once it is listening. */
async function serve(mode: Served["mode"], dir: string): Promise<Served> {
  const proc = Bun.spawn(["bun", CSP_SERVER, dir], { stdout: "pipe", stderr: "ignore" });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let base = "";
  while (base === "") {
    const { value, done } = await reader.read();
    if (done) throw new Error(`csp-server exited before listening:\n${seen}`);
    seen += decoder.decode(value);
    const at = seen.indexOf(CSP_SERVER_LISTENING);
    if (at !== -1 && seen.indexOf("\n", at) !== -1) {
      base = seen.slice(at + CSP_SERVER_LISTENING.length, seen.indexOf("\n", at)).trim();
    }
  }
  void (async () => {
    while (!(await reader.read()).done);
  })(); // keep draining so the child never blocks on a full pipe
  return { mode, base, proc, dir };
}

browserDescribe()("browser: the Content-Security-Policy produces zero violations", () => {
  const served: Served[] = [];
  const contexts: BrowserContext[] = [];
  let browser: Browser;

  beforeAll(async () => {
    for (const mode of ["production", "development"] as const) served.push(await serve(mode, buildClient(mode)));
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
  }, 240_000);

  afterAll(async () => {
    for (const context of contexts) await context.close();
    for (const s of served) {
      s.proc.kill("SIGTERM");
      await s.proc.exited;
      rmSync(s.dir, { recursive: true, force: true });
    }
  }, 60_000);

  /** A page whose CSP violations (events + console) land in the returned list. */
  async function open(
    opts: { theme?: "light" | "dark"; width?: number } = {},
  ): Promise<{ page: Page; violations: string[] }> {
    const context = await browser.newContext({
      viewport: { width: opts.width ?? 1280, height: 900 },
      extraHTTPHeaders: { [CSP_SERVER_IDENTITY_HEADER]: "csp-suite" },
    });
    contexts.push(context);
    const violations: string[] = [];
    await context.exposeBinding("__pulseCspViolation", (_source, line: string) => {
      violations.push(line);
    });
    await context.addInitScript((theme) => {
      localStorage.setItem("pulse.web.theme", theme);
      document.addEventListener(
        "securitypolicyviolation",
        (e) => {
          const report = (window as unknown as { __pulseCspViolation(line: string): void }).__pulseCspViolation;
          report(`${e.effectiveDirective} blocked=${e.blockedURI} at ${e.sourceFile}:${e.lineNumber} sample=${e.sample}`);
        },
        true,
      );
    }, opts.theme ?? "light");
    const page = await context.newPage();
    page.on("console", (message) => {
      if (CSP_CONSOLE.test(message.text())) violations.push(`console: ${message.text()}`);
    });
    return { page, violations };
  }

  async function visit(page: Page, base: string, path: string): Promise<void> {
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main [data-slot$="-page"]', { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
  }

  /** Wait for `dialog` to open, then close it with Escape and wait until it is gone. */
  async function openThenDismiss(page: Page, dialog: Locator): Promise<void> {
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  }

  for (const mode of ["production", "development"] as const) {
    const server = (): Served => served.find((s) => s.mode === mode)!;

    test(`${mode}: the violation capture works (a non-nonced <style> is reported)`, async () => {
      const { page, violations } = await open();
      await visit(page, server().base, "/overview");
      await page.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = "body { outline: 0 }";
        document.head.append(style);
      });
      for (let i = 0; i < 50 && violations.length === 0; i++) await Bun.sleep(100);
      expect(violations.join("\n")).toContain("style-src");
    }, 60_000);

    for (const theme of ["light", "dark"] as const) {
      test(`${mode}: every route loads with zero violations (${theme})`, async () => {
        const { page, violations } = await open({ theme });
        for (const path of ROUTES) {
          await visit(page, server().base, path);
          const shell = await page.evaluate(() => {
            const island = document.getElementById("pulse-chunk-css");
            let islandOk = false;
            try {
              islandOk = island !== null && typeof JSON.parse(island.textContent ?? "") === "object";
            } catch {
              islandOk = false;
            }
            return {
              density: document.documentElement.dataset["density"] ?? null,
              dark: document.documentElement.classList.contains("dark"),
              islandOk,
            };
          });
          // The hashed pre-paint script ran: it stamped density and the stored theme.
          expect(shell, path).toEqual({
            density: path.includes("kiosk=1") ? "wallboard" : "desk",
            dark: theme === "dark",
            islandOk: true,
          });
        }
        expect(violations, violations.join("\n")).toEqual([]);
      }, 300_000);
    }

    test(`${mode}: dialogs, menus, popovers and charts open with zero violations`, async () => {
      const { page, violations } = await open();
      const base = server().base;
      const steps: string[] = [];
      const step = async (name: string, run: () => Promise<void>): Promise<void> => {
        steps.push(name);
        await run();
      };

      await step("command palette", async () => {
        await visit(page, base, "/overview");
        await page.keyboard.press("Control+k");
        const palette = page.getByRole("dialog", { name: "Command palette" });
        await palette.waitFor();
        await page.keyboard.type("alerts");
        // The modal's scroll lock injected a <style> that carries this response's nonce.
        const nonced = await page.evaluate(() => {
          const meta = document.querySelector<HTMLMetaElement>('meta[name="pulse-csp-nonce"]');
          const nonce = meta?.nonce ?? "";
          return {
            nonce: nonce.length > 0,
            hidden: meta?.getAttribute("nonce") === "",
            styles: [...document.querySelectorAll("style")].filter((s) => s.nonce === nonce).length,
          };
        });
        expect(nonced.nonce).toBe(true);
        expect(nonced.hidden).toBe(true); // nonce hiding: the attribute is not readable from the DOM
        expect(nonced.styles).toBeGreaterThan(0);
        await openThenDismiss(page, palette);
      });

      await step("theme menu", async () => {
        await page.getByRole("button", { name: /^Theme:/ }).click();
        await page.getByRole("menuitemradio", { name: "Dark" }).click();
        await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
      });

      await step("tooltip", async () => {
        await page.locator('[data-slot="tooltip-trigger"]').first().hover();
        await page.getByRole("tooltip").first().waitFor({ timeout: 10_000 });
      });

      await step("alert detail, Silence and Acknowledge dialogs", async () => {
        await visit(page, base, "/alerts");
        await page.locator("main tbody tr").first().getByRole("button").first().click();
        await page.waitForURL(/[?&]sel=/);
        await page.getByRole("button", { name: "Silence…" }).click();
        await openThenDismiss(page, page.getByRole("dialog", { name: /^Silence / }));
        await page.getByRole("button", { name: /^(Acknowledge|Update acknowledgement)…$/ }).click();
        await openThenDismiss(page, page.getByRole("dialog", { name: /acknowledg/i }));
      });

      await step("Expire silence confirm", async () => {
        await visit(page, base, "/alerts?tab=silences");
        await page.getByRole("button", { name: /^Expire/ }).first().click();
        await openThenDismiss(page, page.getByRole("alertdialog"));
      });

      await step("findings Severity and Code Selects (Radix Select injects its own <style>)", async () => {
        await visit(page, base, "/estate?tab=findings");
        for (const testId of ["estate-findings-sev", "estate-findings-code"]) {
          await page.getByTestId(testId).click();
          await page.getByRole("listbox").waitFor();
          const viewportStyles = await page.evaluate(() => {
            const nonce = document.querySelector<HTMLMetaElement>('meta[name="pulse-csp-nonce"]')?.nonce ?? "";
            const styles = [...document.querySelectorAll("style")].filter((s) =>
              (s.textContent ?? "").includes("data-radix-select-viewport"),
            );
            return { count: styles.length, nonced: styles.every((s) => nonce !== "" && s.nonce === nonce) };
          });
          expect(viewportStyles).toEqual({ count: 1, nonced: true });
          await page.keyboard.press("Escape");
          await page.getByRole("listbox").waitFor({ state: "hidden" });
        }
      });

      await step("coverage artifacts Popover", async () => {
        await visit(page, base, "/estate?tab=coverage");
        await page.locator("main button[data-artifacts]").first().click();
        const popover = page.getByRole("dialog", { name: /^Artifacts for / });
        await openThenDismiss(page, popover);
      });

      await step("density menu", async () => {
        await visit(page, base, "/estate?tab=coverage");
        await page.getByRole("button", { name: /^Density:/ }).click();
        await page.getByRole("menu").waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "hidden" });
      });

      await step("Propose edit dialog", async () => {
        await visit(page, base, "/estate/host/harbor-app-02");
        await page.getByRole("button", { name: "Propose edit…" }).click();
        await openThenDismiss(page, page.getByRole("dialog", { name: /^Propose edit: / }));
      });

      await step("Engine charts", async () => {
        await visit(page, base, "/engine");
        await page.locator(".uplot").first().waitFor({ timeout: 15_000 });
        const box = await page.locator(".uplot canvas, .uplot .u-over").first().boundingBox();
        if (box !== null) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      });

      await step("Timeline detail chart", async () => {
        await visit(page, base, "/timeline");
        await page.locator('[data-slot="timeline-lane-name"]').first().click();
        await page.waitForURL(/[?&]sel=/);
        await page.locator(".uplot").first().waitFor({ timeout: 15_000 });
      });

      await step("error fallback and Retry (a malformed /api/estate body)", async () => {
        await page.route("**/api/estate*", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ malformed: true }) }),
        );
        await visit(page, base, "/estate");
        const retry = page.locator('main [data-slot="error-state"]').getByRole("button", { name: /retry/i });
        await retry.waitFor({ timeout: 15_000 });
        await page.unrouteAll({ behavior: "wait" });
        await retry.click();
        await page.locator('main [data-slot="error-state"]').waitFor({ state: "detached", timeout: 15_000 });
        await page.locator('main [data-slot="tabs"]').first().waitFor({ timeout: 15_000 });
      });

      await page.waitForLoadState("networkidle");
      expect(steps.length).toBe(12);
      expect(violations, violations.join("\n")).toEqual([]);
    }, 300_000);

    if (mode === "development") {
      test("development: the /_ui workbench (every @/ui component, ScrollArea, Select) has zero violations", async () => {
        const { page, violations } = await open();
        await visit(page, server().base, "/_ui");
        const scrollAreaStyles = await page.evaluate(() => {
          const nonce = document.querySelector<HTMLMetaElement>('meta[name="pulse-csp-nonce"]')?.nonce ?? "";
          const styles = [...document.querySelectorAll("style")].filter((s) =>
            (s.textContent ?? "").includes("data-radix-scroll-area-viewport"),
          );
          return { some: styles.length > 0, nonced: styles.every((s) => nonce !== "" && s.nonce === nonce) };
        });
        expect(scrollAreaStyles).toEqual({ some: true, nonced: true });
        await page.getByRole("combobox", { name: "Minimum severity" }).click();
        await page.getByRole("listbox").waitFor();
        await page.keyboard.press("Escape");
        await page.waitForLoadState("networkidle");
        expect(violations, violations.join("\n")).toEqual([]);
      }, 120_000);
    }

    test(`${mode}: the mobile navigation sheet opens with zero violations`, async () => {
      const { page, violations } = await open({ width: 375 });
      await visit(page, server().base, "/overview");
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      await page.getByRole("navigation", { name: "Views" }).waitFor();
      await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Alerts" }).click();
      await page.waitForSelector('main [data-slot="alerts-page"]');
      expect(violations, violations.join("\n")).toEqual([]);
    }, 120_000);
  }
});
