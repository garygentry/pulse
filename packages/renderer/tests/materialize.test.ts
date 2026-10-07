/** materialize.test.ts — atomic stage-and-swap writer (03 §3; item 009).
 *
 *  - Round-trip green: materialize(tree, root) writes the full tree byte-for-byte, with no
 *    leftover *.tmp-* / *.bak-* siblings on success.
 *  - Wholesale replace: a second materialize with a host removed deletes that host's stale
 *    scrape-target file.
 *  - Path escape ("../escape.json" or an absolute path) throws RenderIoError PATH_ESCAPE and
 *    writes nothing.
 *  - Simulated interruption (renameSync throws before the swap completes) leaves the prior
 *    complete root (or absent on first run) — never a partial tree — with an inert *.tmp-*
 *    sibling holding the fully-staged tree.
 *  - The staging index is derived only from existing *.tmp-* siblings: two runs from the same
 *    on-disk state pick the same index.
 *  - A grep of materialize.ts finds no Date.now / process.pid / Math.random. */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { EstateModel } from "@pulse/core";

import { materialize, RenderIoError } from "../src/materialize.js";
import type { RenderedTree } from "../src/tree.js";
import { render } from "../src/render/index.js";
import { multiclassModel } from "./fixtures/multiclass/model.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Recursively read every file under `root` into a tree-relative POSIX path → contents map. */
function readTreeUnder(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else map.set(relative(root, abs).split(sep).join("/"), readFileSync(abs, "utf8"));
    }
  };
  walk(root);
  return map;
}

/** Sibling entries of `root` matching `<base>.<suffix>-<n>`. */
function siblings(parent: string, base: string, suffix: "tmp" | "bak"): string[] {
  const re = new RegExp(`^${base}\\.${suffix}-\\d+$`);
  return readdirSync(parent).filter((n) => re.test(n));
}

/** Narrow the discriminated RenderResult and return its tree (item 010); throw on a fatal render. */
function treeOf(model: EstateModel): RenderedTree {
  const result = render(model);
  if (!result.ok) throw new Error("render unexpectedly failed");
  return result.tree;
}

/** The three coordinated v2 web artifacts a coherent render materializes. */
const WEB_ARTIFACTS = ["web-coverage.json", "web-estate-model.json", "web-findings.json"] as const;

let scratch: string[] = [];
function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-mat-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

describe("materialize round-trip (REQ-RND-06)", () => {
  test("writes the full tree byte-for-byte with no leftover siblings on success", () => {
    const dir = makeScratch();
    const root = join(dir, "rendered");
    const { tree } = render(multiclassModel);

    materialize(tree, root);

    const onDisk = readTreeUnder(root);
    const expected = new Map(tree.map((f) => [f.path, f.contents] as const));
    expect([...onDisk.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [path, contents] of expected) expect(onDisk.get(path)).toBe(contents);

    // A clean success leaves only `rendered/` — no staging or backup siblings.
    expect(siblings(dir, "rendered", "tmp")).toEqual([]);
    expect(siblings(dir, "rendered", "bak")).toEqual([]);
  });
});

describe("wholesale replace (REQ-RND-03)", () => {
  test("re-materializing with a host removed deletes its stale scrape-target file", () => {
    const dir = makeScratch();
    const root = join(dir, "rendered");

    materialize(render(multiclassModel).tree, root);
    expect(existsSync(join(root, "scrape/file_sd/nas-api.json"))).toBe(true);

    const withoutNas: EstateModel = {
      ...multiclassModel,
      hosts: multiclassModel.hosts.filter((h) => h.name !== "nas1"),
    };
    materialize(render(withoutNas).tree, root);

    // The wholesale swap drops the stale target; the old root left no *.bak-* behind.
    expect(existsSync(join(root, "scrape/file_sd/nas-api.json"))).toBe(false);
    expect(existsSync(join(root, "scrape/file_sd/managed-linux.json"))).toBe(true);
    expect(siblings(dir, "rendered", "bak")).toEqual([]);
    expect(siblings(dir, "rendered", "tmp")).toEqual([]);
  });
});

describe("path containment guard (REQ-RND-03)", () => {
  test("a '..' escape throws PATH_ESCAPE and writes nothing", () => {
    const dir = makeScratch();
    const root = join(dir, "rendered");
    const tree: RenderedTree = [{ path: "../escape.json", contents: "{}\n" }];

    expect(() => materialize(tree, root)).toThrow(RenderIoError);
    try {
      materialize(tree, root);
    } catch (e) {
      expect((e as RenderIoError).code).toBe("PATH_ESCAPE");
    }
    // Nothing written: no root, no staging sibling.
    expect(existsSync(root)).toBe(false);
    expect(siblings(dir, "rendered", "tmp")).toEqual([]);
  });

  test("an absolute path throws PATH_ESCAPE and writes nothing", () => {
    const dir = makeScratch();
    const root = join(dir, "rendered");
    const tree: RenderedTree = [{ path: "/etc/pwned.json", contents: "{}\n" }];

    let code: string | undefined;
    try {
      materialize(tree, root);
    } catch (e) {
      code = (e as RenderIoError).code;
    }
    expect(code).toBe("PATH_ESCAPE");
    expect(existsSync(root)).toBe(false);
    expect(siblings(dir, "rendered", "tmp")).toEqual([]);
  });
});

describe("simulated interruption before swap (REQ-RND-06)", () => {
  test("first run: throw before swap leaves root absent and an inert *.tmp-* holding the full tree", () => {
    const dir = makeScratch();
    const root = join(dir, "rendered");
    const { tree } = render(multiclassModel);

    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated crash before swap");
    });
    try {
      let code: string | undefined;
      try {
        materialize(tree, root);
      } catch (e) {
        code = (e as RenderIoError).code;
      }
      expect(code).toBe("SWAP_FAILED");
    } finally {
      spy.mockRestore();
    }

    // Root never materialized; a single staging sibling holds the COMPLETE staged tree.
    expect(existsSync(root)).toBe(false);
    const tmps = siblings(dir, "rendered", "tmp");
    expect(tmps.length).toBe(1);
    const staged = readTreeUnder(join(dir, tmps[0]!));
    const expected = new Map(tree.map((f) => [f.path, f.contents] as const));
    expect([...staged.keys()].sort()).toEqual([...expected.keys()].sort());
  });

  test("second run: throw before swap leaves the PRIOR complete root intact (never partial)", () => {
    const dir = makeScratch();
    const root = join(dir, "rendered");

    // A clean first materialize establishes the prior complete tree.
    const v1 = render(multiclassModel).tree;
    materialize(v1, root);

    // A subsequent run is interrupted at the swap.
    const withoutNas: EstateModel = {
      ...multiclassModel,
      hosts: multiclassModel.hosts.filter((h) => h.name !== "nas1"),
    };
    const v2 = render(withoutNas).tree;
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated crash before swap");
    });
    try {
      expect(() => materialize(v2, root)).toThrow(RenderIoError);
    } finally {
      spy.mockRestore();
    }

    // Root still holds v1 exactly — the interrupted v2 never became visible.
    const onDisk = readTreeUnder(root);
    const expected = new Map(v1.map((f) => [f.path, f.contents] as const));
    expect([...onDisk.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [path, contents] of expected) expect(onDisk.get(path)).toBe(contents);
    expect(existsSync(join(root, "scrape/file_sd/nas-api.json"))).toBe(true);
  });
});

describe("injected stage-creation failure (REQ-REL-04)", () => {
  test("a failed staging mkdir throws STAGE_FAILED; no root and no web artifact authoritative", () => {
    const dir = makeScratch();
    const root = join(dir, "rendered");
    const tree = treeOf(multiclassModel);

    // The FIRST mkdirSync materialize makes is the staging dir itself (03 §2); fail it.
    const spy = spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("simulated ENOSPC creating staging dir");
    });
    let code: string | undefined;
    try {
      try {
        materialize(tree, root);
      } catch (e) {
        code = (e as RenderIoError).code;
      }
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe("STAGE_FAILED");
    // Nothing became authoritative: no root, hence no individual web artifact.
    expect(existsSync(root)).toBe(false);
    for (const a of WEB_ARTIFACTS) expect(existsSync(join(root, a))).toBe(false);
  });
});

describe("injected staged-write failure (REQ-REL-04)", () => {
  test("a failed staged file write throws WRITE_FAILED; no partial web artifact is authoritative", () => {
    const dir = makeScratch();
    const root = join(dir, "rendered");
    const tree = treeOf(multiclassModel);

    // Fail every staged file write: the swap is never reached, so `root` is never created.
    const spy = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("simulated disk-full during staged write");
    });
    let code: string | undefined;
    try {
      try {
        materialize(tree, root);
      } catch (e) {
        code = (e as RenderIoError).code;
      }
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe("WRITE_FAILED");
    // A half-written staging sibling is inert; the authoritative root and each web artifact are absent.
    expect(existsSync(root)).toBe(false);
    for (const a of WEB_ARTIFACTS) expect(existsSync(join(root, a))).toBe(false);
  });
});

describe("root-swap failure restores the old complete root (REQ-REL-04, REQ-CONC-01)", () => {
  test("promote failure after parking the old root restores it; no v2 web artifact becomes authoritative", () => {
    const dir = makeScratch();
    const root = join(dir, "rendered");

    // Establish a prior complete root (v1), capturing its coherent web-estate-model bytes.
    const v1 = treeOf(multiclassModel);
    materialize(v1, root);
    const oldWeb = readFileSync(join(root, "web-estate-model.json"), "utf8");

    // v2 drops a host → a different bundleId → byte-different web artifacts.
    const withoutNas: EstateModel = {
      ...multiclassModel,
      hosts: multiclassModel.hosts.filter((h) => h.name !== "nas1"),
    };
    const v2 = treeOf(withoutNas);
    expect(v2.find((f) => f.path === "web-estate-model.json")!.contents).not.toBe(oldWeb);

    // Capture the REAL renameSync, then fail ONLY the promote (staging → root): call 1 parks the old
    // root aside, call 2 (promote) throws, call 3 is the best-effort restore of the old root.
    const realRename = fs.renameSync.bind(fs);
    let calls = 0;
    const spy = spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated crash promoting staging → root");
      return realRename(from, to);
    });
    let code: string | undefined;
    try {
      try {
        materialize(v2, root);
      } catch (e) {
        code = (e as RenderIoError).code;
      }
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe("SWAP_FAILED");
    // The old root was restored intact — the interrupted v2 never became visible.
    const onDisk = readTreeUnder(root);
    const expected = new Map(v1.map((f) => [f.path, f.contents] as const));
    expect([...onDisk.keys()].sort()).toEqual([...expected.keys()].sort());
    // The authoritative web bundle is still the OLD coherent one, not a v2 partial.
    expect(readFileSync(join(root, "web-estate-model.json"), "utf8")).toBe(oldWeb);
    // The restore moved the backup back onto root: no orphan *.bak-* is left masquerading as authority.
    expect(siblings(dir, "rendered", "bak")).toEqual([]);
  });
});

describe("deterministic staging index (REQ-DET-01)", () => {
  test("two runs from the same on-disk state pick the same *.tmp-* index", () => {
    const stage = (): string => {
      const dir = makeScratch();
      const root = join(dir, "rendered");
      // Seed identical leftover staging siblings; nextIndex must return max(2,5)+1 = 6.
      mkdirSync(join(dir, "rendered.tmp-2"));
      mkdirSync(join(dir, "rendered.tmp-5"));

      const spy = spyOn(fs, "renameSync").mockImplementation(() => {
        throw new Error("freeze staging");
      });
      try {
        try {
          materialize(render(multiclassModel).tree, root);
        } catch {
          /* SWAP_FAILED — staging dir is frozen for inspection */
        }
      } finally {
        spy.mockRestore();
      }
      // The single NEW staging dir (index 6) beyond the two seeds.
      const created = siblings(dir, "rendered", "tmp").filter(
        (n) => n !== "rendered.tmp-2" && n !== "rendered.tmp-5",
      );
      expect(created.length).toBe(1);
      return created[0]!;
    };

    expect(stage()).toBe("rendered.tmp-6");
    expect(stage()).toBe("rendered.tmp-6"); // identical state ⇒ identical index
  });
});

describe("no nondeterminism source in materialize.ts (REQ-DET-01)", () => {
  test("grep finds no Date.now / process.pid / Math.random", () => {
    const src = readFileSync(join(here, "..", "src", "materialize.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(/Date\.now\b/.test(src)).toBe(false);
    expect(/process\.pid\b/.test(src)).toBe(false);
    expect(/Math\.random\b/.test(src)).toBe(false);
  });
});
