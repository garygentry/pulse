// apps/web/src/client/views/connect/qr-code.tsx — SVG renderer for a connect-link QR matrix. View-local,
// not an `@/ui` pattern: the connect screen is its only user.
import type { ReactElement } from "react";
import type { QrMatrix } from "@pulse/web-data/contract";

/** Modules of light margin around the code (QR spec minimum). */
export const QR_QUIET_ZONE = 4;

export interface QrCodeProps {
  /** Encoded matrix from encodeQrMatrix. */
  readonly matrix: QrMatrix;
  /** Text alternative: the full link text. */
  readonly label: string;
}

/**
 * One SVG path for all dark modules. Each run of consecutive dark modules in a row becomes
 * `M{x+Q} {y+Q}h{run}v1h-{run}z` (Q = QR_QUIET_ZONE), which keeps `d` short. Pure; exported for tests.
 * @throws {RangeError} when matrix.modules.length !== matrix.size * matrix.size
 */
export function qrPathData(matrix: QrMatrix): string {
  const { size, modules } = matrix;
  if (!Number.isInteger(size) || size < 0 || modules.length !== size * size) {
    throw new RangeError("qrPathData: modules length does not match size");
  }
  let d = "";
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (modules[y * size + x] !== true) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < size && modules[y * size + x] === true) x += 1;
      const run = x - start;
      d += `M${start + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h${run}v1h-${run}z`;
    }
  }
  return d;
}

/** Renders `<svg role="img" aria-label={label} viewBox="0 0 N N">` with N = size + 2·Q and one `<path d>`.
 *  The plate is light and the modules dark in both themes, so a phone camera reads it either way. */
export function QrCode({ matrix, label }: QrCodeProps): ReactElement {
  const n = matrix.size + 2 * QR_QUIET_ZONE;
  return (
    <svg
      data-slot="qr-code"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      className="block aspect-square w-full max-w-64 rounded-md bg-qr-plate md:max-w-72"
    >
      <path d={qrPathData(matrix)} className="fill-qr-module" />
    </svg>
  );
}
