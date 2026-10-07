// packages/renderer/src/render/index.ts — the top-level pure render pipeline (02 §3).
//
// `render(model)` transforms a validated `EstateModel` into the complete in-memory
// monitoring-config tree (REQ-RND-01) plus any renderer-raised findings. It is PURE and
// DETERMINISTIC: identical input yields a byte-identical `RenderResult` (REQ-RND-02, REQ-DET-01)
// and it performs NO I/O of any kind — no filesystem, network, clock, PID, or hostname read
// (REQ-SEC-01). Writing the tree to disk is `materialize` (03 §2); this only builds the value.
import type { EstateModel } from "@pulse/core";
import type { Finding } from "@pulse/core";

import type { RenderedFile, RenderResult, RenderInputs } from "../tree.js";
import { buildManifestFile } from "../manifest.js";
import { compareString } from "../order.js";
import { sortFindings } from "../findings.js";
import type { EmitResult } from "./emit-result.js";
import { emitScrape } from "./scrape.js";
import { emitGatus } from "./gatus.js";
import { emitAlertmanager } from "./alertmanager.js";
import { emitProber } from "./prober.js";
import { emitCommandExporter } from "./command-exporter.js";
import { emitWebArtifacts } from "./web-artifacts.js";
import { emitAgent } from "./agent.js";

// Re-export the render-input contract from its home file so the `@pulse/renderer` barrel can
// surface `RenderInputs` alongside `render`/`renderOnly` (00-core-definitions.md §6.1).
export type { RenderInputs } from "../tree.js";

/**
 * The fixed set of render kinds (00 §2). `render` renders all of them; `--only <kind[,…]>`
 * narrows to a subset (REQ-RND-05). `web` selects `web-estate-model.json`; `agent` selects the
 * per-host managed-linux bundle configs (`agent/<host>.yaml`, 05 §4.1).
 */
export const RENDER_KINDS = [
  "scrape",
  "gatus",
  "alertmanager",
  "prober",
  "command-exporter",
  "web",
  "agent",
] as const;

/** One render kind — a member of `RENDER_KINDS`. */
export type RenderKind = (typeof RENDER_KINDS)[number];

/** Append an emitter fragment's files and findings onto the running accumulators. */
function push(files: RenderedFile[], findings: Finding[], fragment: EmitResult): void {
  for (const f of fragment.files) files.push(f);
  for (const finding of fragment.findings) findings.push(finding);
}

/**
 * Render only the named kinds (REQ-RND-05). `render` is exactly `renderOnly(model, RENDER_KINDS, …)`.
 * The emit order below is fixed only for readability and pre-sort finding determinism; the single
 * final `compareString` sort on `path` is the SOLE ordering authority, so emit order can never
 * affect output (02 §3.1). The manifest ledger is always regenerated over exactly the emitted set
 * (it excludes itself, 02 §8), so a partial render carries a partial — but consistent — manifest.
 *
 * The `web` kind is the coordinated three-file emitter (`emitWebArtifacts`, 04 §§4–5): it produces
 * `web-coverage.json`, `web-estate-model.json`, and `web-findings.json` sharing one deterministic
 * `bundleId`, threading `inputs.findings` into the findings artifact exactly once. A FATAL web
 * projection (unsafe provenance / final leak assertion, 00 §12) removes the ENTIRE tree branch —
 * `renderOnly` returns `{ ok: false, findings }` and no `tree`, so the CLI can never materialize a
 * partial web generation.
 *
 * @param model - A validated `EstateModel` (REQ-VAL-02).
 * @param kinds - A subset of `RENDER_KINDS`; duplicates are ignored.
 * @param inputs - Optional loader/validation findings threaded into web findings; never mutated.
 * @returns `{ ok: true, tree, findings }` (selected kinds + manifest, path-sorted; canonically
 *   sorted union of input and renderer findings), or `{ ok: false, findings }` on fatal projection.
 */
export function renderOnly(
  model: EstateModel,
  kinds: readonly RenderKind[],
  inputs?: RenderInputs,
): RenderResult {
  const inputFindings = inputs?.findings ?? [];
  const selected = new Set<RenderKind>(kinds);
  const files: RenderedFile[] = [];
  const findings: Finding[] = []; // non-web renderer findings (secret-literal refusal, etc.)

  // (1) Per-kind non-web emitters — each returns { files, findings }.
  if (selected.has("scrape")) push(files, findings, emitScrape(model));
  if (selected.has("gatus")) push(files, findings, emitGatus(model));
  if (selected.has("alertmanager")) push(files, findings, emitAlertmanager(model));
  if (selected.has("prober")) push(files, findings, emitProber(model));
  if (selected.has("command-exporter")) push(files, findings, emitCommandExporter(model));
  if (selected.has("agent")) push(files, findings, emitAgent(model));

  // (2) The coordinated web emitter. Its `findings` return is already the sorted union of the
  //     input findings and the web-safety findings (no dedupe). A fatal projection discards the
  //     whole tree (00 §12): return no `tree`, only the merged findings.
  let webFindings: Finding[] | null = null;
  if (selected.has("web")) {
    const web = emitWebArtifacts(model, inputFindings);
    if (!web.ok) {
      return { ok: false, findings: sortFindings([...web.findings, ...findings]) };
    }
    for (const f of web.value) files.push(f);
    webFindings = web.findings;
  }

  // (3) Manifest ledger over the emitted set (excludes itself, 02 §8).
  files.push(buildManifestFile(files));

  // (4) Final sort by path (raw code-point) — whole-tree determinism (REQ-RND-02).
  files.sort((a, b) => compareString(a.path, b.path));

  // (5) Findings union sorted once with core's key (02 §6.3). When web is selected its return
  //     already folds in `inputFindings`; otherwise thread them through here so a `--only scrape`
  //     render still surfaces loader findings to the CLI.
  const unionFindings = webFindings
    ? sortFindings([...webFindings, ...findings])
    : sortFindings([...inputFindings, ...findings]);
  return { ok: true, tree: files, findings: unionFindings };
}

/**
 * Render a validated estate into the complete in-memory monitoring-config tree (REQ-RND-01).
 * Pure and deterministic (REQ-RND-02, REQ-DET-01); no I/O (REQ-SEC-01).
 *
 * @param model - A validated `EstateModel` obtained via `loadAndValidate` (REQ-VAL-02).
 * @param inputs - Optional loader/validation findings threaded into web findings; never mutated.
 * @returns The all-or-nothing `RenderResult` (00 §6.1): tree + findings, or a fatal findings-only
 *   result on unsafe web projection.
 */
export function render(model: EstateModel, inputs?: RenderInputs): RenderResult {
  return renderOnly(model, RENDER_KINDS, inputs);
}
