// apps/web/tests/timeline-view-chunk.test.ts — REQ-PERF-04, D9, V-005 (08 §5.2).
//
// Runs the same build as build-budget.test.ts and asserts the deferred V-005 half: uPlot is PRESENT
// in at least one lazy manifest chunk. The ABSENT-from-entries half stays in build-budget.test.ts
// (REQ-PERF-3), which this feature must keep green and does not duplicate; chunk sizes are the budget
// test's concern too.
//
// Protection set: at least one lazy `.js` chunk contains a uPlot marker (the `u-over`/`uplot` class
// strings survive minification in uPlot 1.6.32). Non-goal: which chunk it is.
//
// Also: the timeline view ships no stylesheet of its own. No CSS output has an input under
// views/timeline/ or views/_shared/timeseries/, and neither the timeline nor uPlot gets a chunk
// stylesheet: Bun folds the CSS of lazily imported modules into every ancestor's bundle, the entry
// included, and the build omits chunk sheets whose rules the entry sheet already carries.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { ClientManifest } from "../src/server/assets.js";
import type { BuildMetafile, ClientBuildResult } from "../scripts/build-client.js";

const BUILD_CLIENT = resolve(import.meta.dir, "../scripts/build-client.ts");
const UPLOT_MARKER = /uPlot|u-over|uplot/;

let outdir: string;
let manifest: ClientManifest;
let metafile: BuildMetafile;

const TIMELINE_CSS_KEY = "views/timeline/view";
const UPLOT_CSS_KEY = "ui/viz/uplot-chart";
const OWNED_SOURCE = /(^|\/)src\/client\/views\/(timeline|_shared\/timeseries)\//;

function readJs(publicPath: string): string {
  return readFileSync(join(outdir, basename(publicPath)), "utf8");
}

// A full client build takes 3–5 s on the 2-CPU host, at bun's 5 s default hook timeout.
beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "pulse-timeline-chunk-"));
  const proc = Bun.spawnSync({
    cmd: ["bun", BUILD_CLIENT, "--outdir", outdir, "--minify", "--json"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`build-client.ts exited ${proc.exitCode}\nstderr=${proc.stderr.toString()}`);
  }
  const result = JSON.parse(proc.stdout.toString().trim()) as ClientBuildResult;
  if (!result.ok) throw new Error(`buildClient failed:\n${result.errors.join("\n")}`);
  manifest = result.manifest;
  metafile = result.metafile;
}, 60_000);

afterAll(() => {
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

test("REQ-PERF-04: uPlot ships only in a lazy chunk", () => {
  const lazyJs = manifest.chunks.filter((c) => c.endsWith(".js"));
  const hit = lazyJs.filter((c) => UPLOT_MARKER.test(readJs(c)));
  expect(hit.length, `lazy chunks: ${lazyJs.join(", ")}`).toBeGreaterThanOrEqual(1);
});

test("the timeline view's own stylesheet is gone: no CSS output takes an input from timeline/ or _shared/timeseries/", () => {
  const offenders: string[] = [];
  for (const [out, rec] of Object.entries(metafile.outputs)) {
    if (!out.endsWith(".css")) continue;
    for (const input of Object.keys(rec.inputs)) if (OWNED_SOURCE.test(input)) offenders.push(`${out} <- ${input}`);
  }
  expect(offenders).toEqual([]);
});

test("neither the timeline view nor uPlot gets a chunk stylesheet; uPlot's CSS rides the entry sheet", () => {
  const chunkCss = manifest.chunkCss ?? {};
  expect(chunkCss[TIMELINE_CSS_KEY]).toBeUndefined();
  expect(chunkCss[UPLOT_CSS_KEY]).toBeUndefined();
  expect(manifest.entries.css.some((p) => readFileSync(join(outdir, basename(p)), "utf8").includes(".uplot"))).toBe(true);
});
