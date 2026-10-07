// apps/web/tests/dom-guard.test.ts
// dom-guard: not-a-dom-test — greps other files' sources; never renders.
//
// REQ-TEST-01 meta-guard. Reads sibling suites FROM DISK (never imports them) and fails when a file
// that uses the DOM does not import `./dom.js`, `./happy-dom.js` or `./rtl.js`. Protection set and non-goals are
// enumerated below (09 §3 / 10 §3.1).
//
// ── Enumerated protection set — the guard fails when, and only when: ─────────────────────────────
// 1. T1 — a `.test.ts`/`.test.tsx` under `apps/web/tests` (excluding `browser/**`) whose comment-stripped
//    source matches `/\b(document|window)\./` without importing `./dom.js` or `./happy-dom.js`.
// 2. T2 — the same, for a static VALUE import `from "react"` / `"react-dom"` / `"react-dom/client"`
//    or the `./react-render.js` render helper.
// 3. T3 — the same, for a dynamic `import("react")` / `import("react-dom")` / `import("react-dom/client")`.
// 4. A `DOM_GUARD_OPT_OUT` marker without a `" — <reason>"` tail.
//
// ── Explicit non-goals — a verifier MUST NOT file incompleteness against any of these: ───────────
// 1. Transitive DOM use through a helper module — only first-party `.test.ts` source is scanned.
// 2. `globalThis.document` / `globalThis.window` and any other indirection or computed access.
// 3. Runtime detection — no test file is executed, so actual DOM touches are unknowable.
// 4. Browser tests — `tests/browser/**` is excluded by design (runs in real Chromium).
// 5. String-literal false positives — `stripComments` does not tokenise strings; such a file uses
//    the opt-out.
// 6. Correct USE of the wrapper — the guard proves the import exists, not that `describeDom` is
//    called or that `beforeAll` registers.
// 7. Test style, coverage, ordering, or forbidding `document` usage inside non-test helpers.
// 8. Other test trees — `stack/`, `agent/`, `tests/deploy-toolkit/` are out of scope.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { DOM_GUARD_OPT_OUT } from "./dom.js";

const TESTS_DIR = import.meta.dir;

/** T1 — global DOM access after comments are stripped. */
const T1 = /\b(document|window)\./;
/** T2 — static VALUE import of the UI framework (`import type` excluded by the lookahead). */
const T2 = /^import\s+(?!type\b)[^;]*from\s+"(react(-dom(\/client)?)?|(\.{1,2}\/)+react-render\.js)"/m;
/** T3 — dynamic value import of the UI framework: the repo's dominant lazy idiom. */
const T3 = /\bimport\(\s*"react(-dom(\/client)?)?"\s*\)/;
/** The registrar/kit import a triggered file must carry. */
const REGISTRAR = /from\s+"(\.{1,2}\/)+(dom|happy-dom|rtl)\.js"/;
/** A direct Testing Library import; suites go through `./rtl.js` (it loads them after happy-dom). */
const DIRECT_RTL = /from\s+"@testing-library\/(react|user-event|dom)(\/[^"]*)?"/;
/** Opt-out: exact marker, then " — ", then a NON-EMPTY reason. Matched on RAW source. */
const OPT_OUT_LINE = new RegExp(
  `^${DOM_GUARD_OPT_OUT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — \\S.*$`,
  "m",
);

/** Remove `//`-to-EOL and `/* … *​/` spans. Lexical approximation, not a parser (non-goal 5). */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

interface GuardEvaluation {
  optedOut: boolean;
  bareOptOut: boolean;
  trigger: "T1" | "T2" | "T3" | null;
  hasRegistrar: boolean;
}

/** Apply the §3.3 per-file order to a source string. Pure — no filesystem. */
export function evaluateSource(raw: string): GuardEvaluation {
  const hasMarker = raw.includes(DOM_GUARD_OPT_OUT);
  const optedOut = OPT_OUT_LINE.test(raw);
  const bareOptOut = hasMarker && !optedOut;
  const src = stripComments(raw);
  const trigger: "T1" | "T2" | "T3" | null = T1.test(src)
    ? "T1"
    : T2.test(src)
      ? "T2"
      : T3.test(src)
        ? "T3"
        : null;
  const hasRegistrar = REGISTRAR.test(src);
  return { optedOut, bareOptOut, trigger, hasRegistrar };
}

/** Walk `TESTS_DIR/**​/*.test.{ts,tsx}`, excluding `browser/**`. Sorted for stable test order. */
function domTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (relPath === "browser") continue; // non-goal 4
        walk(abs, relPath);
        continue;
      }
      if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) out.push(abs);
    }
  };
  walk(TESTS_DIR, "");
  return out.sort();
}

describe("dom-guard (REQ-TEST-01)", () => {
  for (const file of domTestFiles()) {
    const rel = file.slice(TESTS_DIR.length + 1);
    test(`REQ-TEST-01: ${rel} registers happy-dom if it uses the DOM`, () => {
      const raw = readFileSync(file, "utf8");
      const r = evaluateSource(raw);
      if (r.bareOptOut) {
        throw new Error(
          `${rel}: opt-out needs a reason ("${DOM_GUARD_OPT_OUT} — <why>")`,
        );
      }
      if (r.optedOut) return;
      if (r.trigger === null) return;
      expect(
        r.hasRegistrar,
        `${rel} uses the DOM (${r.trigger}) but imports neither ` +
          `./dom.js nor ./happy-dom.js nor ./rtl.js — wrap the suite in describeDom(...) from ./dom.js`,
      ).toBe(true);
    });
  }

  test("Testing Library is imported only through ./rtl.js", () => {
    const offenders = domTestFiles()
      .filter((file) => DIRECT_RTL.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.slice(TESTS_DIR.length + 1));
    expect(offenders).toEqual([]);
  });

  test("REQ-TEST-01: a synthetic DOM test lacking describeDom+marker fails the guard", () => {
    const synthetic = [
      `import { describe, expect, test } from "bun:test";`,
      `describe("synthetic", () => {`,
      `  test("touches the DOM", () => {`,
      `    const el = document.createElement("div");`,
      `    expect(el).toBeDefined();`,
      `  });`,
      `});`,
    ].join("\n");
    const r = evaluateSource(synthetic);
    expect(r.trigger).toBe("T1");
    expect(r.hasRegistrar).toBe(false);
    expect(r.optedOut).toBe(false);
  });

  test("REQ-TEST-01: a synthetic DOM test with the opt-out marker+reason is allowed", () => {
    const synthetic = [
      `${DOM_GUARD_OPT_OUT} — not really a DOM test, greps only`,
      `const s = "document.body.appendChild";`,
    ].join("\n");
    const r = evaluateSource(synthetic);
    expect(r.optedOut).toBe(true);
    expect(r.bareOptOut).toBe(false);
  });

  test("REQ-TEST-01: a bare opt-out marker without a reason is rejected", () => {
    const synthetic = [
      DOM_GUARD_OPT_OUT,
      `const s = "document.body";`,
    ].join("\n");
    const r = evaluateSource(synthetic);
    expect(r.bareOptOut).toBe(true);
    expect(r.optedOut).toBe(false);
  });

  test("REQ-TEST-01: stripComments removes prose that would otherwise false-positive T1", () => {
    // poll.test.ts:3 contains the prose "…runs many cycles in a short window. Asserts:…";
    // stripComments must delete it so poll.test.ts does not trigger T1 (09 §3.4).
    const src = [
      `// runs many cycles in a short window. Asserts:`,
      `import { describe } from "bun:test";`,
      `describe("noop", () => {});`,
    ].join("\n");
    const r = evaluateSource(src);
    expect(r.trigger).toBeNull();
  });

  test("REQ-TEST-01: only the meta-guards opt out", () => {
    const opted = domTestFiles().filter((f) => OPT_OUT_LINE.test(readFileSync(f, "utf8")));
    expect(opted.map((f) => f.slice(TESTS_DIR.length + 1))).toEqual([
      "dom-guard.test.ts",
      "prod-isolation.test.ts",
    ]);
  });
});
