// packages/renderer/src/tree.ts
import type { Finding } from "@pulse/core";

/** A single rendered file: fully-serialized canonical text at a tree-relative path. */
export interface RenderedFile {
  /**
   * Path relative to `outputRoot`, POSIX separators (`/`), deterministic. Never absolute,
   * never containing `..` (a path-escape is a hard error in `materialize`, `03 §2`).
   * e.g. `"scrape/file_sd/managed-linux.json"`.
   */
  path: string;
  /**
   * Fully-serialized file contents: already canonical (fixed key order, stable scalar
   * styles) and ending in exactly one trailing newline (`02 §5`, REQ-DET-01).
   */
  contents: string;
}

/**
 * The complete in-memory rendered tree, sorted ascending by `path` using raw code-point
 * comparison (`compareString`, `02 §5`). Whole-tree value: a golden-file test compares
 * the entire array so an added/removed file fails the test (REQ-DET-01).
 */
export type RenderedTree = RenderedFile[];

/**
 * The all-or-nothing output of `render(model, inputs?)` (rendered-model-v2, 00-core-definitions.md
 * §6.1). A discriminated union on `ok`:
 *
 *  - `ok: true`  — the complete path-sorted `tree` plus the canonically-sorted union of input
 *    findings and every renderer-raised finding (loader/validation findings threaded via
 *    `RenderInputs`, plus the `secret_literal` refusal and the web-safety sanitization findings).
 *  - `ok: false` — a FATAL projection outcome (an unsafe web provenance or a final leak assertion,
 *    00 §12). No `tree` member exists, so a caller can never materialize a partial web generation;
 *    `findings` carries the fatal (and any accompanying) findings.
 *
 * `findings` is always sorted with the same key `@pulse/core` uses and may be empty on success.
 */
export type RenderResult =
  | {
      ok: true;
      /** The complete tree (sorted by path). */
      tree: RenderedTree;
      /** Canonically-sorted union of input and renderer findings; empty on a clean render. */
      findings: Finding[];
    }
  | {
      ok: false;
      /** Fatal projection findings; no `tree` member exists. */
      findings: Finding[];
    };

/**
 * Optional contextual inputs to rendering (rendered-model-v2, 00-core-definitions.md §6.1).
 * Carries loader/validation findings to merge into the coordinated web findings artifact. This
 * is a frozen compile-time contract for the item-010 producer cutover; the current `render`
 * signature does not yet accept it. Never mutated by the renderer.
 */
export interface RenderInputs {
  /** Loader and validation findings to include in web findings output. Never mutated. */
  readonly findings?: readonly Finding[];
}
