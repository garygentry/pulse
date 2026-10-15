// theme-pulse.css restates a few of deck's theme.css values in its `.dark` block, because deck sets
// them in `:root` only and the theme-parity guardrail wants a dark value for every light colour. A
// restatement is a copied literal, so a deck re-sync that changes the `:root` value would leave dark
// mode stale. Pin each one to theme.css (#51).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { THEME_TOKENS } from "./support/tokens.js";

const stylesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/client/styles");
const themeCss = readFileSync(resolve(stylesDir, "theme.css"), "utf8");
const pulseCss = readFileSync(resolve(stylesDir, "theme-pulse.css"), "utf8");

/** The `--name: value` declarations of a top-level `.dark { … }` block in `css` (empty when absent). */
function darkDeclarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const block = /(?:^|\n)\.dark \{([^}]*)\}/.exec(css);
  if (block === null) return out;
  for (const [, name, value] of block[1]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(name!, value!.trim());
  return out;
}

const restated = darkDeclarations(pulseCss);

test("theme-pulse.css restates --destructive-control-foreground for dark mode", () => {
  expect(restated.has("--destructive-control-foreground")).toBe(true);
});

test("every value theme-pulse.css restates in .dark equals theme.css's :root value", () => {
  expect(restated.size).toBeGreaterThan(0);
  for (const [name, value] of restated) {
    expect(THEME_TOKENS.light[name], `${name}: theme.css :root defines it`).toBeDefined();
    expect(value, `${name}: theme-pulse.css .dark must equal theme.css :root`).toBe(THEME_TOKENS.light[name]!);
  }
});

test("theme.css's own .dark does not define a restated token (drop the restatement once deck does)", () => {
  const deckDark = darkDeclarations(themeCss);
  expect(deckDark.size).toBeGreaterThan(0);
  expect([...restated.keys()].filter((name) => deckDark.has(name))).toEqual([]);
});
