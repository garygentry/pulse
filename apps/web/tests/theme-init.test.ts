// apps/web/tests/theme-init.test.ts — the pre-paint drift meta-guard + no-flash ordering (item 005).
//
// The inline pre-paint <script> in index.html (02-design-tokens.md §6) cannot import preferences.ts
// (it is a static inline script), so it duplicates three literals verbatim: PREF_KEYS.theme,
// PREF_KEYS.density, and the density fallback DEFAULT_DENSITY. This test pins those three literals
// against the imported constants so the duplication cannot silently drift, and asserts the pre-paint
// attribute is stamped BEFORE the first stylesheet in the served shell (no-flash ordering).
//
// PROTECTED SET (exactly, per 02 §6): "pulse.web.theme", "pulse.web.density", "desk". This test does
// NOT assert the script's control flow, the dark/light computation, or the catch branch — those are
// declared non-goals (owned by the runtime resolver's tests, theme-runtime.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { PREF_KEYS, DEFAULT_DENSITY } from "../src/client/store/preferences.js";
import { injectEntryTags, ASSET_PREFIX, type ClientManifest } from "../src/server/assets.js";

const INDEX_HTML = readFileSync(
  join(import.meta.dir, "../src/client/index.html"),
  "utf8",
);

describe("pre-paint theme-init drift guard (item 005)", () => {
  test("the inline literals equal PREF_KEYS.theme / PREF_KEYS.density / DEFAULT_DENSITY", () => {
    // If any constant is renamed in store/preferences.ts, the hardcoded inline literal no longer
    // matches the imported value and this assertion fails — the drift guard.
    expect(INDEX_HTML).toContain(`"${PREF_KEYS.theme}"`);
    expect(INDEX_HTML).toContain(`"${PREF_KEYS.density}"`);
    expect(INDEX_HTML).toContain(`"${DEFAULT_DENSITY}"`);
  });

  test("no-flash ordering: the pre-paint attribute is set before the first stylesheet", () => {
    // The source index.html carries no <link rel="stylesheet"> — the server splices the entry CSS in
    // just before </head> (assets.ts injectEntryTags). Build the served shell and assert the pre-paint
    // stamp (the `.dark` class toggle) precedes the first injected stylesheet link.
    const manifest: ClientManifest = {
      buildId: "test",
      entries: {
        js: [`${ASSET_PREFIX}main.js`],
        css: [`${ASSET_PREFIX}main.css`],
      },
      chunks: [],
      chunkCss: {},
    };
    const shell = injectEntryTags(INDEX_HTML, manifest, { dev: false });

    const stampIndex = shell.indexOf('classList.toggle("dark"');
    const firstStylesheetIndex = shell.indexOf('rel="stylesheet"');

    expect(stampIndex).toBeGreaterThan(-1);
    expect(firstStylesheetIndex).toBeGreaterThan(-1);
    expect(stampIndex).toBeLessThan(firstStylesheetIndex);
  });
});
