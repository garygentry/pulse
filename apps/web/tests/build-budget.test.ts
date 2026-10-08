// apps/web/tests/build-budget.test.ts — SC-04, REQ-PERF-01/03, REQ-UI-04, 10-testing-strategy.md §3.10.
//
// The design-system build-size gate. NOTE ON FILENAME: 10 §3.10 calls this "build.test.ts", but
// apps/web/tests/build.test.ts is web-foundation's snapshot-fold test (unrelated) and the initial-
// route budget contract lives in client-build.test.ts — both are web-foundation source this member
// must not edit (CON-04). So this member's tightened three-way budget + REQ-PERF-3 + REQ-UI-04
// assertions live in this separately-named, member-owned file (mirroring the item-009 precedent for
// the skeleton.test.ts name collision).
//
// Builds the client via the CLI subprocess (as client-build.test.ts does — the in-process bundler's
// resolver is unreliable inside `bun test`) and asserts, against the measured baseline:
//   • initial-route JS (entries.js plus every chunk they import statically) gz ≤
//     INITIAL_ROUTE_JS_BUDGET_BYTES
//   • total JS (entries.js + every .js chunk) gz ≤ TOTAL_JS_BUDGET_BYTES
//   • total CSS (entries.css + every .css chunk) gz ≤ TOTAL_CSS_BUDGET_BYTES
//   • "uplot" is ABSENT from the initial-route JS (REQ-PERF-3) — uPlot must never ship on the initial
//     route. The complementary "uPlot present in a lazy chunk" assertion lives with the chart's
//     consumer, engine-health-timeline (timeline-view-chunk.test.ts).
//   • each view's first load (initial route + view chunk closure + icon chunk) gz ≤ its ceiling, and
//     the overview's first load carries no data table (the `@/ui` barrel no longer merges views'
//     library code into one chunk; build-client.ts "Barrel imports")
//   • only the shell's icons ride the initial route, and every icon token an initial-route module
//     renders is one of them (ui/lib/icons-shell.ts)
//   • only imported (curated) icons land in the bundle (REQ-UI-04) — the curated lucide icons
//     appear by name; a representative sample of NON-curated lucide icons is absent (the whole barrel
//     is tree-shaken).
//   • a barrel import of one `@/ui` component bundles what a deep import does (the barrel is
//     tree-shaken), and library code only a lazy chunk uses stays off the app's initial route.
//
//   • the dev-only /_ui workbench is absent from the production build (no chunk, no marker), and a
//     development build carries it in a lazy chunk (positive control).
//   • no client chunk bundles server runtime (node:*, @pulse/core, @pulse/renderer, yaml, zod) —
//     checked on the emitted sourcemaps (last describe block).
//
// Starting ceilings (charter 02-decisions.md): initial-route JS ≤ 120 KB, total JS ≤ 250 KB, CSS
// ≤ 40 KB. The design-system baseline (entries.js ≈ 11 KB, total JS ≈ 213 KB) was dominated by a
// ~240 KB-gz lazy chunk that turned out to be a LEAK: src/shared/constants.ts runtime-imported
// @pulse/renderer, pulling the core loader into the browser (fixed 2026-09-25, 1cc4642). With all M1
// views landed, total JS is ≈ 144 KB gz. The initial-route JS ceiling is tightened well below the
// 120 KB starting ceiling; any later loosening of a ceiling is a recorded decision.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { modulePreloadPaths, type ClientManifest } from "../src/server/assets.js";
import type { ClientBuildResult } from "../scripts/build-client.js";
import { SHELL_ICONS } from "../src/client/ui/lib/icons-shell.js";
import { ICONS } from "../src/client/ui/lib/icons.js";
import { initialRouteJsFiles, staticClosure } from "./initial-route.js";

/**
 * Initial-route JS ceiling (gz): the entry plus every chunk it imports statically, so the framework
 * runtime split into shared chunks is counted. Re-baselined for the React 19 runtime: measured
 * 99,586 B (≈ 97 KB; the Preact build measured 36,186 B on the same definition and 6,696 B for the
 * entry file alone), ceiling at measured + ~10%. Re-baselined for deck's app shell (Radix sidebar,
 * sheet, tooltip and dropdown menu, tailwind-merge, the frame's library patterns; the palette dialog
 * stays lazy): measured 156,969 B, ceiling at measured + ~10%. With `"sideEffects"` declared in
 * apps/web/package.json (the `@/ui` barrel tree-shakes): measured 158,124 B — the same modules, and
 * the +1.1 KB is the minifier picking less compressible identifiers — so the ceiling holds. The
 * mutations UI measured 164,205 B (lazy-only Radix rode the entry through the `radix-ui` umbrella);
 * with scoped `@radix-ui/react-*` imports 159,717 B. Measured + ~10% is above 169 KB, so the ceiling
 * holds. Final (every view on the library, legacy CSS deleted): measured 157,452 B; 169 KB is
 * measured + ~10%, so it stays the final ceiling. Icons off the initial route (only the shell's 19
 * of the curated set's 76 ship eagerly, −4.3 KB) and barrel imports rewritten per module (more,
 * smaller initial-route chunks, +4.6 KB of per-file gzip overhead): measured 162,624 B (main before
 * it: 162,258 B); the ceiling holds.
 */
export const INITIAL_ROUTE_JS_BUDGET_BYTES = 169 * 1024;
/**
 * Total JS ceiling (gz), all entry + chunk .js. Baseline ≈ 213 KB; charter starting ceiling was 250 KB.
 * Raised to 300 KB (overview-redesign 014 and engine-health-timeline 017, both user-approved): the viz
 * barrel's lazy uPlot TimeSeriesChart chunk (~24 KB gz) is emitted into the build once any view imports
 * from it, plus wave-3 view growth. That chunk still never ships on the initial route — the
 * initial-route ceiling and the no-uplot-in-entries check are unchanged. The React 19 port measured
 * 226,080 B (Preact: 165,796 B), so the ceiling holds unchanged. The app shell measured 293,508 B;
 * with `"sideEffects"` declared 295,983 B (same modules, minifier naming noise); the ceiling holds.
 * The mutations UI on the library (Radix Dialog/AlertDialog/Checkbox/RadioGroup/Collapsible in lazy
 * chunks, no duplicated module) measured 308,432 B; re-baselined to measured + ~10%. None of it is on
 * the initial route (that ceiling is unchanged). Scoped `@radix-ui/react-*` imports: 308,080 B.
 * The timeline view and its shared chart stack on the library (Radix ToggleGroup behind
 * SegmentedControl, Kbd, the alert-severity map and the library StatusTimeline, all lazy; no module
 * emitted twice) measured 338,220 B; re-baselined to measured + ~10%. The initial route is unchanged.
 * Final (every view on the library, legacy CSS deleted): measured 350,747 B. Measured + ~10% would
 * raise it, so the ceiling stays at 364 KB (+6%). Barrel imports rewritten per module (each view
 * chunk reaches only the library code it imports; icons split into a shell set and a lazy chunk):
 * measured 370,645 B (main before it: 355,395 B). The same code in more, smaller chunks compresses
 * less well file by file (+15 KB gz, raw +12 KB), while each view's first load fell 6–44 KB gz. That
 * left the 364 KB ceiling 1.3% of headroom, so it is re-baselined to measured + ~10%; the per-view
 * first-load ceilings below are the tight guard on what users download.
 */
export const TOTAL_JS_BUDGET_BYTES = 395 * 1024;
/** Total CSS ceiling (gz), all entry + chunk .css. Baseline ≈ 14 KB; charter starting ceiling.
 *  Re-measured with Tailwind and the legacy layer coexisting: 37,190 B (React-only build 31,162 B),
 *  so the ceiling (measured + ~10%) held unchanged as the temporary coexistence ceiling. Raised when
 *  the `@/ui` library was vendored: Tailwind's source detection scans the source tree, not just the
 *  bundled modules, so every utility the library uses ships in the entry sheet before any view uses
 *  it (entry sheet 15,947 → 27,984 B; total 49,231 B). Ceiling at measured + ~10% while the legacy
 *  layer coexisted. Final, with the legacy CSS deleted and every lazy chunk's CSS carried by the entry
 *  sheet (one stylesheet): measured 21,640 B (was 27,915 B with the legacy layer); ceiling at
 *  measured + ~10%. Source detection rooted at the client source (`source("..")`, not the build's
 *  working directory, which at the repo root also picked up candidates from tests, docs and other
 *  packages): measured 20,280 B; ceiling at measured + ~10%. */
export const TOTAL_CSS_BUDGET_BYTES = 22 * 1024;

/** A representative sample of lucide icons NOT in the curated set (ui/lib/icons.ts). Their kebab
 *  names must never appear in the bundle — proof the whole barrel is tree-shaken (REQ-UI-04). */
const NON_CURATED_ICONS = [
  "anchor", "banana", "rocket", "croissant", "volleyball", "airplay", "anvil", "cherry",
] as const;
/** Curated icons whose lucide-internal (kebab) name matches the search string — positive controls
 *  proving the detection actually finds icons that ARE imported. */
const CURATED_ICON_SAMPLE = ["trending-up", "wifi-off", "chevron-right", "server"] as const;

const BUILD_CLIENT = resolve(import.meta.dir, "../scripts/build-client.ts");

/** Class names uPlot puts on its DOM. They survive minification, unlike the `uPlot` identifier. */
const UPLOT_MARKER = /["'.]u-(?:legend|over|wrap)\b/;

let outdir: string;
let manifest: ClientManifest;

function gzSize(publicPath: string): number {
  return Bun.gzipSync(readFileSync(join(outdir, basename(publicPath)))).byteLength;
}
function readJs(publicPath: string): string {
  return readFileSync(join(outdir, basename(publicPath)), "utf8");
}
function allJs(): string[] {
  return [...manifest.entries.js, ...manifest.chunks.filter((c) => c.endsWith(".js"))];
}
function allCss(): string[] {
  return [...manifest.entries.css, ...manifest.chunks.filter((c) => c.endsWith(".css"))];
}

/** Run build-client.ts as a subprocess (minified, i.e. production, unless `minify` is false) and
 *  return its manifest. */
function buildInto(dir: string, entry?: string, minify = true, cwd?: string): ClientManifest {
  const proc = Bun.spawnSync({
    ...(cwd ? { cwd } : {}),
    cmd: [
      "bun",
      BUILD_CLIENT,
      "--outdir",
      dir,
      ...(minify ? ["--minify"] : []),
      "--json",
      ...(entry ? ["--entry", entry] : []),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`build-client.ts exited ${proc.exitCode}\nstderr=${proc.stderr.toString()}`);
  }
  const result = JSON.parse(proc.stdout.toString().trim()) as ClientBuildResult;
  if (!result.ok) throw new Error(`buildClient failed:\n${result.errors.join("\n")}`);
  return result.manifest;
}

// A full client build takes 3–5 s on the 2-CPU host, at bun's 5 s default hook timeout.
const BUILD_HOOK_TIMEOUT_MS = 60_000;

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "pulse-build-budget-"));
  manifest = buildInto(outdir);
}, BUILD_HOOK_TIMEOUT_MS);

afterAll(() => {
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

describe("build budget (SC-04, REQ-PERF-01)", () => {
  test(`initial-route JS gz ≤ ${INITIAL_ROUTE_JS_BUDGET_BYTES}`, () => {
    const files = initialRouteJsFiles(manifest, outdir);
    const total = files.reduce((acc, p) => acc + gzSize(p), 0);
    const breakdown = files.map((p) => `${p}=${gzSize(p)}`).join(", ");
    expect(total, `initial-route JS gz = ${total}; ${breakdown}`).toBeLessThanOrEqual(
      INITIAL_ROUTE_JS_BUDGET_BYTES,
    );
  });

  test(`total JS gz ≤ ${TOTAL_JS_BUDGET_BYTES}`, () => {
    const total = allJs().reduce((acc, p) => acc + gzSize(p), 0);
    const breakdown = allJs().map((p) => `${p}=${gzSize(p)}`).join(", ");
    expect(total, `total JS gz = ${total}; ${breakdown}`).toBeLessThanOrEqual(TOTAL_JS_BUDGET_BYTES);
  });

  test(`total CSS gz ≤ ${TOTAL_CSS_BUDGET_BYTES}`, () => {
    const total = allCss().reduce((acc, p) => acc + gzSize(p), 0);
    const breakdown = allCss().map((p) => `${p}=${gzSize(p)}`).join(", ");
    expect(total, `total CSS gz = ${total}; ${breakdown}`).toBeLessThanOrEqual(TOTAL_CSS_BUDGET_BYTES);
  });
});

describe("REQ-PERF-3: uPlot absent from the initial route", () => {
  test("no initial-route JS file contains uPlot (uplot never ships on the initial route)", () => {
    for (const p of initialRouteJsFiles(manifest, outdir)) {
      expect(readJs(p), `${p} must not contain uPlot`).not.toContain("uPlot");
      expect(readJs(p), `${p} must not contain uPlot`).not.toMatch(UPLOT_MARKER);
    }
    // V-005 (deferred to engine-health-timeline): the complementary "uPlot present in a lazy chunk"
    // assertion is intentionally NOT made here — while the engine/timeline views are stubs, uPlot is
    // tree-shaken out of the whole bundle, so asserting its presence would be unsatisfiable.
  });
});

describe("@/ui TimeSeriesChart keeps uPlot out of the entry", () => {
  // No view renders the `@/ui` chart yet, so the app build alone cannot show where uPlot lands.
  // This fixture app imports TimeSeriesChart from the barrel and renders it on its first route.
  const FIXTURE_ENTRY = resolve(import.meta.dir, "fixtures/ui-viz-app/main.tsx");
  let vizOutdir: string;
  let vizManifest: ClientManifest;
  const read = (p: string): string => readFileSync(join(vizOutdir, basename(p)), "utf8");

  beforeAll(() => {
    vizOutdir = mkdtempSync(join(tmpdir(), "pulse-build-budget-viz-"));
    vizManifest = buildInto(vizOutdir, FIXTURE_ENTRY);
  }, BUILD_HOOK_TIMEOUT_MS);
  afterAll(() => {
    if (vizOutdir) rmSync(vizOutdir, { recursive: true, force: true });
  });

  test("the fixture imports TimeSeriesChart from the @/ui barrel", () => {
    const src = readFileSync(FIXTURE_ENTRY, "utf8");
    expect(src).toMatch(/import \{ TimeSeriesChart \} from "[./]+\/src\/client\/ui\/index\.js"/);
  });

  test("uPlot is absent from the entry and every chunk it imports statically", () => {
    const initial = initialRouteJsFiles(vizManifest, vizOutdir);
    expect(initial.length).toBeGreaterThan(0);
    for (const p of initial) expect(read(p), `${p} must not contain uPlot`).not.toMatch(UPLOT_MARKER);
  });

  test("uPlot ships in a lazy chunk (detection is not vacuous); its stylesheet rides the entry sheet", () => {
    const initial = new Set(initialRouteJsFiles(vizManifest, vizOutdir));
    const lazy = vizManifest.chunks.filter((c) => c.endsWith(".js") && !initial.has(basename(c)));
    expect(lazy.some((p) => UPLOT_MARKER.test(read(p))), "no lazy chunk carries uPlot").toBe(true);
    // Bun copies a lazy child's CSS into the entry bundle, so the chunk's own copy is omitted.
    expect(vizManifest.entries.css.some((p) => read(p).includes(".uplot"))).toBe(true);
    expect(vizManifest.chunkCss ?? {}).toEqual({});
  });
});

describe("the @/ui barrel is tree-shaken", () => {
  // Bun.build drops an unused re-export only when the package declares `"sideEffects"`
  // (apps/web/package.json); without it, importing one component through the barrel bundled most of
  // the library (+23 KB gz on the initial route). barrel.tsx and deep.tsx import the same component,
  // through the barrel and from its own file; their initial routes must carry the same library code.
  const BARREL_ENTRY = resolve(import.meta.dir, "fixtures/ui-barrel-app/barrel.tsx");
  const DEEP_ENTRY = resolve(import.meta.dir, "fixtures/ui-barrel-app/deep.tsx");
  /** Split-chunk overhead the barrel build may add over the single-file deep build (measured 609 B). */
  const BARREL_OVERHEAD_BYTES = 2 * 1024;
  const builds = {} as Record<"barrel" | "deep", { dir: string; manifest: ClientManifest }>;

  /** gz size of the initial route and the `@/ui` modules it bundles (from the sourcemaps). */
  function initialRoute(which: "barrel" | "deep"): { gz: number; uiModules: string[] } {
    const { dir, manifest: m } = builds[which];
    let gz = 0;
    const modules = new Set<string>();
    for (const file of initialRouteJsFiles(m, dir)) {
      gz += Bun.gzipSync(readFileSync(join(dir, file))).byteLength;
      const { sources } = JSON.parse(readFileSync(join(dir, `${file}.map`), "utf8")) as { sources: string[] };
      for (const src of sources) {
        const at = src.indexOf("src/client/ui/");
        if (at !== -1) modules.add(src.slice(at));
      }
    }
    return { gz, uiModules: [...modules].sort() };
  }

  beforeAll(() => {
    for (const [which, entry] of [["barrel", BARREL_ENTRY], ["deep", DEEP_ENTRY]] as const) {
      const dir = mkdtempSync(join(tmpdir(), `pulse-build-budget-${which}-`));
      builds[which] = { dir, manifest: undefined as never }; // registered first, so afterAll removes it
      builds[which].manifest = buildInto(dir, entry);
    }
  }, BUILD_HOOK_TIMEOUT_MS);
  afterAll(() => {
    for (const b of Object.values(builds)) rmSync(b.dir, { recursive: true, force: true });
  });

  test("the fixtures import the same component, through the barrel and from its own file", () => {
    expect(readFileSync(BARREL_ENTRY, "utf8")).toMatch(/import \{ Button \} from "[./]+\/src\/client\/ui\/index\.js"/);
    expect(readFileSync(DEEP_ENTRY, "utf8")).toMatch(/import \{ Button \} from "[./]+\/src\/client\/ui\/primitives\/button\.js"/);
  });

  test("a barrel import bundles no @/ui module the deep import does not", () => {
    const deep = initialRoute("deep").uiModules;
    expect(deep).toContain("src/client/ui/primitives/button.tsx"); // detection is not vacuous
    expect(initialRoute("barrel").uiModules).toEqual(deep);
  });

  test(`a barrel import costs at most ${BARREL_OVERHEAD_BYTES} B gz over the deep import`, () => {
    const barrel = initialRoute("barrel").gz;
    const deep = initialRoute("deep").gz;
    expect(barrel - deep, `barrel ${barrel} B vs deep ${deep} B`).toBeLessThanOrEqual(BARREL_OVERHEAD_BYTES);
  });

  // When the entry imports the barrel too, Bun.build assigns every library module that a lazy chunk
  // uses to a chunk the entry imports statically (measured +6.3 KB gz with the shell on the barrel).
  // So entry code deep-imports `@/ui` (`// ui-deep-import:`); this pins it on the app build, through
  // the lazily loaded command palette. (`"sideEffects"` is package-wide: a module imported only for its
  // effect, `import "./x.js"`, is now dropped unless the list names it.)
  test("library code only a lazy chunk uses stays off the app's initial route", () => {
    const PALETTE = /ui\/patterns\/command-palette\.tsx$|node_modules\/cmdk\//;
    const sourcesOf = (file: string): string[] =>
      (JSON.parse(readFileSync(join(outdir, `${basename(file)}.map`), "utf8")) as { sources: string[] }).sources;
    const initial = new Set(initialRouteJsFiles(manifest, outdir));
    const lazy = allJs().filter((p) => !initial.has(basename(p)));
    // Detection is not vacuous: the palette and cmdk are in the build, in a lazy chunk.
    expect(lazy.flatMap(sourcesOf).filter((s) => PALETTE.test(s)).length).toBeGreaterThanOrEqual(2);
    expect([...initial].flatMap(sourcesOf).filter((s) => PALETTE.test(s))).toEqual([]);
  });
});

describe("Radix code only lazy views use stays off the initial route", () => {
  // Through the `radix-ui` umbrella, Bun.build put every Radix package the app used anywhere into a
  // chunk the entry imports statically (+4.5 KB gz). The primitives import the scoped packages instead
  // (tests/ui-guardrails.test.ts forbids the umbrella). These three back only the mutation dialogs,
  // which stay lazy (U12), so none of them may reach the initial route.
  const LAZY_ONLY = ["react-alert-dialog", "react-checkbox", "react-radio-group"] as const;
  const radixPackagesOf = (files: readonly string[]): Set<string> => {
    const found = new Set<string>();
    for (const file of files) {
      const { sources } = JSON.parse(readFileSync(join(outdir, `${basename(file)}.map`), "utf8")) as { sources: string[] };
      for (const src of sources) {
        const m = /node_modules\/@radix-ui\/([\w-]+)\//.exec(src);
        if (m) found.add(m[1]!);
      }
    }
    return found;
  };

  test("lazy-only Radix packages ship in lazy chunks, not on the initial route", () => {
    const initialFiles = initialRouteJsFiles(manifest, outdir);
    const initial = radixPackagesOf(initialFiles);
    const lazy = radixPackagesOf(allJs().filter((p) => !initialFiles.includes(basename(p))));
    // Detection is not vacuous: the shell's Radix is found on the initial route, the dialogs' in lazy chunks.
    expect(initial.has("react-tooltip")).toBe(true);
    for (const pkg of LAZY_ONLY) {
      expect(lazy.has(pkg), `${pkg} is not in any lazy chunk`).toBe(true);
      expect(initial.has(pkg), `${pkg} is on the initial route`).toBe(false);
    }
  });
});

describe("the dev-only /_ui workbench never ships in a production build", () => {
  // The workbench page root carries this data-slot; it survives minification as a string literal.
  const WORKBENCH_MARKER = "ui-workbench-page";
  const isWorkbenchKey = (key: string): boolean => /(^|\/)_ui(\/|$)/.test(key);
  let devOutdir: string;
  let devManifest: ClientManifest;
  const readDev = (p: string): string => readFileSync(join(devOutdir, basename(p)), "utf8");
  const devJs = (): string[] => [...devManifest.entries.js, ...devManifest.chunks.filter((c) => c.endsWith(".js"))];

  beforeAll(() => {
    devOutdir = mkdtempSync(join(tmpdir(), "pulse-build-budget-dev-"));
    devManifest = buildInto(devOutdir, undefined, false);
  }, BUILD_HOOK_TIMEOUT_MS);
  afterAll(() => {
    if (devOutdir) rmSync(devOutdir, { recursive: true, force: true });
  });

  test("the production manifest has no workbench chunk", () => {
    expect(allJs().concat(allCss()).filter((p) => p.includes("_ui"))).toEqual([]);
    expect(Object.keys(manifest.chunkCss ?? {}).filter(isWorkbenchKey)).toEqual([]);
  });

  test("no production JS file (entry or chunk) contains workbench code", () => {
    expect(allJs().filter((p) => readJs(p).includes(WORKBENCH_MARKER))).toEqual([]);
  });

  test("a development build ships the workbench in a lazy chunk (detection is not vacuous)", () => {
    const initial = new Set(initialRouteJsFiles(devManifest, devOutdir));
    const carriers = devJs().filter((p) => readDev(p).includes(WORKBENCH_MARKER));
    expect(carriers.length).toBeGreaterThan(0);
    for (const p of carriers) expect(initial.has(basename(p)), `${p} is on the initial route`).toBe(false);
  });
});

/**
 * Per-view first load ceilings (gz): what a first page load on each view downloads — the initial
 * route, the view's chunk with every chunk it imports statically, and the lazy icon chunk ViewHost
 * loads with it. Measured after feature code's `@/ui` imports were pointed at the owning modules at
 * build time (build-client.ts "Barrel imports"); before, every view shared one lazy chunk of library
 * code and its first load carried ~12–55 KB gz of modules only other views use. Ceilings at
 * measured + ~10%.
 */
export const VIEW_FIRST_LOAD_BUDGET_BYTES = {
  overview: 213 * 1024, // measured 199,293 B (240,117 B through the barrel)
  alerts: 246 * 1024, // measured 230,160 B (236,328 B)
  estate: 250 * 1024, // measured 233,523 B (238,114 B)
  engine: 244 * 1024, // measured 227,811 B (248,102 B)
  timeline: 226 * 1024, // measured 211,491 B (254,368 B)
} as const;

/** Everything a session that opens all five views downloads (the union of their first loads). The
 *  finer chunking costs a full session a little (more, smaller files compress less well) while every
 *  single-view session saves; this caps the full-session cost. Ceiling at measured + ~10%. */
export const ALL_VIEWS_BUDGET_BYTES = 350 * 1024; // measured 326,463 B

/** Sources (repo-relative from `apps/web/`) a JS file bundles, from its sourcemap. */
function bundledSources(dir: string, file: string): string[] {
  const { sources } = JSON.parse(readFileSync(join(dir, `${basename(file)}.map`), "utf8")) as { sources: string[] };
  return sources;
}

/** The emitted chunk that bundles a source module (matched by path suffix). */
function chunkWith(suffix: string): string {
  const hit = allJs().find((p) => bundledSources(outdir, p).some((s) => s.endsWith(suffix)));
  if (!hit) throw new Error(`no chunk bundles ${suffix}`);
  return basename(hit);
}

/** Every JS file a first page load on view `id` downloads. */
function viewFirstLoadFiles(id: string): string[] {
  const roots = [...manifest.entries.js, chunkWith(`views/${id}/view.tsx`), chunkWith("ui/lib/icons.ts")];
  return staticClosure(roots, outdir);
}

describe("per-view first load", () => {
  for (const [id, budget] of Object.entries(VIEW_FIRST_LOAD_BUDGET_BYTES)) {
    test(`${id}: first load gz ≤ ${budget}`, () => {
      const files = viewFirstLoadFiles(id);
      const total = files.reduce((acc, p) => acc + gzSize(p), 0);
      expect(total, `${id} first load gz = ${total} over ${files.length} files`).toBeLessThanOrEqual(budget);
    });
  }

  test(`a session that opens every view downloads ≤ ${ALL_VIEWS_BUDGET_BYTES} gz`, () => {
    const files = [...new Set(Object.keys(VIEW_FIRST_LOAD_BUDGET_BYTES).flatMap(viewFirstLoadFiles))];
    const total = files.reduce((acc, p) => acc + gzSize(p), 0);
    expect(total, `shell + all views gz = ${total} over ${files.length} files`).toBeLessThanOrEqual(ALL_VIEWS_BUDGET_BYTES);
  });

  test("the shell preloads every chunk on the initial route", () => {
    const preload = modulePreloadPaths(manifest, (path) => {
      const file = join(outdir, basename(path));
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    });
    const entries = new Set(manifest.entries.js.map((p) => basename(p)));
    const expected = initialRouteJsFiles(manifest, outdir).filter((f) => !entries.has(f));
    expect(expected.length).toBeGreaterThan(5);
    expect(preload.map((p) => basename(p)).sort()).toEqual(expected.sort());
  });

  // The regression the split fixed: through the barrel, the overview's first load carried the data
  // table (TanStack Table and Virtual), which only the alerts, estate and engine views render.
  test("the overview's first load does not carry the data table", () => {
    const sources = viewFirstLoadFiles("overview").flatMap((f) => bundledSources(outdir, f));
    expect(sources.some((s) => s.endsWith("views/overview/view.tsx"))).toBe(true); // not vacuous
    expect(sources.filter((s) => /ui\/patterns\/data-table\.tsx$|@tanstack\//.test(s))).toEqual([]);
    const alerts = viewFirstLoadFiles("alerts").flatMap((f) => bundledSources(outdir, f));
    expect(alerts.some((s) => s.endsWith("ui/patterns/data-table.tsx"))).toBe(true); // detection works
  });
});

describe("the stylesheet does not depend on the build's working directory", () => {
  // Modules that import a barrel are loaded through the build's rewrite plugin, and Tailwind does not
  // scan a plugin-loaded module as it is bundled; styles/app.css roots source detection at the client
  // source (`source("..")`) so the sheet still has every class. Rooted at the working directory, a
  // build started elsewhere (the browser suites' dev server) dropped most utilities, `md:block` on
  // the sidebar among them, and one started at the repo root picked up candidates from tests and docs.
  let otherDir: string;
  let other: ClientManifest;
  beforeAll(() => {
    otherDir = mkdtempSync(join(tmpdir(), "pulse-build-budget-cwd-"));
    other = buildInto(otherDir, undefined, true, resolve(import.meta.dir, "fixtures"));
  }, BUILD_HOOK_TIMEOUT_MS);
  afterAll(() => {
    if (otherDir) rmSync(otherDir, { recursive: true, force: true });
  });

  test("a build started from another directory emits the same stylesheet", () => {
    const sheet = (dir: string, m: ClientManifest): string =>
      m.entries.css.map((p) => readFileSync(join(dir, basename(p)), "utf8")).join("\n");
    const here = sheet(outdir, manifest);
    expect(here).toContain("md\\:block"); // detection is not vacuous
    expect(sheet(otherDir, other)).toBe(here);
  });
});

describe("no build-machine paths in the bundle", () => {
  // The bundle is public: neither code nor sourcemap sourcesContent may carry an absolute path of the
  // machine that built it (the barrel rewrite once named lucide's icon modules by absolute path).
  // Sourcemap `sources` are relative to the output directory and are not checked.
  const repoRoot = resolve(import.meta.dir, "../../..");
  const ABSOLUTE = [repoRoot, `${homedir()}/`, "/node_modules/.bun/"].filter((p) => p.length > 2);

  test("no emitted JS or sourcemap content contains an absolute filesystem path", () => {
    const offenders: string[] = [];
    let maps = 0;
    for (const p of allJs()) {
      const code = readJs(p);
      for (const needle of ABSOLUTE) if (code.includes(needle)) offenders.push(`${p}: ${needle}`);
      const mapPath = join(outdir, `${basename(p)}.map`);
      if (!existsSync(mapPath)) continue;
      maps += 1;
      const { sourcesContent = [] } = JSON.parse(readFileSync(mapPath, "utf8")) as { sourcesContent?: (string | null)[] };
      for (const content of sourcesContent) {
        for (const needle of ABSOLUTE) if (content?.includes(needle)) offenders.push(`${p}.map: ${needle}`);
      }
    }
    expect(maps).toBeGreaterThan(0);
    expect(offenders.slice(0, 10)).toEqual([]);
  });
});

describe("only the shell's icons ride the initial route", () => {
  /** Lucide icon modules (by file name) bundled into a set of files. */
  const lucideIcons = (files: readonly string[]): Set<string> =>
    new Set(
      files
        .flatMap((f) => bundledSources(outdir, f))
        .map((s) => /lucide-react\/dist\/esm\/icons\/([\w-]+)\.mjs$/.exec(s)?.[1])
        .filter((name): name is string => name !== undefined),
    );

  test("curated icons the shell does not use load lazily", () => {
    const initial = lucideIcons(initialRouteJsFiles(manifest, outdir));
    const lazy = lucideIcons([chunkWith("ui/lib/icons.ts")]);
    // Shell icons are on the initial route; the rest of the curated set is in the icon chunk.
    for (const name of ["server", "wifi-off", "triangle-alert"]) expect(initial.has(name), name).toBe(true);
    for (const name of ["bell", "trending-up", "keyboard", "inbox", "zap"]) {
      expect(initial.has(name), `${name} is on the initial route`).toBe(false);
      expect(lazy.has(name), `${name} is not in the icon chunk`).toBe(true);
    }
    // Only the shell's icons, plus the few the shell's primitives import directly (dropdown and
    // sidebar chevrons, check, panel), may ride the initial route.
    expect(initial.size).toBeLessThanOrEqual(new Set(Object.values(SHELL_ICONS)).size + 4);
  });

  // Icon tokens in an initial-route module must resolve before the icon chunk loads, or the shell
  // paints an empty placeholder until it does. A token is a curated name in an icon position: an
  // object value (`icon: "server"`, a tone→icon map), a `name=`/`icon=` prop, or a `?`/`??` branch.
  /** Literals in an icon-like position that are not icon tokens (the scan is a heuristic). */
  const NOT_ICON_TOKENS: Readonly<Record<string, readonly string[]>> = {
    "ui/lib/list-navigation.ts": ["list"], // ListNavContext origin
    "ui/hooks/use-list-navigation.ts": ["list"], // ListNavContext origin
  };

  test("every icon token in an initial-route module is a shell icon", () => {
    const TOKEN = /(?:(?:\bname|\bicon)\s*=\s*\{?\s*|[:?]\s*)["']([^"'\n]{1,32})["']/g;
    const missing: string[] = [];
    let scanned = 0;
    for (const file of initialRouteJsFiles(manifest, outdir)) {
      const map = JSON.parse(readFileSync(join(outdir, `${file}.map`), "utf8")) as { sources: string[]; sourcesContent?: string[] };
      map.sources.forEach((src, i) => {
        if (!src.includes("src/client/") || /ui\/lib\/icons(-shell)?\.ts$/.test(src)) return;
        scanned += 1;
        const code = (map.sourcesContent?.[i] ?? "").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
        for (const [, token] of code.matchAll(TOKEN)) {
          const rel = src.replace(/.*src\/client\//, "");
          if (NOT_ICON_TOKENS[rel]?.includes(token!)) continue;
          if (Object.hasOwn(ICONS, token!) && !Object.hasOwn(SHELL_ICONS, token!)) missing.push(`${rel}: ${token}`);
        }
      });
    }
    expect(scanned).toBeGreaterThan(20); // sourcesContent is present: the scan is not vacuous
    expect(missing, "add these to ui/lib/icons-shell.ts").toEqual([]);
  });
});

describe("REQ-UI-04: only imported (curated) icons land in the bundle", () => {
  test("a representative sample of NON-curated lucide icons is absent from every JS file", () => {
    const sources = allJs().map((p) => readJs(p));
    for (const name of NON_CURATED_ICONS) {
      const needle = `"${name}"`;
      const present = sources.some((src) => src.includes(needle));
      expect(present, `non-curated icon "${name}" leaked into the bundle`).toBe(false);
    }
  });

  test("curated icons that ARE imported appear in the bundle (detection is not vacuous)", () => {
    const joined = allJs().map((p) => readJs(p)).join("\n");
    for (const name of CURATED_ICON_SAMPLE) {
      expect(joined, `expected curated icon "${name}" in the bundle`).toContain(`"${name}"`);
    }
  });
});

describe("client bundle carries no server runtime (charter 04 §2: only @pulse/web-data/wire is browser-safe)", () => {
  // A runtime (non-type) import of @pulse/renderer or @pulse/core anywhere in the client graph (e.g.
  // via src/shared/) drags the core loader into the browser: yaml, zod and node:crypto/stream
  // polyfills (~240 KB gz). Checked on the emitted sourcemaps, which list every bundled module.
  const FORBIDDEN_SOURCE = /(^|\/)node:|packages\/(core|renderer)\/|node_modules\/(yaml|zod)\//;

  test("no emitted JS chunk bundles node:*, @pulse/core, @pulse/renderer, yaml or zod", () => {
    const offenders: string[] = [];
    let mapsSeen = 0;
    for (const p of allJs()) {
      const mapPath = join(outdir, `${basename(p)}.map`);
      if (!existsSync(mapPath)) continue;
      mapsSeen += 1;
      const { sources } = JSON.parse(readFileSync(mapPath, "utf8")) as { sources: string[] };
      for (const src of sources) if (FORBIDDEN_SOURCE.test(src)) offenders.push(`${basename(p)}: ${src}`);
    }
    expect(mapsSeen, "the client build must emit sourcemaps for this guard to be meaningful").toBeGreaterThan(0);
    expect(offenders, offenders.slice(0, 20).join("\n")).toEqual([]);
  });
});

describe("build-time env is inlined", () => {
  // The browser has no `import.meta.env`; the vendored `@/ui` library reads `import.meta.env.DEV`
  // (deck builds with Vite), so the client build must define it or that read throws at runtime.
  test("no emitted JS chunk reads import.meta.env", () => {
    const offenders = allJs().filter((p) => readJs(p).includes("import.meta.env"));
    expect(offenders).toEqual([]);
  });
});
