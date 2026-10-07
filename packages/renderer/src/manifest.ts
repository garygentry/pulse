// packages/renderer/src/manifest.ts
import type { RenderedFile } from "./tree.js";
import { toCanonicalJson } from "./format.js";
import { compareString } from "./order.js";

/**
 * The rendered-tree format version. A static integer stamped into `.rendered-manifest.json`
 * and the three coordinated web artifacts (`web-estate-model.json`, `web-coverage.json`,
 * `web-findings.json`). Downstream consumers (`stack-core`, `web-app`) assert against it and
 * fail loudly on mismatch (REQ-RND-10, REQ-RENDER-04). Bumped ONLY on a breaking change to the
 * rendered-tree layout or the web-artifact shapes — never per-run, never a clock value.
 * v2 = 2: the rendered-model-v2 coordinated three-file web bundle (00-core-definitions.md §1.2).
 */
export const RENDER_FORMAT_VERSION = 2 as const;

/**
 * The manifest's tree-relative filename — a single shared literal so the manifest writer
 * (`02 §8`), `diffTree`'s ledger read, and `materialize`'s stale-removal (`03 §2`, `§4`) all
 * name the same file. Defined in `manifest.ts` beside `RENDER_FORMAT_VERSION`; never re-spelled
 * as a bare string.
 */
export const MANIFEST_FILENAME = ".rendered-manifest.json" as const;

/**
 * `.rendered-manifest.json` — the tree's ledger. Carries the static `formatVersion`
 * (REQ-RND-10) and the sorted list of every managed file, so `render` knows exactly what
 * it owns and can remove stale artifacts (REQ-RND-03), and a consumer can assert format
 * compatibility.
 */
export interface RenderedManifest {
  /** Equals RENDER_FORMAT_VERSION at write time; asserted by consumers. */
  formatVersion: number;
  /** Every managed tree-relative path, sorted (raw code-point). Excludes the manifest itself. */
  files: string[];
}

/**
 * Build the `.rendered-manifest.json` member for a rendered file set. Stamps the static
 * `RENDER_FORMAT_VERSION` and the code-point-sorted list of the given files' paths. The
 * manifest names only the OTHER managed files; it never lists itself (the caller passes the
 * emitted set, and this member is appended afterward — `02 §8`).
 *
 * @param files - The already-emitted rendered files (the manifest itself excluded).
 * @returns A `RenderedFile` at `MANIFEST_FILENAME` with canonical-JSON contents.
 */
export function buildManifestFile(files: readonly RenderedFile[]): RenderedFile {
  return {
    path: MANIFEST_FILENAME,
    contents: toCanonicalJson({
      formatVersion: RENDER_FORMAT_VERSION,
      files: files.map((f) => f.path).sort(compareString),
    }),
  };
}
