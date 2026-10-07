// apps/web/tests/mutations-client-imports.test.ts — sign-module isolation and client import boundaries
// (10 §5.3; REQ-SEC-07, REQ-SEC-04). Reads client sources from disk; never renders.
//
// ── Protects (10 §5.3 + item 037): ───────────────────────────────────────────────────────────────
// 1. No file under `apps/web/src/client/**` imports `@pulse/core/proposals/sign`.
// 2. No file under `apps/web/src/client/**` has a relative specifier that resolves into
//    `apps/web/src/server/**`.
// 3. Runtime (value) `@pulse/core/proposals` imports appear only in the lazy
//    `mutations/dialogs/ProposeDialog.tsx` and `mutations/proposals/ProposalList.tsx` (an upper bound).
// 4. `mutations/dialogs/*.tsx` are never statically value-imported (only `import("…")` or `import type`).
// 5. The client label byte literals in `mutations/matchers.ts` equal the server
//    SILENCE_MATCHER_NAME_MAX_BYTES / SILENCE_MATCHER_VALUE_MAX_BYTES (test-side import only).
//
// ── Non-goals (10 §5.3): ─────────────────────────────────────────────────────────────────────────
// type-only imports (erased) for protection 3 and 4; transitive imports inside `node_modules`.
//
// Method: value imports come from Bun.Transpiler.scanImports (type-only imports are elided; dynamic
// imports are reported with kind "dynamic-import"). Protections 1 and 2 additionally run a lexical
// scan over comment-stripped source that also sees `import type`, so they are stricter than 10 §5.3.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { matcherIssue } from "../src/client/mutations/matchers.js";
import {
  SILENCE_MATCHER_NAME_MAX_BYTES,
  SILENCE_MATCHER_VALUE_MAX_BYTES,
} from "../src/server/mutations/handlers/silences.js";

const SRC = resolve(import.meta.dir, "../src");
const CLIENT = join(SRC, "client");
const SERVER = join(SRC, "server");
const DIALOGS = join(CLIENT, "mutations/dialogs");

const SIGN = "@pulse/core/proposals/sign";
const PROPOSALS = "@pulse/core/proposals";
const PROPOSALS_RUNTIME_ALLOWED = new Set([
  "mutations/dialogs/ProposeDialog.tsx",
  "mutations/proposals/ProposalList.tsx",
]);

interface Scanned {
  readonly rel: string;
  /** Every specifier (value, type-only, dynamic, re-export) from a lexical scan. */
  readonly allSpecifiers: readonly string[];
  /** Value imports per Bun's parser. */
  readonly valueImports: readonly { readonly path: string; readonly kind: string }[];
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SPECIFIER_RE = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function scanSource(rel: string, raw: string): Scanned {
  const transpiler = new Bun.Transpiler({ loader: rel.endsWith(".tsx") ? "tsx" : "ts" });
  const code = stripComments(raw);
  return {
    rel,
    allSpecifiers: [...code.matchAll(SPECIFIER_RE)].map((m) => m[1]!),
    valueImports: transpiler.scanImports(raw),
  };
}

function clientFiles(): Scanned[] {
  return (readdirSync(CLIENT, { recursive: true }) as string[])
    .filter((p) => /\.tsx?$/.test(p) && !p.endsWith(".d.ts"))
    .map((p) => join(CLIENT, p))
    .filter((p) => statSync(p).isFile())
    .sort()
    .map((p) => scanSource(relative(CLIENT, p), readFileSync(p, "utf8")));
}

const isSign = (s: string): boolean => s === SIGN || s.startsWith(`${SIGN}/`);
const resolvesIntoServer = (rel: string, spec: string): boolean =>
  spec.startsWith(".") && `${resolve(dirname(join(CLIENT, rel)), spec)}/`.startsWith(`${SERVER}/`);
const resolvesIntoDialogs = (rel: string, spec: string): boolean =>
  spec.startsWith(".") && resolve(dirname(join(CLIENT, rel)), spec).startsWith(`${DIALOGS}/`);

/** The four checks, over any set of scanned files. Returns "<file> :: <rule>" offenders. */
function offenders(files: readonly Scanned[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const s of f.allSpecifiers) {
      if (isSign(s)) out.push(`${f.rel} :: sign`);
      if (resolvesIntoServer(f.rel, s)) out.push(`${f.rel} :: server`);
    }
    for (const i of f.valueImports) {
      if (i.path === PROPOSALS && !PROPOSALS_RUNTIME_ALLOWED.has(f.rel)) out.push(`${f.rel} :: proposals-runtime`);
      if (i.kind !== "dynamic-import" && resolvesIntoDialogs(f.rel, i.path)) out.push(`${f.rel} :: static-dialog`);
    }
  }
  return out;
}

describe("client import boundaries — self-test (REQ-SEC-07, 10 §5.3)", () => {
  test("each matcher catches a synthetic violation (the guard cannot pass vacuously)", () => {
    expect(offenders([scanSource("views/x.tsx", `import { signProposal } from "@pulse/core/proposals/sign";`)]))
      .toEqual(["views/x.tsx :: sign"]);
    expect(offenders([scanSource("views/x.tsx", `import type { VerifyResult } from "@pulse/core/proposals/sign";`)]))
      .toEqual(["views/x.tsx :: sign"]);
    expect(offenders([scanSource("views/alerts/x.ts", `import { MUTATION_PATH_PREFIX } from "../../../server/mutations/constants.js"; console.log(MUTATION_PATH_PREFIX);`)]))
      .toEqual(["views/alerts/x.ts :: server"]);
    expect(offenders([scanSource("mutations/x.ts", `const m = import("../../server/config.js");`)]))
      .toEqual(["mutations/x.ts :: server"]);
    expect(offenders([scanSource("mutations/x.ts", `import { fieldApplies } from "@pulse/core/proposals"; fieldApplies;`)]))
      .toEqual(["mutations/x.ts :: proposals-runtime"]);
    expect(offenders([scanSource("mutations/Foo.tsx", `import AckDialog from "./dialogs/AckDialog.js"; AckDialog;`)]))
      .toEqual(["mutations/Foo.tsx :: static-dialog"]);
  });

  test("allowed shapes are not flagged: type-only, dynamic dialog import, allowlisted runtime, comments", () => {
    expect(offenders([scanSource("mutations/x.ts", `import type { ProposalValue } from "@pulse/core/proposals";`)])).toEqual([]);
    expect(offenders([scanSource("mutations/x.ts", `import { type ProposalValue } from "@pulse/core/proposals";`)])).toEqual([]);
    expect(offenders([scanSource("mutations/dialogs/ProposeDialog.tsx", `import { fieldApplies } from "@pulse/core/proposals"; fieldApplies;`)])).toEqual([]);
    expect(offenders([scanSource("mutations/Foo.tsx",
      `import type { AckDialogProps } from "./dialogs/AckDialog.js";\nconst l = () => import("./dialogs/AckDialog.js");`)])).toEqual([]);
    expect(offenders([scanSource("mutations/x.ts", `// never import "@pulse/core/proposals/sign" or from "../../server/x.js"\nexport {};`)])).toEqual([]);
  });
});

describe("client import boundaries (REQ-SEC-07, REQ-SEC-04, 10 §5.3)", () => {
  const files = clientFiles();

  test("the scanned client file list is non-empty and includes the mutation layer", () => {
    expect(files.length).toBeGreaterThan(0);
    const rels = files.map((f) => f.rel);
    for (const r of PROPOSALS_RUNTIME_ALLOWED) expect(rels).toContain(r);
    expect(rels.filter((r) => r.startsWith("mutations/dialogs/")).length).toBeGreaterThanOrEqual(4);
  });

  test("no client file imports @pulse/core/proposals/sign (REQ-SEC-04, REQ-SEC-07)", () => {
    const bad = offenders(files).filter((o) => o.endsWith(":: sign"));
    expect(bad, bad.join(", ")).toEqual([]);
  });

  test("no client file has a relative specifier resolving into src/server (REQ-SEC-07)", () => {
    const bad = offenders(files).filter((o) => o.endsWith(":: server"));
    expect(bad, bad.join(", ")).toEqual([]);
  });

  test("runtime @pulse/core/proposals imports only in ProposeDialog.tsx / ProposalList.tsx (REQ-SEC-07)", () => {
    const bad = offenders(files).filter((o) => o.endsWith(":: proposals-runtime"));
    expect(bad, bad.join(", ")).toEqual([]);
  });

  test("dialogs/*.tsx are never statically value-imported — lazy chunks only (REQ-SEC-07, 01 §3.3)", () => {
    const bad = offenders(files).filter((o) => o.endsWith(":: static-dialog"));
    expect(bad, bad.join(", ")).toEqual([]);
    // Positive control: the dialogs ARE reached, dynamically.
    const dynamicDialogImports = files.flatMap((f) =>
      f.valueImports.filter((i) => i.kind === "dynamic-import" && resolvesIntoDialogs(f.rel, i.path)));
    expect(dynamicDialogImports.length).toBeGreaterThanOrEqual(4);
  });
});

describe("client matcher bounds pinned to the server (REQ-SEC-07, 05)", () => {
  const source = readFileSync(join(CLIENT, "mutations/matchers.ts"), "utf8");
  const literal = (name: string): number => {
    const m = new RegExp(`\\bconst\\s+${name}\\s*=\\s*(\\d+)\\s*;`).exec(source);
    if (m === null) throw new Error(`${name} literal not found in matchers.ts`);
    return Number(m[1]);
  };

  test("matchers.ts label byte literals equal SILENCE_MATCHER_NAME/VALUE_MAX_BYTES", () => {
    expect(literal("LABEL_NAME_MAX_BYTES")).toBe(SILENCE_MATCHER_NAME_MAX_BYTES);
    expect(literal("LABEL_VALUE_MAX_BYTES")).toBe(SILENCE_MATCHER_VALUE_MAX_BYTES);
  });

  test("matcherIssue enforces exactly the server bounds at the boundary", () => {
    const name = (n: number): string => "a".repeat(n);
    expect(matcherIssue({ name: name(SILENCE_MATCHER_NAME_MAX_BYTES), value: "v" })).toBeNull();
    expect(matcherIssue({ name: name(SILENCE_MATCHER_NAME_MAX_BYTES + 1), value: "v" })).not.toBeNull();
    expect(matcherIssue({ name: "job", value: "v".repeat(SILENCE_MATCHER_VALUE_MAX_BYTES) })).toBeNull();
    expect(matcherIssue({ name: "job", value: "v".repeat(SILENCE_MATCHER_VALUE_MAX_BYTES + 1) })).not.toBeNull();
  });
});
