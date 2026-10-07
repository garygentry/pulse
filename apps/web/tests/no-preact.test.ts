// apps/web/tests/no-preact.test.ts
//
// The web client renders with React. This guard fails when any source, test or script under
// apps/web (src, tests, scripts and the top-level source files) imports the Preact framework, its
// hooks/compat/test-utils entry points, the Preact signals bindings or the Preact icon package, or
// when apps/web/package.json declares one of them. The
// framework-neutral `@preact/signals-core` and the React bindings `@preact/signals-react` are the
// store's signal layer and stay allowed.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const SCANNED_DIRS = ["src", "tests", "scripts"] as const;

/** Specifiers and package names that would bring the Preact framework back. Any package whose name
 *  mentions preact is forbidden except the two signals packages. */
const FORBIDDEN_SPECIFIER = /^(?!@preact\/signals-(core|react)(\/|$)).*preact/;

/** Static `from "…"` / `import "…"`, dynamic `import("…")` and `require("…")` specifiers. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** A JSX pragma or config that would compile JSX against Preact's runtime. */
const PREACT_JSX_SOURCE = /jsxImportSource["'\s:]+preact/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(path);
  }
  return out.sort();
}

/** Source files directly in apps/web (build/config scripts), outside the scanned directories. */
function topLevelSourceFiles(): string[] {
  return readdirSync(WEB_ROOT)
    .filter((name) => /\.(ts|tsx|js|mjs|cjs)$/.test(name))
    .map((name) => join(WEB_ROOT, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

export function forbiddenSpecifiers(source: string): string[] {
  const found = [...source.matchAll(SPECIFIER)].map((m) => m[1]!).filter((s) => FORBIDDEN_SPECIFIER.test(s));
  return PREACT_JSX_SOURCE.test(source) ? [...found, "jsxImportSource preact"] : found;
}

describe("no Preact framework in apps/web", () => {
  test("the matcher flags framework specifiers and allows the signals bridge", () => {
    expect(forbiddenSpecifiers('import { h } from "preact";')).toEqual(["preact"]);
    expect(forbiddenSpecifiers('import { useState } from "preact/hooks";')).toEqual(["preact/hooks"]);
    expect(forbiddenSpecifiers('const m = await import("preact/compat");')).toEqual(["preact/compat"]);
    expect(forbiddenSpecifiers('import { signal } from "@preact/signals";')).toEqual(["@preact/signals"]);
    expect(forbiddenSpecifiers('import { X } from "lucide-preact";')).toEqual(["lucide-preact"]);
    expect(forbiddenSpecifiers('const p = require("preact");')).toEqual(["preact"]);
    expect(forbiddenSpecifiers('import { render } from "@testing-library/preact";')).toEqual(["@testing-library/preact"]);
    expect(forbiddenSpecifiers("/** @jsxImportSource preact */")).toEqual(["jsxImportSource preact"]);
    expect(forbiddenSpecifiers('import { signal } from "@preact/signals-core";')).toEqual([]);
    expect(forbiddenSpecifiers('import { useSignals } from "@preact/signals-react/runtime";')).toEqual([]);
  });

  test("no source, test or script imports a Preact framework module", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(join(WEB_ROOT, dir))) {
        if (file === import.meta.path) continue; // this file names the specifiers it forbids
        for (const spec of forbiddenSpecifiers(readFileSync(file, "utf8"))) {
          offenders.push(`${relative(WEB_ROOT, file)}: "${spec}"`);
        }
      }
    }
    for (const file of topLevelSourceFiles()) {
      for (const spec of forbiddenSpecifiers(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(WEB_ROOT, file)}: "${spec}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("apps/web/package.json declares no Preact framework package", () => {
    const pkg = JSON.parse(readFileSync(join(WEB_ROOT, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
    const declared = fields.flatMap((field) => Object.keys(pkg[field] ?? {}));
    expect(declared.filter((name) => FORBIDDEN_SPECIFIER.test(name))).toEqual([]);
  });

  test("no tsconfig compiles JSX against Preact", () => {
    for (const name of readdirSync(WEB_ROOT).filter((n) => /^tsconfig.*\.json$/.test(n))) {
      expect(readFileSync(join(WEB_ROOT, name), "utf8"), name).not.toMatch(PREACT_JSX_SOURCE);
    }
  });
});
