// src/server/assets.ts — the built client-bundle loader (manifest-driven).
//
// The router serves the SPA shell and its content-hashed assets from `dist/client`, whose contents
// `scripts/build-client.ts` publishes together with a `manifest.json` describing entries + chunks.
// In production the manifest is read ONCE at boot (immutable, content-hashed names); in dev the
// mtime is checked on every `shell()` call and on `get()` misses, so a rebuild is picked up. When
// the manifest is absent, unparseable, or shape-invalid the loader falls back to today's directory
// scan (REQ-BUILD-04) so the server still boots and the operational routes work.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";

import { log } from "./log.js";
import { CSP_HASH_PATTERN, CSP_NONCE_META, inlineScriptHashes, type CspHash } from "./security-headers.js";

/** The manifest file name inside the client output directory. */
export const MANIFEST_FILENAME = "manifest.json" as const;

/** The public URL prefix every served client file lives under. */
export const ASSET_PREFIX = "/assets/" as const;

/**
 * Names of the markers the shell carries for the client. Deliberately duplicated in
 * `src/client/api/client.ts` because the client graph must not import from `src/server/**`; a test
 * pins the two copies as deep-equal.
 */
export const SHELL_MARKERS = {
  /** `<meta name="pulse-build-id" content="<buildId>">` — present whenever a manifest loaded. */
  buildIdMeta: "pulse-build-id",
  /** `<meta name="pulse-dev" content="1">` — present only under `{ dev: true }`. */
  devMeta: "pulse-dev",
  /** `<script type="application/json" id="pulse-chunk-css">` — the inert `chunkCss` island. */
  chunkCssIsland: "pulse-chunk-css",
  /** `<meta name="pulse-csp-nonce" nonce="<nonce>">` — the per-response CSP style nonce, stamped by
   *  the router on every shell response (read through the element's `.nonce` property). */
  cspNonceMeta: CSP_NONCE_META,
} as const;

/**
 * The client build manifest written to `<outdir>/manifest.json` by `buildClient` and read by
 * `loadStaticAssets`. Every path is a public asset path (`/assets/<basename>`), never a filesystem
 * path. Sourcemaps are never listed.
 */
export interface ClientManifest {
  /** 12-hex deterministic build id. */
  buildId: string;
  /** Entry-point outputs the shell injects. */
  entries: {
    /** JS entry points, injected as `<script type="module">` before `</body>`. */
    js: string[];
    /** Entry stylesheets, injected as `<link rel="stylesheet">` before `</head>`. */
    css: string[];
  };
  /** Every non-entry JS chunk and every non-entry CSS output. Served under `/assets/`, never
   *  injected by the shell. */
  chunks: string[];
  /** Lazily imported module key → chunk stylesheets that module owns. Optional so an older build
   *  without the field still parses; consumers treat absence as `{}`. */
  chunkCss?: Record<string, string[]>;
  /** CSP hash (`sha256-<base64>`) of each inline executable script in the shipped `index.html`,
   *  computed by `buildClient` from the file it publishes. The shell's `script-src` allows exactly
   *  these. Optional so an older build still parses; production then allows no inline script (dev hashes the served shell). */
  inlineScriptHashes?: string[];
}

/** One served static asset: its raw bytes and its content type. */
export interface StaticAsset {
  /** The asset bytes (an `ArrayBuffer` so it is a valid `BodyInit` under both DOM and Bun libs). */
  body: ArrayBuffer;
  /** The `content-type` header value. */
  contentType: string;
}

/** Why the loader fell back to directory-scan injection (REQ-BUILD-04). */
export type ManifestFallbackReason = "missing" | "unparseable" | "shape";

/** The loaded static client bundle — a per-request asset lookup + the SPA shell. */
export interface StaticAssets {
  /** Return the asset registered for a request pathname (`/assets/<name>`), or `undefined`. In dev
   *  mode a miss re-checks the manifest mtime once before returning `undefined`. */
  get(pathname: string): StaticAsset | undefined;
  /** The SPA shell HTML with entry tags injected. In dev mode the manifest mtime is checked on
   *  every call. */
  shell(): string;
  /** The manifest's `buildId`, or `null` in fallback mode. OPTIONAL so a plain literal (see
   *  `tests/routes.test.ts`) still satisfies the interface; the loader always implements it. */
  buildId?(): string | null;
  /** CSP hashes of the inline scripts in the shell `shell()` returns — the shell policy's
   *  `script-src` allows exactly these. OPTIONAL for the same reason as `buildId`; the router then
   *  allows no inline script. */
  inlineScriptHashes?(): readonly CspHash[];
  /** `shell()` and `inlineScriptHashes()` read from ONE loader snapshot, so a dev rebuild between
   *  the two reads can never pair a shell with another build's hashes. OPTIONAL like the others;
   *  the router falls back to the two separate reads. */
  shellDocument?(): ShellDocument;
}

/** A shell and the inline-script hashes its policy allows, from one loader snapshot. */
export interface ShellDocument {
  /** The composed shell HTML (as `shell()` returns it). */
  html: string;
  /** The hashes its CSP `script-src` allows (as `inlineScriptHashes()` returns them). */
  scriptHashes: readonly CspHash[];
}

/** Options for `loadStaticAssets`. */
export interface StaticAssetsOptions {
  /** `true`: re-read `manifest.json` when its mtime changes and stamp the dev meta into the shell.
   *  Default `false` (production: load once at boot, immutable). */
  dev?: boolean;
}

/** Content type by file extension (the small set the client bundle emits). */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** The absolute path of the built client tree, relative to this compiled module (dist/server/…). */
const DEFAULT_CLIENT_DIR = resolve(import.meta.dir, "..", "client");

/** A minimal fallback shell used when no built `index.html` is present. */
const FALLBACK_SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Pulse — Estate Overview</title></head>
<body><div id="app"></div></body></html>
`;

/** A manifest `buildId`: the build emits 12 hex chars; any short token-safe id is accepted, never
 *  markup (it is interpolated into the shell's build-id meta, where it is also attribute-escaped). */
export const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Escape a value for a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Plain (non-null, non-array) object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A `string[]` whose every element starts with `ASSET_PREFIX`. */
function isAssetPathArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((p) => typeof p === "string" && p.startsWith(ASSET_PREFIX));
}

/**
 * Structural validation of a manifest document. Returns `null` on any shape error and NEVER throws.
 * Accepts a missing `chunkCss` (older build) by defaulting it to `{}`. Enumerated in
 * `03-asset-injection.md §2` as rules R1–R8.
 */
export function parseClientManifest(text: string): ClientManifest | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null; // R1
  }
  if (!isRecord(doc)) return null; // R2
  if (typeof doc["buildId"] !== "string" || !BUILD_ID_PATTERN.test(doc["buildId"])) return null; // R3
  const entries = doc["entries"];
  if (!isRecord(entries)) return null; // R4
  if (!isAssetPathArray(entries["js"])) return null; // R5/R8
  if (!isAssetPathArray(entries["css"])) return null; // R5/R8
  if (!isAssetPathArray(doc["chunks"])) return null; // R6/R8

  const chunkCss: Record<string, string[]> = {};
  const raw = doc["chunkCss"];
  if (raw !== undefined) {
    if (!isRecord(raw)) return null; // R7
    for (const [key, value] of Object.entries(raw)) {
      if (!isAssetPathArray(value)) return null; // R7/R8
      chunkCss[key] = [...value];
    }
  }
  const hashes = doc["inlineScriptHashes"];
  if (
    hashes !== undefined &&
    !(Array.isArray(hashes) && hashes.every((h) => typeof h === "string" && CSP_HASH_PATTERN.test(h)))
  ) {
    return null; // R9
  }
  return {
    buildId: doc["buildId"],
    entries: { js: [...entries["js"]], css: [...entries["css"]] },
    chunks: [...doc["chunks"]],
    chunkCss,
    ...(hashes !== undefined ? { inlineScriptHashes: [...(hashes as string[])] } : {}),
  };
}

/**
 * The inline-script hashes the shell's policy allows.
 *
 * Production fails closed: the policy allows exactly the hashes `buildClient` recorded in the
 * manifest. The loader re-hashes the composed shell, and if the two differ (the shell was edited in
 * place after the build) it logs `assets_csp_hash_drift` at load and keeps the recorded hashes, so
 * the edited inline script is blocked rather than trusted. With no recorded hashes (an older build,
 * or directory-scan fallback) production allows no inline script.
 *
 * Development serves the hashes of the bytes it serves, so an `index.html` edit applies on rebuild
 * without a manifest round-trip, and logs the same drift line.
 */
function policyHashes(manifest: ClientManifest | null, shell: string, dev: boolean): CspHash[] {
  const served = inlineScriptHashes(shell);
  const recorded = manifest?.inlineScriptHashes as CspHash[] | undefined;
  const same =
    recorded !== undefined && recorded.length === served.length && recorded.every((h, i) => h === served[i]);
  if (!same) {
    log({
      event: "assets_csp_hash_drift",
      ok: false,
      recorded: recorded?.length ?? null,
      served: served.length,
      enforcing: dev ? "served" : "recorded",
    });
  }
  if (dev) return served;
  return recorded ?? [];
}

/**
 * Splice the built bundle's `<link rel="stylesheet">` / `<script type="module">` tags into the SPA
 * shell — stylesheets before `</head>`, module scripts before `</body>` (appended if that tag is
 * absent). Retained verbatim from the pre-manifest world as the REQ-BUILD-04 fallback path.
 */
function injectBundleTags(shell: string, scripts: string[], styles: string[]): string {
  const splice = (
    html: string,
    names: string[],
    render: (name: string) => string,
    anchors: string[],
  ): string => {
    const tags = [...names]
      .sort()
      .filter((name) => !html.includes(`/assets/${name}"`))
      .map(render)
      .join("");
    if (!tags) return html;
    const anchor = anchors.find((a) => html.includes(a));
    return anchor ? html.replace(anchor, `${tags}  ${anchor}`) : html + tags;
  };

  let out = shell;
  out = splice(out, styles, (name) => `    <link rel="stylesheet" href="/assets/${name}" />\n`, ["</head>", "</body>"]);
  out = splice(out, scripts, (name) => `    <script type="module" src="/assets/${name}"></script>\n`, ["</body>"]);
  return out;
}

/** Insert `tags` immediately before the first present anchor; if none present, append at end. */
function splice(html: string, tags: string, anchors: readonly string[]): string {
  if (!tags) return html;
  const anchor = anchors.find((a) => html.includes(a));
  return anchor !== undefined ? html.replace(anchor, `${tags}  ${anchor}`) : html + tags;
}

/**
 * Make a JSON document safe as a `<script>` element's text: neutralise the two byte sequences the
 * HTML tokenizer would otherwise treat as script-data breakers, while keeping the result valid JSON.
 */
function escapeJsonForScript(json: string): string {
  return json.replaceAll("</", "<\\/").replaceAll("<!--", "<\\u0021--");
}

/** A static ESM import of a sibling chunk in a built module, minified or not: `from"./x.js"`. */
const STATIC_CHUNK_IMPORT = /(?:\bfrom|\bimport)\s*["']\.\/([^"'/]+\.js)["']/g;

/**
 * Public paths of every chunk the entry scripts reach through static imports (not the entries
 * themselves, not dynamic `import()` targets), for `<link rel="modulepreload">`. The build splits
 * the initial route into many small chunks several import levels deep; without preloads the
 * browser finds each level only after parsing the one above.
 */
export function modulePreloadPaths(manifest: ClientManifest, readModule: (path: string) => string | null): string[] {
  const entries = new Set(manifest.entries.js);
  const seen = new Set<string>();
  const pending = [...manifest.entries.js];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readModule(path);
    if (text === null) continue;
    for (const match of text.matchAll(STATIC_CHUNK_IMPORT)) pending.push(`${ASSET_PREFIX}${match[1]}`);
  }
  return [...seen].filter((path) => !entries.has(path)).sort();
}

/**
 * Pure: splice the manifest's entry tags into `shell` (CSS before `</head>`, JS before `</body>`),
 * then the shell markers (build-id meta, `chunkCss` island, and dev meta under `opts.dev`). Emitted
 * order is manifest array order — no alphabetical sort. Idempotent via the quoted attribute test.
 */
export function injectEntryTags(
  shell: string,
  manifest: ClientManifest,
  opts: { dev: boolean; modulePreload?: readonly string[] },
): string {
  // CSS entry tags — skip a path already referenced in a full quoted-attribute form.
  const cssTags = manifest.entries.css
    .filter((path) => !shell.includes(`"${path}"`))
    .map((path) => `    <link rel="stylesheet" href="${path}" />\n`)
    .join("");

  // Module preloads for the chunks the entry imports statically, so the browser fetches them in
  // parallel instead of discovering them one import level at a time (modulePreloadPaths).
  const preloadTags = (opts.modulePreload ?? [])
    .filter((path) => !shell.includes(`"${path}"`))
    .map((path) => `    <link rel="modulepreload" href="${path}" />\n`)
    .join("");

  // Build-id meta — skip when the shell already has it.
  const buildIdTag = shell.includes(`name="${SHELL_MARKERS.buildIdMeta}"`)
    ? ""
    : `    <meta name="${SHELL_MARKERS.buildIdMeta}" content="${escapeAttribute(manifest.buildId)}">\n`;

  // Chunk-css island — skip when already present. Payload is `chunkCss` (`{}` when absent).
  const island = shell.includes(`id="${SHELL_MARKERS.chunkCssIsland}"`)
    ? ""
    : `    <script type="application/json" id="${SHELL_MARKERS.chunkCssIsland}">${escapeJsonForScript(
        JSON.stringify(manifest.chunkCss ?? {}),
      )}</script>\n`;

  // Dev meta — only in dev mode; skip when already present.
  const devTag =
    opts.dev && !shell.includes(`name="${SHELL_MARKERS.devMeta}"`)
      ? `    <meta name="${SHELL_MARKERS.devMeta}" content="1">\n`
      : "";

  const headBlock = `${cssTags}${preloadTags}${buildIdTag}${island}${devTag}`;

  // JS entry tags — skip a path already referenced.
  const jsTags = manifest.entries.js
    .filter((path) => !shell.includes(`"${path}"`))
    .map((path) => `    <script type="module" src="${path}"></script>\n`)
    .join("");

  let out = shell;
  out = splice(out, headBlock, ["</head>", "</body>"]);
  out = splice(out, jsTags, ["</body>"]);
  return out;
}

/** Everything one loader derives from a single read of `dir`. Replaced wholesale by `reload()`. */
interface LoaderState {
  /** The parsed manifest, or `null` in directory-scan fallback mode. */
  manifest: ClientManifest | null;
  /** `manifest.buildId`, or `null` in fallback mode. */
  buildId: string | null;
  /** Public path → asset; every regular file except `index.html` / `manifest.json`. */
  assets: Map<string, StaticAsset>;
  /** The fully composed shell HTML `shell()` returns. */
  shell: string;
  /** `statSync(<dir>/manifest.json).mtimeMs` at load time, or `null` when absent/unreadable. */
  mtimeMs: number | null;
  /** CSP hashes of the shell's inline scripts (see `policyHashes`). */
  scriptHashes: CspHash[];
}

/** Result of one manifest read attempt. */
type ManifestRead =
  | { ok: true; manifest: ClientManifest; mtimeMs: number }
  | { ok: false; reason: ManifestFallbackReason; mtimeMs: number | null };

function readManifest(dir: string): ManifestRead {
  const path = join(dir, MANIFEST_FILENAME);
  let mtimeMs: number;
  let text: string;
  try {
    mtimeMs = statSync(path).mtimeMs;
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "missing", mtimeMs: null };
  }
  try {
    JSON.parse(text);
  } catch {
    return { ok: false, reason: "unparseable", mtimeMs };
  }
  const manifest = parseClientManifest(text);
  return manifest === null
    ? { ok: false, reason: "shape", mtimeMs }
    : { ok: true, manifest, mtimeMs };
}

/**
 * Load the built client bundle from `dir` (default `dist/client`). Never throws.
 *
 * @param dir - The built client directory (test seam; default resolves to `dist/client`).
 * @param opts - Options bag; `dev: true` enables per-request manifest re-read and the dev meta.
 * @returns The in-memory `StaticAssets` handle the router serves from.
 */
export function loadStaticAssets(
  dir: string = DEFAULT_CLIENT_DIR,
  opts: StaticAssetsOptions = {},
): StaticAssets {
  let state: LoaderState = emptyState();
  let loggedFallback = false;

  const reload = (): void => {
    const read = readManifest(dir);
    const assets = new Map<string, StaticAsset>();
    let shellTemplate = FALLBACK_SHELL;
    let shellFromBuild = false;
    const scanScripts: string[] = [];
    const scanStyles: string[] = [];

    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        let bytes: Buffer;
        try {
          bytes = readFileSync(full);
        } catch {
          continue; // a directory entry or unreadable file — skip
        }
        if (name === "index.html") {
          shellTemplate = bytes.toString("utf8");
          shellFromBuild = true;
          continue;
        }
        if (name === MANIFEST_FILENAME) continue; // loader input, not a served asset
        const ext = extname(name).toLowerCase();
        const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
        const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        assets.set(`/assets/${name}`, { body, contentType });
        if (ext === ".js" || ext === ".mjs") scanScripts.push(name);
        else if (ext === ".css") scanStyles.push(name);
      }
    }

    let shellHtml: string;
    let buildId: string | null;
    let manifest: ClientManifest | null;
    let mtimeMs: number | null;

    if (read.ok) {
      manifest = read.manifest;
      buildId = manifest.buildId;
      mtimeMs = read.mtimeMs;
      const modulePreload = modulePreloadPaths(manifest, (path) => {
        const asset = assets.get(path);
        return asset === undefined ? null : new TextDecoder().decode(asset.body);
      });
      shellHtml = injectEntryTags(shellTemplate, manifest, { dev: opts.dev === true, modulePreload });
      log({
        event: "assets_manifest_loaded",
        ok: true,
        buildId,
        entries: manifest.entries.js.length + manifest.entries.css.length,
        chunks: manifest.chunks.length,
      });
    } else {
      manifest = null;
      buildId = null;
      mtimeMs = read.mtimeMs;
      shellHtml =
        shellFromBuild && (scanScripts.length || scanStyles.length)
          ? injectBundleTags(shellTemplate, scanScripts, scanStyles)
          : shellTemplate;
      if (!loggedFallback) {
        loggedFallback = true;
        log({ event: "assets_manifest_fallback", ok: false, reason: read.reason, dir });
      }
    }

    const scriptHashes = policyHashes(manifest, shellHtml, opts.dev === true);
    state = { manifest, buildId, assets, shell: shellHtml, mtimeMs, scriptHashes };
  };

  const checkForReload = (): void => {
    if (opts.dev !== true) return;
    let mtimeMs: number | null;
    try {
      mtimeMs = statSync(join(dir, MANIFEST_FILENAME)).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    if (mtimeMs !== state.mtimeMs) reload();
  };

  reload();

  return {
    get(pathname) {
      const hit = state.assets.get(pathname);
      if (hit !== undefined) return hit;
      if (opts.dev !== true) return undefined;
      checkForReload();
      return state.assets.get(pathname);
    },
    shell() {
      checkForReload();
      return state.shell;
    },
    buildId() {
      return state.buildId;
    },
    inlineScriptHashes() {
      checkForReload();
      return state.scriptHashes;
    },
    shellDocument() {
      checkForReload();
      const snapshot = state; // one read: `reload()` replaces `state` wholesale
      return { html: snapshot.shell, scriptHashes: snapshot.scriptHashes };
    },
  };
}

/** An empty starting state so the first `reload()` has something to replace. */
function emptyState(): LoaderState {
  return {
    manifest: null,
    buildId: null,
    assets: new Map(),
    shell: FALLBACK_SHELL,
    mtimeMs: null,
    scriptHashes: [],
  };
}
