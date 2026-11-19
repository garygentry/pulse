// packages/web-data/src/contract/qr.ts — QR module matrix for a connect link. Browser-safe: the only import is
// `qrcode-generator`. Renderers (SVG, terminal) add the quiet zone themselves.

import qrcode from "qrcode-generator";

/** Error-correction level. "M" is the default (~15% recovery). */
export type QrEcc = "L" | "M" | "Q" | "H";

/** A square QR module matrix. */
export interface QrMatrix {
  /** Modules per side (21 for version 1, +4 per version). */ readonly size: number;
  /** Row-major dark flags, length size*size. */ readonly modules: readonly boolean[];
}

/** One character per UTF-8 byte, so the library's default byte conversion (`charCodeAt & 0xff`) reproduces the bytes. */
function utf8BinaryString(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096) out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return out;
}

/**
 * Encode text (byte mode, UTF-8) at the smallest version that fits. The matrix has no quiet zone. Deterministic
 * for a given text and level.
 * @throws {RangeError} when text exceeds QR capacity at the given ECC
 */
export function encodeQrMatrix(text: string, options: { /** Error-correction level; default "M". */ readonly ecc?: QrEcc } = {}): QrMatrix {
  const ecc = options.ecc ?? "M";
  const qr = qrcode(0, ecc); // 0 = pick the smallest version
  try {
    qr.addData(utf8BinaryString(text), "Byte");
    qr.make();
  } catch {
    // The library signals overflow by throwing a string. The message never echoes the text.
    throw new RangeError("encodeQrMatrix: text exceeds QR capacity");
  }
  const size = qr.getModuleCount();
  const modules = new Array<boolean>(size * size);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) modules[r * size + c] = qr.isDark(r, c);
  }
  return Object.freeze({ size, modules: Object.freeze(modules) });
}
