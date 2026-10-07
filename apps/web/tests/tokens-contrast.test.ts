import { converter, parse } from "culori";
import { describe, expect, it } from "bun:test";
import {
  AA_TEXT_TOKENS,
  contrastRatio,
  STATUS_TONES,
  TEXT_SURFACES,
  THEME_TOKENS,
  tokenColor,
  type Mode,
} from "./support/tokens.js";

// ---------------------------------------------------------------------------
// Design-token contrast, parsed from src/client/styles/theme.css in both modes.
//
// - Every AA text token (foreground, muted-foreground, primary, each status
//   tone's -fg) clears 4.5:1 on background, card and muted, so any state colour
//   that aliases one of them is readable wherever it lands.
// - Each tone's -fg also clears 4.5:1 on its own -bg (chips and banners).
// - Paired foreground/surface tokens clear 4.5:1.
// - Focus ring and form-control edges (`--input`) clear the 3:1 non-text bar.
//   `--border` is a decorative divider and is deliberately not held to 3:1.
// - The ok tone stays ≥40° of hue from the teal primary, so "healthy" never
//   reads as a link or an action.
//
// Colour is never the only status signal (icon + text); these ratios make the
// redundant colour cue legible, not load-bearing.
// ---------------------------------------------------------------------------

const MODES: readonly Mode[] = ["light", "dark"];

const PAIRS: readonly (readonly [string, string])[] = [
  ["--foreground", "--background"],
  ["--card-foreground", "--card"],
  ["--popover-foreground", "--popover"],
  ["--primary-foreground", "--primary"],
  ["--secondary-foreground", "--secondary"],
  ["--accent-foreground", "--accent"],
  ["--destructive-foreground", "--destructive"],
  ["--sidebar-foreground", "--sidebar"],
  ["--sidebar-primary-foreground", "--sidebar-primary"],
  ["--sidebar-accent-foreground", "--sidebar-accent"],
];

const oklch = converter("oklch");

function hue(mode: Mode, token: string): number {
  const color = oklch(parse(tokenColor(mode, token)));
  if (color?.h === undefined) throw new Error(`${token} has no hue in ${mode}`);
  return color.h;
}

const ratio = (mode: Mode, fg: string, bg: string): number =>
  contrastRatio(tokenColor(mode, fg), tokenColor(mode, bg));

describe("design token contrast", () => {
  it("defines every status tone with -fg, -bg and -border in both modes", () => {
    for (const mode of MODES) {
      for (const tone of STATUS_TONES) {
        for (const part of ["fg", "bg", "border"]) {
          expect(THEME_TOKENS[mode], `${mode} --status-${tone}-${part}`).toHaveProperty(
            `--status-${tone}-${part}`,
          );
        }
      }
    }
  });

  it("authors every token as a literal oklch() colour, so this suite can read it", () => {
    for (const mode of MODES) {
      for (const [token, value] of Object.entries(THEME_TOKENS[mode])) {
        if (token === "--radius") continue;
        expect(value, `${mode} ${token}`).toMatch(/^oklch\([^)]*\)$/);
      }
    }
  });

  for (const mode of MODES) {
    describe(mode, () => {
      for (const token of AA_TEXT_TOKENS) {
        for (const surface of TEXT_SURFACES) {
          it(`${token} meets 4.5:1 on ${surface}`, () => {
            expect(ratio(mode, token, surface)).toBeGreaterThanOrEqual(4.5);
          });
        }
      }

      for (const tone of STATUS_TONES) {
        it(`--status-${tone}-fg meets 4.5:1 on its own -bg`, () => {
          expect(
            ratio(mode, `--status-${tone}-fg`, `--status-${tone}-bg`),
          ).toBeGreaterThanOrEqual(4.5);
        });
      }

      for (const [fg, bg] of PAIRS) {
        it(`${fg} meets 4.5:1 on ${bg}`, () => {
          expect(ratio(mode, fg, bg)).toBeGreaterThanOrEqual(4.5);
        });
      }

      for (const token of ["--ring", "--input"]) {
        for (const surface of TEXT_SURFACES) {
          it(`${token} meets the 3:1 non-text bar on ${surface}`, () => {
            expect(ratio(mode, token, surface)).toBeGreaterThanOrEqual(3);
          });
        }
      }

      it("keeps the ok tone at least 40° of hue from primary", () => {
        const delta = Math.abs(hue(mode, "--status-ok-fg") - hue(mode, "--primary"));
        expect(Math.min(delta, 360 - delta)).toBeGreaterThanOrEqual(40);
      });
    });
  }

  it("fails an unparseable or undefined colour rather than passing it", () => {
    expect(() => contrastRatio("", "#fff")).toThrow();
    expect(() => contrastRatio("not-a-colour", "#fff")).toThrow();
    expect(() => tokenColor("light", "--nonexistent")).toThrow();
  });
});
