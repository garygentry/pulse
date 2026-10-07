/** clean-build.test.ts — clean package build, dist export/import, and the built-artifact `/wire`
 *  emitted-graph + browser-bundle guard (item 052; 02-architecture-layout-and-package-build.md
 *  §§4–4.1, 7–8; 11-testing-strategy.md §2.2).
 *
 *  Unlike wire-browser-safe.test.ts (which walks the *source* value graph), this suite compiles the
 *  package from source into a FRESH temp outDir and exercises the EMITTED artifacts:
 *    - it must build with no pre-existing output (so a passing run cannot rely on a stale dev dist);
 *    - every one of the eight public export subpaths imports from the freshly built dist, resolving
 *      its runtime deps (zod/ipaddr.js) without any source alias;
 *    - the recursively-walked emitted `/wire` graph is browser-safe, and the walker FAILS with an
 *      import chain for every forbidden dependency class (§4.1's enumerated guard);
 *    - a minimal browser-target bundle of representative `/wire` value/type exports succeeds.
 *
 *  The temp build + fixtures live under the gitignored `packages/web-data/dist/` subtree so (a) the
 *  emitted files resolve `zod`/`ipaddr.js` via `packages/web-data/node_modules` by walking up, and
 *  (b) a stray dir after a crash is never committed. The shared `dist/*` files are never touched, so
 *  concurrent tests importing `@pulse/web-data/*` are unaffected. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PKG_DIR = resolve(REPO_ROOT, "packages/web-data");
const SRC_DIR = resolve(PKG_DIR, "src");
const DIST_DIR = resolve(PKG_DIR, "dist");

/** The eight public export subpaths from package.json (02 §3) → their emitted entry file. */
const SUBPATH_ENTRIES: Readonly<Record<string, string>> = {
  ".": "index.js",
  "./wire": "wire/index.js",
  "./cycle": "cycle/index.js",
  "./sources": "sources/index.js",
  "./queries": "queries/index.js",
  "./history": "history/index.js",
  "./identity": "identity/index.js",
  "./audit": "audit/index.js",
};

const tempDirs: string[] = [];

/** Make a temp dir under the gitignored dist/ subtree (kept inside the package for dep resolution). */
function makeTempDir(prefix: string): string {
  mkdirSync(DIST_DIR, { recursive: true });
  const dir = mkdtempSync(join(DIST_DIR, prefix));
  tempDirs.push(dir);
  return dir;
}

// ── Fresh compile of the package into a temp outDir (no pre-existing output) ──────────────────────

let outDir = "";
let tscExit = -1;
let tscOutput = "";

beforeAll(() => {
  const workDir = makeTempDir(".cleanbuild-");
  outDir = join(workDir, "out");
  // A standalone (non-composite) compile of just the package source: renderer/core are `import type`
  // (erased at emit) and resolve their .d.ts via node_modules, so we do not rebuild the whole graph
  // here — we prove the package's own emit is correct from a clean output state.
  const tsconfig = {
    extends: resolve(REPO_ROOT, "tsconfig.base.json"),
    compilerOptions: {
      composite: false,
      incremental: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      noEmit: false,
      emitDeclarationOnly: false,
      tsBuildInfoFile: null,
      rootDir: SRC_DIR,
      outDir,
    },
    include: [`${SRC_DIR}/**/*.ts`],
  };
  const tsconfigPath = join(workDir, "tsconfig.cleanbuild.json");
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
  const proc = Bun.spawnSync({
    cmd: ["bunx", "tsc", "--project", tsconfigPath],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  tscExit = proc.exitCode ?? -1;
  tscOutput = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
}, 180_000);

afterAll(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ── Export map + clean build + dist import (AC1) ─────────────────────────────────────────────────

describe("package export map", () => {
  test("lists exactly the eight documented subpaths, each resolving to ./dist", () => {
    const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf8")) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual(Object.keys(SUBPATH_ENTRIES).sort());
    for (const [sub, entry] of Object.entries(SUBPATH_ENTRIES)) {
      expect(pkg.exports[sub]!.import).toBe(`./dist/${entry}`);
      expect(pkg.exports[sub]!.types).toBe(`./dist/${entry.replace(/\.js$/, ".d.ts")}`);
    }
  });
});

describe("clean package build (no pre-existing output)", () => {
  test("compiles the package from source with a clean output state", () => {
    expect(tscOutput.includes("error TS") ? tscOutput : `exit ${tscExit}`).not.toContain("error TS");
    expect(tscExit).toBe(0);
  });

  test("emits every public subpath entry into the fresh dist", () => {
    for (const entry of Object.values(SUBPATH_ENTRIES)) {
      expect(existsSync(join(outDir, entry)), `${entry} should be emitted`).toBe(true);
    }
  });

  test("every public subpath imports from the freshly built dist without source aliases", async () => {
    // Representative named runtime exports per subpath prove the import is non-vacuous and that
    // runtime deps (zod/ipaddr.js) resolve from the emitted graph.
    const expectedExport: Readonly<Record<string, string>> = {
      "./wire": "validateCycleObservation",
      "./cycle": "foldOverview",
      "./sources": "createVmClient",
      "./queries": "QUERY_CATALOG",
      "./history": "createHistoryService",
      "./identity": "resolveIdentity",
      "./audit": "createJsonlAuditWriter",
    };
    for (const [sub, entry] of Object.entries(SUBPATH_ENTRIES)) {
      const mod = (await import(join(outDir, entry))) as Record<string, unknown>;
      expect(Object.keys(mod).length, `${sub} should export something`).toBeGreaterThan(0);
      const named = expectedExport[sub];
      if (named) expect(named in mod, `${sub} should export ${named}`).toBe(true);
    }
  });
});

// ── Project reference order + no source aliases (AC1) ────────────────────────────────────────────

describe("project references build core → renderer → web-data → web", () => {
  function refs(tsconfigPath: string): string[] {
    const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, tsconfigPath), "utf8")) as {
      references?: { path: string }[];
      compilerOptions?: { paths?: unknown };
    };
    return (cfg.references ?? []).map((r) => r.path);
  }

  test("root references list core, renderer, web-data before apps/web", () => {
    const r = refs("tsconfig.json");
    for (const p of ["packages/core", "packages/renderer", "packages/web-data"]) {
      expect(r).toContain(p);
    }
    expect(r.indexOf("packages/web-data")).toBeLessThan(r.indexOf("apps/web"));
    expect(r.indexOf("packages/renderer")).toBeLessThan(r.indexOf("packages/web-data"));
    expect(r.indexOf("packages/core")).toBeLessThan(r.indexOf("packages/renderer"));
  });

  test("app and test tsconfigs reference the package, and it references renderer", () => {
    expect(refs("apps/web/tsconfig.json")).toContain("../../packages/web-data");
    expect(refs("apps/web/tsconfig.tests.json")).toContain("../../packages/web-data");
    expect(refs("packages/web-data/tsconfig.json")).toContain("../renderer");
  });

  test("no `paths` alias in the base config could shadow the package's dist", () => {
    const base = JSON.parse(readFileSync(resolve(REPO_ROOT, "tsconfig.base.json"), "utf8")) as {
      compilerOptions?: { paths?: unknown };
    };
    expect(base.compilerOptions?.paths).toBeUndefined();
  });

  test("no root/app/test/package tsconfig defines a package source-alias `paths` mapping", () => {
    // AC1 "every package subpath imports from dist without source aliases": a `paths` or `baseUrl`
    // in ANY tsconfig that participates in the build (not just the base) could redirect
    // `@pulse/web-data/*` to `src`, hiding a missing dist. Assert every reference-order config is
    // free of both.
    for (const cfg of [
      "tsconfig.json",
      "tsconfig.base.json",
      "apps/web/tsconfig.json",
      "apps/web/tsconfig.tests.json",
      "packages/web-data/tsconfig.json",
    ]) {
      const parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, cfg), "utf8")) as {
        compilerOptions?: { paths?: unknown; baseUrl?: unknown };
      };
      const { paths, baseUrl } = parsed.compilerOptions ?? {};
      if (cfg.startsWith("apps/web/")) {
        // The web app's one alias, `@/*` → its own client sources (the vendored `@/ui` library's
        // specifier), cannot redirect a package; nothing else is allowed.
        if (paths !== undefined) expect(paths, `${cfg} paths`).toEqual({ "@/*": ["./src/client/*"] });
        if (baseUrl !== undefined) expect(baseUrl, `${cfg} baseUrl`).toBe(".");
        continue;
      }
      expect(paths, `${cfg} must not define paths`).toBeUndefined();
      expect(baseUrl, `${cfg} must not define baseUrl`).toBeUndefined();
    }
  });
});

// ── Emitted `/wire` graph walker (AC2) ───────────────────────────────────────────────────────────

interface WireViolation {
  readonly reason: string;
  readonly chain: readonly string[];
}

/** Resolve a relative `.js` specifier to a real emitted file. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, resolve(base, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Classify a bare (non-relative) specifier into a forbidden dependency class, or null if benign
 *  (nothing benign is expected on the wire graph, so any bare import is still a violation). */
function classifyBare(specifier: string): string {
  if (specifier.startsWith("node:")) return "node-builtin";
  if (specifier.startsWith("bun:")) return "bun-builtin";
  if (specifier === "@pulse/renderer" || specifier.startsWith("@pulse/renderer/")) return "renderer-runtime";
  if (specifier === "ipaddr.js") return "cidr-ipaddr";
  if (specifier.startsWith("@pulse/web") || specifier.startsWith("apps/")) return "app-path";
  return "bare-dependency";
}

/** Recursively walk the emitted import graph from `entry`, collecting reachable files and every
 *  forbidden edge with the import chain that reaches it (02 §4.1). */
function walkEmittedWireGraph(entry: string, wireRoot: string): {
  files: Set<string>;
  violations: WireViolation[];
} {
  const files = new Set<string>();
  const violations: WireViolation[] = [];
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const label = (file: string): string => relative(wireRoot, file) || basename(file);

  const visit = (file: string, path: readonly string[]): void => {
    if (files.has(file)) return;
    files.add(file);
    const chainHere = [...path, label(file)];
    for (const imp of transpiler.scanImports(readFileSync(file, "utf8"))) {
      const dynamic = imp.kind === "dynamic-import";
      if (!imp.path.startsWith(".")) {
        violations.push({ reason: classifyBare(imp.path), chain: [...chainHere, imp.path] });
        continue;
      }
      const target = resolveRelative(file, imp.path);
      if (target === null) {
        violations.push({ reason: "unresolved-alias", chain: [...chainHere, imp.path] });
        continue;
      }
      const insideWire = target === wireRoot || target.startsWith(`${wireRoot}/`);
      if (!insideWire) {
        violations.push({
          reason: dynamic ? "dynamic-import-outside-wire" : "escapes-wire",
          chain: [...chainHere, label(target)],
        });
        continue;
      }
      visit(target, chainHere);
    }
  };
  visit(entry, []);
  return { files, violations };
}

describe("emitted `/wire` graph is browser-safe (built dist)", () => {
  test("the freshly built `/wire` graph has no forbidden edge and reaches common.js", () => {
    const wireRoot = join(outDir, "wire");
    const { files, violations } = walkEmittedWireGraph(join(wireRoot, "index.js"), wireRoot);
    expect(violations).toEqual([]);
    // Non-vacuous: it actually reached the authoritative common module and stayed within wire/.
    expect(files.has(join(wireRoot, "common.ts")) || files.has(join(wireRoot, "common.js"))).toBe(true);
    for (const f of files) expect(f.startsWith(wireRoot)).toBe(true);
  });
});

describe("the `/wire` walker fails with an import chain for every forbidden class", () => {
  /** Build a `wire/index.js → wire/hop.js → <offending>` fixture; `extra` places sibling targets. */
  function fixture(offending: string, extra: Readonly<Record<string, string>> = {}): {
    entry: string;
    wireRoot: string;
  } {
    const root = makeTempDir(".cb-fixture-");
    const files: Record<string, string> = {
      "wire/index.js": 'import "./hop.js";\n',
      "wire/hop.js": `${offending}\n`,
      ...extra,
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    return { entry: join(root, "wire/index.js"), wireRoot: join(root, "wire") };
  }

  const outside = { "sources/impl.js": "export const x = 1;\n" };
  const cases: {
    name: string;
    reason: string;
    offending: string;
    extra?: Record<string, string>;
    tail: string;
  }[] = [
    { name: "node builtin", reason: "node-builtin", offending: 'import "node:crypto";', tail: "node:crypto" },
    { name: "bun builtin", reason: "bun-builtin", offending: 'import "bun:sqlite";', tail: "bun:sqlite" },
    { name: "renderer runtime", reason: "renderer-runtime", offending: 'import "@pulse/renderer";', tail: "@pulse/renderer" },
    { name: "CIDR/ipaddr.js", reason: "cidr-ipaddr", offending: 'import "ipaddr.js";', tail: "ipaddr.js" },
    { name: "app path", reason: "app-path", offending: 'import "@pulse/web/router";', tail: "@pulse/web/router" },
    { name: "unresolved alias", reason: "unresolved-alias", offending: 'import "./missing.js";', tail: "./missing.js" },
    {
      name: "sources implementation",
      reason: "escapes-wire",
      offending: 'import "../sources/impl.js";',
      extra: outside,
      tail: "sources",
    },
    {
      name: "audit writer",
      reason: "escapes-wire",
      offending: 'import "../audit/writer.js";',
      extra: { "audit/writer.js": "export const x = 1;\n" },
      tail: "audit",
    },
    {
      name: "canonical",
      reason: "escapes-wire",
      offending: 'import "../canonical.js";',
      extra: { "canonical.js": "export const x = 1;\n" },
      tail: "canonical",
    },
    {
      name: "dynamic import outside wire",
      reason: "dynamic-import-outside-wire",
      offending: 'await import("../sources/impl.js");',
      extra: outside,
      tail: "sources",
    },
  ];

  for (const c of cases) {
    test(`flags ${c.name} with the reaching import chain`, () => {
      const { entry, wireRoot } = fixture(c.offending, c.extra);
      const { violations } = walkEmittedWireGraph(entry, wireRoot);
      const hit = violations.find((v) => v.reason === c.reason);
      expect(hit, `expected a ${c.reason} violation, got ${JSON.stringify(violations)}`).toBeDefined();
      // The chain reaches the offending edge through both hops.
      expect(hit!.chain[0]).toBe("index.js");
      expect(hit!.chain[1]).toBe("hop.js");
      expect(hit!.chain.length).toBeGreaterThanOrEqual(3);
      expect(hit!.chain[hit!.chain.length - 1]).toContain(c.tail);
    });
  }
});

// ── Browser-target bundle of representative `/wire` exports (AC2) ─────────────────────────────────

describe("browser-target bundle of `/wire`", () => {
  test("a minimal browser entry importing representative value/type exports bundles cleanly", async () => {
    const root = makeTempDir(".cb-bundle-");
    const wireEntry = JSON.stringify(join(outDir, "wire/index.js"));
    const entry = join(root, "entry.ts");
    writeFileSync(
      entry,
      [
        `import { validateCycleObservation, validateLiveTick } from ${wireEntry};`,
        `import { CORE_CADENCE_MS, GATUS_STATUS_PAGE_SIZE } from ${wireEntry};`,
        `import type { OverviewSnapshotV2 } from ${wireEntry};`,
        `const _typeProbe: OverviewSnapshotV2 | null = null;`,
        `export const probe = {`,
        `  validateCycleObservation, validateLiveTick, CORE_CADENCE_MS, GATUS_STATUS_PAGE_SIZE, _typeProbe,`,
        `};`,
        "",
      ].join("\n"),
    );
    const result = await Bun.build({ entrypoints: [entry], target: "browser" });
    expect(result.success, JSON.stringify(result.logs)).toBe(true);
    const bundled = await result.outputs[0]!.text();
    for (const forbidden of ["node:", "bun:", "ipaddr", "@pulse/renderer"]) {
      expect(bundled.includes(forbidden), `bundle must not contain ${forbidden}`).toBe(false);
    }
  });
});
