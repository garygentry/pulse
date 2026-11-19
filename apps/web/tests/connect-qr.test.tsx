// apps/web/tests/connect-qr.test.tsx — the connect screen's QR renderer: path data and the a11y contract.
import { describe, expect, it } from "bun:test";
import { encodeQrMatrix, type QrMatrix } from "@pulse/web-data/contract";

import { QR_QUIET_ZONE, QrCode, qrPathData } from "../src/client/views/connect/qr-code.js";
import { describeUi, render, screen } from "./rtl.js";

const LINK = "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com";

/** A matrix from rows of `#` (dark) and `.` (light). */
function matrixOf(rows: readonly string[]): QrMatrix {
  return { size: rows.length, modules: rows.flatMap((row) => [...row].map((c) => c === "#")) };
}

describe("qrPathData", () => {
  it("uses the QR minimum quiet zone", () => {
    expect(QR_QUIET_ZONE).toBe(4);
  });

  it("emits one closed rectangle per run of dark modules, offset by the quiet zone", () => {
    const d = qrPathData(matrixOf(["##.", "...", "#.#"]));
    expect(d).toBe("M4 4h2v1h-2z" + "M4 6h1v1h-1z" + "M6 6h1v1h-1z");
  });

  it("does not join runs across rows and handles a full-width run", () => {
    expect(qrPathData(matrixOf(["##", "##"]))).toBe("M4 4h2v1h-2zM4 5h2v1h-2z");
  });

  it("is empty for an all-light matrix", () => {
    expect(qrPathData(matrixOf(["..", ".."]))).toBe("");
  });

  it("covers exactly the dark modules of a 21×21 matrix, inside the quiet zone", () => {
    const size = 21;
    const modules = Array.from({ length: size * size }, (_, i) => (i * 7 + Math.floor(i / size)) % 3 === 0);
    const d = qrPathData({ size, modules });
    const covered = new Set<number>();
    const segments = [...d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
    expect(segments.map((s) => s[0]).join("")).toBe(d);
    for (const [, xs, ys, run, back] of segments) {
      expect(back).toBe(run!);
      const x = Number(xs) - QR_QUIET_ZONE;
      const y = Number(ys) - QR_QUIET_ZONE;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + Number(run)).toBeLessThanOrEqual(size);
      expect(y).toBeLessThan(size);
      // A segment is a maximal run: the module before it and the one after it are light or off the row.
      if (x > 0) expect(modules[y * size + x - 1]).toBe(false);
      if (x + Number(run) < size) expect(modules[y * size + x + Number(run)]).toBe(false);
      for (let i = 0; i < Number(run); i += 1) covered.add(y * size + x + i);
    }
    const dark = modules.flatMap((on, i) => (on ? [i] : []));
    expect([...covered].sort((a, b) => a - b)).toEqual(dark);
  });

  it("throws RangeError when the module count does not match the size", () => {
    expect(() => qrPathData({ size: 21, modules: new Array<boolean>(440).fill(false) })).toThrow(RangeError);
    expect(() => qrPathData({ size: 2, modules: [true, false, true, false, true] })).toThrow(RangeError);
  });
});

describeUi("QrCode", () => {
  it("renders an image named by the link, as one path inside the quiet zone, with no inline style", () => {
    const matrix = encodeQrMatrix("pulse", { ecc: "M" });
    expect(matrix.size).toBe(21);
    render(<QrCode matrix={matrix} label={LINK} />);

    const img = screen.getByRole("img", { name: LINK });
    expect(img.tagName.toLowerCase()).toBe("svg");
    expect(img).toHaveAttribute("viewBox", "0 0 29 29");
    expect(img).toHaveAttribute("data-slot", "qr-code");
    expect(img).not.toHaveAttribute("style");

    expect(img.children).toHaveLength(1);
    const path = img.children[0]!;
    expect(path.tagName.toLowerCase()).toBe("path");
    expect(path).toHaveAttribute("d", qrPathData(matrix));
    expect(path).not.toHaveAttribute("style");
    expect(path).not.toHaveAttribute("fill");
  });

  it("sizes the view box to the matrix plus the quiet zone on each side", () => {
    const matrix = encodeQrMatrix(LINK, { ecc: "M" });
    render(<QrCode matrix={matrix} label={LINK} />);
    const n = matrix.size + 2 * QR_QUIET_ZONE;
    expect(screen.getByRole("img", { name: LINK })).toHaveAttribute("viewBox", `0 0 ${n} ${n}`);
  });
});
