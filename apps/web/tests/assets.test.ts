// apps/web/tests/assets.test.ts — the built client-bundle loader (src/server/assets.ts).
//
// Covers manifest-driven injection (REQ-BUILD-03/09), fallback (REQ-BUILD-04), dev re-read
// (REQ-BUILD-05), the chunkCss island (V-022), and parity with the existing directory-scan tests.

import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  loadStaticAssets,
  injectEntryTags,
  modulePreloadPaths,
  parseClientManifest,
  MANIFEST_FILENAME,
  SHELL_MARKERS,
  ASSET_PREFIX,
  type ClientManifest,
} from "../src/server/assets.js";

const BARE_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Pulse — Estate Overview</title>
  </head>
  <body>
    <!-- SPA mount point; the built client bundle (content-hashed) is injected by the server shell. -->
    <div id="app"></div>
  </body>
</html>
`;

const tmpDirs: string[] = [];

/** Make a throwaway dist/client dir seeded with `files` (name → contents). */
function buildDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-assets-"));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/** Serialise a manifest to the file's JSON. */
function writeManifest(dir: string, m: ClientManifest): void {
  writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(m, null, 2));
}

/** Bump a file's mtime so dev re-read fires deterministically (avoids race on same-second writes). */
function bumpMtime(path: string, seconds: number): void {
  const now = Date.now() / 1000 + seconds;
  utimesSync(path, now, now);
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ── manifest path: injectEntryTags + loadStaticAssets ──────────────────────────────────────────

describe("manifest path — loadStaticAssets injects the manifest's entries", () => {
  test("injects entry JS before </body> and entry CSS before </head>; stamps build-id meta and island", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-a5qb8458.js": "console.log('app')",
      "main-xak0e6gh.css": ".x{}",
    });
    writeManifest(dir, {
      buildId: "3f9c2a1b7e40",
      entries: {
        js: [`${ASSET_PREFIX}main-a5qb8458.js`],
        css: [`${ASSET_PREFIX}main-xak0e6gh.css`],
      },
      chunks: [],
      chunkCss: {},
    });

    const assets = loadStaticAssets(dir);
    const shell = assets.shell();

    expect(shell).toContain('<script type="module" src="/assets/main-a5qb8458.js"></script>');
    expect(shell).toContain('<link rel="stylesheet" href="/assets/main-xak0e6gh.css" />');
    expect(shell).toContain(`<meta name="${SHELL_MARKERS.buildIdMeta}" content="3f9c2a1b7e40">`);
    expect(shell).toContain(`id="${SHELL_MARKERS.chunkCssIsland}"`);
    expect(shell.indexOf("main-xak0e6gh.css")).toBeLessThan(shell.indexOf("</head>"));
    expect(shell.indexOf("main-a5qb8458.js")).toBeGreaterThan(shell.indexOf("</head>"));
    expect(shell.indexOf("main-a5qb8458.js")).toBeLessThan(shell.indexOf("</body>"));
    expect(assets.buildId?.()).toBe("3f9c2a1b7e40");
    // The manifest file itself is not served as an asset.
    expect(assets.get(`/assets/${MANIFEST_FILENAME}`)).toBeUndefined();
    // The dev meta is NOT stamped in production mode.
    expect(shell).not.toContain(`name="${SHELL_MARKERS.devMeta}"`);
  });

  test("REQ-BUILD-09 (chunk-present): a chunk in the manifest is served but NOT injected as a tag", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-a5qb8458.js": "x",
      "main-xak0e6gh.css": "x",
      "chunk-k6hfrknt.js": "x",
    });
    writeManifest(dir, {
      buildId: "aaaaaaaaaaaa",
      entries: {
        js: [`${ASSET_PREFIX}main-a5qb8458.js`],
        css: [`${ASSET_PREFIX}main-xak0e6gh.css`],
      },
      chunks: [`${ASSET_PREFIX}chunk-k6hfrknt.js`],
      chunkCss: {},
    });

    const assets = loadStaticAssets(dir);
    const shell = assets.shell();

    // Chunk is served under /assets/…
    expect(assets.get(`${ASSET_PREFIX}chunk-k6hfrknt.js`)).toBeDefined();
    // …but never appears as an injected <script src> or <link href>.
    expect(shell).not.toContain('src="/assets/chunk-k6hfrknt.js"');
    expect(shell).not.toContain('href="/assets/chunk-k6hfrknt.js"');
  });

  test("V-022 (island is inert data): chunkCss values appear only inside the JSON island, never as tags", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-a5qb8458.js": "x",
      "main-xak0e6gh.css": "x",
      "chunk-cxrrqzbx.css": ".y{}",
    });
    writeManifest(dir, {
      buildId: "bbbbbbbbbbbb",
      entries: {
        js: [`${ASSET_PREFIX}main-a5qb8458.js`],
        css: [`${ASSET_PREFIX}main-xak0e6gh.css`],
      },
      chunks: [`${ASSET_PREFIX}chunk-cxrrqzbx.css`],
      chunkCss: { "views/alerts/view": [`${ASSET_PREFIX}chunk-cxrrqzbx.css`] },
    });

    const shell = loadStaticAssets(dir).shell();

    // Not stamped as a <link rel="stylesheet"> tag nor a <script src>.
    expect(shell).not.toContain('<link rel="stylesheet" href="/assets/chunk-cxrrqzbx.css"');
    expect(shell).not.toContain('src="/assets/chunk-cxrrqzbx.css"');
    // No fetch is generated by the loader itself (server never issues a client fetch).
    // The path DOES appear once — inside the inert JSON island.
    const islandStart = shell.indexOf(`id="${SHELL_MARKERS.chunkCssIsland}"`);
    expect(islandStart).toBeGreaterThan(-1);
    expect(shell).toContain(`/assets/chunk-cxrrqzbx.css`);
    // Every occurrence of the chunk path in the shell is inside the island — never in a src/href.
    const occ = shell.split("/assets/chunk-cxrrqzbx.css").length - 1;
    expect(occ).toBe(1);
  });

  test("dev mode stamps the pulse-dev meta; production does not", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-a.js": "x",
      "main-a.css": "x",
    });
    writeManifest(dir, {
      buildId: "cccccccccccc",
      entries: { js: [`${ASSET_PREFIX}main-a.js`], css: [`${ASSET_PREFIX}main-a.css`] },
      chunks: [],
      chunkCss: {},
    });

    const prod = loadStaticAssets(dir).shell();
    const dev = loadStaticAssets(dir, { dev: true }).shell();

    expect(prod).not.toContain(`name="${SHELL_MARKERS.devMeta}"`);
    expect(dev).toContain(`<meta name="${SHELL_MARKERS.devMeta}" content="1">`);
  });
});

// ── fallback (REQ-BUILD-04) ───────────────────────────────────────────────────────────────────

describe("fallback path — manifest missing / unparseable / wrong shape", () => {
  test("no manifest → directory-scan shell, buildId() === null, no island, no meta", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-a5qb8458.js": "console.log('app')",
      "main-xak0e6gh.css": ".x{}",
    });

    const assets = loadStaticAssets(dir);
    const shell = assets.shell();

    expect(assets.buildId?.()).toBeNull();
    expect(shell).toContain('<script type="module" src="/assets/main-a5qb8458.js"></script>');
    expect(shell).toContain('<link rel="stylesheet" href="/assets/main-xak0e6gh.css" />');
    expect(shell).not.toContain(`name="${SHELL_MARKERS.buildIdMeta}"`);
    expect(shell).not.toContain(`id="${SHELL_MARKERS.chunkCssIsland}"`);
  });

  test("unparseable manifest → directory-scan fallback (no throw); shell still boots", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-a.js": "x",
      "main-a.css": "x",
      [MANIFEST_FILENAME]: "{ not valid json",
    });

    const assets = loadStaticAssets(dir);
    expect(assets.buildId?.()).toBeNull();
    expect(assets.shell()).toContain('src="/assets/main-a.js"');
  });

  test("wrong-shape manifest (chunks not string[]) → directory-scan fallback", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-a.js": "x",
      [MANIFEST_FILENAME]: JSON.stringify({
        buildId: "x",
        entries: { js: [`${ASSET_PREFIX}main-a.js`], css: [] },
        chunks: "not-an-array",
      }),
    });

    const assets = loadStaticAssets(dir);
    expect(assets.buildId?.()).toBeNull();
    expect(assets.shell()).toContain('src="/assets/main-a.js"');
  });
});

// ── dev re-read (REQ-BUILD-05) ─────────────────────────────────────────────────────────────────

describe("dev re-read — manifest changes between two shell() calls", () => {
  test("rewriting manifest.json changes the injected tags and buildId()", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-old.js": "x",
      "main-old.css": "x",
      "main-new.js": "y",
      "main-new.css": "y",
    });
    writeManifest(dir, {
      buildId: "1111aaaa1111",
      entries: { js: [`${ASSET_PREFIX}main-old.js`], css: [`${ASSET_PREFIX}main-old.css`] },
      chunks: [],
      chunkCss: {},
    });
    // Fix an initial mtime so the bump below is guaranteed different.
    bumpMtime(join(dir, MANIFEST_FILENAME), -60);

    const assets = loadStaticAssets(dir, { dev: true });
    const first = assets.shell();
    expect(first).toContain('src="/assets/main-old.js"');
    expect(assets.buildId?.()).toBe("1111aaaa1111");

    // Publish a new manifest, ensure mtime differs, then call shell() again.
    writeManifest(dir, {
      buildId: "2222bbbb2222",
      entries: { js: [`${ASSET_PREFIX}main-new.js`], css: [`${ASSET_PREFIX}main-new.css`] },
      chunks: [],
      chunkCss: {},
    });
    bumpMtime(join(dir, MANIFEST_FILENAME), 0);

    const second = assets.shell();
    expect(second).toContain('src="/assets/main-new.js"');
    expect(second).not.toContain('src="/assets/main-old.js"');
    expect(assets.buildId?.()).toBe("2222bbbb2222");
  });

  test("production loader does NOT re-read the manifest between calls", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-old.js": "x",
      "main-old.css": "x",
      "main-new.js": "y",
      "main-new.css": "y",
    });
    writeManifest(dir, {
      buildId: "1111aaaa1111",
      entries: { js: [`${ASSET_PREFIX}main-old.js`], css: [`${ASSET_PREFIX}main-old.css`] },
      chunks: [],
      chunkCss: {},
    });

    const assets = loadStaticAssets(dir); // production
    const first = assets.shell();
    expect(first).toContain('src="/assets/main-old.js"');

    writeManifest(dir, {
      buildId: "2222bbbb2222",
      entries: { js: [`${ASSET_PREFIX}main-new.js`], css: [`${ASSET_PREFIX}main-new.css`] },
      chunks: [],
      chunkCss: {},
    });
    bumpMtime(join(dir, MANIFEST_FILENAME), 60);

    expect(assets.shell()).toContain('src="/assets/main-old.js"'); // unchanged in prod
    expect(assets.buildId?.()).toBe("1111aaaa1111");
  });
});

// ── directory scan (regression coverage retained) ─────────────────────────────────────────────

describe("directory-scan fallback — legacy behaviours retained", () => {
  test("no built dir → fallback shell, no bundle reference, no assets", () => {
    const assets = loadStaticAssets(join(tmpdir(), "pulse-assets-does-not-exist-xyz"));
    expect(assets.shell()).toContain('<div id="app">');
    expect(assets.shell()).not.toContain("/assets/");
    expect(assets.get("/assets/anything.js")).toBeUndefined();
    expect(assets.buildId?.()).toBeNull();
  });

  test("built dir but no bundle files → shell served unchanged (no empty tags injected)", () => {
    const dir = buildDir({ "index.html": BARE_SHELL });
    expect(loadStaticAssets(dir).shell()).not.toContain("/assets/");
  });

  test("a .map is served but NOT injected", () => {
    const dir = buildDir({
      "index.html": BARE_SHELL,
      "main-a.js": "x",
      "main-a.js.map": "{}",
    });
    const assets = loadStaticAssets(dir);
    expect(assets.get("/assets/main-a.js.map")).toBeDefined();
    expect(assets.shell()).not.toContain("main-a.js.map");
  });

  test("template pre-referencing only .map still gets .js injected (regression #36)", () => {
    const preRef = BARE_SHELL.replace(
      "</body>",
      '  <link rel="preload" as="fetch" href="/assets/main-a5qb8458.js.map" />\n  </body>',
    );
    const dir = buildDir({
      "index.html": preRef,
      "main-a5qb8458.js": "x",
      "main-a5qb8458.js.map": "{}",
    });
    const shell = loadStaticAssets(dir).shell();
    expect(shell).toContain('<script type="module" src="/assets/main-a5qb8458.js"></script>');
  });
});

// ── parseClientManifest + injectEntryTags direct coverage ─────────────────────────────────────

describe("parseClientManifest — rejects shape errors, never throws", () => {
  test("returns null on non-JSON (R1) and on wrong root (R2)", () => {
    expect(parseClientManifest("not json")).toBeNull();
    expect(parseClientManifest("[]")).toBeNull();
    expect(parseClientManifest("null")).toBeNull();
  });

  test("returns null on missing/typed-wrong fields (R3–R6)", () => {
    expect(parseClientManifest("{}")).toBeNull();
    expect(
      parseClientManifest(JSON.stringify({ buildId: "x", entries: "no", chunks: [] })),
    ).toBeNull();
    expect(
      parseClientManifest(
        JSON.stringify({ buildId: "x", entries: { js: [`${ASSET_PREFIX}m.js`], css: [] }, chunks: "no" }),
      ),
    ).toBeNull();
  });

  test("returns null when any listed path lacks the /assets/ prefix (R8)", () => {
    expect(
      parseClientManifest(
        JSON.stringify({
          buildId: "x",
          entries: { js: ["/bad/main.js"], css: [] },
          chunks: [],
        }),
      ),
    ).toBeNull();
  });

  test("accepts a manifest lacking chunkCss and defaults it to {}", () => {
    const m = parseClientManifest(
      JSON.stringify({
        buildId: "y",
        entries: { js: [`${ASSET_PREFIX}m.js`], css: [`${ASSET_PREFIX}m.css`] },
        chunks: [],
      }),
    );
    expect(m).not.toBeNull();
    expect(m!.chunkCss).toEqual({});
  });
});

describe("injectEntryTags — pure splice with SHELL_MARKERS", () => {
  test("emits tags in manifest order, not alphabetical", () => {
    const manifest: ClientManifest = {
      buildId: "z",
      entries: {
        js: [`${ASSET_PREFIX}b.js`, `${ASSET_PREFIX}a.js`],
        css: [`${ASSET_PREFIX}b.css`, `${ASSET_PREFIX}a.css`],
      },
      chunks: [],
      chunkCss: {},
    };
    const out = injectEntryTags(BARE_SHELL, manifest, { dev: false });
    // Manifest order: b before a — not alphabetical.
    expect(out.indexOf("b.js")).toBeLessThan(out.indexOf("a.js"));
    expect(out.indexOf("b.css")).toBeLessThan(out.indexOf("a.css"));
  });

  test("island payload is JSON-safe: `</` sequences are escaped", () => {
    // A key that would otherwise close the <script> if unescaped.
    const manifest: ClientManifest = {
      buildId: "w",
      entries: { js: [`${ASSET_PREFIX}m.js`], css: [] },
      chunks: [],
      chunkCss: { "views/</script>-oddity/view": [] },
    };
    const out = injectEntryTags(BARE_SHELL, manifest, { dev: false });
    // The raw </script sequence must not appear inside the island's text content.
    const islandStart = out.indexOf(`id="${SHELL_MARKERS.chunkCssIsland}"`);
    const bodyStart = out.indexOf(">", islandStart) + 1;
    const bodyEnd = out.indexOf("</script>", bodyStart);
    const body = out.slice(bodyStart, bodyEnd);
    expect(body.includes("</")).toBe(false);
    // …but the escaped form parses back to the original key.
    const parsed = JSON.parse(body) as Record<string, string[]>;
    expect(parsed["views/</script>-oddity/view"]).toEqual([]);
  });
});

describe("modulepreload for the initial route's static imports", () => {
  const manifest: ClientManifest = {
    buildId: "p",
    entries: { js: [`${ASSET_PREFIX}main.js`], css: [] },
    chunks: [`${ASSET_PREFIX}a.js`, `${ASSET_PREFIX}b.js`, `${ASSET_PREFIX}lazy.js`, `${ASSET_PREFIX}deep.js`],
    chunkCss: {},
  };
  const modules: Record<string, string> = {
    [`${ASSET_PREFIX}main.js`]: 'import{a}from"./a.js";import"./b.js";const v=()=>import("./lazy.js");',
    [`${ASSET_PREFIX}a.js`]: 'import { d } from "./deep.js";',
    [`${ASSET_PREFIX}b.js`]: 'import{a}from"./a.js";',
    [`${ASSET_PREFIX}lazy.js`]: 'import"./deep.js";',
    [`${ASSET_PREFIX}deep.js`]: "export const d=1;",
  };

  test("modulePreloadPaths walks static imports from the entries, not dynamic ones or the entries", () => {
    expect(modulePreloadPaths(manifest, (p) => modules[p] ?? null)).toEqual([
      `${ASSET_PREFIX}a.js`,
      `${ASSET_PREFIX}b.js`,
      `${ASSET_PREFIX}deep.js`,
    ]);
  });

  test("injectEntryTags emits a modulepreload link per path in <head>, before the entry script", () => {
    const out = injectEntryTags(BARE_SHELL, manifest, { dev: false, modulePreload: [`${ASSET_PREFIX}a.js`] });
    const link = out.indexOf(`<link rel="modulepreload" href="${ASSET_PREFIX}a.js" />`);
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(out.indexOf("</head>"));
    expect(injectEntryTags(BARE_SHELL, manifest, { dev: false })).not.toContain("modulepreload");
  });

  test("loadStaticAssets preloads the built entry's static imports in the served shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-assets-preload-"));
    try {
      writeFileSync(join(dir, "index.html"), BARE_SHELL);
      for (const [path, text] of Object.entries(modules)) writeFileSync(join(dir, path.slice(ASSET_PREFIX.length)), text);
      writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(manifest));
      const shell = loadStaticAssets(dir).shell();
      expect(shell).toContain(`<link rel="modulepreload" href="${ASSET_PREFIX}deep.js" />`);
      expect(shell).not.toContain(`modulepreload" href="${ASSET_PREFIX}lazy.js"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
