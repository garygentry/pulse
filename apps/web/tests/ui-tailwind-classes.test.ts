// apps/web/tests/ui-tailwind-classes.test.ts — every Tailwind class the `@/ui` library uses compiles.
//
// `bun-plugin-tailwind` embeds its own Tailwind compiler, which can lag the installed `tailwindcss`
// that deck's library was written against. This bundles the whole `@/ui` barrel with the plugin
// (as the client build does), then asks the installed Tailwind which class-like tokens in the
// library's sources are utilities. Each of those must have a rule in the plugin's output too, so a
// class the embedded compiler does not know fails here instead of silently rendering unstyled.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import tailwind from "bun-plugin-tailwind";

import { hasClassRule, referenceCompiler } from "./support/tailwind.js";

const WEB = resolve(import.meta.dir, "..");
const UI_DIR = join(WEB, "src/client/ui");
const ENTRY = join(import.meta.dir, "fixtures/ui-library-entry.ts");

/** The vendored library directories (the old kit at the `ui/` root is not Tailwind). */
const LIBRARY_DIRS = ["primitives", "patterns", "hooks", "lib", "status", "viz"];

let outdir: string;
let pluginCss: string;

/** Every string-literal fragment in the library's sources, split into class-like tokens. */
function libraryTokens(): string[] {
  const tokens = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/"([^"\n]*)"|`([^`]*)`/g)) {
          const literal = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
          for (const token of literal.split(/\s+/)) {
            if (/^[!a-z@*[-][^\s]*$/.test(token)) tokens.add(token);
          }
        }
      }
    }
  };
  for (const dir of LIBRARY_DIRS) walk(join(UI_DIR, dir));
  return [...tokens].sort();
}

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), "pulse-ui-classes-"));
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir,
    target: "browser",
    plugins: [tailwind],
    loader: { ".woff2": "file", ".woff": "file" },
    throw: false,
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  const css = result.outputs.find((o) => o.path.endsWith(".css"));
  if (css === undefined) throw new Error("the ui library bundle emitted no stylesheet");
  pluginCss = await css.text();
}, 120_000);

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("@/ui Tailwind classes", () => {
  test("every utility the library uses has a rule in the plugin-compiled sheet", async () => {
    const compiler = await referenceCompiler();
    const tokens = libraryTokens();
    const referenceCss = compiler.build(tokens);
    // A token is a utility when the reference compiler emitted its class selector.
    const utilities = tokens.filter((t) => hasClassRule(referenceCss, t));
    const missing = utilities.filter((t) => !hasClassRule(pluginCss, t));

    // Sanity: the scan finds the library's classes (hundreds), not a handful.
    expect(utilities.length).toBeGreaterThan(300);
    expect(missing).toEqual([]);
  }, 60_000);
});
