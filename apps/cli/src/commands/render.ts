// apps/cli/src/commands/render.ts — deterministic rendering (05 §5, REQ-RND-05/07, REQ-VAL-02).

import { loadAndValidate } from "@pulse/core";
import type { EstateModel, Finding, LoadResult } from "@pulse/core";
import { diffTree, materialize, renderOnly, RENDER_KINDS } from "@pulse/renderer";
import type { DriftEntry, RenderKind, RenderResult, RenderedTree } from "@pulse/renderer";

import type { CommandResult } from "./result.js";
import type { RenderData } from "../envelope.js"; // 00 §5.1

/** Options the shell passes to `runRender` after resolving config + flags (05 §3.2). */
export interface RenderOptions {
  /** Resolved output root (config `outputRoot`, overridden by `--output-root`; `04` config.ts). */
  outputRoot: string;
  /** "write" (default) or "check" (`--check`, REQ-RND-07). */
  mode: "write" | "check";
  /** `--only` narrowed kinds, or `undefined` for the full tree (REQ-RND-05). */
  only?: RenderKind[];
}

/**
 * Run `pulse render` (REQ-RND-05/07). Order of operations:
 *
 *  1. `loadAndValidate(estateDir)` — the validation FRONT (REQ-VAL-02). On `ok: false`
 *     (≥1 error finding) STOP before rendering: return the findings, no `data`, exit 1.
 *     Nothing is written.
 *  2. On `ok: true`, `renderOnly(model, kinds, { findings })` → discriminated `RenderResult`
 *     (00 §6.1). Loader/validation findings are threaded into the renderer EXACTLY ONCE via
 *     `RenderInputs`; the renderer returns the canonically-sorted union of those and its own
 *     findings (secret-literal refusal, web-safety sanitizations), so the CLI no longer runs a
 *     local finding merge. `kinds` is `opts.only ?? RENDER_KINDS`, so `--only web` selects the
 *     coordinated three-file web bundle directly rather than rendering all kinds and filtering.
 *  2a. A FATAL web projection (`ok: false`, 00 §12) writes and diffs NOTHING: return the fatal
 *      findings (their `error` severity drives exit 1), no `data`.
 *  3a. `mode === "write"` (default): `materialize(tree, outputRoot)` writes the full tree
 *      atomically (REQ-RND-06); `data.filesWritten` is the sorted tree paths.
 *  3b. `mode === "check"`: `diffTree(tree, outputRoot)` computes drift WITHOUT writing
 *      (REQ-RND-07); non-empty drift ⇒ `outcomeFailed = true` (exit 1).
 *
 * @param estateDir - resolved estate directory.
 * @param opts - resolved output root, mode, and optional `--only` kinds.
 * @throws {ConfigIoError}  PROPAGATED from `loadAndValidate` (usage fault) → shell exit 2.
 * @throws {RenderIoError}  PROPAGATED from `materialize` (stage/write/swap/path-escape) →
 *   shell exit 2. NEITHER is caught here (05 §3.3).
 */
export function runRender(estateDir: string, opts: RenderOptions): CommandResult<RenderData> {
  const loaded: LoadResult = loadAndValidate(estateDir);

  // (1) Validation front (REQ-VAL-02): an invalid estate never renders.
  if (!loaded.ok) {
    return {
      findings: loaded.findings, // verbatim, pre-sorted
      data: null, // no partial render data on a validation stop
      outcomeFailed: false, // exit 1 comes from the error finding, not an outcome flag
    };
  }

  // (2) Render the validated model, threading loader findings into the renderer exactly once and
  //     selecting only the requested kinds (`--only web` renders the coordinated bundle directly).
  const model: EstateModel = loaded.model;
  const kinds: readonly RenderKind[] = opts.only ?? RENDER_KINDS;
  const rendered: RenderResult = renderOnly(model, kinds, { findings: loaded.findings });

  // (2a) Fatal web projection (unsafe provenance / final leak assertion): no tree exists, so write
  //      and diff NOTHING. The fatal findings are `error` severity and drive exit 1 (00 §12).
  if (!rendered.ok) {
    return { findings: rendered.findings, data: null, outcomeFailed: false };
  }

  // The renderer already returns the sorted union of loader and renderer findings.
  const findings: Finding[] = rendered.findings;
  const tree: RenderedTree = rendered.tree;

  if (opts.mode === "check") {
    // (3b) `--check`: diff against the committed tree, write NOTHING (REQ-RND-07).
    const drift: DriftEntry[] = diffTree(tree, opts.outputRoot);
    return {
      findings,
      data: {
        outputRoot: opts.outputRoot,
        filesWritten: [], // check writes nothing
        mode: "check",
        drift, // present; empty ⇒ green, non-empty ⇒ exit 1
      },
      outcomeFailed: drift.length > 0, // any drift ⇒ exit 1 (REQ-RND-07)
    };
  }

  // (3a) Default write path: atomic full-tree materialize (REQ-RND-06).
  materialize(tree, opts.outputRoot);
  return {
    findings,
    data: {
      outputRoot: opts.outputRoot,
      filesWritten: tree.map((f) => f.path), // already sorted (RenderedTree is path-sorted, 00 §3.1)
      mode: "write",
      // `drift` omitted in write mode (00 §5.1)
    },
    // A secret-refusal error finding drives exit 1 via `computeOutcomeExit`; write mode sets no outcome flag.
    outcomeFailed: false,
  };
}
