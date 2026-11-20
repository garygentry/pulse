// Push module boundaries: a static import scan of apps/web/src/server/push/** and of every file outside it that
// imports from it. push/** stays off the read pipeline (it reads the read model only through ServerRuntime), may use
// only the named mutation helpers, and is entered from outside through a fixed allowlist of edges. apps/web/tests/**
// is exempt.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../../..");
const SERVER = join(REPO, "apps/web/src/server");
const PUSH = join(SERVER, "push");

/** Trees scanned for external importers of push/** (tests are exempt). */
const IMPORTER_ROOTS = ["apps/web/src", "apps/web/scripts", "apps/cli/src", "packages"] as const;

// ---------------------------------------------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------------------------------------------

/** One static or dynamic import edge of a source file. */
interface ImportEdge {
  readonly specifier: string;
  /** True when the edge carries types only (`import type`, or every named binding marked `type`). */
  readonly typeOnly: boolean;
  /** Named bindings (without `type`), or `*` / `default` / `side-effect` / `dynamic`. */
  readonly names: readonly string[];
}

const STATIC_RE = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Line and block comments, or a string literal (kept), matched left to right in one pass. */
const COMMENT_OR_STRING_RE = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** Strip comments so commented-out imports never count (one pass, so `/*` inside a line comment is inert). */
function stripComments(source: string): string {
  return source.replace(COMMENT_OR_STRING_RE, (_m, str: string | undefined) => str ?? "");
}

/** Every import edge of `source`. */
function importsOf(source: string): ImportEdge[] {
  const text = stripComments(source);
  const edges: ImportEdge[] = [];
  for (const m of text.matchAll(STATIC_RE)) {
    const typeKeyword = m[2] !== undefined;
    const clause = (m[3] ?? "").trim();
    const specifier = m[4] ?? "";
    const names: string[] = [];
    let allTypes = true;
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces !== null) {
      for (const raw of (braces[1] ?? "").split(",")) {
        const part = raw.trim();
        if (part === "") continue;
        const isType = part.startsWith("type ");
        if (!isType) allTypes = false;
        names.push((isType ? part.slice(5) : part).split(/\s+as\s+/)[0]!.trim());
      }
    }
    const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
    if (outside.startsWith("*")) {
      names.push("*");
      allTypes = false;
    } else if (outside !== "") {
      names.push("default");
      allTypes = false;
    }
    edges.push({ specifier, typeOnly: typeKeyword || (names.length > 0 && allTypes), names });
  }
  for (const m of text.matchAll(SIDE_EFFECT_RE)) {
    edges.push({ specifier: m[1] ?? "", typeOnly: false, names: ["side-effect"] });
  }
  for (const m of text.matchAll(DYNAMIC_RE)) {
    edges.push({ specifier: m[1] ?? "", typeOnly: false, names: ["dynamic"] });
  }
  return edges;
}

/** Repo-relative target of a relative specifier (`.js` → `.ts`), or null for a package specifier. */
function resolveTarget(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const abs = resolve(dirname(join(REPO, fromFile)), specifier).replace(/\.js$/, ".ts");
  return relative(REPO, abs);
}

// ---------------------------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------------------------

const SERVER_REL = "apps/web/src/server/";
const PUSH_REL = "apps/web/src/server/push/";

/** Violations of the rules for a file inside push/** (`file` is repo-relative). */
function pushFileViolations(file: string, source: string): string[] {
  const out: string[] = [];
  for (const edge of importsOf(source)) {
    const where = `${file} → ${edge.specifier}`;
    if (edge.specifier === "@pulse/web-data/cycle") {
      // Registry bytes only: canonicalJson and nothing else from the cycle package.
      if (edge.names.length === 0 || edge.names.some((n) => n !== "canonicalJson")) {
        out.push(`${where}: only canonicalJson may come from @pulse/web-data/cycle`);
      }
      continue;
    }
    const target = resolveTarget(file, edge.specifier);
    if (target === null || target.startsWith(PUSH_REL)) continue;
    if (!target.startsWith(SERVER_REL)) {
      if (target.startsWith("apps/web/src/client/")) out.push(`${where}: push/** never imports the web client`);
      continue;
    }
    const rel = target.slice(SERVER_REL.length);
    const segments = rel.split("/");
    if (segments.some((s) => s.startsWith("cycle") || s.startsWith("fold"))) {
      out.push(`${where}: push/** never imports the server's cycle or fold modules`);
    } else if (rel.startsWith("history/") || rel.startsWith("sources/")) {
      out.push(`${where}: push/** never imports history/** or sources/**`);
    } else if (rel.startsWith("routes/") && rel !== "routes/metrics.ts") {
      out.push(`${where}: push/** imports routes/metrics.ts only from routes/`);
    } else if (rel === "router.ts" || rel === "index.ts") {
      out.push(`${where}: push/** never imports the router or the entry point`);
    } else if (rel.startsWith("mutations/")) {
      if (rel === "mutations/refusal.ts") {
        if (!edge.typeOnly) out.push(`${where}: mutations/refusal.ts is imported for types only (never refuse())`);
      } else if (rel !== "mutations/guards.ts" && rel !== "mutations/stores/atomic-file.ts") {
        out.push(`${where}: push/** may import only guards.ts, stores/atomic-file.ts and refusal.ts from mutations/`);
      }
    } else if ((rel === "refresh.ts" || rel === "config.ts") && !edge.typeOnly) {
      out.push(`${where}: ${rel} is imported for types only (the read model is reached through ServerRuntime)`);
    }
  }
  return out;
}

/** One allowed external edge into push/**. */
interface AllowedEdge {
  /** Importer: an exact repo-relative path, or a directory prefix ending in "/". */
  readonly from: string;
  /** Target: an exact push file, or a push directory prefix ending in "/". */
  readonly to: string;
  /** The edge must be type-only. */
  readonly typesOnly?: boolean;
  /** When set, only these named bindings may be imported. */
  readonly names?: readonly string[];
}

const SCRIPTS = "apps/web/scripts/contract/";

/** The full allowlist of importers of push/** outside push/** and the test trees. */
const EXTERNAL_ALLOWLIST: readonly AllowedEdge[] = [
  { from: `${SERVER_REL}index.ts`, to: `${PUSH_REL}bootstrap.ts` },
  { from: `${SERVER_REL}router.ts`, to: `${PUSH_REL}routes.ts` },
  { from: `${SERVER_REL}config.ts`, to: `${PUSH_REL}config.ts`, names: ["parsePushConfig", "PushConfigState"] },
  { from: `${SERVER_REL}routes/metrics.ts`, to: `${PUSH_REL}plan.ts`, typesOnly: true, names: ["NotificationKind"] },
  { from: SCRIPTS, to: `${PUSH_REL}handlers/` },
  { from: SCRIPTS, to: `${PUSH_REL}bootstrap.ts` },
  { from: SCRIPTS, to: `${PUSH_REL}payload.ts` },
  { from: SCRIPTS, to: `${PUSH_REL}ids.ts`, typesOnly: true },
  { from: SCRIPTS, to: `${PUSH_REL}dispatch/queue.ts`, typesOnly: true },
  // The contract operations and scenario rows reuse the route paths, the planner's collapse-id and severity
  // helpers and the webhook alert type rather than restating them.
  { from: SCRIPTS, to: `${PUSH_REL}constants.ts`, names: ["PUSH_PATHS", "PUSH_LIMITS"] },
  // The fixture stub runtime holds its placeholder operator secret the way the server does.
  { from: SCRIPTS, to: `${PUSH_REL}secrets.ts`, names: ["loadPushSecret"] },
  { from: SCRIPTS, to: `${PUSH_REL}plan.ts`, names: ["groupCollapseId", "severityOf"] },
  { from: SCRIPTS, to: `${PUSH_REL}webhook.ts`, typesOnly: true },
];

function matches(pattern: string, path: string): boolean {
  return pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern;
}

/** Violations for a file outside push/** (`file` is repo-relative). */
function externalFileViolations(file: string, source: string): string[] {
  const out: string[] = [];
  for (const edge of importsOf(source)) {
    const target = resolveTarget(file, edge.specifier);
    if (target === null || !target.startsWith(PUSH_REL)) continue;
    const where = `${file} → ${edge.specifier}`;
    const rules = EXTERNAL_ALLOWLIST.filter((r) => matches(r.from, file) && matches(r.to, target));
    const ok = rules.some(
      (r) =>
        (r.typesOnly !== true || edge.typeOnly) &&
        (r.names === undefined || (edge.names.length > 0 && edge.names.every((n) => r.names!.includes(n)))),
    );
    if (!ok) out.push(`${where}: not an allowed importer of push/** (or the imported names/kind are not allowed)`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "tests" || name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(abs);
  }
  return out;
}

const pushFiles = walk(PUSH).map((abs) => relative(REPO, abs));
const externalFiles = IMPORTER_ROOTS.flatMap((root) => walk(join(REPO, root)))
  .map((abs) => relative(REPO, abs))
  .filter((f) => !f.startsWith(PUSH_REL));

const read = (file: string): string => readFileSync(join(REPO, file), "utf8");

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe("push boundaries: import extraction", () => {
  test("type-only, mixed, namespace, default, re-export, side-effect and dynamic imports are classified", () => {
    const edges = importsOf(
      [
        'import type { A } from "./a.js";',
        'import { type B, c } from "./b.js";',
        'import { type D, type E } from "./d.js";',
        'import * as ns from "./ns.js";',
        'import def, { f } from "./def.js";',
        'export type { G } from "./g.js";',
        'export { h as hh } from "./h.js";',
        'import "./side.js";',
        'const m = await import("./dyn.js");',
        '// import { gone } from "./commented.js";',
        "// a line comment naming `/api/push/*` must not open a block comment",
        'import { afterComment } from "./after-comment.js";',
        "import {\n  multi,\n  type Line,\n} from \"./multi.js\";",
      ].join("\n"),
    );
    const by = Object.fromEntries(edges.map((e) => [e.specifier, e]));
    expect(by["./a.js"]).toMatchObject({ typeOnly: true, names: ["A"] });
    expect(by["./b.js"]).toMatchObject({ typeOnly: false, names: ["B", "c"] });
    expect(by["./d.js"]).toMatchObject({ typeOnly: true, names: ["D", "E"] });
    expect(by["./ns.js"]).toMatchObject({ typeOnly: false, names: ["*"] });
    expect(by["./def.js"]).toMatchObject({ typeOnly: false });
    expect(by["./g.js"]).toMatchObject({ typeOnly: true, names: ["G"] });
    expect(by["./h.js"]).toMatchObject({ typeOnly: false, names: ["h"] });
    expect(by["./side.js"]).toMatchObject({ typeOnly: false, names: ["side-effect"] });
    expect(by["./dyn.js"]).toMatchObject({ typeOnly: false, names: ["dynamic"] });
    expect(by["./commented.js"]).toBeUndefined();
    expect(by["./after-comment.js"]).toMatchObject({ typeOnly: false, names: ["afterComment"] });
    expect(by["./multi.js"]).toMatchObject({ typeOnly: false, names: ["multi", "Line"] });
  });
});

describe("push boundaries: the rules reject forbidden imports (fixture strings)", () => {
  const FILE = `${PUSH_REL}probe.ts`;
  const NESTED = `${PUSH_REL}handlers/probe.ts`;

  test.each([
    ["the server's cycle module", FILE, 'import { runCycle } from "../cycle.js";'],
    ["a fold module", FILE, 'import { foldOverview } from "../snapshot/fold-overview.js";'],
    ["history/**", FILE, 'import { readHistory } from "../history/store.js";'],
    ["sources/**", NESTED, 'import { createSources } from "../../sources/index.js";'],
    ["a route other than metrics", FILE, 'import { json } from "../routes/respond.js";'],
    ["the router", FILE, 'import { dispatch } from "../router.js";'],
    ["the entry point", FILE, 'import { main } from "../index.js";'],
    ["a value from mutations/refusal.ts", FILE, 'import { refuse } from "../mutations/refusal.js";'],
    ["another mutations module", FILE, 'import { createAuditLog } from "../mutations/audit.js";'],
    ["a value from refresh.ts", FILE, 'import { createServerRuntime } from "../refresh.js";'],
    ["a non-canonicalJson cycle export", FILE, 'import { canonicalJson, buildCycle } from "@pulse/web-data/cycle";'],
    ["a cycle namespace import", FILE, 'import * as cycle from "@pulse/web-data/cycle";'],
    ["the web client", FILE, 'import { App } from "../../client/app.js";'],
  ])("push/** importing %s is a violation", (_label, file, source) => {
    expect(pushFileViolations(file, source)).toHaveLength(1);
  });

  test("the permitted push imports pass", () => {
    const source = [
      'import { canonicalJson } from "@pulse/web-data/cycle";',
      'import type { RefusalReason } from "../mutations/refusal.js";',
      'import { checkSameOrigin } from "../mutations/guards.js";',
      'import { writeFileAtomic } from "../mutations/stores/atomic-file.js";',
      'import { recordPushWebhook } from "../routes/metrics.js";',
      'import type { ServerRuntime } from "../refresh.js";',
      'import { log } from "../log.js";',
      'import { PUSH_LIMITS } from "./constants.js";',
    ].join("\n");
    expect(pushFileViolations(FILE, source)).toEqual([]);
  });

  test.each([
    ["an unlisted server module", `${SERVER_REL}routes/current.ts`, 'import { planDeliveries } from "../push/plan.js";'],
    ["routes/metrics.ts with a value import", `${SERVER_REL}routes/metrics.ts`, 'import { planDeliveries } from "../push/plan.js";'],
    ["index.ts reaching past bootstrap", `${SERVER_REL}index.ts`, 'import { createIntake } from "./push/intake.js";'],
    ["config.ts importing an extra name", `${SERVER_REL}config.ts`, 'import { parsePushConfig, parsePushDataDir } from "./push/config.js";'],
    ["the contract scripts with a value from ids.ts", `${SCRIPTS}stub.ts`, 'import { newCredential } from "../../src/server/push/ids.js";'],
    ["the contract scripts reaching the store", `${SCRIPTS}stub.ts`, 'import { createDeviceStore } from "../../src/server/push/registry/store.js";'],
    ["the CLI", "apps/cli/src/commands/push/client.ts", 'import { PUSH_PATHS } from "../../../../web/src/server/push/constants.js";'],
    ["the web client", "apps/web/src/client/views/connect/view.tsx", 'import type { PushRuntime } from "../../../server/push/bootstrap.js";'],
  ])("%s is not an allowed importer", (_label, file, source) => {
    expect(externalFileViolations(file, source)).toHaveLength(1);
  });

  test("the allowlisted edges pass", () => {
    expect(externalFileViolations(`${SERVER_REL}index.ts`, 'import { buildPushRuntime, type PushRuntime } from "./push/bootstrap.js";')).toEqual([]);
    expect(externalFileViolations(`${SERVER_REL}routes/metrics.ts`, 'import type { NotificationKind } from "../push/plan.js";')).toEqual([]);
    expect(externalFileViolations(`${SCRIPTS}stub.ts`, 'import type { Clock } from "../../src/server/push/ids.js";')).toEqual([]);
    expect(externalFileViolations(`${SCRIPTS}stub.ts`, 'import { handleRedeem } from "../../src/server/push/handlers/redeem.js";')).toEqual([]);
  });
});

describe("push boundaries: the real tree", () => {
  test("the scan sees the push tree and its known importers", () => {
    expect(pushFiles).toContain(`${PUSH_REL}bootstrap.ts`);
    expect(pushFiles).toContain(`${PUSH_REL}registry/store.ts`);
    expect(externalFiles).toContain(`${SERVER_REL}index.ts`);
    expect(externalFiles).toContain(`${SERVER_REL}router.ts`);
  });

  test("the extractor finds every `from \"…\"` line of the scanned files (no silent miss)", () => {
    const FROM_LINE = /^\s*(?:import|export|\}).*\bfrom\s+["'][^"']+["'];?\s*(?:\/\/.*)?$/gm;
    for (const f of [...pushFiles, ...externalFiles.filter((x) => x.startsWith(SERVER_REL))]) {
      const source = read(f);
      const expected = source.match(FROM_LINE)?.length ?? 0;
      const found = importsOf(source).filter((e) => !e.names.includes("side-effect") && !e.names.includes("dynamic")).length;
      expect(found, f).toBe(expected);
    }
  });

  test("push/** imports only what the rules allow", () => {
    const violations = pushFiles.flatMap((f) => pushFileViolations(f, read(f)));
    expect(violations).toEqual([]);
  });

  test("push/** never calls the mutation refuse()", () => {
    for (const f of pushFiles) {
      for (const edge of importsOf(read(f))) {
        if (edge.specifier.endsWith("mutations/refusal.js")) expect(edge.typeOnly, f).toBe(true);
      }
    }
  });

  test("every importer of push/** outside it is on the allowlist", () => {
    const violations = externalFiles.flatMap((f) => externalFileViolations(f, read(f)));
    expect(violations).toEqual([]);
  });

  test("the entry point, router, config and metrics edges exist", () => {
    const importers = new Set(
      externalFiles.filter((f) => importsOf(read(f)).some((e) => resolveTarget(f, e.specifier)?.startsWith(PUSH_REL))),
    );
    for (const f of ["index.ts", "router.ts", "config.ts", "routes/metrics.ts"]) {
      expect(importers.has(`${SERVER_REL}${f}`), f).toBe(true);
    }
  });
});
