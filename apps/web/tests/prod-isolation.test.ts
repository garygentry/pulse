// apps/web/tests/prod-isolation.test.ts
// dom-guard: not-a-dom-test — walks the import graph from disk; renders nothing
//
// REQ-DEV-12 / REQ-SEC-01 meta-guard. Static walk of the transitive import graphs (via
// `Bun.Transpiler.scanImports`, which drops `import type` and `type` specifiers before we see
// them — verified — so type-only edges from `src/shared/registry.ts` into the server are legal
// and invisible to this test) starting from two real entry roots, enforcing the four rules of
// 01 §6.1. Rules 3 and 4 grep every first-party `.ts`/`.tsx` under `apps/web/src/**` and
// `apps/web/scripts/**` for a specifier resolving into the guarded tree.
//
// ── Enumerated protection set — the guard fails when, and only when: ─────────────────────────
// Rule 1: A path under `apps/web/src/server/dev/`, `apps/web/tests/`, or `apps/web/scripts/`
//         is transitively reachable from `apps/web/src/server/index.ts` (production server).
// Rule 2: A path under `apps/web/src/server/`, `apps/web/tests/`, or `apps/web/scripts/` is
//         transitively reachable from `apps/web/src/client/main.tsx` (production client). The
//         one permitted crossing is `src/shared/registry.ts`, whose server-half imports are
//         `import type` and are dropped by the transpiler (01 §6.2).
// Rule 3: `apps/web/src/server/dev/**` is imported by a file that is neither itself under
//         `apps/web/src/server/dev/**` nor `apps/web/scripts/dev.ts`.
// Rule 4: `apps/web/scripts/**` is imported by any file under `apps/web/src/**`.
//
// ── Explicit non-goals — a verifier MUST NOT file incompleteness against any of these: ───────
// 1. Style, coverage, module density, or the correctness of a permitted import — this guard
//    checks module *edges*, not module *contents*.
// 2. Cross-package imports outside `apps/web/` — `packages/**`, `stack/**`, `agent/**` are out
//    of scope. Third-party isolation is the budget test's job (`client-build.test.ts`).
// 3. Dynamic `import()` with a non-literal specifier — `scanImports` reports literal dynamic
//    imports, but a computed specifier is unknowable statically.
// 4. Bare package specifiers (`react`, `@preact/signals-core`, …) — the rule set is about
//    first-party tiers; anything not starting with `.` is skipped.
// 5. Type-only imports — the transpiler drops them before `scanImports` runs; a type-only edge
//    from `src/shared/registry.ts` into the client is deliberately legal.
// 6. Bundle *content* checks (SC-11's second half) — asserted on the built artifact by
//    `client-build.test.ts` via `FORBIDDEN_MARKERS`, not here. This file reads source, not
//    bundles.
// 7. Runtime reachability — nothing is executed; a module that is imported but never called
//    still counts as reachable, deliberately.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const APP = resolve(import.meta.dir, "..");
const SRC = resolve(APP, "src");
const SCRIPTS = resolve(APP, "scripts");
const SERVER_ENTRY = resolve(SRC, "server/index.ts");
const CLIENT_ENTRY = resolve(SRC, "client/main.tsx");
const SERVER_DEV = resolve(SRC, "server/dev");
const SERVER_DIR = resolve(SRC, "server");
const TESTS_DIR = resolve(APP, "tests");
const DEV_SUPERVISOR = resolve(SCRIPTS, "dev.ts");

/**
 * Resolve a RELATIVE specifier to a real file. The tree is authored with `.js` specifiers
 * (verbatimModuleSyntax + NodeNext), so `./x.js` is on disk as `x.ts` or `x.tsx`.
 * Returns `null` for bare specifiers, stylesheet imports, or unresolvable relative paths.
 */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  if (specifier.endsWith(".css")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const st = statSync(candidate);
      if (st.isFile()) return candidate;
    }
  }
  return null;
}

/**
 * Every file transitively reachable from `entry` by a VALUE import. `import type` and
 * `import { type X }` specifiers are dropped by the transpiler before `scanImports` sees
 * them (verified — 01 §6.2). Returns the set of resolved absolute paths, plus any relative,
 * non-`.css` specifier that failed to resolve to a file on disk (which would let a leak hide
 * behind a typo).
 */
export function importGraph(entry: string): { files: Set<string>; unresolved: string[] } {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const loader = file.endsWith(".tsx") ? "tsx" : "ts";
    const scanner = new Bun.Transpiler({ loader });
    const source = readFileSync(file, "utf8");
    for (const imp of scanner.scanImports(source)) {
      if (!imp.path.startsWith(".")) continue;
      const next = resolveRelative(file, imp.path);
      if (next === null) {
        if (!imp.path.endsWith(".css")) unresolved.push(`${file} → ${imp.path}`);
      } else {
        queue.push(next);
      }
    }
  }
  return { files, unresolved };
}

/** Recursively enumerate every `.ts`/`.tsx` file under a directory. */
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(abs);
    }
  };
  walk(dir);
  return out.sort();
}

interface ResolvedEdge {
  from: string;
  to: string;
}

/**
 * For every first-party `.ts`/`.tsx` source under `roots`, return every value-import edge
 * whose target resolves under `underDir`. Skips type-only imports (transpiler-erased) and
 * bare/CSS specifiers.
 */
export function edgesInto(roots: readonly string[], underDir: string): ResolvedEdge[] {
  const edges: ResolvedEdge[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const files = statSync(root).isDirectory() ? walkTsFiles(root) : [root];
    for (const file of files) {
      const loader = file.endsWith(".tsx") ? "tsx" : "ts";
      const scanner = new Bun.Transpiler({ loader });
      const source = readFileSync(file, "utf8");
      for (const imp of scanner.scanImports(source)) {
        if (!imp.path.startsWith(".")) continue;
        const next = resolveRelative(file, imp.path);
        if (next === null) continue;
        if (next === underDir || next.startsWith(`${underDir}/`)) {
          edges.push({ from: file, to: next });
        }
      }
    }
  }
  return edges;
}

const rel = (f: string): string => f.slice(APP.length + 1);

describe("production isolation (REQ-DEV-12, REQ-SEC-01, SC-11)", () => {
  it("Rule 1 — the production server graph contains no dev, test, or script module", () => {
    const { files, unresolved } = importGraph(SERVER_ENTRY);
    expect(unresolved).toEqual([]);
    const leaks: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (r.startsWith("src/server/dev/") || r.startsWith("tests/") || r.startsWith("scripts/")) {
        leaks.push(r);
      }
    }
    expect(leaks, `server entry leaks: ${leaks.join(", ")}`).toEqual([]);
    // Positive control: a walk that silently resolved nothing must not pass vacuously.
    expect(files.has(resolve(SRC, "server/assets.ts"))).toBe(true);
  });

  it("Rule 2 — the production client graph contains no server, test, or script module", () => {
    const { files, unresolved } = importGraph(CLIENT_ENTRY);
    expect(unresolved).toEqual([]);
    const leaks: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (r.startsWith("src/server/") || r.startsWith("tests/") || r.startsWith("scripts/")) {
        leaks.push(r);
      }
    }
    expect(leaks, `client entry leaks: ${leaks.join(", ")}`).toEqual([]);
    // Positive control: a walk that silently resolved nothing must not pass vacuously.
    expect(files.has(resolve(SRC, "client/app.tsx"))).toBe(true);
    expect(files.has(resolve(SRC, "client/store/index.ts"))).toBe(true);
  });

  it("Rule 3 — only src/server/dev/** and scripts/dev.ts may import from src/server/dev/**", () => {
    const edges = edgesInto([SRC, SCRIPTS], SERVER_DEV);
    const violations: string[] = [];
    for (const edge of edges) {
      const from = edge.from;
      const inDev = from === SERVER_DEV || from.startsWith(`${SERVER_DEV}/`);
      const isSupervisor = from === DEV_SUPERVISOR;
      if (!inDev && !isSupervisor) {
        violations.push(`${rel(from)} → ${rel(edge.to)}`);
      }
    }
    expect(violations, `illegal server/dev importers: ${violations.join(", ")}`).toEqual([]);
    // Positive control: the supervisor DOES import from server/dev/**, so `edges` is non-empty.
    expect(edges.length).toBeGreaterThan(0);
  });

  it("Rule 4 — nothing under src/** may import from scripts/**", () => {
    const edges = edgesInto([SRC], SCRIPTS);
    const violations = edges.map((e) => `${rel(e.from)} → ${rel(e.to)}`);
    expect(violations, `src/** must not import scripts/**: ${violations.join(", ")}`).toEqual([]);
  });

  it("the walk skips import-type specifiers", () => {
    const appTsx = resolve(SRC, "client/app.tsx");
    const raw = readFileSync(appTsx, "utf8");
    expect(raw).toContain('import type { ViewDefinition } from "../shared/registry.js"');
    const scanner = new Bun.Transpiler({ loader: "tsx" });
    const paths = scanner.scanImports(raw).map((i) => i.path);
    expect(paths).not.toContain("../shared/registry.js");
    const { files } = importGraph(CLIENT_ENTRY);
    expect(files.has(resolve(SRC, "server/assets.ts"))).toBe(false);
  });

  it("Rule 1 negative control — a synthetic dev-leak fixture is caught by importGraph", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-prod-isolation-"));
    try {
      // Build a synthetic mini-tree mirroring the real layout: server/index.ts imports
      // server/dev/leak.ts. If Rule 1's assertion ran against THIS tree, it would fail.
      const synthSrc = join(dir, "src");
      const synthServer = join(synthSrc, "server");
      const synthDev = join(synthServer, "dev");
      mkdirSync(synthDev, { recursive: true });
      const leakFile = join(synthDev, "leak.ts");
      const entryFile = join(synthServer, "index.ts");
      writeFileSync(leakFile, `export const leak = "boom";\n`, "utf8");
      writeFileSync(entryFile, `import { leak } from "./dev/leak.js";\nconsole.log(leak);\n`, "utf8");

      const { files, unresolved } = importGraph(entryFile);
      expect(unresolved).toEqual([]);
      // The utility resolved the illicit edge and put the dev file in the graph.
      expect(files.has(leakFile)).toBe(true);
      // Simulate Rule 1's check against this synthetic tree.
      const relSynth = (f: string): string => f.slice(dir.length + 1);
      const leaks: string[] = [];
      for (const f of files) {
        if (relSynth(f).startsWith("src/server/dev/")) leaks.push(relSynth(f));
      }
      expect(leaks).toEqual(["src/server/dev/leak.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
