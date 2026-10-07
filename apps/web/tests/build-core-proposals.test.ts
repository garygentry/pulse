// apps/web/tests/build-core-proposals.test.ts — the production build compiles @pulse/core/proposals (REQ-SEAM-02).
//
// The production build runs only `tsc -b packages/web-data` before bundling, and the server imports
// `@pulse/core/proposals` + `/sign` through core's `exports` map (→ dist). Those dist files exist only
// because web-data → renderer → core is a project-reference chain. The repo-wide `tsc -b` in typecheck
// builds core anyway, so a broken chain would surface only in the Docker/production bundle: pin it here.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const json = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
const refs = (rel: string): string[] =>
  ((json(rel)["references"] as { path: string }[] | undefined) ?? []).map((r) => r.path);

describe("build compiles @pulse/core/proposals via the web-data reference chain (REQ-SEAM-02)", () => {
  test("the build script compiles packages/web-data", () => {
    expect(readFileSync(resolve(ROOT, "apps/web/scripts/build.ts"), "utf8")).toContain('"tsc", "-b", "packages/web-data"');
  });

  test("web-data references renderer, and renderer references core", () => {
    expect(refs("packages/web-data/tsconfig.json")).toContain("../renderer");
    expect(refs("packages/renderer/tsconfig.json")).toContain("../core");
  });

  test("core compiles its proposals sources and exports them from dist", () => {
    expect(json("packages/core/tsconfig.json")["include"]).toContain("src/**/*.ts");
    const exportsMap = json("packages/core/package.json")["exports"] as Record<string, { import: string }>;
    expect(exportsMap["./proposals"]?.import).toBe("./dist/proposals/index.js");
    expect(exportsMap["./proposals/sign"]?.import).toBe("./dist/proposals/sign.js");
  });
});
