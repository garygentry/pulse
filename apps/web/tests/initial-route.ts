// apps/web/tests/initial-route.ts — the JS a first page load fetches before any lazy chunk.
//
// The build splits shared code (the React runtime included) out of the entry into chunks that the
// entry imports statically, so the entry file alone understates the initial route. This walks the
// static `import … from "./chunk-….js"` edges from every entry file and returns the closure; dynamic
// `import("./…")` edges (lazy views, dialogs, uPlot) are not followed.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { ClientManifest } from "../src/server/assets.js";

/** Static ESM imports of a relative module, minified or not: `from"./x.js"`, `import "./x.js"`. */
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g;

/** File names (basenames) of the entry JS plus every chunk it reaches through static imports. */
export function initialRouteJsFiles(manifest: ClientManifest, outdir: string): string[] {
  const seen = new Set<string>();
  const pending = manifest.entries.js.map((p) => basename(p));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(join(outdir, file), "utf8");
    for (const match of src.matchAll(STATIC_IMPORT)) {
      const spec = match[1]!;
      // The build writes every chunk flat beside the entry; any other edge would be miscounted.
      if (!/^\.\/[^/]+\.js$/.test(spec)) throw new Error(`${file}: unexpected static import "${spec}"`);
      pending.push(spec.slice(2));
    }
  }
  return [...seen].sort();
}
