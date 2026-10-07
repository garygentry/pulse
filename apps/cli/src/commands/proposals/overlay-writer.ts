// apps/cli/src/commands/proposals/overlay-writer.ts — choose the ONE overlay file an apply edits and
// edit it through the yaml Document API, preserving comments, key order and styling
// (REQ-PROP-08 c).
//
// Ownership: a model entity's `provenance.file` is its owning overlay whenever it has an overlay entry
// (merge.ts attributes cross-layer provenance to the overlay), otherwise its base file. The loader's
// ProvenanceIndex is not exported, so each file's layer and the base entry's keys are read here by
// parsing the top-level estate YAML files, mirroring readEstateDir (top level only, sorted).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMap, isSeq, parse, parseDocument } from "yaml";
import { PROPOSABLE_FIELDS } from "@pulse/core/proposals";
import type { ProposalChange } from "@pulse/core/proposals";
import type { Finding } from "@pulse/core";

import { cannotClearBaseFinding, overlayAmbiguousFinding } from "./findings.js";
import { ProposalToolError } from "./git.js";

/** The top-level estate YAML sequence an entity lives in. */
export type EstateSection = "hosts" | "services";

/** Inputs for {@link locateOverlay}. */
export interface LocateInputs {
  readonly estateDir: string;
  readonly section: EstateSection;
  /** Core identity (payload target.name). */
  readonly name: string;
  /** entity.provenance.file (relative to estateDir). */
  readonly ownerFile: string;
  readonly overlayFlag: string | null;
}

/** The chosen overlay file (estate-relative and absolute), or the refusal finding. */
export type LocateResult =
  | {
      readonly ok: true;
      readonly file: string;
      readonly absPath: string;
      /** The overlay already holds a `{name}` item in `section`. */
      readonly hasEntry: boolean;
      /** YAML keys the BASE-layer entry declares (for the clear-base rule). */
      readonly baseDeclaredKeys: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly finding: Finding };

/** One estate source as seen by the writer. */
interface LayerFile {
  readonly file: string;
  readonly layer: "base" | "overlay";
  readonly content: Record<string, unknown>;
}

const ESTATE_FILE_RE = /\.ya?ml$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Choose the ONE overlay file to edit:
 *  1. ownerFile is layer:overlay and holds the entity → that file. A different --overlay → AMBIGUOUS
 *     (it would create a competing overlay and a DUPLICATE_IDENTITY).
 *  2. else --overlay given → it must be a top-level *.yaml|*.yml in estateDir declaring layer: overlay.
 *  3. else exactly one layer:overlay file in estateDir → it.
 *  4. else (0 or ≥2 candidates) → PROPOSAL_OVERLAY_AMBIGUOUS listing the candidates.
 */
export function locateOverlay(inp: LocateInputs): LocateResult {
  const files = scanLayers(inp.estateDir);
  const holds = (f: LayerFile): boolean => entryOf(f.content, inp.section, inp.name) !== null;
  const base = files.find((f) => f.layer === "base" && holds(f));
  const baseDeclaredKeys = new Set(Object.keys(base ? entryOf(base.content, inp.section, inp.name)! : {}));
  const flagFile = inp.overlayFlag === null ? null : toEstateRel(inp.estateDir, inp.overlayFlag);

  const owner = files.find((f) => f.file === inp.ownerFile && f.layer === "overlay" && holds(f));
  if (owner) {
    if (flagFile !== null && flagFile !== owner.file) {
      return ambiguous(
        `${inp.section} "${inp.name}" is already refined in ${owner.file}; --overlay ${flagFile} would add a competing overlay`,
      );
    }
    return located(inp.estateDir, owner.file, true, baseDeclaredKeys);
  }
  if (flagFile !== null) {
    const f = files.find((x) => x.file === flagFile);
    if (!f || f.layer !== "overlay") {
      return ambiguous(`--overlay ${flagFile} is not a top-level layer: overlay file in the estate directory`);
    }
    return located(inp.estateDir, f.file, holds(f), baseDeclaredKeys);
  }
  const overlays = files.filter((f) => f.layer === "overlay");
  if (overlays.length === 1) {
    const only = overlays[0]!;
    return located(inp.estateDir, only.file, holds(only), baseDeclaredKeys);
  }
  return ambiguous(
    overlays.length === 0
      ? "the estate has no layer: overlay file; create one or pass --overlay"
      : `${overlays.length} overlay files (${overlays.map((o) => o.file).join(", ")}); pass --overlay <file>`,
  );
}

function located(estateDir: string, file: string, hasEntry: boolean, baseDeclaredKeys: ReadonlySet<string>): LocateResult {
  return { ok: true, file, absPath: join(estateDir, file), hasEntry, baseDeclaredKeys };
}

function ambiguous(message: string): LocateResult {
  return { ok: false, finding: overlayAmbiguousFinding(message) };
}

/** Top-level estate YAML files, sorted, parsed with `yaml.parse`; `layer` absent → base. */
function scanLayers(estateDir: string): LayerFile[] {
  let names: string[];
  try {
    names = readdirSync(estateDir);
  } catch (err) {
    throw new ProposalToolError("io", `cannot read the estate directory: ${(err as Error).message}`);
  }
  const out: LayerFile[] = [];
  for (const file of names.filter((n) => ESTATE_FILE_RE.test(n)).sort()) {
    const abs = join(estateDir, file);
    if (!statSync(abs).isFile()) continue;
    let content: Record<string, unknown> = {};
    try {
      const parsed: unknown = parse(readFileSync(abs, "utf8"));
      if (isRecord(parsed)) content = parsed;
    } catch {
      // An unparseable source is reported by the loader; here it simply holds nothing.
    }
    out.push({ file, layer: content["layer"] === "overlay" ? "overlay" : "base", content });
  }
  return out;
}

/** The `{name}` mapping in content[section], or null. */
function entryOf(content: Record<string, unknown>, section: EstateSection, name: string): Record<string, unknown> | null {
  const seq = content[section];
  if (!Array.isArray(seq)) return null;
  for (const item of seq) if (isRecord(item) && item["name"] === name) return item;
  return null;
}

/** estateDir-relative path of --overlay; a path escaping estateDir or not at top level → returned verbatim (then fails rule 2). */
function toEstateRel(estateDir: string, p: string): string {
  const candidates = isAbsolute(p) ? [p] : [resolve(estateDir, p), resolve(p)];
  for (const c of candidates) {
    const r = relative(resolve(estateDir), c);
    if (r !== "" && !r.startsWith("..") && !isAbsolute(r) && !r.includes(sep)) return r;
  }
  return p;
}

/** Inputs for {@link applyChangesToOverlay}: the overlay text, the entity to edit and the changes to apply. */
export interface OverlayEditInputs {
  readonly text: string;
  readonly file: string;
  readonly section: EstateSection;
  readonly name: string;
  readonly changes: readonly ProposalChange[];
  readonly baseDeclaredKeys: ReadonlySet<string>;
}

/** The edited overlay text, or the refusal finding. */
export type OverlayEditResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly finding: Finding };

/**
 * Edit the overlay text through the yaml Document API, preserving comments, key order and styling
 * so an apply leaves a minimal, reviewable diff. Pure: text in, text out; no I/O.
 *  - find the `{name: <name>}` item in the `section` sequence, or append one (creating the sequence when absent);
 *  - proposed !== null → setIn([section, i, yamlKey], value);
 *  - proposed === null → if the BASE entry declares yamlKey → PROPOSAL_CANNOT_CLEAR_BASE (an overlay cannot
 *    delete a base key; deleting the overlay key would reveal the base value, not clear it); else deleteIn.
 * All clear checks run before any mutation.
 */
export function applyChangesToOverlay(inp: OverlayEditInputs): OverlayEditResult {
  const keyOf = (c: ProposalChange): string => PROPOSABLE_FIELDS.find((s) => s.field === c.field)!.yamlKey;
  for (const c of inp.changes) {
    if (c.proposed === null && inp.baseDeclaredKeys.has(keyOf(c))) {
      return { ok: false, finding: cannotClearBaseFinding(inp.file, inp.section, inp.name, keyOf(c)) };
    }
  }
  const doc = parseDocument(inp.text);
  if (doc.errors.length > 0) throw new ProposalToolError("io", `${inp.file} no longer parses as YAML`);
  // Not addIn: a missing section would be created as a MAP; create the sequence explicitly.
  let seq = doc.get(inp.section, true);
  if (seq === undefined || seq === null) {
    doc.set(inp.section, doc.createNode([]));
    seq = doc.get(inp.section, true);
  }
  if (!isSeq(seq)) throw new ProposalToolError("io", `${inp.file}: '${inp.section}' is not a sequence`);
  let idx = seq.items.findIndex((it) => isMap(it) && it.get("name") === inp.name);
  if (idx === -1) {
    seq.add(doc.createNode({ name: inp.name }));
    idx = seq.items.length - 1;
  }
  for (const c of inp.changes) {
    if (c.proposed === null) doc.deleteIn([inp.section, idx, keyOf(c)]);
    else doc.setIn([inp.section, idx, keyOf(c)], doc.createNode(c.proposed));
  }
  return { ok: true, text: doc.toString({ lineWidth: 0 }) }; // lineWidth 0: never re-fold existing scalars
}
