// apps/cli/src/qr-terminal.ts — render a QR module matrix as terminal text with half-block glyphs.

import type { QrMatrix } from "@pulse/web-data/contract";

/** Quiet-zone width in modules (the QR minimum). */
export const TERMINAL_QR_QUIET_ZONE = 4;

/**
 * Render a matrix with half-block characters, two module rows per text line. Pure; no ANSI
 * escapes, so `NO_COLOR` and pipes are unaffected.
 *
 * The padded grid is the matrix plus a {@link TERMINAL_QR_QUIET_ZONE} light border. For each
 * line, rows r and r+1 (row r+1 counts as light past the bottom edge) and each column, the
 * "painted" cells form the glyph: both painted gives "█", only top "▀", only bottom "▄", neither
 * " ". Lines are joined with "\n", with no trailing newline.
 *
 * Painted cells are the LIGHT modules by default (`invert: false`): terminals usually draw light
 * glyphs on a dark background, so painting the light modules gives the dark-on-light code that
 * scanners expect. `invert: true` paints the dark modules, for light-background terminals.
 *
 * @throws {RangeError} when `modules.length !== size * size`
 */
export function renderQrHalfBlocks(
  matrix: QrMatrix,
  options: { readonly invert?: boolean } = {},
): string {
  const { size, modules } = matrix;
  if (!Number.isInteger(size) || size < 0 || modules.length !== size * size) {
    throw new RangeError("QR matrix modules length must equal size * size");
  }
  const paintDark = options.invert === true;
  const side = size + 2 * TERMINAL_QR_QUIET_ZONE;

  /** Is the padded-grid cell dark? Anything outside the matrix is light. */
  const dark = (row: number, col: number): boolean => {
    const r = row - TERMINAL_QR_QUIET_ZONE;
    const c = col - TERMINAL_QR_QUIET_ZONE;
    return r >= 0 && r < size && c >= 0 && c < size && modules[r * size + c] === true;
  };
  const painted = (row: number, col: number): boolean => dark(row, col) === paintDark;

  const lines: string[] = [];
  for (let row = 0; row < side; row += 2) {
    let line = "";
    for (let col = 0; col < side; col++) {
      const top = painted(row, col);
      // Past the bottom edge the missing row is light: painted unless inverted.
      const bottom = row + 1 < side ? painted(row + 1, col) : !paintDark;
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
