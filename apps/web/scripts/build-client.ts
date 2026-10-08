// apps/web/scripts/build-client.ts — the single Bun.build driver for the client (CON-02).
//
// Exposes buildClient (library) and a CLI mode used by tests + the dev supervisor. It classifies
// Bun's metafile outputs into the REQ-BUILD-02 manifest shape, checks the invariants BEFORE writing
// anything, and publishes manifest.json atomically (writeFileSync + renameSync — REQ-CONC-02).
//
// Architecture: docs/architecture/web-foundation/.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { BunPlugin } from "bun";
import tailwind from "bun-plugin-tailwind";

import type { ClientManifest } from "../src/server/assets.js";
import { ASSET_PREFIX, MANIFEST_FILENAME } from "../src/server/assets.js";

/** Length of the hex build id (first 12 hex chars of SHA-256). */
export const BUILD_ID_HEX_LEN = 12 as const;

/** Bun's metafile document — re-exported so tests and budget code name one type. */
export type BuildMetafile = NonNullable<Awaited<ReturnType<typeof Bun.build>>["metafile"]>;

/** Options for one client build (REQ-BUILD-01/06/07, REQ-DEV-02/03). */
export interface ClientBuildOptions {
  outdir: string;
  minify: boolean;
  sourcemap: "linked" | "external" | "none";
  clean: boolean;
  entry?: string;
}

/** Discriminated outcome — buildClient never throws. */
export type ClientBuildResult =
  | { ok: true; manifest: ClientManifest; metafile: BuildMetafile; durationMs: number }
  | { ok: false; errors: readonly string[]; durationMs: number };

/** Default client entry — resolved relative to this script so cwd is free. */
const DEFAULT_CLIENT_ENTRY = resolve(import.meta.dir, "../src/client/main.tsx");

/** Bun output-name templates. Hashed in every mode. */
const BUILD_NAMING = {
  entry: "[dir]/[name]-[hash].[ext]",
  chunk: "chunk-[name]-[hash].[ext]",
  asset: "[name]-[hash].[ext]",
} as const;

/** Anchor points scanned when rendering Bun's diagnostics — pure formatting. */
function renderBuildMessage(message: unknown): string {
  if (!message || typeof message !== "object") return String(message);
  const m = message as {
    level?: string;
    message?: string;
    position?: {
      file?: string;
      line?: number;
      column?: number;
      lineText?: string;
    } | null;
  };
  const level = m.level ?? "error";
  const text = m.message ?? String(message);
  const parts: string[] = [`${level}: ${text}`];
  if (m.position) {
    const { file, line, column, lineText } = m.position;
    if (file && typeof line === "number") {
      parts.push(`  at ${file}:${line}${typeof column === "number" ? `:${column}` : ""}`);
    }
    if (lineText) parts.push(`    ${lineText}`);
  }
  return parts.join("\n");
}

/**
 * Deterministic build id — the first BUILD_ID_HEX_LEN hex chars of SHA-256 over the sorted output
 * basenames joined by "\n". .map files are excluded so toggling sourcemap does not change the id.
 */
export function computeBuildId(outputPaths: readonly string[]): string {
  const names = outputPaths
    .map((p) => basename(p))
    .filter((name) => !name.endsWith(".map"))
    .sort();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(names.join("\n"));
  return hasher.digest("hex").slice(0, BUILD_ID_HEX_LEN);
}

/** Namespace of the shim modules that stand in for tagged lazy entries (chunkTagPlugin). */
const CHUNK_ENTRY_NAMESPACE = "pulse-chunk-entry";

/** Extension of a shim's path, replacing the module's own (`view.page.tsx` → `view.page.pulse-chunk`). */
const CHUNK_ENTRY_EXT = ".pulse-chunk";

/** Namespace of the virtual stylesheets that tag a lazy chunk's CSS (chunkTagPlugin). */
const CHUNK_TAG_NAMESPACE = "pulse-chunk-tag";

/** Derive the chunkCss map key for a chunk stylesheet — its entryPoint made relative to
 *  the client root with POSIX separators and the extension removed. Preserves leading `../`
 *  segments for a stylesheet whose entry lives outside the client root — still unique. */
function chunkCssKey(entryPoint: string, clientRoot: string): string {
  const relPath = relative(clientRoot, resolve(entryPoint));
  const posix = relPath.split(sep).join("/");
  const ext = extname(posix);
  return ext ? posix.slice(0, -ext.length) : posix;
}

/** Bun's `[name]` for a module: its basename without the extension. */
function chunkName(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** A lazy entry that needs a chunk tag: its chunkCss key and whether it has a default export. */
interface TaggedEntry {
  key: string;
  hasDefault: boolean;
}

/**
 * Lazy-chunk entries (dynamic `import()` targets under the client root) that share Bun's `[name]`
 * with another lazy entry, keyed by absolute path.
 *
 * Chunk stylesheets are named `chunk-[name]-[hash]` with a content hash, and Bun copies a lazy
 * child's CSS into every ancestor's bundle (uPlot's sheet rides `views/<id>/view` as well as its own
 * chunk). Two `view` chunks whose CSS is the same — e.g. both hold only uPlot's — would get the same
 * output path, and Bun.build fails with "Multiple files share the same output path". `[dir]` keeps
 * names unique but nests outputs, so these entries get a per-chunk tag instead.
 */
function collidingLazyEntries(clientRoot: string): Map<string, TaggedEntry> {
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  // Unreadable or unparsable files are skipped: Bun.build reports them itself, and buildClient
  // must return its diagnostics rather than throw (a half-edited file under the dev watcher).
  const scan = (file: string, onlyIfDynamic: boolean): ReturnType<Bun.Transpiler["scan"]> | null => {
    try {
      const source = readFileSync(file, "utf8");
      if (onlyIfDynamic && !source.includes("import(")) return null;
      return transpilers[/\.[jt]sx$/.test(file) ? "tsx" : "ts"].scan(source);
    } catch {
      return null;
    }
  };
  const byName = new Map<string, Set<string>>();
  for (const rel of new Bun.Glob("**/*.{ts,tsx}").scanSync(clientRoot)) {
    const file = resolve(clientRoot, rel);
    for (const imp of scan(file, true)?.imports ?? []) {
      if (imp.kind !== "dynamic-import") continue;
      let target: string;
      try {
        target = Bun.resolveSync(imp.path, dirname(file));
      } catch {
        continue;
      }
      if (relative(clientRoot, target).startsWith("..")) continue;
      const name = chunkName(target);
      const targets = byName.get(name) ?? new Set<string>();
      targets.add(target);
      byName.set(name, targets);
    }
  }
  const tagged = new Map<string, TaggedEntry>();
  for (const targets of byName.values()) {
    if (targets.size < 2) continue;
    for (const target of targets) {
      const scanned = scan(target, false);
      if (scanned === null) continue;
      tagged.set(target, { key: chunkCssKey(target, clientRoot), hasDefault: scanned.exports.includes("default") });
    }
  }
  return tagged;
}

/** Path of the shim that stands in for a tagged lazy entry. */
function shimPath(path: string): string {
  return `${path.slice(0, -extname(path).length)}${CHUNK_ENTRY_EXT}`;
}

/** Report a tagged entry's outputs under the module its shim stands in for, in Bun's cwd-relative
 *  form, so the shim stays internal to the build (chunkCss keys, metafile consumers). */
function unshimEntryPoints(metafile: BuildMetafile, tagged: ReadonlyMap<string, TaggedEntry>): BuildMetafile {
  const modules = new Map(
    [...tagged.keys()].map((path) => [
      `${CHUNK_ENTRY_NAMESPACE}:${shimPath(path)}`,
      relative(process.cwd(), path).split(sep).join("/"),
    ]),
  );
  const outputs = Object.fromEntries(
    Object.entries(metafile.outputs).map(([key, rec]) => {
      const original = rec.entryPoint === undefined ? undefined : modules.get(rec.entryPoint);
      return [key, original === undefined ? rec : { ...rec, entryPoint: original }];
    }),
  );
  return { ...metafile, outputs };
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Give each tagged lazy entry a unique chunk stylesheet. Its `import()` resolves to a shim at the
 * module's path with its extension swapped for `.pulse-chunk` — the same `[name]` and chunkCss key
 * (both strip one extension), but a distinct module (Bun identifies modules by path across
 * namespaces) — that imports a one-comment stylesheet,
 * `/*! chunk <key> *\/` (kept by the minifier), and re-exports the untouched module. The module
 * itself is never rewritten: a module whose contents come from an `onLoad` skips Tailwind's
 * candidate scan. A chunk whose stylesheet is only its tag is dropped after the build.
 */
function chunkTagPlugin(tagged: ReadonlyMap<string, TaggedEntry>): BunPlugin {
  return {
    name: "pulse-chunk-tag",
    setup(build) {
      if (tagged.size === 0) return;
      const shims = new Map([...tagged].map(([path, entry]) => [shimPath(path), { path, ...entry }]));
      const names = [...new Set([...tagged.keys()].map(chunkName))].map(escapeRegExp);
      const specifier = new RegExp(`(?:^|/)(?:${names.join("|")})(?:\\.[cm]?[jt]sx?)?$`);
      build.onResolve({ filter: specifier }, (args) => {
        if (args.kind !== "dynamic-import" || args.namespace !== "file") return undefined;
        let target: string;
        try {
          target = Bun.resolveSync(args.path, args.resolveDir);
        } catch {
          return undefined;
        }
        if (!tagged.has(target)) return undefined;
        return { path: shimPath(target), namespace: CHUNK_ENTRY_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: CHUNK_ENTRY_NAMESPACE }, (args) => {
        const entry = shims.get(args.path)!;
        const original = JSON.stringify(entry.path);
        const lines = [`import "${CHUNK_TAG_NAMESPACE}:${entry.key}";`, `export * from ${original};`];
        if (entry.hasDefault) lines.push(`export { default } from ${original};`);
        return { contents: `${lines.join("\n")}\n`, loader: "js" };
      });
      build.onResolve({ filter: new RegExp(`^${CHUNK_TAG_NAMESPACE}:`) }, (args) => ({
        path: args.path.slice(CHUNK_TAG_NAMESPACE.length + 1),
        namespace: CHUNK_TAG_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: CHUNK_TAG_NAMESPACE }, (args) => ({
        contents: `/*! chunk ${args.path} */\n`,
        loader: "css",
      }));
    },
  };
}

// ─── Barrel imports ──────────────────────────────────────────────────────────────────────────────
//
// Bun.build tree-shakes a barrel whose package declares `"sideEffects"`, but it assigns modules to
// chunks by reachability: every module a barrel re-exports counts as used by every chunk that
// imports the barrel. Through the `@/ui` barrel, all library modules shared one lazy chunk, so a
// view's first load carried the data table, Radix Select and the rest whether it used them or not
// (measured: ~46 KB gz unused on the overview's first load). Through the `lucide-react` barrel,
// every curated icon rode the initial route with the shell's handful. barrelImportPlugin rewrites
// named imports of these barrels into imports of the modules that own each name, at build time, so
// the source keeps one import site per barrel and each chunk reaches only what it imports.

/** Where a barrel export lives: the module to import it from, and its name there. */
export interface BarrelOwner {
  module: string;
  imported: string;
}

/** A barrel the build rewrites, and which client modules it rewrites it in. */
interface RewrittenBarrel {
  specifier: string;
  owners: ReadonlyMap<string, BarrelOwner>;
  /** Whether a module (absolute path) gets this barrel's imports rewritten. */
  appliesTo: (file: string) => boolean;
}

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** Resolve a barrel-relative module (`./patterns/icon`) to its file. */
function barrelModuleFile(dir: string, rel: string): string {
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const file = resolve(dir, `${rel}${ext}`);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  throw new Error(`barrel: cannot resolve ${rel} from ${dir}`);
}

/** A module that re-exports from relative modules (a barrel, possibly nested in another). */
const RELATIVE_REEXPORT = /\bexport\s+(?:\*|(?:type\s+)?\{[^}]*\})\s*from\s*["']\./;

/**
 * Map every value a barrel file exports to the module that owns it. Understands the two re-export
 * forms barrels use, `export * from "./x"` (the module's own value exports, read with Bun's
 * scanner) and `export { a, b as c, type T } from "./x"`; type-only exports are skipped (they are
 * imported with `type`, which the bundler erases). An `export *` of a module that is itself a
 * barrel (`ui/status/index.ts`) is followed, so its names map to the modules that own them, not to
 * the nested barrel. `moduleSpecifier` names the owning module (by absolute path) in the rewritten
 * import; it must not leak the build machine's paths into the bundle.
 */
export function barrelOwners(barrelFile: string, moduleSpecifier: (file: string) => string): Map<string, BarrelOwner> {
  const scanner = new Bun.Transpiler({ loader: "tsx" });
  const owned = (file: string, seen: ReadonlySet<string>): Map<string, { file: string; imported: string }> => {
    const dir = dirname(file);
    const text = readFileSync(file, "utf8");
    const source = text.replace(COMMENTS, "");
    const owners = new Map<string, { file: string; imported: string }>();
    for (const [, rel] of source.matchAll(/\bexport\s+\*\s+from\s+["'](\.[^"']+)["']/g)) {
      const target = barrelModuleFile(dir, rel!);
      if (seen.has(target)) continue;
      const targetText = readFileSync(target, "utf8");
      if (RELATIVE_REEXPORT.test(targetText.replace(COMMENTS, ""))) {
        for (const [name, owner] of owned(target, new Set([...seen, target]))) owners.set(name, owner);
      } else {
        for (const name of scanner.scan(targetText).exports) owners.set(name, { file: target, imported: name });
      }
    }
    for (const [, typeOnly, names, rel] of source.matchAll(/\bexport\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      if (typeOnly || !rel!.startsWith(".")) continue;
      const target = barrelModuleFile(dir, rel!);
      for (const raw of names!.split(",")) {
        const spec = raw.trim();
        if (spec === "" || spec.startsWith("type ")) continue;
        const [imported, exported = imported] = spec.split(/\s+as\s+/).map((s) => s.trim());
        owners.set(exported!, { file: target, imported: imported! });
      }
    }
    // A nested barrel's own declarations (the top-level barrel is all re-exports).
    if (seen.size > 1) {
      for (const name of scanner.scan(text).exports) if (!owners.has(name)) owners.set(name, { file, imported: name });
    }
    return owners;
  };
  const result = new Map<string, BarrelOwner>();
  for (const [name, { file, imported }] of owned(barrelFile, new Set([barrelFile]))) {
    result.set(name, { module: moduleSpecifier(file), imported });
  }
  return result;
}

/**
 * Rewrite a module's `import { … } from "<specifier>"` statements into imports from the modules
 * that own each name, keeping the line count (sourcemaps stay aligned). `type` specifiers and
 * `import type` statements are dropped. Throws on a value the barrel does not export, and on any
 * other form of reference to the barrel (namespace, default, side-effect, re-export, dynamic), so
 * nothing falls back to the barrel silently.
 */
export function rewriteBarrelImports(
  source: string,
  specifier: string,
  owners: ReadonlyMap<string, BarrelOwner>,
  file: string,
): string {
  const quoted = `["']${escapeRegExp(specifier)}["']`;
  const named = new RegExp(`\\bimport\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*${quoted}\\s*;?`, "g");
  const rewritten = source.replace(named, (statement, typeOnly: string | undefined, names: string) => {
    const pad = "\n".repeat(statement.split("\n").length - 1);
    if (typeOnly) return pad;
    const byModule = new Map<string, string[]>();
    for (const raw of names.replace(COMMENTS, "").split(",")) {
      const spec = raw.trim();
      if (spec === "" || spec.startsWith("type ")) continue;
      const [name, local = name] = spec.split(/\s+as\s+/).map((s) => s.trim());
      const owner = owners.get(name!);
      if (!owner) throw new Error(`${file}: "${name}" is not a value export of "${specifier}"`);
      const binding = owner.imported === local ? local! : `${owner.imported} as ${local}`;
      byModule.set(owner.module, [...(byModule.get(owner.module) ?? []), binding]);
    }
    const imports = [...byModule].map(([module, bindings]) => `import { ${bindings.join(", ")} } from ${JSON.stringify(module)};`);
    return `${imports.join(" ")}${pad}`;
  });
  if (new RegExp(`(?:\\bfrom|\\bimport)\\s*\\(?\\s*${quoted}`).test(rewritten.replace(COMMENTS, ""))) {
    throw new Error(`${file}: only named imports (import { … } from "${specifier}") of this barrel are supported`);
  }
  return rewritten;
}

/** The barrels the client build rewrites: `@/ui` in feature code, `lucide-react` everywhere. */
function rewrittenBarrels(clientRoot: string): RewrittenBarrel[] {
  const barrels: RewrittenBarrel[] = [];
  const uiRoot = resolve(clientRoot, "ui");
  const uiIndex = resolve(uiRoot, "index.ts");
  if (existsSync(uiIndex)) {
    barrels.push({
      specifier: "@/ui",
      owners: barrelOwners(uiIndex, (file) => `@/ui/${relative(uiRoot, file).split(sep).join("/").replace(/\.tsx?$/, "")}`),
      appliesTo: (file) => !file.startsWith(uiRoot + sep),
    });
  }
  // The ESM barrel the browser build bundles (`module`); Bun.resolveSync picks the CommonJS `main`.
  // Owners are named by package subpath (`lucide-react/dist/esm/icons/x.mjs`; the package has no
  // `exports` map, so deep imports resolve), never by absolute path: the rewritten source is what
  // the sourcemaps carry.
  let lucide: { root: string; index: string } | null = null;
  try {
    const pkgJson = Bun.resolveSync("lucide-react/package.json", clientRoot);
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { module?: string };
    if (pkg.module) lucide = { root: dirname(pkgJson), index: resolve(dirname(pkgJson), pkg.module) };
  } catch {
    // Not resolvable from this entry.
  }
  if (lucide !== null) {
    const { root, index } = lucide;
    barrels.push({
      specifier: "lucide-react",
      owners: barrelOwners(index, (file) => `lucide-react/${relative(root, file).split(sep).join("/")}`),
      appliesTo: () => true,
    });
  }
  return barrels;
}

/** Load the client modules that import a rewritten barrel with those imports rewritten (see above).
 *  Tailwind skips its candidate scan for a module an onLoad supplies; its source-tree detection
 *  still sees these files. */
function barrelImportPlugin(clientRoot: string): BunPlugin {
  return {
    name: "pulse-barrel-imports",
    setup(build) {
      const barrels = rewrittenBarrels(clientRoot);
      const mentions = barrels.map((b) => new RegExp(`["']${escapeRegExp(b.specifier)}["']`));
      const importers: string[] = [];
      for (const rel of new Bun.Glob("**/*.{ts,tsx}").scanSync(clientRoot)) {
        const file = resolve(clientRoot, rel);
        try {
          const text = readFileSync(file, "utf8");
          if (barrels.some((b, i) => b.appliesTo(file) && mentions[i]!.test(text))) importers.push(file);
        } catch {
          // Unreadable: Bun.build reports it itself.
        }
      }
      if (importers.length === 0) return;
      const filter = new RegExp(`^(?:${importers.map(escapeRegExp).join("|")})$`);
      build.onLoad({ filter }, (args) => {
        let contents = readFileSync(args.path, "utf8");
        for (const barrel of barrels) {
          if (barrel.appliesTo(args.path)) contents = rewriteBarrelImports(contents, barrel.specifier, barrel.owners, args.path);
        }
        return { contents, loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
      });
    },
  };
}

/** The top-level rules and statements of a stylesheet, comments removed and whitespace collapsed. */
function topLevelRules(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  const rules: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{") depth += 1;
    else if (c === "}" && depth > 0 && --depth === 0) {
      rules.push(text.slice(start, i + 1).trim());
      start = i + 1;
    } else if (c === ";" && depth === 0) {
      rules.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest !== "") rules.push(rest);
  return rules;
}

/** Read a metafile output, or null when it cannot be read. */
function readOutput(key: string, outdir: string): string | null {
  try {
    return readFileSync(isAbsolute(key) ? resolve(key) : resolve(outdir, key), "utf8");
  } catch {
    return null;
  }
}

/**
 * Output keys of chunk stylesheets that are omitted from the output dir and the manifest: sheets
 * with no rules (a chunk whose only CSS is its tag), and sheets whose every rule already ships in
 * the entry stylesheet. Bun copies a lazy child's CSS into each ancestor's bundle, entry included,
 * so a third-party sheet reached lazily (uPlot's) is already on the page; attaching the chunk's copy
 * again would only cost a request.
 */
function omittedChunkCss(metafile: BuildMetafile, entry: string, outdir: string): string[] {
  const entryAbs = resolve(entry);
  const outputs = Object.entries(metafile.outputs).filter(
    ([key, rec]) => extname(key) === ".css" && rec.entryPoint !== undefined,
  );
  const entryKey = outputs.find(([, rec]) => resolve(rec.entryPoint!) === entryAbs)?.[0];
  const entryCss = entryKey === undefined ? null : readOutput(entryKey, outdir);
  const entryRules = new Set(entryCss === null ? [] : topLevelRules(entryCss));
  const omitted: string[] = [];
  for (const [key, rec] of outputs) {
    if (resolve(rec.entryPoint!) === entryAbs) continue;
    const css = readOutput(key, outdir);
    if (css === null) continue; // unreadable — keep it listed; serving surfaces the problem
    if (topLevelRules(css).every((rule) => entryRules.has(rule))) omitted.push(key);
  }
  return omitted;
}

/**
 * Classify metafile outputs into the REQ-BUILD-02 manifest shape. Pure and total.
 */
function classifyOutputs(
  metafile: BuildMetafile,
  outdir: string,
  entry: string,
): { entries: { js: string[]; css: string[] }; chunks: string[]; chunkCss: Record<string, string[]> } {
  void outdir; // absolute output dir; reserved for future flatness checks
  const entryAbs = resolve(entry);
  const clientRoot = dirname(entryAbs);

  const entriesJs: string[] = [];
  const entriesCss: string[] = [];
  const chunks: string[] = [];
  const chunkCss: Record<string, string[]> = {};
  const entryCssBundles = new Set<string>();

  // Pass 1 — JS and sourcemaps.
  for (const [key, rec] of Object.entries(metafile.outputs)) {
    const ext = extname(key);
    if (ext === ".map") continue;
    if (ext !== ".js") continue;
    const isEntry =
      rec.entryPoint !== undefined && resolve(rec.entryPoint) === entryAbs;
    if (isEntry) {
      entriesJs.push(`${ASSET_PREFIX}${basename(key)}`);
      if (rec.cssBundle !== undefined) {
        entryCssBundles.add(basename(rec.cssBundle));
      }
    } else {
      chunks.push(`${ASSET_PREFIX}${basename(key)}`);
    }
  }

  // Pass 2 — CSS.
  for (const [key, rec] of Object.entries(metafile.outputs)) {
    if (extname(key) !== ".css") continue;
    const publicPath = `${ASSET_PREFIX}${basename(key)}`;
    if (entryCssBundles.has(basename(key))) {
      entriesCss.push(publicPath);
    } else {
      chunks.push(publicPath);
      if (rec.entryPoint !== undefined) {
        const key2 = chunkCssKey(rec.entryPoint, clientRoot);
        (chunkCss[key2] ??= []).push(publicPath);
      }
    }
  }

  // Sort every list and rebuild chunkCss from sorted keys — determinism (REQ-OBS-02).
  entriesJs.sort();
  entriesCss.sort();
  chunks.sort();
  const chunkCssSorted: Record<string, string[]> = {};
  for (const k of Object.keys(chunkCss).sort()) {
    chunkCssSorted[k] = [...chunkCss[k]!].sort();
  }

  return {
    entries: { js: entriesJs, css: entriesCss },
    chunks,
    chunkCss: chunkCssSorted,
  };
}

/** Validate every-build manifest invariants and return all violations without throwing. */
export function checkManifestInvariants(
  classified: Pick<ClientManifest, "entries" | "chunks" | "chunkCss">,
  metafile: BuildMetafile,
  outdir: string,
): readonly string[] {
  const errors: string[] = [];
  const allPaths = [
    ...classified.entries.js,
    ...classified.entries.css,
    ...classified.chunks,
    ...Object.values(classified.chunkCss ?? {}).flat(),
  ];
  for (const path of allPaths) {
    if (!path.startsWith(ASSET_PREFIX)) errors.push(`asset path ${path} does not start with ${ASSET_PREFIX}`);
    if (path.endsWith(".map")) errors.push(`sourcemap ${path} must not be listed in the manifest`);
  }
  if (classified.entries.js.length !== 1) {
    errors.push(`entries.js must contain exactly one entry (found ${classified.entries.js.length})`);
  }

  const chunkSet = new Set(classified.chunks);
  const keysForPath = new Map<string, string[]>();
  for (const [key, paths] of Object.entries(classified.chunkCss ?? {})) {
    for (const path of paths) {
      if (!chunkSet.has(path)) {
        errors.push(`chunkCss[${JSON.stringify(key)}] names ${path}, which is not in manifest.chunks`);
      }
      const keys = keysForPath.get(path) ?? [];
      keys.push(key);
      keysForPath.set(path, keys);
    }
  }
  for (const path of classified.chunks) {
    if (extname(path) !== ".css") continue;
    const keys = keysForPath.get(path) ?? [];
    if (keys.length === 0) errors.push(`chunk stylesheet ${path} has no chunkCss key`);
    if (keys.length > 1) {
      errors.push(`chunk stylesheet ${path} is named by multiple chunkCss keys ${JSON.stringify(keys)}`);
    }
  }

  const outdirAbs = resolve(outdir);
  for (const output of Object.keys(metafile.outputs)) {
    const outputPath = isAbsolute(output) ? resolve(output) : resolve(outdirAbs, output);
    if (dirname(outputPath) !== outdirAbs) {
      errors.push(`output ${output} is not directly inside the output directory; assets are served by basename`);
    }
  }
  return errors;
}

/**
 * Snapshot the output directory before a build so a failure can be rolled back to it.
 */
function snapshotDir(dir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  if (!existsSync(dir)) return snapshot;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      snapshot.set(entry.name, statSync(resolve(dir, entry.name)).mtimeMs);
    } catch {
      // unreadable — skip
    }
  }
  return snapshot;
}

/**
 * Roll back partial outputs after a failed build (§6.5). Removes any regular file in `dir` that is
 * either absent from `snapshot` or has a different mtime than the snapshot, except `index.html` and
 * MANIFEST_FILENAME (owned by the previous build). Returns any unlink error messages.
 */
function rollbackDir(dir: string, snapshot: Map<string, number>): string[] {
  if (!existsSync(dir)) return [];
  const errors: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === "index.html" || entry.name === MANIFEST_FILENAME) continue;
    const full = resolve(dir, entry.name);
    let current: number;
    try {
      current = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const prior = snapshot.get(entry.name);
    if (prior === undefined || prior !== current) {
      try {
        unlinkSync(full);
      } catch (e) {
        errors.push(`rollback: unlink ${entry.name} failed: ${(e as Error).message}`);
      }
    }
  }
  return errors;
}

/** Prune everything in `dir` not in `keep`, except index.html and manifest.json (which the caller
 *  overwrites explicitly). Returns any unlink error messages. */
function pruneDir(dir: string, keep: Set<string>): string[] {
  const errors: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === "index.html" || entry.name === MANIFEST_FILENAME) continue;
    if (keep.has(entry.name)) continue;
    try {
      unlinkSync(resolve(dir, entry.name));
    } catch (e) {
      errors.push(`prune: unlink ${entry.name} failed: ${(e as Error).message}`);
    }
  }
  return errors;
}

/**
 * Basenames of every file this build left in the output dir: the prune keep-set.
 *
 * Bun's metafile lists only JS/CSS outputs. It omits `file`-loader assets (the hashed Geist
 * .woff2 files) and sourcemaps, so the keep-set is built from the build artifacts. Keeping only
 * metafile outputs made every clean:false rebuild delete the fonts and .map files that this same
 * build had just written (#8). The omitted chunk stylesheets and their maps are already off disk
 * and stay out of the set.
 */
function emittedFiles(
  artifacts: readonly { path: string }[],
  metafile: BuildMetafile,
  omitted: readonly string[],
): Set<string> {
  const dropped = new Set(omitted.flatMap((key) => [basename(key), `${basename(key)}.map`]));
  const keep = new Set<string>();
  for (const path of [...artifacts.map((a) => a.path), ...Object.keys(metafile.outputs)]) {
    const name = basename(path);
    if (!dropped.has(name)) keep.add(name);
  }
  return keep;
}

/**
 * Build the client into opts.outdir. Never throws; failures are values.
 */
export async function buildClient(opts: ClientBuildOptions): Promise<ClientBuildResult> {
  const startedAt = performance.now();
  const outdirAbs = resolve(opts.outdir);
  const entryAbs = resolve(opts.entry ?? DEFAULT_CLIENT_ENTRY);
  const clientRoot = dirname(entryAbs);

  // Step 0/1 — clean or snapshot.
  let snapshot: Map<string, number>;
  if (opts.clean) {
    try {
      rmSync(outdirAbs, { recursive: true, force: true });
    } catch (e) {
      return {
        ok: false,
        errors: [`clean: rmSync ${outdirAbs} failed: ${(e as Error).message}`],
        durationMs: Math.round(performance.now() - startedAt),
      };
    }
    snapshot = new Map();
  } else {
    snapshot = snapshotDir(outdirAbs);
  }
  try {
    mkdirSync(outdirAbs, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      errors: [`mkdir: ${outdirAbs} failed: ${(e as Error).message}`],
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  const tagged = collidingLazyEntries(clientRoot);

  // Step 3 — Bun.build. `throw: false` so failures are values (REQ-DEV-06).
  const output = await Bun.build({
    entrypoints: [entryAbs],
    outdir: outdirAbs,
    target: "browser",
    splitting: true,
    sourcemap: opts.sourcemap,
    metafile: true,
    minify: opts.minify,
    naming: BUILD_NAMING,
    // React reads process.env.NODE_ENV to choose its production or development build; JSX compiles
    // to the matching runtime.
    // `import.meta.env.DEV` gates the vendored `@/ui` library's development warnings (deck builds
    // with Vite, which defines it); the browser has no `import.meta.env`.
    define: {
      "process.env.NODE_ENV": JSON.stringify(opts.minify ? "production" : "development"),
      "import.meta.env.DEV": JSON.stringify(!opts.minify),
    },
    jsx: { development: !opts.minify },
    // Tailwind v4 compiles every stylesheet that imports it (styles/app.css), scanning the source
    // tree (automatic detection, minus `@source not`) plus the bundled modules for candidate classes.
    // barrelImportPlugin points `@/ui` and `lucide-react` imports at the owning modules, so each
    // chunk reaches only what it imports (see "Barrel imports").
    plugins: [tailwind, chunkTagPlugin(tagged), barrelImportPlugin(clientRoot)],
    // Fonts ship as hashed files next to the bundle (same-origin, cacheable), never inlined into
    // the entry stylesheet as data: URLs.
    loader: { ".woff2": "file", ".woff": "file" },
    throw: false,
  });

  if (!output.success) {
    const rendered =
      output.logs.filter((l) => (l as { level?: string }).level === "error").map(renderBuildMessage);
    const errors = rendered.length > 0 ? rendered : ["Bun.build failed with no diagnostics"];
    const rollbackErrs = rollbackDir(outdirAbs, snapshot);
    return {
      ok: false,
      errors: [...errors, ...rollbackErrs],
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  if (!output.metafile) {
    const rollbackErrs = rollbackDir(outdirAbs, snapshot);
    return {
      ok: false,
      errors: [
        "Bun.build returned success without a metafile (metafile: true was requested)",
        ...rollbackErrs,
      ],
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  const built = unshimEntryPoints(output.metafile, tagged);

  // Step 4 — drop the rule-free and entry-covered chunk stylesheets from disk and the metafile.
  const omitted = omittedChunkCss(built, entryAbs, outdirAbs);
  const omitErrs: string[] = [];
  for (const key of omitted) {
    const outPath = isAbsolute(key) ? resolve(key) : resolve(outdirAbs, key);
    for (const path of [outPath, `${outPath}.map`]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (e) {
        omitErrs.push(`omit: unlink ${basename(path)} failed: ${(e as Error).message}`);
      }
    }
  }
  if (omitErrs.length > 0) {
    const rollbackErrs = rollbackDir(outdirAbs, snapshot);
    return {
      ok: false,
      errors: [...omitErrs, ...rollbackErrs],
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
  const omittedSet = new Set(omitted);
  const metafile: BuildMetafile = {
    ...built,
    outputs: Object.fromEntries(
      Object.entries(built.outputs).filter(([key]) => !omittedSet.has(key)),
    ),
  };

  // Step 5 — classify + invariants.
  const classified = classifyOutputs(metafile, outdirAbs, entryAbs);
  const violations = checkManifestInvariants(classified, metafile, outdirAbs);
  if (violations.length > 0) {
    const rollbackErrs = rollbackDir(outdirAbs, snapshot);
    return {
      ok: false,
      errors: [...violations, ...rollbackErrs],
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
  const buildId = computeBuildId([
    ...classified.entries.js,
    ...classified.entries.css,
    ...classified.chunks,
    ...Object.values(classified.chunkCss ?? {}).flat(),
  ]);
  const manifest: ClientManifest = { buildId, ...classified };

  // Step 7 — prune previous outputs on clean:false.
  const keep = emittedFiles(output.outputs, metafile, omitted);
  const pruneErrs = opts.clean ? [] : pruneDir(outdirAbs, keep);

  // Step 8 — copy index.html.
  try {
    await Bun.write(
      resolve(outdirAbs, "index.html"),
      Bun.file(resolve(clientRoot, "index.html")),
    );
  } catch (e) {
    return {
      ok: false,
      errors: [`index.html copy failed: ${(e as Error).message}`],
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  // Step 9 — atomic manifest publication (REQ-CONC-02).
  const manifestPath = resolve(outdirAbs, MANIFEST_FILENAME);
  const tmpPath = `${manifestPath}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmpPath, manifestPath);
  } catch (e) {
    return {
      ok: false,
      errors: [`manifest publish failed: ${(e as Error).message}`],
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  // Emit any prune warnings to stderr (non-fatal).
  for (const w of pruneErrs) console.error(w);

  return {
    ok: true,
    manifest,
    metafile,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────

/** Local exit codes for `build-client.ts` (distinct from DEV_EXIT in scripts/dev.ts). */
const EXIT_OK = 0;
const EXIT_BUILD_FAIL = 1;
const EXIT_USAGE = 2;

const USAGE =
  "usage: bun apps/web/scripts/build-client.ts --outdir <abs> [--minify] [--no-clean] " +
  "[--sourcemap none|linked|external] [--entry <file>] [--json]";

type ParsedArgs =
  | { ok: true; options: ClientBuildOptions; json: boolean }
  | { ok: false; error: string };

function parseBuildClientArgs(argv: readonly string[]): ParsedArgs {
  let outdir: string | null = null;
  let minify = false;
  let clean = true;
  let sourcemap: "none" | "linked" | "external" = "linked";
  let entry: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--outdir": {
        const v = argv[i + 1];
        if (!v || v.startsWith("--")) return { ok: false, error: "--outdir requires a path" };
        outdir = resolve(v);
        i += 1;
        break;
      }
      case "--minify":
        minify = true;
        break;
      case "--no-clean":
        clean = false;
        break;
      case "--sourcemap": {
        const v = argv[i + 1];
        if (v !== "none" && v !== "linked" && v !== "external") {
          return { ok: false, error: `--sourcemap must be none|linked|external (got ${v ?? "<missing>"})` };
        }
        sourcemap = v;
        i += 1;
        break;
      }
      case "--entry": {
        const v = argv[i + 1];
        if (!v || v.startsWith("--")) return { ok: false, error: "--entry requires a file" };
        entry = resolve(v);
        i += 1;
        break;
      }
      case "--json":
        json = true;
        break;
      default:
        return { ok: false, error: `unknown flag: ${arg}` };
    }
  }

  if (outdir === null) return { ok: false, error: "--outdir is required" };
  const options: ClientBuildOptions = { outdir, minify, sourcemap, clean };
  if (entry !== undefined) options.entry = entry;
  return { ok: true, options, json };
}

if (import.meta.main) {
  const parsed = parseBuildClientArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }
  const result = await buildClient(parsed.options);
  if (parsed.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    for (const message of result.errors) console.error(message);
    process.exit(EXIT_BUILD_FAIL);
  }
  process.exit(EXIT_OK);
}
