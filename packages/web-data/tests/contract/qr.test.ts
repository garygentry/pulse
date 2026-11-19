/** qr.test.ts — QR matrix encoding: pinned sizes, finder patterns, determinism, overflow. */

import { describe, expect, test } from "bun:test";
import qrcode from "qrcode-generator";
import { buildConnectLink } from "../../src/contract/connect-link.js";
import { encodeQrMatrix, type QrMatrix } from "../../src/contract/qr.js";

const LINK_55 = "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com";

function link256(): string {
  const built = buildConnectLink(`https://pulse.example.com/${"a".repeat(198)}`);
  if (!built.ok) throw new Error(`expected ok, got ${built.refusal}`);
  return built.link;
}

const at = (m: QrMatrix, row: number, col: number): boolean => m.modules[row * m.size + col] as boolean;

/** A finder pattern: 7×7 dark ring, light ring inside it, 3×3 dark centre. */
function expectFinder(m: QrMatrix, top: number, left: number): void {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const edge = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      expect(at(m, top + r, left + c)).toBe(edge || core);
    }
  }
}

describe("encodeQrMatrix", () => {
  test("a 55-character link is version 4 (33 modules)", () => {
    expect(LINK_55.length).toBe(55);
    const m = encodeQrMatrix(LINK_55);
    expect(m.size).toBe(33);
    expect(m.modules.length).toBe(33 * 33);
  });

  test("a 256-character link is version 12 (65 modules)", () => {
    const link = link256();
    expect(link.length).toBe(256);
    const m = encodeQrMatrix(link);
    expect(m.size).toBe(65);
    expect(m.modules.length).toBe(65 * 65);
  });

  test("modules are booleans and the result is frozen", () => {
    const m = encodeQrMatrix(LINK_55);
    expect(m.modules.every((v) => typeof v === "boolean")).toBe(true);
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.modules)).toBe(true);
  });

  test("the three finder patterns sit at the corners, with no quiet zone", () => {
    for (const m of [encodeQrMatrix(LINK_55), encodeQrMatrix(link256())]) {
      expectFinder(m, 0, 0);
      expectFinder(m, 0, m.size - 7);
      expectFinder(m, m.size - 7, 0);
    }
  });

  test("output is deterministic", () => {
    expect(encodeQrMatrix(LINK_55)).toEqual(encodeQrMatrix(LINK_55));
    expect(encodeQrMatrix(link256(), { ecc: "Q" })).toEqual(encodeQrMatrix(link256(), { ecc: "Q" }));
  });

  test("the default level is M, and a higher level needs a larger or equal symbol", () => {
    expect(encodeQrMatrix(LINK_55)).toEqual(encodeQrMatrix(LINK_55, { ecc: "M" }));
    expect(encodeQrMatrix(LINK_55, { ecc: "L" }).size).toBeLessThanOrEqual(33);
    expect(encodeQrMatrix(LINK_55, { ecc: "H" }).size).toBeGreaterThan(33);
  });

  test("matches the library's own matrix for the same bytes", () => {
    const reference = qrcode(0, "M");
    reference.addData(LINK_55, "Byte");
    reference.make();
    const m = encodeQrMatrix(LINK_55);
    expect(m.size).toBe(reference.getModuleCount());
    for (let r = 0; r < m.size; r += 1) {
      for (let c = 0; c < m.size; c += 1) expect(at(m, r, c)).toBe(reference.isDark(r, c));
    }
  });

  test("non-ASCII text is encoded as its UTF-8 bytes", () => {
    const text = "pulse ü €";
    const binary = String.fromCharCode(...new TextEncoder().encode(text));
    expect(binary.length).toBeGreaterThan(text.length);
    const reference = qrcode(0, "M");
    reference.addData(binary, "Byte");
    reference.make();
    const m = encodeQrMatrix(text);
    expect(m.size).toBe(reference.getModuleCount());
    const expected: boolean[] = [];
    for (let r = 0; r < m.size; r += 1) {
      for (let c = 0; c < m.size; c += 1) expected.push(reference.isDark(r, c));
    }
    expect([...m.modules]).toEqual(expected);
  });

  test("oversize input throws RangeError without echoing the text", () => {
    const text = "x".repeat(3000);
    let thrown: unknown;
    try {
      encodeQrMatrix(text);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RangeError);
    expect((thrown as RangeError).message).toBe("encodeQrMatrix: text exceeds QR capacity");
  });

  test("the capacity boundary at M is 2331 bytes (version 40)", () => {
    expect(encodeQrMatrix("x".repeat(2331)).size).toBe(177);
    expect(() => encodeQrMatrix("x".repeat(2332))).toThrow(RangeError);
  });

  test("does not mutate the library's global byte conversion", () => {
    const before = qrcode.stringToBytes;
    encodeQrMatrix("pulse ü");
    expect(qrcode.stringToBytes).toBe(before);
    expect(qrcode.stringToBytes("ü")).toEqual([0xfc]);
  });
});
