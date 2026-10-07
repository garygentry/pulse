/** wire-browser-safe.test.ts — evidence for item 005 / criterion 4 (01 §§1, 14).
 *
 *  The `/wire` barrel must be safe to bundle into the browser: its VALUE-import graph may
 *  not reach Node/Bun built-ins, the runtime `@pulse/renderer` value graph, any source
 *  client implementation, `ipaddr.js` (CIDR parsing), the audit writer, or app code.
 *
 *  This walks the graph from `src/wire/index.ts` with `Bun.Transpiler.scanImports`, which
 *  drops `import type` / `import { type … }` specifiers before we see them — exactly the
 *  edges TypeScript erases under `verbatimModuleSyntax`. So the lone type-only edge
 *  `import type { SourceErrorKind }` in `wire/common.ts` is invisible here, and the emitted
 *  `/wire` runtime graph it models has no cross-boundary dependency at all.
 *
 *  Scope: source-graph reachability, the repo's established isolation-guard technique
 *  (cf. `apps/web/tests/prod-isolation.test.ts`). The built-artifact browser bundle walk is
 *  owned by items 052/053; this evidence does not require `dist`. */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const WIRE_DIR = resolve(import.meta.dir, "../src/wire");
const WIRE_ENTRY = resolve(WIRE_DIR, "index.ts");

/**
 * Resolve a RELATIVE specifier to a real source file. The tree is authored with `.js`
 * specifiers (verbatimModuleSyntax + NodeNext), so `./x.js` is `x.ts` on disk. Returns null
 * for bare specifiers; unresolvable relative paths are surfaced separately as leaks.
 */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    resolve(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface WireGraph {
  /** Every file transitively reachable from the entry by a value import. */
  readonly files: Set<string>;
  /** Distinct bare (non-relative) value-import specifiers seen anywhere in the graph. */
  readonly bare: Set<string>;
  /** Relative, non-resolvable specifiers — a typo could hide a leak, so these fail the test. */
  readonly unresolved: string[];
}

/** Walk the value-import graph from `entry`, collecting reachable files and bare specifiers. */
function wireGraph(entry: string): WireGraph {
  const files = new Set<string>();
  const bare = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const imp of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!imp.path.startsWith(".")) {
        bare.add(imp.path);
        continue;
      }
      const next = resolveRelative(file, imp.path);
      if (next === null) unresolved.push(`${relative(REPO_ROOT, file)} → ${imp.path}`);
      else queue.push(next);
    }
  }
  return { files, bare, unresolved };
}

describe("`/wire` common graph is browser-safe (criterion 4)", () => {
  const graph = wireGraph(WIRE_ENTRY);

  test("the walk actually reaches the authoritative common module", () => {
    // Guard against a vacuous pass if the barrel were emptied or the entry moved.
    expect(graph.files.has(WIRE_ENTRY)).toBe(true);
    expect(graph.files.has(resolve(WIRE_DIR, "common.ts"))).toBe(true);
    expect(graph.unresolved).toEqual([]);
  });

  test("no value import escapes the wire/ directory", () => {
    const escapes = [...graph.files]
      .filter((f) => !f.startsWith(WIRE_DIR))
      .map((f) => relative(REPO_ROOT, f));
    expect(escapes).toEqual([]);
  });

  test("no forbidden runtime dependency is reachable", () => {
    const forbidden = [...graph.bare].filter((spec) =>
      spec.startsWith("node:")
      || spec.startsWith("bun:")
      || spec === "@pulse/renderer"
      || spec.startsWith("@pulse/renderer/")
      || spec === "ipaddr.js"
      || spec.startsWith("@pulse/web")
      || spec.startsWith("apps/"),
    );
    expect(forbidden).toEqual([]);
  });

  test("the browser-safe wire graph has zero runtime dependencies at all", () => {
    // `/wire` is pure contracts; any bare value import (even a benign one) would ship runtime
    // code to the browser and is disallowed.
    expect([...graph.bare]).toEqual([]);
  });
});
