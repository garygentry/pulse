// apps/web/tests/client-build-chunk-names.test.ts — lazy chunks with identical CSS build.
//
// Chunk stylesheets are named `chunk-[name]-[hash]` with a content hash, and Bun copies a lazy
// child's CSS into every ancestor's bundle. Two lazy `view` modules whose CSS is the same (e.g. both
// hold only a shared library's sheet) used to get one output path, and Bun.build failed with
// "Multiple files share the same output path". This pins the fix on a fixture client built through
// the CLI (subprocess — the in-process bundler's resolver is unreliable inside `bun test`), in dev and
// prod: both chunks build, their stylesheets (which the entry sheet already carries) are omitted, a
// lazy entry with no CSS gets no rule-free stylesheet, and the lazy modules' exports survive.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ClientManifest } from "../src/server/assets.js";
import { ASSET_PREFIX, MANIFEST_FILENAME } from "../src/server/assets.js";

const BUILD_CLIENT = resolve(import.meta.dir, "../scripts/build-client.ts");

const SHARED_RULE = ".shared-lib";

/** A fixture build takes ~1 s, longer on the loaded 2-CPU host than bun's 5 s default. */
const BUILD_TIMEOUT_MS = 60_000;

/** Only the tagged `.tsx` view uses it, so it reaches the entry sheet only if Tailwind scanned that
 *  module. Assembled from parts: Tailwind's source detection scans this (tracked) file too, and the
 *  fixture lives under git-ignored node_modules, which source detection skips. */
const TAILWIND_ONLY_CLASS = ["mt", "[13px]"].join("-");

/** A client root of lazy modules: a and b (`view`) import only the shared stylesheet, so their
 *  chunk CSS is byte-identical; c (`view`) imports no CSS; d and e (`view.page`, a dotted name) are
 *  another identical pair. The entry imports a Tailwind sheet. */
const FIXTURE: Record<string, string> = {
  "index.html": "<!doctype html><html><head></head><body></body></html>\n",
  "app.css": '@import "tailwindcss";\n',
  "main.ts": [
    'import "./app.css";',
    "export const views = {",
    '  a: () => import("./views/a/view.js"),',
    '  b: () => import("./views/b/view.js"),',
    '  c: () => import("./views/c/view.js"),',
    '  d: () => import("./views/d/view.page.js"),',
    '  e: () => import("./views/e/view.page.js"),',
    "};",
    "",
  ].join("\n"),
  "shared/lib.css": `${SHARED_RULE} { color: red; }\n`,
  "shared/lib.ts": 'import "./lib.css";\nexport const lib = "shared";\n',
  "views/a/view.tsx": [
    'import { lib } from "../../shared/lib";',
    `export const className = "${TAILWIND_ONLY_CLASS}";`,
    "export default function a() { return `a:${lib}`; }",
    "",
  ].join("\n"),
  "views/b/view.ts": 'import { lib } from "../../shared/lib";\nexport const b = () => `b:${lib}`;\n',
  "views/c/view.ts": "export default function c() { return \"c\"; }\n",
  "views/d/view.page.ts": 'import { lib } from "../../shared/lib";\nexport const d = () => `d:${lib}`;\n',
  "views/e/view.page.ts": 'import { lib } from "../../shared/lib";\nexport const e = () => `e:${lib}`;\n',
};

/** Under apps/web/node_modules (git-ignored) so the fixture resolves `tailwindcss`. */
const FIXTURE_PARENT = resolve(import.meta.dir, "../node_modules/.cache");

let root: string;

beforeAll(() => {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  root = mkdtempSync(join(FIXTURE_PARENT, "pulse-chunk-names-"));
  for (const [rel, contents] of Object.entries(FIXTURE)) {
    const path = join(root, "src", rel);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function build(mode: "dev" | "prod"): { outdir: string; manifest: ClientManifest } {
  const outdir = join(root, `out-${mode}`);
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      BUILD_CLIENT,
      "--outdir",
      outdir,
      "--entry",
      join(root, "src", "main.ts"),
      ...(mode === "prod" ? ["--minify"] : []),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`build-client.ts exited ${proc.exitCode}\nstderr=${proc.stderr.toString()}`);
  }
  const manifest = JSON.parse(readFileSync(join(outdir, MANIFEST_FILENAME), "utf8")) as ClientManifest;
  return { outdir, manifest };
}

function fileOf(outdir: string, publicPath: string): string {
  return join(outdir, publicPath.slice(ASSET_PREFIX.length));
}

describe.each(["dev", "prod"] as const)("lazy chunks with identical CSS (%s)", (mode) => {
  let outdir: string;
  let manifest: ClientManifest;

  beforeAll(() => {
    ({ outdir, manifest } = build(mode));
  }, BUILD_TIMEOUT_MS);

  test("identical chunk stylesheets build, and are omitted because the entry sheet carries their rules", () => {
    // Bun copies each lazy child's CSS into the entry bundle too, so the chunks' own copies add nothing.
    expect(manifest.chunkCss ?? {}).toEqual({});
    expect(manifest.entries.css).toHaveLength(1);
    expect(readFileSync(fileOf(outdir, manifest.entries.css[0]!), "utf8")).toContain(SHARED_RULE);
  });

  test("a lazy chunk without CSS gets no stylesheet", () => {
    expect(manifest.chunkCss?.["views/c/view"]).toBeUndefined();
    const sheets = readdirSync(outdir).filter((name) => name.endsWith(".css"));
    for (const name of sheets) {
      const rules = readFileSync(join(outdir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").trim();
      expect(rules, `${name} has no rules`).not.toBe("");
    }
    // Every stylesheet on disk is listed (entry or chunk); nothing was left behind.
    const listed = new Set([...manifest.entries.css, ...manifest.chunks].map((p) => p.slice(ASSET_PREFIX.length)));
    expect(sheets.filter((name) => !listed.has(name))).toEqual([]);
  });

  test("the lazy modules keep their exports", async () => {
    const entry = fileOf(outdir, manifest.entries.js[0]!);
    expect(existsSync(entry)).toBe(true);
    const { views } = (await import(entry)) as {
      views: Record<"a" | "b" | "c" | "d" | "e", () => Promise<Record<string, unknown>>>;
    };
    const a = await views.a();
    const b = await views.b();
    const c = await views.c();
    expect((a.default as () => string)()).toBe("a:shared");
    expect((b.b as () => string)()).toBe("b:shared");
    expect((c.default as () => string)()).toBe("c");
    expect(((await views.d()).d as () => string)()).toBe("d:shared");
    expect(((await views.e()).e as () => string)()).toBe("e:shared");
  });

  test("Tailwind still scans a tagged lazy module", () => {
    const entryCss = manifest.entries.css.map((p) => readFileSync(fileOf(outdir, p), "utf8")).join("\n");
    expect(entryCss).toContain(`.${TAILWIND_ONLY_CLASS.replace(/[[\]]/g, "\\$&")}`);
  });
});

describe("a syntax error in a lazy view", () => {
  test("comes back as build diagnostics, not a thrown pre-scan", () => {
    const broken = join(root, "src-broken");
    for (const [rel, contents] of Object.entries(FIXTURE)) {
      const path = join(broken, rel);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, rel === "views/b/view.ts" ? `${contents}export const = ;\n` : contents);
    }
    const proc = Bun.spawnSync({
      cmd: ["bun", BUILD_CLIENT, "--outdir", join(root, "out-broken"), "--entry", join(broken, "main.ts"), "--json"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    const result = JSON.parse(proc.stdout.toString().trim()) as { ok: boolean; errors: string[] };
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("views/b/view.ts");
  }, BUILD_TIMEOUT_MS);
});
