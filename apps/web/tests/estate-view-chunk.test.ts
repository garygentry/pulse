// apps/web/tests/estate-view-chunk.test.ts — the estate view ships no stylesheet of its own.
//
// No CSS output takes an input from views/estate/, and the `views/estate/view` chunkCss key carries
// nothing but uPlot's CSS (plus the build's per-chunk tag sheet) — never an estate or old-kit sheet.
// Bun folds the CSS of lazily imported modules (the `@/ui` chart's uPlot chunk) into every importing
// chunk's bundle, so the key itself still exists.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ClientManifest } from "../src/server/assets.js";
import type { BuildMetafile, ClientBuildResult } from "../scripts/build-client.js";

const BUILD_CLIENT = resolve(import.meta.dir, "../scripts/build-client.ts");
const ESTATE_DIR = resolve(import.meta.dir, "../src/client/views/estate");
const ESTATE_CSS_KEY = "views/estate/view";
const OWNED_SOURCE = /(^|\/)src\/client\/views\/estate\//;

let outdir: string;
let manifest: ClientManifest;
let metafile: BuildMetafile;

// A full client build takes 3–5 s on the 2-CPU host, at bun's 5 s default hook timeout.
beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "pulse-estate-chunk-"));
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

test("views/estate holds no .css files", () => {
  expect(readdirSync(ESTATE_DIR).filter((f) => f.endsWith(".css"))).toEqual([]);
});

test("no CSS output takes an input from views/estate/", () => {
  const offenders: string[] = [];
  for (const [out, rec] of Object.entries(metafile.outputs)) {
    if (!out.endsWith(".css")) continue;
    for (const input of Object.keys(rec.inputs)) if (OWNED_SOURCE.test(input)) offenders.push(`${out} <- ${input}`);
  }
  expect(offenders).toEqual([]);
});

test("the estate view gets no chunk stylesheet (its styles, and uPlot's, ride the entry sheet)", () => {
  expect((manifest.chunkCss ?? {})[ESTATE_CSS_KEY]).toBeUndefined();
});
