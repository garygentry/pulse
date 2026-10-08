// apps/web/tests/client-build-rebuild.test.ts — incremental (clean:false) rebuilds keep every file
// the build emits (#8).
//
// The dev supervisor rebuilds into the live dist/client with clean:false, and buildClient then
// prunes files the new build did not emit. Bun's metafile omits `file`-loader assets (the hashed
// Geist .woff2 files) and sourcemaps, so a prune keyed on metafile outputs deleted the fonts and
// .map files that the rebuild had just written, and pages 404'd on /assets/geist-*.woff2. This
// builds a fixture client through the CLI (subprocess: the in-process bundler's resolver is
// unreliable inside `bun test`), edits the entry, rebuilds with --no-clean twice, and checks after
// each build that every asset the JS references and every sourcemap is on disk, and that the
// previous build's stale entry was pruned.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ClientManifest } from "../src/server/assets.js";
import { ASSET_PREFIX, MANIFEST_FILENAME } from "../src/server/assets.js";

const BUILD_CLIENT = resolve(import.meta.dir, "../scripts/build-client.ts");

/** A fixture build takes ~1 s, longer on the loaded 2-CPU host than bun's 5 s default. */
const BUILD_TIMEOUT_MS = 60_000;

/** Under apps/web/node_modules (git-ignored) so the fixture resolves `tailwindcss`. */
const FIXTURE_PARENT = resolve(import.meta.dir, "../node_modules/.cache");

/** Not a real font: the `file` loader copies bytes verbatim, so any content gets a hashed file. */
const FONT_BYTES = "wOF2-fixture-bytes\n";

function mainSource(revision: number): string {
  return [
    'import "./app.css";',
    'import face from "./fonts/face.woff2";',
    `export const revision = ${revision};`,
    "export const fontUrl = face;",
    'export const lazy = () => import("./views/lazy/view.js");',
    "",
  ].join("\n");
}

const FIXTURE: Record<string, string> = {
  "index.html": "<!doctype html><html><head></head><body></body></html>\n",
  "app.css": ".fixture-rule { color: red; }\n",
  "fonts/face.woff2": FONT_BYTES,
  "views/lazy/view.ts": 'export default function lazy() { return "lazy"; }\n',
};

let root: string;
let outdir: string;

beforeAll(() => {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  root = mkdtempSync(join(FIXTURE_PARENT, "pulse-rebuild-"));
  outdir = join(root, "out");
  for (const [rel, contents] of Object.entries({ ...FIXTURE, "main.ts": mainSource(0) })) {
    const path = join(root, "src", rel);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function build(clean: boolean): ClientManifest {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      BUILD_CLIENT,
      "--outdir",
      outdir,
      "--entry",
      join(root, "src", "main.ts"),
      "--sourcemap",
      "linked",
      ...(clean ? [] : ["--no-clean"]),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`build-client.ts exited ${proc.exitCode}\nstderr=${proc.stderr.toString()}`);
  }
  return JSON.parse(readFileSync(join(outdir, MANIFEST_FILENAME), "utf8")) as ClientManifest;
}

/** Hashed output names of the fixture font the emitted JS references (dev JS also names the
 *  unhashed source file in path comments, which is not a URL). */
function referencedFonts(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(outdir).filter((f) => f.endsWith(".js"))) {
    for (const match of readFileSync(join(outdir, file), "utf8").matchAll(/face-[a-z0-9]+\.woff2/g)) {
      names.add(match[0]);
    }
  }
  return [...names].sort();
}

function expectCompleteOutput(manifest: ClientManifest): void {
  const onDisk = new Set(readdirSync(outdir));
  const fonts = referencedFonts();
  expect(fonts.length).toBe(1);
  for (const font of fonts) expect(onDisk.has(font), `${font} referenced but missing`).toBe(true);
  expect(readFileSync(join(outdir, fonts[0]!), "utf8")).toBe(FONT_BYTES);

  const listed = [...manifest.entries.js, ...manifest.entries.css, ...manifest.chunks];
  for (const publicPath of listed) {
    const name = publicPath.slice(ASSET_PREFIX.length);
    expect(onDisk.has(name), `${name} listed in the manifest but missing`).toBe(true);
    if (name.endsWith(".js")) expect(onDisk.has(`${name}.map`), `${name}.map missing`).toBe(true);
  }
}

describe("clean:false rebuilds keep every emitted file (#8)", () => {
  test(
    "fonts and sourcemaps survive two consecutive incremental rebuilds; stale entries are pruned",
    () => {
      const first = build(true);
      expectCompleteOutput(first);

      let previousEntry = first.entries.js[0]!;
      for (const revision of [1, 2]) {
        writeFileSync(join(root, "src", "main.ts"), mainSource(revision));
        const next = build(false);
        expectCompleteOutput(next);

        const entry = next.entries.js[0]!;
        expect(entry).not.toBe(previousEntry);
        const onDisk = new Set(readdirSync(outdir));
        const stale = previousEntry.slice(ASSET_PREFIX.length);
        expect(onDisk.has(stale), `stale entry ${stale} not pruned`).toBe(false);
        expect(onDisk.has(`${stale}.map`), `stale ${stale}.map not pruned`).toBe(false);
        previousEntry = entry;
      }
    },
    BUILD_TIMEOUT_MS,
  );
});
