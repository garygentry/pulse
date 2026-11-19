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
 *  The same walk covers the `/contract` barrel (`src/contract/index.ts`), which is also bundled
 *  into the browser. It may import by value only its own files, `wire/common.ts` (through
 *  `contract/limits.ts`) and the two third-party packages `ipaddr.js` and `qrcode-generator`.
 *
 *  Scope: source-graph reachability, the repo's established isolation-guard technique
 *  (cf. `apps/web/tests/prod-isolation.test.ts`). The built-artifact browser bundle walk is
 *  owned by items 052/053; this evidence does not require `dist`. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const WIRE_DIR = resolve(import.meta.dir, "../src/wire");
const WIRE_ENTRY = resolve(WIRE_DIR, "index.ts");
const CONTRACT_DIR = resolve(import.meta.dir, "../src/contract");
const CONTRACT_ENTRY = resolve(CONTRACT_DIR, "index.ts");
/** The only third-party packages the contract runtime may import by value. */
const CONTRACT_ALLOWED_BARE = ["ipaddr.js", "qrcode-generator"];

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

  test("the only value import that escapes wire/ is contract/limits.ts", () => {
    // The overview validator reads its caps from the contract limits. That module is a leaf whose only
    // import is wire/common.ts, so the graph stays acyclic and free of third-party code.
    const escapes = [...graph.files]
      .filter((f) => !f.startsWith(WIRE_DIR))
      .map((f) => relative(REPO_ROOT, f));
    expect(escapes).toEqual(["packages/web-data/src/contract/limits.ts"]);
  });

  test("contract/limits.ts imports only wire/common.ts", () => {
    const limits = wireGraph(resolve(CONTRACT_DIR, "limits.ts"));
    expect([...limits.files].map((f) => relative(REPO_ROOT, f)).sort()).toEqual([
      "packages/web-data/src/contract/limits.ts",
      "packages/web-data/src/wire/common.ts",
    ]);
    expect([...limits.bare]).toEqual([]);
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

describe("`/contract` graph is browser-safe", () => {
  const graph = wireGraph(CONTRACT_ENTRY);
  const contractFiles = readdirSync(CONTRACT_DIR, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => resolve(CONTRACT_DIR, name));

  test("the walk reaches the barrel and the limits module, with nothing unresolved", () => {
    expect(graph.files.has(CONTRACT_ENTRY)).toBe(true);
    expect(graph.files.has(resolve(CONTRACT_DIR, "limits.ts"))).toBe(true);
    expect(graph.unresolved).toEqual([]);
  });

  test("the only value import that leaves contract/ is wire/common.ts", () => {
    const escapes = [...graph.files]
      .filter((f) => !f.startsWith(CONTRACT_DIR))
      .map((f) => relative(REPO_ROOT, f));
    expect(escapes).toEqual(["packages/web-data/src/wire/common.ts"]);
  });

  test("every file under src/contract/ imports only allowed third-party packages", () => {
    // Scans each file directly, so a module not yet re-exported by the barrel is covered too.
    const offenders: string[] = [];
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    for (const file of contractFiles) {
      for (const imp of transpiler.scanImports(readFileSync(file, "utf8"))) {
        if (imp.path.startsWith(".")) continue;
        if (!CONTRACT_ALLOWED_BARE.includes(imp.path)) offenders.push(`${relative(REPO_ROOT, file)} → ${imp.path}`);
      }
    }
    expect(contractFiles.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test("no file under src/contract/ reaches cycle/, sources/ or another package by value", () => {
    const offenders: string[] = [];
    for (const file of contractFiles) {
      const reached = wireGraph(file);
      for (const f of reached.files) {
        const inside = f.startsWith(CONTRACT_DIR) || f === resolve(WIRE_DIR, "common.ts");
        if (!inside) offenders.push(`${relative(REPO_ROOT, file)} → ${relative(REPO_ROOT, f)}`);
      }
      offenders.push(...reached.unresolved);
    }
    expect(offenders).toEqual([]);
  });

  test("nothing in src/contract/ imports the contract barrel", () => {
    const offenders: string[] = [];
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    for (const file of contractFiles) {
      for (const imp of transpiler.scanImports(readFileSync(file, "utf8"))) {
        if (imp.path === "./index.js") offenders.push(relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
