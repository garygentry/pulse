// apps/web/tests/connect-qr-tokens.test.ts — the QR plate tokens: one light-plate / dark-module pair shared by
// both themes, restating theme.css's light values, with enough contrast for a phone camera.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contrastRatio, THEME_TOKENS } from "./support/tokens.js";

// Comments are stripped: they quote selectors and braces.
const pulseCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/client/styles/theme-pulse.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `selector { … }` rule in theme-pulse.css that declares `name`, as [selector, value]. */
function declarationsOf(name: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const [, selector, body] of pulseCss.matchAll(/(?:^|\n)([^\n{}/@][^\n{}]*?) \{([^}]*)\}/g)) {
    const value = new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+);`).exec(body!);
    if (value !== null) out.push([selector!.trim(), value[1]!.trim()]);
  }
  return out;
}

const plate = declarationsOf("--qr-plate");
const module_ = declarationsOf("--qr-module");

test("each QR token is declared once, under the selector that covers light and dark", () => {
  expect(plate.map(([selector]) => selector)).toEqual([":root, .dark"]);
  expect(module_.map(([selector]) => selector)).toEqual([":root, .dark"]);
  // No other rule (a `.dark` block, a preset) re-declares them, so the values are identical in both themes.
  expect(pulseCss.match(/--qr-plate:/g)).toHaveLength(1);
  expect(pulseCss.match(/--qr-module:/g)).toHaveLength(1);
});

test("the QR tokens restate theme.css's light --card and --foreground", () => {
  expect(plate[0]![1]).toBe(THEME_TOKENS.light["--card"]!);
  expect(module_[0]![1]).toBe(THEME_TOKENS.light["--foreground"]!);
});

test("the module colour has at least 7:1 contrast on the plate", () => {
  expect(contrastRatio(plate[0]![1], module_[0]![1])).toBeGreaterThanOrEqual(7);
});

test("the tokens are mapped to Tailwind colours", () => {
  expect(pulseCss).toContain("--color-qr-plate: var(--qr-plate);");
  expect(pulseCss).toContain("--color-qr-module: var(--qr-module);");
});
