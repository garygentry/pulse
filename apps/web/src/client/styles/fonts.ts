// src/client/styles/fonts.ts — Geist Sans and Geist Mono, self-hosted from @fontsource-variable.
//
// Bun's CSS bundler inlines every url() font into the stylesheet as a data: URL, which would put
// ~400 KB of fonts in the entry stylesheet. Imported from JS instead, each .woff2 is emitted as a
// hashed, same-origin file next to the bundle and only fetched when text in its unicode range is
// first drawn (the faces below mirror the packages' index.css, pinned by fonts.test.ts). The app
// renders nothing before its JS runs, so registering the faces from JS costs no first paint.
import geistCyrillicExt from "@fontsource-variable/geist/files/geist-cyrillic-ext-wght-normal.woff2";
import geistCyrillic from "@fontsource-variable/geist/files/geist-cyrillic-wght-normal.woff2";
import geistVietnamese from "@fontsource-variable/geist/files/geist-vietnamese-wght-normal.woff2";
import geistLatinExt from "@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2";
import geistLatin from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2";
import geistMonoCyrillicExt from "@fontsource-variable/geist-mono/files/geist-mono-cyrillic-ext-wght-normal.woff2";
import geistMonoCyrillic from "@fontsource-variable/geist-mono/files/geist-mono-cyrillic-wght-normal.woff2";
import geistMonoSymbols2 from "@fontsource-variable/geist-mono/files/geist-mono-symbols2-wght-normal.woff2";
import geistMonoVietnamese from "@fontsource-variable/geist-mono/files/geist-mono-vietnamese-wght-normal.woff2";
import geistMonoLatinExt from "@fontsource-variable/geist-mono/files/geist-mono-latin-ext-wght-normal.woff2";
import geistMonoLatin from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2";

const CYRILLIC_EXT = "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F";
const CYRILLIC = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116";
const VIETNAMESE = "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const SYMBOLS2 = "U+2000-2001,U+2004-2008,U+200A,U+23B8-23BD,U+2500-259F";

/** One variable font face: family, the bundled file's URL, and the code points it covers. */
export interface FontFaceSpec {
  readonly family: "Geist Variable" | "Geist Mono Variable";
  readonly url: string;
  readonly unicodeRange: string;
}

/** Every normal-style face of the two packages (wght 100–900, one file per subset). */
export const FONT_FACES: readonly FontFaceSpec[] = [
  { family: "Geist Variable", url: geistCyrillicExt, unicodeRange: CYRILLIC_EXT },
  { family: "Geist Variable", url: geistCyrillic, unicodeRange: CYRILLIC },
  { family: "Geist Variable", url: geistVietnamese, unicodeRange: VIETNAMESE },
  { family: "Geist Variable", url: geistLatinExt, unicodeRange: LATIN_EXT },
  { family: "Geist Variable", url: geistLatin, unicodeRange: LATIN },
  { family: "Geist Mono Variable", url: geistMonoCyrillicExt, unicodeRange: CYRILLIC_EXT },
  { family: "Geist Mono Variable", url: geistMonoCyrillic, unicodeRange: CYRILLIC },
  { family: "Geist Mono Variable", url: geistMonoSymbols2, unicodeRange: SYMBOLS2 },
  { family: "Geist Mono Variable", url: geistMonoVietnamese, unicodeRange: VIETNAMESE },
  { family: "Geist Mono Variable", url: geistMonoLatinExt, unicodeRange: LATIN_EXT },
  { family: "Geist Mono Variable", url: geistMonoLatin, unicodeRange: LATIN },
];

/**
 * Add the faces to `doc.fonts`. Asset URLs are resolved against this module's URL: the bundler
 * emits them relative to the bundle directory, not the page. A no-op without the CSS Font Loading
 * API (happy-dom, SSR).
 */
export function registerFonts(doc: Document | undefined = globalThis.document): void {
  const fonts = doc?.fonts as FontFaceSet | undefined;
  if (fonts === undefined || typeof FontFace === "undefined") return;
  for (const face of FONT_FACES) {
    const src = `url("${new URL(face.url, import.meta.url).href}") format("woff2-variations")`;
    const descriptors: FontFaceDescriptors = {
      weight: "100 900",
      style: "normal",
      display: "swap",
      unicodeRange: face.unicodeRange,
    };
    fonts.add(new FontFace(face.family, src, descriptors));
  }
}
