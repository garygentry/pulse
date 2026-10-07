/** Location-aware YAML parse → content + provenance index (03 §4.4, REQ-MODEL-03).
 *
 *  Parses a single {@link RawSource} with the `yaml` document API so every node's source
 *  offset resolves to a 1-based `{ line, col }`. Malformed YAML surfaces as a
 *  MALFORMED_YAML **finding**, never a throw (03 §4.3). */

import { parseDocument, LineCounter, isMap, isSeq, isScalar } from "yaml";
import type { Node } from "yaml";
import type { Finding } from "../findings/index.js";
import { FINDING_CODES } from "../findings/codes.js";

/** Per-file raw source locations: snake_case dotted YAML path → { line, col } within THAT
 *  file. Internal to the loader; `mergeSources` (§4.5) folds every file's `FileLocations`
 *  into the single unified ProvenanceIndex that normalization (04) consumes. Keys use the
 *  same dotted form as `Provenance.path` (00 §3.7), e.g. "hosts[2].exporter_ports". */
export type FileLocations = ReadonlyMap<string, { line: number; col: number }>;

/** Result of parsing one source file. Malformed YAML surfaces as a `findings` entry
 *  (MALFORMED_YAML), **never** a throw (§4.3). On malformed input, `content` is `undefined`
 *  and the file contributes nothing to the merge. */
export interface ParsedSource {
  /** Source file, relative to the loaded directory (matches `RawSource.file`). */
  file: string;
  /** Parsed top-level content (a plain object), or `undefined` if YAML was malformed. */
  content: Record<string, unknown> | undefined;
  /** path → { line, col } for every node in this file (empty when malformed). */
  provenance: FileLocations;
  /** MALFORMED_YAML findings for this file (empty on success). */
  findings: Finding[];
}

/**
 * Parse one source file into content + a provenance index, capturing syntax errors as
 * findings (REQ-MODEL-03, §4.3). Never throws for content problems.
 *
 * @param src - one sorted `RawSource` (§4.2).
 * @returns a {@link ParsedSource}; `content` is `undefined` iff YAML was malformed.
 */
export function parseYamlDocument(src: { file: string; text: string }): ParsedSource {
  const lc = new LineCounter();
  const doc = parseDocument(src.text, { lineCounter: lc });

  // Malformed YAML → MALFORMED_YAML finding(s), not a throw (§4.3, tech spec §3.8).
  if (doc.errors.length > 0) {
    const findings: Finding[] = doc.errors.map((e) => {
      const at = e.linePos?.[0] ?? lc.linePos(e.pos[0]);
      return {
        severity: "error",
        code: FINDING_CODES.MALFORMED_YAML,
        file: src.file,
        path: "", // syntax error precedes any resolvable field path
        message: `Malformed YAML at line ${at.line}, column ${at.col}: ${e.message}`,
        fix: `Fix the YAML syntax at ${src.file}:${at.line}:${at.col}, then re-run validation.`,
      };
    });
    return { file: src.file, content: undefined, provenance: new Map(), findings };
  }

  // Walk the AST accumulating a snake_case dotted path per node → its 1-based location.
  const provenance = new Map<string, { line: number; col: number }>();
  walk(doc.contents as Node | null, "", provenance, lc);

  const content = doc.toJS() as Record<string, unknown> | undefined;
  return { file: src.file, content: content ?? {}, provenance, findings: [] };
}

/** Depth-first walk of the AST, keying each node by its snake_case dotted path (map
 *  membership → `.key`, sequence membership → `[i]`) and recording the node's 1-based start
 *  location. Keys are taken verbatim from the YAML (already snake_case per tech spec §3.4);
 *  the resulting string is the `Provenance.path` contract (00 §3.7). O(n) over the tree. */
function walk(
  node: Node | null,
  path: string,
  locs: Map<string, { line: number; col: number }>,
  lc: LineCounter,
): void {
  if (node === null || node === undefined) return;

  const range = (node as { range?: [number, number, number] | null }).range;
  if (path !== "" && range) {
    locs.set(path, lc.linePos(range[0]));
  }

  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      const childPath = path === "" ? key : `${path}.${key}`;
      walk((pair.value ?? null) as Node | null, childPath, locs, lc);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, i) => {
      walk((item ?? null) as Node | null, `${path}[${i}]`, locs, lc);
    });
  }
}
