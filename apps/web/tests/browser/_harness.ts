// apps/web/tests/browser/_harness.ts — shared support for the browser-criteria suite (09 §4).
// NOT a test file (no `test(...)` calls). It provides four things the grayscale / reflow / axe /
// harness files share:
//
//   1. chromiumAvailable() — a SYNCHRONOUS filesystem probe; browser files gate their whole
//      `describe` on the result via browserDescribe() (09 §4.1).
//   2. browserDescribe() — the SINGLE suite gate (09 §4.2). Returns `describe` when Chromium is
//      provisioned, `describe.skip` otherwise (printing BROWSER_SKIP_MESSAGE to stderr once per
//      process). When PULSE_REQUIRE_BROWSER=1 and Chromium is absent, THROWS so the file fails at
//      collection instead of quietly skipping (REQ-TEST-04, REQ-CI-01, REQ-OBS-03).
//   3. renderFixtureShell(jsName, cssName, theme) — pure, synchronous shell HTML (09 §4.3);
//      unit-testable without Chromium; marks the theme on `<html>` (REQ-TEST-03).
//   4. buildFixturePage(entry, { theme }) — bundles `entry` via a build-fixture.ts SUBPROCESS (see
//      block-comment inside doBuildFixtureBundle), writes the shell via renderFixtureShell, and
//      serves the result on loopback via serveDir. Memoized per (entry, theme); server per call
//      (09 §4.4).
//
//   Also carries the small loopback static server (serveDir) so Chromium loads pages over HTTP
//   (module scripts are CORS-blocked over file://).

import { describe } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser } from "playwright-core";

const HERE = import.meta.dir; // apps/web/tests/browser
/** Repo root (four levels up from apps/web/tests/browser). */
const ROOT = resolve(HERE, "../../../..");

/** Env var that makes a missing Chromium fatal (REQ-TEST-04, REQ-CI-01). Set to `"1"` in CI. */
export const REQUIRE_BROWSER_ENV = "PULSE_REQUIRE_BROWSER" as const;

/** The install command printed with the skip reason (REQ-TEST-04). */
export const CHROMIUM_INSTALL_HINT = "bunx playwright-core install chromium" as const;

/** The skip/failure message (REQ-OBS-03). */
export const BROWSER_SKIP_MESSAGE =
  `browser suite skipped: Chromium not provisioned (run: ${CHROMIUM_INSTALL_HINT})` as const;

/** Absolute path of the default fixture entry (`tests/browser/fixture.tsx`) — 09 §4.4.1. */
export const FIXTURE_ENTRY = resolve(HERE, "fixture.tsx");

/** The subprocess bundler for fixture entries (React production build; see build-fixture.ts). */
export const FIXTURE_BUILD_SCRIPT = resolve(HERE, "build-fixture.ts");

/** Document theme marked on `<html>` — the `.dark` class + color-scheme (REQ-TEST-03). */
export type FixtureTheme = "dark" | "light";

/** A built, served fixture page (00 §9.2). */
export interface FixturePage {
  /** Temp dir holding the bundle and `index.html`. */
  dir: string;
  /** `http://127.0.0.1:<port>/` of the loopback server. */
  url: string;
  /** Basename of the bundled JS entry inside `dir`. */
  jsName: string;
  /** Basename of the emitted stylesheet inside `dir`, or `null` when the entry imports no CSS. */
  cssName: string | null;
  /** Stop the loopback server. Idempotent. */
  stop(): void;
}

/** A running loopback static server (00 §9.2). */
export interface FixtureServer {
  /** `http://127.0.0.1:<port>/` — the bound loopback origin with a trailing slash. */
  url: string;
  /** Close the listening socket; idempotent. */
  stop(): void;
}

/**
 * Is a launchable Chromium provisioned for the installed `playwright-core`? SYNCHRONOUS on purpose:
 * the browser test files gate their whole `describe` on this via browserDescribe(), and
 * `describe`/`describe.skip` MUST be registered during synchronous module evaluation — a top-level
 * `await` would defer registration past the run and crash bun's runner ("Cannot call describe.skip()
 * after the test run has completed").
 *
 * It is a pure FILESYSTEM check that deliberately does NOT `import "playwright-core"` — importing
 * that module eagerly (only to read a path) drags its bundled deps into every process that merely
 * LOADS a browser test file. Instead we read the exact Chromium revision `playwright-core` expects
 * (from its `browsers.json`) and check whether that build exists in the browser cache. Chromium is a
 * provisioned TOOL (`bunx playwright-core install chromium`), not a package dependency; absent → the
 * suite self-skips so a plain `bun test` stays green. Never throws.
 */
export function chromiumAvailable(): boolean {
  try {
    const browsersJson = resolve(HERE, "../../../../node_modules/playwright-core/browsers.json");
    const registry = JSON.parse(readFileSync(browsersJson, "utf8")) as {
      browsers: Array<{ name: string; revision: string }>;
    };
    const chromiumRev = registry.browsers.find((b) => b.name === "chromium")?.revision;
    if (chromiumRev === undefined) return false;

    const cacheRoot =
      process.env["PLAYWRIGHT_BROWSERS_PATH"] && process.env["PLAYWRIGHT_BROWSERS_PATH"] !== "0"
        ? process.env["PLAYWRIGHT_BROWSERS_PATH"]
        : join(homedir(), ".cache", "ms-playwright");

    const buildDir = join(cacheRoot, `chromium-${chromiumRev}`);
    return (
      existsSync(join(buildDir, "chrome-linux64", "chrome")) ||
      existsSync(join(buildDir, "chrome-linux", "chrome"))
    );
  } catch {
    return false;
  }
}

let sharedBrowserOnce: Promise<Browser> | null = null;

/**
 * The ONE headless Chromium shared by every browser-backed suite in a `bun test` process. Suites own
 * and close their contexts/pages but NEVER close this browser; Chromium exits with the process (its
 * control pipe closes).
 *
 * Why shared: under bun 1.3.9 each additional Chromium launched in one process — especially after
 * large pipe replies (axe results, screenshots) — raises the odds that a later reply is never
 * delivered, so the next newContext/newPage hangs and takes down every later browser file. ~10
 * per-file launch/close rounds wedged a plain `bun test`; one browser carries the whole suite.
 * `playwright-core` is imported lazily so merely LOADING a browser file stays cheap.
 */
export function sharedBrowser(): Promise<Browser> {
  sharedBrowserOnce ??= import("playwright-core").then(({ chromium }) => chromium.launch({ headless: true }));
  return sharedBrowserOnce;
}

/** Printed at most once per `bun test` process, however many browser files load (REQ-OBS-03). */
let skipPrinted = false;

/**
 * The single suite gate (09 §4.2, tech-spec §10 item 9). MUST be called synchronously at a browser
 * test file's module top: `browserDescribe()("name", () => { … })`.
 *
 * @returns `describe` when Chromium is provisioned; `describe.skip` otherwise.
 * @throws {Error} `BROWSER_SKIP_MESSAGE` when Chromium is absent and
 *   `process.env[REQUIRE_BROWSER_ENV] === "1"` — thrown during module evaluation, so the file fails
 *   at collection instead of reporting a green skip (REQ-CI-01, REQ-TEST-04).
 */
export function browserDescribe(): typeof describe {
  if (chromiumAvailable()) return describe;
  if (process.env[REQUIRE_BROWSER_ENV] === "1") throw new Error(BROWSER_SKIP_MESSAGE);
  if (!skipPrinted) {
    skipPrinted = true;
    process.stderr.write(`${BROWSER_SKIP_MESSAGE}\n`);
  }
  return describe.skip;
}

/**
 * The shell HTML for a built fixture bundle (09 §4.3). Pure: no I/O, no globals. The theme is marked
 * on `<html>` as the app's pre-paint script does — the `.dark` class (dark only) plus `color-scheme` —
 * which is what REQ-TEST-03 requires and what `harness.test.ts` asserts.
 *
 * @param jsName - Basename of the emitted entry bundle, served at `/<jsName>`.
 * @param cssName - Basename of the emitted stylesheet, or `null` when the entry imports no CSS.
 * @param theme - `"dark" | "light"` (`FixtureTheme`).
 */
export function renderFixtureShell(
  jsName: string,
  cssName: string | null,
  theme: FixtureTheme,
): string {
  return (
    `<!doctype html><html lang="en"${theme === "dark" ? ' class="dark"' : ""} style="color-scheme: ${theme}"><head>` +
    `<meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<title>Pulse — browser fixture (${theme})</title>` +
    (cssName !== null ? `<link rel="stylesheet" href="/${cssName}" />` : "") +
    `</head><body><div id="app"></div>` +
    `<script type="module" src="/${jsName}"></script></body></html>\n`
  );
}

/** The built bundle. Internal — callers receive a `FixturePage`. */
interface FixtureBundle {
  dir: string;
  jsName: string;
  cssName: string | null;
}

/** Memoized per `${entry}\0${theme}`: one fixture build per distinct fixture page, per process. */
const bundles = new Map<string, Promise<FixtureBundle>>();

/**
 * Bundle `entry` via a build-fixture.ts subprocess, synthesize `index.html` with the theme marked on `<html>` and
 * the app stylesheet, serve on loopback. Memoized per `(entry, theme)`: a second call with the same
 * (entry, theme) shares the one bundle. The loopback server is created PER CALL so each returned
 * page owns exactly one server (three suites in one process cannot tear down each other's URL —
 * 09 §4.4.1).
 */
export function buildFixturePage(
  entry: string,
  opts: { theme: FixtureTheme },
): Promise<FixturePage> {
  const key = `${entry}\0${opts.theme}`;
  let pending = bundles.get(key);
  if (pending === undefined) {
    pending = doBuildFixtureBundle(entry, opts.theme);
    // A REJECTED promise stays cached on purpose: a broken fixture fails every waiting suite with
    // the same error and never rebuilds in a loop.
    bundles.set(key, pending);
  }
  return pending.then((bundle) => {
    const server = serveDir(bundle.dir);
    let stopped = false;
    return {
      dir: bundle.dir,
      url: server.url,
      jsName: bundle.jsName,
      cssName: bundle.cssName,
      stop(): void {
        if (stopped) return;
        stopped = true;
        server.stop();
      },
    };
  });
}

async function doBuildFixtureBundle(entry: string, theme: FixtureTheme): Promise<FixtureBundle> {
  const dir = mkdtempSync(join(tmpdir(), "pulse-web-browser-"));

  // Build in a FRESH subprocess (build-fixture.ts), NOT the in-process `Bun.build`. The in-process bundler's
  // node_modules resolver is unreliable inside `bun test` — it intermittently fails to resolve bare
  // specifiers the fixture pulls transitively (`@pulse/renderer` → `@pulse/core` → `zod`, …), and a
  // whole test run either resolves or doesn't. A separate bundler process has a clean resolver and
  // builds deterministically. The fixture imports the REAL overview components + `styles.css`, which
  // is exactly what we want under a real browser.
  const proc = Bun.spawnSync({
    cmd: ["bun", FIXTURE_BUILD_SCRIPT, entry, dir],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `browser fixture bundle failed (build-fixture exit ${proc.exitCode}) for ${entry}:\n${proc.stderr.toString()}`,
    );
  }

  const files = readdirSync(dir);
  const jsName = files.find((f) => f.endsWith(".js"));
  const cssName = files.find((f) => f.endsWith(".css")) ?? null;
  if (jsName === undefined) throw new Error(`fixture build produced no .js output in ${dir}`);
  if (cssName !== null) assertLayerOrderLeads(readFileSync(join(dir, cssName), "utf8"), entry);

  writeFileSync(join(dir, "index.html"), renderFixtureShell(jsName, cssName, theme), "utf8");
  return { dir, jsName, cssName };
}

/**
 * Fail a fixture whose bundled CSS opens the `legacy` cascade layer before styles/app.css declares
 * the layer order: the layer would then rank below Preflight. A fixture entry must import app.css
 * before anything that imports a component stylesheet.
 */
export function assertLayerOrderLeads(css: string, entry: string): void {
  const firstLegacy = css.search(/@layer legacy\s*\{/);
  if (firstLegacy === -1) return;
  const order = css.search(/@layer theme,\s*base,\s*legacy,\s*components,\s*utilities\s*;/);
  if (order === -1 || order > firstLegacy) {
    throw new Error(`fixture ${entry}: import styles/app.css first — its @layer order must lead the CSS`);
  }
}

/** Serve `dir` over an ephemeral loopback port (index.html at `/`, files by name). */
export function serveDir(dir: string): FixtureServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      if (name.includes("..")) return new Response("bad request", { status: 400 });
      const file = Bun.file(join(dir, name));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
}
