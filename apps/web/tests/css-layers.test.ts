// apps/web/tests/css-layers.test.ts — the cascade-layer contract of the built stylesheets.
//
// styles/app.css is Tailwind's entry: the layers are Tailwind's own `theme, base, components,
// utilities`, declared by the first statement that names them. There is no pre-Tailwind CSS left:
// every stylesheet lives under styles/, nothing declares a `legacy` layer, and lazy chunks ship no
// stylesheet of their own (third-party CSS a chunk reaches, uPlot's, rides the entry sheet). The
// browser half of the contract is tests/browser/css-layers.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import type { ClientBuildResult } from "../scripts/build-client.js";
import type { ClientManifest } from "../src/server/assets.js";

const BUILD_CLIENT = resolve(import.meta.dir, "../scripts/build-client.ts");
const CLIENT_DIR = resolve(import.meta.dir, "../src/client");
const LAYER_ORDER = "theme,base,components,utilities";

let outdir: string;
let manifest: ClientManifest;

const read = (publicPath: string): string => readFileSync(join(outdir, basename(publicPath)), "utf8");

/** Every .css file under src/client, recursively, as paths relative to it. */
function clientCss(dir = CLIENT_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return clientCss(p);
    return e.name.endsWith(".css") ? [relative(CLIENT_DIR, p)] : [];
  });
}

/** The CSS with comments removed and whitespace collapsed. */
function compact(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
}

// A full client build takes 3–5 s on the 2-CPU host, at bun's 5 s default hook timeout.
beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "pulse-css-layers-"));
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
}, 60_000);

afterAll(() => {
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

describe("cascade layers in the built stylesheets", () => {
  test("the entry sheet declares the layer order before any layer block", () => {
    expect(manifest.entries.css).toHaveLength(1);
    const css = read(manifest.entries.css[0]!);
    const statements = [...css.matchAll(/@layer ([\w-]+(?:\s*,\s*[\w-]+)+)\s*;/g)];
    const ours = statements.find((m) => m[1]!.replace(/\s/g, "") === LAYER_ORDER);
    expect(ours, "layer order statement").toBeDefined();
    const firstBlock = css.search(/@layer [\w-]+\s*\{/);
    expect(firstBlock).toBeGreaterThan(ours!.index!);
    // Only the `properties` layer (Tailwind's @property fallbacks) may be named before it.
    const before = css.slice(0, ours!.index!).match(/@layer ([\w-]+)/g) ?? [];
    expect(before).toEqual(["@layer properties"]);
  });

  test("no chunk ships its own stylesheet: chunk CSS the entry sheet already carries is omitted", () => {
    expect(manifest.chunkCss ?? {}).toEqual({});
    expect(manifest.chunks.filter((c) => c.endsWith(".css"))).toEqual([]);
    expect(readdirSync(outdir).filter((f) => f.endsWith(".css"))).toEqual([basename(manifest.entries.css[0]!)]);
  });

  test("uPlot's stylesheet rides the entry sheet", () => {
    expect(read(manifest.entries.css[0]!)).toContain(".uplot");
  });

  test("no built stylesheet declares a legacy layer", () => {
    expect(read(manifest.entries.css[0]!)).not.toMatch(/@layer[^{;]*\blegacy\b/);
  });

  test("the scroll-lock gap property registration survives the build", () => {
    expect(read(manifest.entries.css[0]!)).toMatch(/@property --removed-body-scroll-bar-size\s*\{[^}]*inherits:\s*false/);
  });

  test("no stylesheet inlines a font or other asset as a data: URL", () => {
    for (const p of [...manifest.entries.css, ...manifest.chunks.filter((c) => c.endsWith(".css"))]) {
      expect(read(p), p).not.toContain("url(data:");
    }
  });

  test("the Geist fonts ship as hashed .woff2 files next to the bundle", () => {
    const fonts = readdirSync(outdir).filter((f) => f.endsWith(".woff2"));
    expect(fonts.some((f) => /^geist-latin-wght-normal-\w+\.woff2$/.test(f))).toBe(true);
    expect(fonts.some((f) => /^geist-mono-latin-wght-normal-\w+\.woff2$/.test(f))).toBe(true);
  });
});

describe("cascade layers in the source stylesheets", () => {
  test("every client stylesheet lives under styles/ (components and views style with Tailwind classes)", () => {
    const sheets = clientCss();
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.filter((f) => !f.startsWith("styles/"))).toEqual([]);
  });

  test("app.css registers the scroll-lock gap property react-remove-scroll-bar writes, non-inherited", async () => {
    const app = readFileSync(join(CLIENT_DIR, "styles/app.css"), "utf8");
    expect(compact(app)).toContain('@property --removed-body-scroll-bar-size { syntax: "<length>"; inherits: false; initial-value: 0px; }');
    // A transitive dependency of the Radix dialog, so it lives only in bun's package store.
    const root = resolve(import.meta.dir, "../../..");
    const glob = new Bun.Glob("node_modules/.bun/react-remove-scroll-bar@*/node_modules/react-remove-scroll-bar/dist/es2015/constants.js");
    const files = [...glob.scanSync({ cwd: root, dot: true })];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(join(root, file), "utf8")).toContain("--removed-body-scroll-bar-size");
  });

  test("app.css leads with Tailwind and imports only the theme files", () => {
    const app = readFileSync(join(CLIENT_DIR, "styles/app.css"), "utf8");
    const imports = [...app.matchAll(/@import "([^"]+)"[^;]*;/g)].map((m) => m[0]);
    expect(imports).toEqual(['@import "tailwindcss";', '@import "tw-animate-css";', '@import "./theme.css";', '@import "./theme-pulse.css";']);
    expect(app).not.toMatch(/\blegacy\b/);
  });
});
