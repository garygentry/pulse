/**
 * Design-token helpers for unit tests, read straight from the stylesheets.
 *
 * - `THEME_TOKENS` parses `src/client/styles/theme.css` into its light (`:root`) and
 *   dark (`:root` overlaid with `.dark`) token values.
 * - `resolveTokenName` checks a token is defined by theme.css and returns it;
 *   it throws for a token theme.css does not define.
 * - `AA_TEXT_TOKENS` are the theme.css tokens `tokens-contrast.test.ts` holds to
 *   WCAG AA as text on every surface. A state colour that resolves to one of
 *   them is guaranteed readable without per-feature colour math.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, wcagContrast } from "culori";

export type Mode = "light" | "dark";
export type TokenValues = Readonly<Record<string, string>>;

const stylesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/client/styles");
const readStyle = (name: string): string => readFileSync(resolve(stylesDir, name), "utf8");

/** The `--name: value;` declarations of the first top-level `selector { … }` block. */
function declarations(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  if (block === null) throw new Error(`No "${selector}" block in stylesheet`);
  const out: Record<string, string> = {};
  for (const [, name, value] of block[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    out[`--${name}`] = value!.trim();
  }
  return out;
}

const themeCss = readStyle("theme.css");
const lightTokens = declarations(themeCss, ":root");

export const THEME_TOKENS: Readonly<Record<Mode, TokenValues>> = {
  light: lightTokens,
  dark: { ...lightTokens, ...declarations(themeCss, ".dark") },
};

/** A theme.css token name, or a thrown error if theme.css does not define it. */
export function resolveTokenName(token: string): string {
  if (token in THEME_TOKENS.light) return token;
  throw new Error(`Undefined CSS token: ${token}`);
}

/** A theme.css token's colour in one mode, e.g. `tokenColor("dark", "--card")`. */
export function tokenColor(mode: Mode, token: string): string {
  const value = THEME_TOKENS[mode][token];
  if (value === undefined) throw new Error(`Undefined theme token: ${token}`);
  return value;
}

/** WCAG contrast ratio between two CSS colours; throws on an unparseable colour. */
export function contrastRatio(a: string, b: string): number {
  const ca = parse(a);
  const cb = parse(b);
  if (ca === undefined || cb === undefined) {
    throw new Error(`Invalid or missing CSS colour: ${ca === undefined ? a : b}`);
  }
  return wcagContrast(ca, cb);
}

export const STATUS_TONES = ["ok", "warn", "danger", "info", "pending", "neutral"] as const;

/** Surfaces text may sit on; AA text tokens are checked against each one. */
export const TEXT_SURFACES = ["--background", "--card", "--muted"] as const;

export const AA_TEXT_TOKENS: readonly string[] = [
  "--foreground",
  "--muted-foreground",
  "--primary",
  ...STATUS_TONES.map((tone) => `--status-${tone}-fg`),
];
