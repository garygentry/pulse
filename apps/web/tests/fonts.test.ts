// apps/web/tests/fonts.test.ts — the Geist faces registered from JS stay in step with the packages.
//
// styles/fonts.ts mirrors @fontsource-variable/{geist,geist-mono}/index.css (the faces are added from
// JS because Bun's CSS bundler would inline the font files). This pins that mirror: same faces, same
// files, same unicode ranges, so a package upgrade that changes its faces fails here.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { describe, expect, test } from "bun:test";

import { FONT_FACES, registerFonts } from "../src/client/styles/fonts.js";

interface Face {
  family: string;
  file: string;
  unicodeRange: string;
}

function packageFaces(pkg: string): Face[] {
  const css = readFileSync(require.resolve(`@fontsource-variable/${pkg}/index.css`), "utf8");
  return [...css.matchAll(/@font-face \{([^}]*)\}/g)].map(([, body]) => ({
    family: /font-family: '([^']+)'/.exec(body!)![1]!,
    file: /url\(\.\/files\/([^)]+)\)/.exec(body!)![1]!,
    unicodeRange: /unicode-range: ([^;]+);/.exec(body!)![1]!,
  }));
}

describe("styles/fonts.ts", () => {
  test("FONT_FACES mirrors every face of the two fontsource packages", () => {
    const expected = [...packageFaces("geist"), ...packageFaces("geist-mono")];
    const actual: Face[] = FONT_FACES.map((f) => ({ family: f.family, file: basename(f.url), unicodeRange: f.unicodeRange }));
    expect(actual).toEqual(expected);
  });

  test("every face is the variable normal style, weights 100–900", () => {
    for (const pkg of ["geist", "geist-mono"]) {
      const css = readFileSync(require.resolve(`@fontsource-variable/${pkg}/index.css`), "utf8");
      for (const [, body] of css.matchAll(/@font-face \{([^}]*)\}/g)) {
        expect(body).toContain("font-style: normal;");
        expect(body).toContain("font-weight: 100 900;");
        expect(body).toContain("format('woff2-variations')");
      }
    }
  });

  test("registerFonts adds one FontFace per face, resolved to an absolute URL", () => {
    const added: { family: string; source: string; descriptors: FontFaceDescriptors }[] = [];
    const original = (globalThis as { FontFace?: unknown }).FontFace;
    (globalThis as { FontFace?: unknown }).FontFace = class {
      constructor(family: string, source: string, descriptors: FontFaceDescriptors) {
        added.push({ family, source, descriptors });
      }
    };
    try {
      const doc = { fonts: { add: () => undefined } } as unknown as Document;
      registerFonts(doc);
    } finally {
      (globalThis as { FontFace?: unknown }).FontFace = original;
    }
    expect(added).toHaveLength(FONT_FACES.length);
    for (const face of added) {
      expect(face.source).toMatch(/^url\("[a-z]+:\/\/.+\.woff2"\) format\("woff2-variations"\)$/);
      expect(face.descriptors).toMatchObject({ weight: "100 900", style: "normal", display: "swap" });
    }
  });

  test("registerFonts is a no-op without the CSS Font Loading API", () => {
    expect(() => registerFonts({} as Document)).not.toThrow();
    expect(() => registerFonts(undefined)).not.toThrow();
  });
});
