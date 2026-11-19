/**
 * Scan-set walk and the CLI runner, against throwaway repo roots. Firing values are built from fragments
 * (helpers.ts) and only ever written to the temporary tree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXCEPTIONS_FILE } from "../../scripts/public-safe/exceptions.js";
import { runLint, USAGE } from "../../scripts/public-safe/lint.js";
import {
  BINARY_SNIFF_BYTES,
  isBinary,
  LOCAL_SPEC_ROOT,
  TRACKED_ROOTS,
  walkScanSet,
} from "../../scripts/public-safe/walk.js";
import { dot } from "./helpers.js";

const PRIVATE_V4 = dot("10", "1", "2", "3");
const PRIVATE_HOST = dot("nas", "lan");
const EMPTY_EXCEPTIONS = '{"formatVersion":1,"exceptions":[]}\n';

let base = "";
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "public-safe-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Create a temp repo root holding `files` (path → content). */
async function makeRepo(name: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function lint(root: string, argv: readonly string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runLint(argv, root, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, all: [...out, ...err].join("\n") };
}

describe("isBinary", () => {
  const text = new TextEncoder().encode("plain text");
  test("by extension, case-insensitively, on the file name only", () => {
    expect(isBinary("contract/x.png", text)).toBe(true);
    expect(isBinary("contract/X.PNG", text)).toBe(true);
    expect(isBinary("apps/ios/a.tar.gz", text)).toBe(true);
    expect(isBinary("contract/x.md", text)).toBe(false);
    expect(isBinary("contract/dir.png/readme", text)).toBe(false);
    expect(isBinary("contract/png", text)).toBe(false);
  });
  test("by a NUL inside the sniff window only", () => {
    const early = new Uint8Array(20).fill(65);
    early[10] = 0;
    expect(isBinary("contract/blob", early)).toBe(true);
    const late = new Uint8Array(BINARY_SNIFF_BYTES + 10).fill(65);
    late[BINARY_SNIFF_BYTES] = 0;
    expect(isBinary("contract/blob", late)).toBe(false);
    late[BINARY_SNIFF_BYTES - 1] = 0;
    expect(isBinary("contract/blob", late)).toBe(true);
    expect(isBinary("contract/empty", new Uint8Array(0))).toBe(false);
  });
});

describe("walkScanSet", () => {
  let root = "";
  beforeAll(async () => {
    const nul = new Uint8Array(20).fill(65);
    nul[10] = 0;
    root = await makeRepo("walk", {
      "contract/a.json": '{"a":1}',
      "contract/sub/b.md": "b",
      "contract/node_modules/x.md": "skipped",
      "contract/x.png": "not really an image",
      "contract/blob": nul,
      "outside/target.md": "outside the scan set",
      "outside/dir/inner.md": "outside the scan set",
      "README.md": "root files are outside the scan set",
      "specs/ios/f/spec.md": "spec",
      "specs/ios/top.md": "top",
      "specs/ios/.verification/v.md": "x",
      "specs/ios/f/backlogs/b.md": "x",
      "specs/ios/.rauf/r.md": "x",
      "specs/ios/f/.rauf/deep.md": "x",
      "specs/ios/logs/l.md": "x",
      "specs/ios/x.log": "x",
      "specs/ios/f/y.ndjson": "x",
      "specs/ios/f/Z.LOG": "x",
      "specs/other/o.md": "another epic",
    });
    await symlink(join(root, "outside/target.md"), join(root, "contract/link.md"));
    await symlink(join(root, "outside/dir"), join(root, "contract/linkdir"));
    await symlink(join(root, "outside/target.md"), join(root, "specs/ios/f/link.md"));
  });

  test("tracked set: text files only, symlinks not followed, binaries skipped, absent apps/ios skipped", async () => {
    const report = await walkScanSet(root, "tracked");
    expect(report.files).toEqual([
      { path: "contract/a.json", text: '{"a":1}' },
      { path: "contract/sub/b.md", text: "b" },
    ]);
    expect(report.contractFileCount).toBe(2);
    expect(report.trackedCount).toBe(2);
    expect(report.localSpecCount).toBeNull();
    expect(report.skippedRoots).toEqual(["apps/ios"]);
    expect(report.skippedBinary).toBe(2);
    expect(report.skippedSymlinks).toBe(2);
  });

  test("local specs are included only on request, with their exclusions", async () => {
    const report = await walkScanSet(root, "tracked+local-specs");
    expect(report.files.map((f) => f.path)).toEqual([
      "contract/a.json",
      "contract/sub/b.md",
      "specs/ios/f/spec.md",
      "specs/ios/top.md",
    ]);
    expect(report.localSpecCount).toBe(2);
    expect(report.trackedCount).toBe(2);
    expect(report.contractFileCount).toBe(2);
    expect(report.skippedSymlinks).toBe(3);
    expect(report.skippedRoots).toEqual(["apps/ios"]);
  });

  test("the local-spec exclusions do not apply under tracked roots", async () => {
    const repo = await makeRepo("tracked-names", {
      "contract/logs/l.md": "kept",
      "contract/x.log": "kept",
      "apps/ios/backlogs/b.md": "kept",
      "apps/ios/.build/state.md": "skipped",
      "apps/ios/DerivedData/d.md": "skipped",
      "apps/ios/App.xcodeproj/xcuserdata/u.md": "skipped",
      "apps/ios/.git/config": "skipped",
    });
    const report = await walkScanSet(repo, "tracked+local-specs");
    expect(report.files.map((f) => f.path)).toEqual(["apps/ios/backlogs/b.md", "contract/logs/l.md", "contract/x.log"]);
    expect(report.skippedRoots).toEqual([LOCAL_SPEC_ROOT]);
    expect(report.localSpecCount).toBeNull();
    expect(report.contractFileCount).toBe(2);
    expect(report.trackedCount).toBe(3);
  });

  test("without contract/ the contract count is zero and every root is skipped", async () => {
    const repo = await makeRepo("empty", { "README.md": "x" });
    const report = await walkScanSet(repo, "tracked+local-specs");
    expect(report.files).toEqual([]);
    expect(report.contractFileCount).toBe(0);
    expect(report.skippedRoots).toEqual([...TRACKED_ROOTS, LOCAL_SPEC_ROOT]);
    expect(report.localSpecCount).toBeNull();
  });

  test("a root that is itself a symlink is skipped, not followed", async () => {
    const repo = await makeRepo("root-link", { "real/a.md": "a" });
    await symlink(join(repo, "real"), join(repo, "contract"));
    const report = await walkScanSet(repo, "tracked");
    expect(report.files).toEqual([]);
    expect(report.skippedRoots).toEqual(["contract", "apps/ios"]);
    expect(report.skippedSymlinks).toBe(1);
  });

  test("invalid UTF-8 is decoded without throwing", async () => {
    const repo = await makeRepo("utf8", { "contract/bad.txt": new Uint8Array([0x61, 0xff, 0x62]) });
    const report = await walkScanSet(repo, "tracked");
    expect(report.files).toEqual([{ path: "contract/bad.txt", text: "a�b" }]);
  });
});

describe("runLint", () => {
  test("exit 0 on a clean tree, with notes and the summary last", async () => {
    const root = await makeRepo("cli-clean", {
      [EXCEPTIONS_FILE]: EMPTY_EXCEPTIONS,
      "contract/a.md": "see https://pulse.example.com and 192.0.2.10",
      "specs/ios/f/spec.md": "clean",
    });
    const result = await lint(root);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    expect(result.out).toEqual([
      "public-safe: apps/ios absent — skipped",
      "public-safe: ok — scanned 2 files (tracked 1; specs/ios 1)",
    ]);
    expect((await lint(root, ["--tracked-only"])).out.at(-1)).toBe(
      "public-safe: ok — scanned 1 files (tracked 1; specs/ios not scanned)",
    );
  });

  test("specs/ios absent is a note and a pass", async () => {
    const root = await makeRepo("cli-no-specs", { [EXCEPTIONS_FILE]: EMPTY_EXCEPTIONS, "contract/a.md": "clean" });
    const result = await lint(root);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "public-safe: apps/ios absent — skipped",
      "public-safe: specs/ios absent — skipped",
      "public-safe: ok — scanned 1 files (tracked 1; specs/ios absent)",
    ]);
  });

  test("exit 1 with masked path:line:col output; the raw value and the root never appear", async () => {
    const root = await makeRepo("cli-firing", {
      [EXCEPTIONS_FILE]: EMPTY_EXCEPTIONS,
      "contract/a.md": `clean line\nconnect to ${PRIVATE_V4} now`,
      "specs/ios/f/spec.md": `host ${PRIVATE_HOST}`,
    });
    const result = await lint(root);
    expect(result.code).toBe(1);
    expect(result.err).toEqual([]);
    expect(result.out).toEqual([
      "public-safe: apps/ios absent — skipped",
      "contract/a.md:2:12 ip-address 10… → 192.0.2.10",
      "specs/ios/f/spec.md:1:6 hostname nas… → pulse.example.com",
      "public-safe: 2 violation(s) in 2 file(s) — scanned 2 files (tracked 1; specs/ios 1)",
    ]);
    expect(result.all).not.toContain(PRIVATE_V4);
    expect(result.all).not.toContain(PRIVATE_HOST);
    expect(result.all).not.toContain(root);
  });

  test("--tracked-only ignores a firing local spec", async () => {
    const root = await makeRepo("cli-tracked-only", {
      [EXCEPTIONS_FILE]: EMPTY_EXCEPTIONS,
      "contract/a.md": "clean",
      "specs/ios/f/spec.md": `host ${PRIVATE_HOST}`,
    });
    expect((await lint(root)).code).toBe(1);
    const result = await lint(root, ["--tracked-only"]);
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toBe("public-safe: ok — scanned 1 files (tracked 1; specs/ios not scanned)");
  });

  test("an empty contract/ fails as empty-scope", async () => {
    const root = await makeRepo("cli-empty", { [EXCEPTIONS_FILE]: EMPTY_EXCEPTIONS });
    const result = await lint(root, ["--tracked-only"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("contract/ empty-scope → contract/ yielded no scannable files; the scan cannot pass vacuously");
  });

  test("a stale exception fails and an applied one passes", async () => {
    const applied = JSON.stringify({
      formatVersion: 1,
      exceptions: [{ value: PRIVATE_HOST, path: "contract/*.md", reason: "test" }],
    });
    const root = await makeRepo("cli-exception", { [EXCEPTIONS_FILE]: applied, "contract/a.md": `host ${PRIVATE_HOST}` });
    expect((await lint(root, ["--tracked-only"])).code).toBe(0);

    const stale = await makeRepo("cli-stale", { [EXCEPTIONS_FILE]: applied, "contract/a.md": "clean" });
    const result = await lint(stale, ["--tracked-only"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "public-safe-exceptions.json exceptions[0] stale-exception na… → remove this entry; nothing under contract/*.md contains it any more",
    );
    expect(result.all).not.toContain(PRIVATE_HOST);
  });

  test("exit 2 for an invalid or missing exceptions file", async () => {
    const invalid = await makeRepo("cli-invalid", {
      [EXCEPTIONS_FILE]: '{"formatVersion":2,"exceptions":[]}',
      "contract/a.md": "clean",
    });
    const bad = await lint(invalid);
    expect(bad.code).toBe(2);
    expect(bad.out).toEqual([]);
    expect(bad.err).toEqual([
      "public-safe: config error EXCEPTIONS_INVALID public-safe-exceptions.json: formatVersion: must be 1",
    ]);

    const missing = await makeRepo("cli-missing", { "contract/a.md": "clean" });
    const none = await lint(missing);
    expect(none.code).toBe(2);
    expect(none.err).toEqual([
      "public-safe: config error EXCEPTIONS_UNREADABLE public-safe-exceptions.json: cannot read (ENOENT)",
    ]);
    expect(none.all).not.toContain(missing);
  });

  test("usage: --help prints usage and exits 0; an unknown argument exits 2 without echoing it", async () => {
    const root = await makeRepo("cli-usage", { [EXCEPTIONS_FILE]: EMPTY_EXCEPTIONS, "contract/a.md": "clean" });
    for (const flag of ["--help", "-h"]) {
      expect(await lint(root, [flag])).toMatchObject({ code: 0, out: [USAGE], err: [] });
    }
    const bogus = await lint(root, ["--bogus"]);
    expect(bogus.code).toBe(2);
    expect(bogus.out).toEqual([]);
    expect(bogus.err).toEqual(["public-safe: unknown argument (see --help)", USAGE]);
  });

  test("the deny list fires, short terms are noted, and an unreadable one is an internal error without the root", async () => {
    const root = await makeRepo("cli-deny", {
      [EXCEPTIONS_FILE]: EMPTY_EXCEPTIONS,
      ".public-safe.local": "# estate\nacme\nab\n",
      "contract/a.md": "build on ACME today",
    });
    const result = await lint(root, ["--tracked-only"]);
    expect(result.code).toBe(1);
    expect(result.out[0]).toBe("public-safe: note: ignored 1 deny term(s) shorter than 3 characters");
    expect(result.out).toContain(
      'contract/a.md:1:10 local-deny AC… → a placeholder from CONTRIBUTING.md "Public-safe placeholders"',
    );

    const broken = await makeRepo("cli-deny-dir", {
      [EXCEPTIONS_FILE]: EMPTY_EXCEPTIONS,
      ".public-safe.local/keep": "a directory, so the read fails with EISDIR",
      "contract/a.md": "clean",
    });
    const failed = await lint(broken);
    expect(failed.code).toBe(2);
    expect(failed.err).toHaveLength(1);
    expect(failed.err[0]).toMatch(/^public-safe: internal error: EISDIR: /);
    expect(failed.all).not.toContain(broken);
  });
});
