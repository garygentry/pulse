/** Content-based union of parsed sources + deterministic duplicate detection (03 §4.5,
 *  REQ-LOAD-02, REQ-MODEL-03, REQ-DET-01).
 *
 *  Any file may contribute any top-level section; collections are unioned by `name`
 *  identity into insertion-ordered plain arrays (never a Map/Set into output).
 *
 *  ## Layered overlays (issue #7)
 *  Each source declares an optional top-level `layer: base | overlay` (default `base` when
 *  absent — so a repo with no markers behaves exactly as before). A machine-generated **base**
 *  layer and a hand-authored **overlay** may both declare the same identity: the two are
 *  **deep-merged**, with the overlay winning on every conflicting scalar, nested objects merged
 *  recursively, and **arrays replaced whole** by the overlay. This holds for the singleton
 *  `estate` block too. A collision **within the same layer** is still a hard error
 *  (DUPLICATE_IDENTITY / DUPLICATE_ESTATE naming both locations) — overlays refine, they do not
 *  silence a genuine same-layer duplicate. `layer` is read here and never reaches shape
 *  validation (it is not one of the merged sections). An unrecognized `layer` value is an
 *  INVALID_LAYER finding. Determinism is unchanged: the overlay always wins regardless of read
 *  order, and merged array indices keep first-appearance (sorted-read) order (REQ-DET-01). */

import type { ParsedSource, FileLocations } from "./yaml.js";
import type { Finding } from "../findings/index.js";
import type { Provenance } from "../model/index.js";
import { FINDING_CODES } from "../findings/codes.js";

/** Merged raw content across all files, plus the unified provenance lookup and the merge-time
 *  findings (duplicate identity / duplicate estate). `content` is the input to the shape
 *  phase (02); `provenance` feeds normalization (04). */
export interface MergedContent {
  /** Unioned top-level sections. Collections are insertion-ordered arrays (REQ-DET-01).
   *  `schema_version` is NOT a top-level key — it lives inside the `estate` block
   *  (`estate.schema_version`, per 02 §4.1 / 06 §3); the version gate reads it from there
   *  pre-shape-validation. Keys mirror `inventorySchema` (02 §4.7). */
  content: {
    estate?: unknown;
    hosts: unknown[];
    services: unknown[];
    channels: unknown[];
    routing_overrides: unknown[];
    suppressions: unknown[];
  };
  /** The single unified provenance lookup across all files, keyed by MERGED dotted path.
   *  Consumed by 04 (and 05's Zod mapper for per-issue file attribution). */
  provenance: ProvenanceIndex;
  /** DUPLICATE_IDENTITY / DUPLICATE_ESTATE findings (empty when no collisions). */
  findings: Finding[];
}

/**
 * The unified provenance lookup — the **canonical** `ProvenanceIndex` that
 * 04-validation-and-normalization.md consumes (and that 05-findings.md's Zod mapper uses
 * for per-issue file attribution). `mergeSources` builds one by folding every file's
 * per-file {@link FileLocations} into a lookup keyed by the element's **merged** dotted path,
 * remembering each element's origin file and original path. Re-exported from
 * `src/loader/index.ts` so 04/05 import it from one place.
 */
export interface ProvenanceIndex {
  /**
   * Resolve a merged snake_case dotted path (e.g. "hosts[2].credential") to its source
   * {@link Provenance} — origin `file`, original snake `path`, and 1-based `line`/`col`.
   * Falls back to the nearest present ancestor when an exact node was not captured (a missing
   * field resolves to its parent's location); the estate has ≥1 source file, so a
   * `Provenance` always exists. Deterministic (relative file, code-point-stable).
   */
  lookup(path: string): Provenance;
}

/** Identity key for a collection element — its `name` field. */
function identityOf(el: unknown): string | undefined {
  return el && typeof el === "object" && typeof (el as { name?: unknown }).name === "string"
    ? (el as { name: string }).name
    : undefined;
}

/** A provenance remap entry: how a merged prefix (e.g. "hosts[2]") maps back to its source. */
type Remap = { file: string; srcPrefix: string; locs: FileLocations };

/** The identity-unioned collection sections. */
type IdentitySection = "hosts" | "services" | "channels";
/** Every collection section (identity-unioned + concatenated). */
type Section = IdentitySection | "routing_overrides" | "suppressions";

/** A source's declared overlay layer (issue #7). `base` is the default when `layer:` is absent. */
type Layer = "base" | "overlay";

/** One layer's contribution to a merged identity (or the estate block): the raw element plus its
 *  source location, kept so a same-layer duplicate can name both sides and a cross-layer merge can
 *  attribute provenance to the overlay (the hand-edited surface). */
interface LayerEntry {
  el: unknown;
  file: string;
  /** Source dotted prefix, e.g. "hosts[0]" or "estate" — the remap srcPrefix. */
  path: string;
  locs: FileLocations;
}

/** The accumulated layer entries for one identity, plus its stable merged array index. At most one
 *  `base` and one `overlay` per identity; a second of either layer is a same-layer duplicate. */
interface IdentityRecord {
  /** Fixed merged index (first-appearance / sorted-read order — REQ-DET-01). */
  index: number;
  base?: LayerEntry;
  overlay?: LayerEntry;
}

/** True for a non-null, non-array plain object — the only shape the overlay deep-merge recurses into. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge a `base` element under an `overlay` element (issue #7). The overlay wins on every
 * conflicting scalar; two plain objects at the same key merge recursively; an **array replaces the
 * base value whole** (the settled precedence — arrays are never element-merged). A type mismatch
 * (base object vs overlay scalar, or vice-versa) resolves to the overlay value. Returns a fresh
 * object; neither input is mutated. When either side is not a plain object, the overlay value is the
 * result (an overlay scalar/array wholly replaces a base of any shape).
 */
function deepMergeOverlay(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const out: Record<string, unknown> = { ...base };
  for (const [key, ov] of Object.entries(overlay)) {
    const bv = out[key];
    out[key] = isPlainObject(bv) && isPlainObject(ov) ? deepMergeOverlay(bv, ov) : ov;
  }
  return out;
}

/** Read a source's declared `layer` (issue #7). Absent → `base`. An unrecognized value yields an
 *  INVALID_LAYER finding and is treated as `base` (the load already fails on the error finding). */
function readLayer(src: ParsedSource, findings: Finding[]): Layer {
  const raw = (src.content as { layer?: unknown } | undefined)?.layer;
  if (raw === undefined) return "base";
  if (raw === "base" || raw === "overlay") return raw;
  findings.push({
    severity: "error",
    code: FINDING_CODES.INVALID_LAYER,
    file: src.file,
    path: "layer",
    message: `Source "${src.file}" declares an invalid layer ${JSON.stringify(raw)}.`,
    fix: `Set "layer:" to "base" (machine-generated skeleton) or "overlay" (hand-authored refinements), or omit it (defaults to "base"). Overlays deep-merge onto the base layer by identity (issue #7).`,
  });
  return "base";
}

/**
 * Merge parsed sources into one raw content object plus the unified provenance lookup
 * (REQ-LOAD-02, REQ-MODEL-03).
 *
 * Rules:
 * - **Content-based**: any file may contribute any of `estate`, `hosts`, `services`,
 *   `channels`, `routing_overrides`, `suppressions` (tech spec §5.1). Filenames carry no
 *   meaning. `schema_version` rides inside the `estate` block and is merged along with it.
 * - **Identity-unioned collections** (`hosts`/`services`/`channels`, keyed by `name`):
 *   appended in read order (already sorted, §4.2) then document order — an
 *   **insertion-ordered array**, never a Map/Set (REQ-DET-01). `routing_overrides` and
 *   `suppressions` are identity-less and simply concatenated in that same order.
 * - **Layered overlay (issue #7)**: a `base` and an `overlay` source may both declare the same
 *   identity (or the `estate` block); they are deep-merged with the overlay winning
 *   ({@link deepMergeOverlay}). The merged element keeps the **first-appearance** index and is
 *   attributed to the **overlay** source for provenance (the hand-edited surface).
 * - **Same-layer duplicate** (two `base`, or two `overlay`, across files or within one) → one
 *   `DUPLICATE_IDENTITY` finding naming **both** locations; the first occurrence is retained
 *   (no last-wins, REQ-LOAD-02). A same-layer second `estate` block → one `DUPLICATE_ESTATE`.
 *
 * Files whose `content` is `undefined` (malformed YAML, §4.4) contribute nothing here.
 *
 * @param sources - parsed sources in sorted read order (§4.2, §4.4).
 * @returns {@link MergedContent}.
 */
export function mergeSources(sources: ParsedSource[]): MergedContent {
  const findings: Finding[] = [];
  const content: MergedContent["content"] = {
    hosts: [],
    services: [],
    channels: [],
    routing_overrides: [],
    suppressions: [],
  };
  // mergedPrefix → source remap, used to build the unified ProvenanceIndex.
  const remap = new Map<string, Remap>();
  // Per-(section, identity) accumulator of the base/overlay entries + the stable merged index.
  const idRecords = new Map<string, IdentityRecord>();
  // The estate block's base/overlay entries (singleton; schema_version rides inside it).
  const estateRec: { base?: LayerEntry; overlay?: LayerEntry } = {};

  /** Point a merged prefix (`estate` | `section[j]`) at a source contribution's provenance. */
  const setRemap = (mergedPrefix: string, e: LayerEntry): void => {
    remap.set(mergedPrefix, { file: e.file, srcPrefix: e.path, locs: e.locs });
  };

  for (const src of sources) {
    if (!src.content) continue; // malformed file — skip (findings already captured)
    const layer = readLayer(src, findings);

    // estate (singleton; overlay may refine the base block — issue #7)
    if (src.content.estate !== undefined) {
      const entry: LayerEntry = {
        el: src.content.estate,
        file: src.file,
        path: "estate",
        locs: src.provenance,
      };
      if (estateRec[layer] !== undefined) {
        findings.push(duplicateEstate(estateRec[layer]!, entry)); // same-layer → hard error
      } else {
        estateRec[layer] = entry;
        // Recompute the merged estate: both layers present → overlay wins; else the sole entry.
        content.estate =
          estateRec.base && estateRec.overlay
            ? deepMergeOverlay(estateRec.base.el, estateRec.overlay.el)
            : entry.el;
        setRemap("estate", estateRec.overlay ?? estateRec.base!); // attribute to the overlay when present
      }
    }

    // identity-unioned collections
    for (const section of ["hosts", "services", "channels"] as const) {
      const list = src.content[section];
      if (!Array.isArray(list)) continue;
      list.forEach((el, i) => {
        const entry: LayerEntry = {
          el,
          file: src.file,
          path: `${section}[${i}]`,
          locs: src.provenance,
        };
        const id = identityOf(el);
        if (id === undefined) {
          // shape layer flags the missing name; unnamed elements never merge — append as-is.
          registerAndPush(section, el, src, i, remap, content);
          return;
        }
        const key = `${section}:${id}`;
        const rec = idRecords.get(key);
        if (rec === undefined) {
          // first appearance: allocate the stable merged index, push provisionally, remap to source.
          const index = content[section].length;
          content[section].push(el);
          const created: IdentityRecord = { index };
          created[layer] = entry;
          idRecords.set(key, created);
          setRemap(`${section}[${index}]`, entry);
        } else if (rec[layer] !== undefined) {
          // same layer already declared this identity → hard duplicate (first retained).
          findings.push(duplicateIdentity(section, id, rec[layer]!, entry));
        } else {
          // cross-layer → deep-merge base+overlay in place; overlay wins, provenance → overlay.
          rec[layer] = entry;
          content[section][rec.index] = deepMergeOverlay(rec.base!.el, rec.overlay!.el);
          setRemap(`${section}[${rec.index}]`, rec.overlay!);
        }
      });
    }

    // identity-less collections: concatenate in deterministic order
    for (const section of ["routing_overrides", "suppressions"] as const) {
      const list = src.content[section];
      if (!Array.isArray(list)) continue;
      list.forEach((el, i) => registerAndPush(section, el, src, i, remap, content));
    }
  }

  return { content, provenance: makeProvenanceIndex(remap), findings };
}

/** Append `el` at the next merged index of `content[section]` and register its provenance
 *  remap entry (`section[j]` → source `section[i]` in `src.file`). */
function registerAndPush(
  section: Section,
  el: unknown,
  src: ParsedSource,
  i: number,
  remap: Map<string, Remap>,
  content: MergedContent["content"],
): void {
  const j = content[section].length;
  content[section].push(el);
  remap.set(`${section}[${j}]`, { file: src.file, srcPrefix: `${section}[${i}]`, locs: src.provenance });
}

/** Build the unified {@link ProvenanceIndex}. `lookup(mergedPath)` extracts the element
 *  prefix (`estate` or `section[j]`) in O(1), rewrites it to the source prefix, and reads the
 *  origin file's {@link FileLocations} with nearest-ancestor fallback — so a never-captured
 *  node (e.g. a missing field) still resolves to its parent's location. No prefix scan (avoids
 *  accidental O(n²), REQ-PERF-01). */
function makeProvenanceIndex(remap: ReadonlyMap<string, Remap>): ProvenanceIndex {
  const PREFIX_RE = /^(estate|(?:hosts|services|channels|routing_overrides|suppressions)\[\d+\])/;
  return {
    lookup(path: string): Provenance {
      const mergedPrefix = PREFIX_RE.exec(path)?.[1];
      const entry = mergedPrefix ? remap.get(mergedPrefix) : undefined;
      if (!entry || mergedPrefix === undefined) {
        const estate = remap.get("estate");
        return { file: estate?.file ?? "", path, line: 1, col: 1 }; // top-level fallback
      }
      const srcPath = entry.srcPrefix + path.slice(mergedPrefix.length); // merged→source prefix
      const loc = lookupWithAncestorFallback(entry.locs, srcPath);
      return { file: entry.file, path: srcPath, line: loc.line, col: loc.col };
    },
  };
}

/** Read `path` from a file's locations, else the nearest present dotted/indexed ancestor,
 *  else the file root (1:1). Deterministic; bounded by the path's segment count. */
function lookupWithAncestorFallback(
  locs: FileLocations,
  path: string,
): { line: number; col: number } {
  let p = path;
  for (;;) {
    const hit = locs.get(p);
    if (hit) return hit;
    const cut = Math.max(p.lastIndexOf("."), p.lastIndexOf("["));
    if (cut <= 0) return { line: 1, col: 1 };
    p = p.slice(0, cut);
  }
}

function duplicateIdentity(
  section: string,
  id: string,
  first: { file: string; path: string },
  second: { file: string; path: string },
): Finding {
  return {
    severity: "error",
    code: FINDING_CODES.DUPLICATE_IDENTITY,
    file: second.file,
    path: second.path,
    message: `Duplicate ${section} identity "${id}": first declared at ${first.file}:${first.path}, redeclared at ${second.file}:${second.path}.`,
    fix: `Remove or rename one of the two "${id}" ${section} entries (${first.file}:${first.path} and ${second.file}:${second.path}); identities must be unique across all files.`,
  };
}

function duplicateEstate(
  first: { file: string; path: string },
  second: { file: string; path: string },
): Finding {
  return {
    severity: "error",
    code: FINDING_CODES.DUPLICATE_ESTATE,
    file: second.file,
    path: second.path,
    message: `Multiple estate blocks: first at ${first.file}:${first.path}, second at ${second.file}:${second.path}. Exactly one estate block is allowed.`,
    fix: `Keep a single estate block (merge fields into ${first.file}:${first.path}) and delete the duplicate at ${second.file}:${second.path}.`,
  };
}
