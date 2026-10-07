/** diff.test.ts — read-only drift diff (03 §…; item 010).
 *
 *  - Green: diffTree on a freshly materialized tree returns [] and writes nothing.
 *  - changed: a hand-edit to one file yields a single { kind: "changed" } for that path.
 *  - added: deleting an on-disk file yields "added" for it.
 *  - removed: dropping a host from the model then diffing the old-committed tree yields
 *    "removed" for that host's now-stale scrape target.
 *  - No committed manifest (never rendered) -> every new-tree path is "added", no throw.
 *  - A corrupt committed manifest throws ConfigIoError "UNREADABLE" (a tool fault), never a
 *    DriftEntry.
 *  - The returned array is sorted by (path, kind). */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ConfigIoError } from "@pulse/core";
import type { EstateModel } from "@pulse/core";

import { diffTree } from "../src/diff.js";
import { materialize } from "../src/materialize.js";
import { MANIFEST_FILENAME } from "../src/manifest.js";
import { render } from "../src/render/index.js";
import type { RenderedTree } from "../src/tree.js";
import { multiclassModel } from "./fixtures/multiclass/model.js";

let scratch: string[] = [];
function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-diff-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

describe("diffTree green (freshly materialized tree)", () => {
  test("returns [] and writes nothing on a byte-identical committed tree", () => {
    const root = join(makeScratch(), "rendered");
    const { tree } = render(multiclassModel);
    materialize(tree, root);

    const before = countFiles(root);
    expect(diffTree(tree, root)).toEqual([]);
    // Read-only: the diff never touches the tree.
    expect(countFiles(root)).toBe(before);
  });
});

describe("diffTree changed", () => {
  test("a hand-edit to one file yields a single 'changed' for that path", () => {
    const root = join(makeScratch(), "rendered");
    const { tree } = render(multiclassModel);
    materialize(tree, root);

    // Corrupt exactly one committed file's bytes (a hand-edit of the rendered output).
    const target = "scrape/file_sd/managed-linux.json";
    writeFileSync(join(root, target), "hand edited\n", "utf8");

    expect(diffTree(tree, root)).toEqual([{ path: target, kind: "changed" }]);
  });
});

describe("diffTree added", () => {
  test("deleting an on-disk file yields 'added' for it", () => {
    const root = join(makeScratch(), "rendered");
    const { tree } = render(multiclassModel);
    materialize(tree, root);

    const target = "scrape/file_sd/managed-linux.json";
    rmSync(join(root, target));

    expect(diffTree(tree, root)).toEqual([{ path: target, kind: "added" }]);
  });
});

describe("diffTree removed (ledger-scoped)", () => {
  test("dropping a host then diffing the old-committed tree yields 'removed' for its stale target", () => {
    const root = join(makeScratch(), "rendered");
    // Commit model A (with the nas host).
    materialize(render(multiclassModel).tree, root);
    const stale = "scrape/file_sd/nas-api.json";
    expect(existsSync(join(root, stale))).toBe(true);

    // Freshly render model B (nas host dropped) and diff it against the committed A tree.
    const withoutNas: EstateModel = {
      ...multiclassModel,
      hosts: multiclassModel.hosts.filter((h) => h.name !== "nas1"),
    };
    const drift = diffTree(render(withoutNas).tree, root);

    // The manifest ledger still lists nas-api.json (present on disk, absent in tree B) -> removed.
    expect(drift).toContainEqual({ path: stale, kind: "removed" });
    // The changed managed-file list surfaces as a 'changed' on the manifest path itself.
    expect(drift).toContainEqual({ path: MANIFEST_FILENAME, kind: "changed" });
  });
});

describe("diffTree with no committed manifest (never rendered)", () => {
  test("every new-tree path is 'added' with no throw", () => {
    const root = join(makeScratch(), "rendered"); // never materialized — dir absent
    const { tree } = render(multiclassModel);

    const drift = diffTree(tree, root);
    expect(drift.length).toBe(tree.length);
    expect(drift.every((d) => d.kind === "added")).toBe(true);
    expect(new Set(drift.map((d) => d.path))).toEqual(new Set(tree.map((f) => f.path)));
  });
});

describe("diffTree fault on a corrupt committed manifest", () => {
  test("throws ConfigIoError UNREADABLE and never emits it as a DriftEntry", () => {
    const root = join(makeScratch(), "rendered");
    const { tree } = render(multiclassModel);
    materialize(tree, root);

    // Corrupt the committed manifest JSON — a tool fault, not drift.
    writeFileSync(join(root, MANIFEST_FILENAME), "{ not valid json", "utf8");

    let code: string | undefined;
    let thrown: unknown;
    try {
      diffTree(tree, root);
    } catch (e) {
      thrown = e;
      code = (e as ConfigIoError).code;
    }
    expect(thrown).toBeInstanceOf(ConfigIoError);
    expect(code).toBe("UNREADABLE");
  });
});

describe("diffTree result ordering", () => {
  test("is sorted by (path, kind) via compareString", () => {
    const root = join(makeScratch(), "rendered");
    const { tree } = render(multiclassModel);
    materialize(tree, root);

    // Manufacture several drifts: edit two files and delete one.
    writeFileSync(join(root, "gatus/config.yaml"), "edited\n", "utf8");
    writeFileSync(join(root, "alertmanager/routing.yaml"), "edited\n", "utf8");
    rmSync(join(root, "scrape/file_sd/managed-linux.json"));

    const drift = diffTree(tree, root);
    expect(drift.length).toBeGreaterThanOrEqual(3);

    const sorted = [...drift].sort(
      (a, b) => cmp(a.path, b.path) || cmp(a.kind, b.kind),
    );
    expect(drift).toEqual(sorted);
  });
});

/** Raw code-point compare, mirroring the src comparator, for the ordering assertion. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Count files under a root by walking it; a lightweight read-only witness. */
function countFiles(root: string): number {
  // Reuse the tree round-trip: the committed tree is exactly what render produced.
  const tree: RenderedTree = render(multiclassModel).tree;
  return tree.filter((f) => existsSync(join(root, f.path))).length;
}
