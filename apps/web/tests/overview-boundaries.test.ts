// apps/web/tests/overview-boundaries.test.ts — overview-redesign static boundary guard + lazy-chunk
// build assertions (08-testing-strategy.md §§6.1–6.2, 01-architecture-layout.md, 07-integration-points).
//
// Scope: PRODUCTION files under apps/web/src/client/views/overview/** only (.ts/.tsx; no stylesheet —
// the view styles with library token classes). Tests,
// fixtures (apps/web/tests/fixtures/overview/**) and browser suites are never scanned as production.
//
// Protections:
//   1. Import allowlist by RESOLVED path. Every relative specifier, resolved against its importing
//      file, lands under views/overview/** or on exactly one allowlisted shared module
//      (client/{ui,viz,a11y,theme}/index.ts, client/store/index.ts, client/store/types.ts — type-only,
//      05 §3.1 SelectedTarget —, client/router.ts, client/api/client.ts, client/format.ts,
//      src/shared/registry.ts). Bare specifiers: @pulse/web-data/wire, react, @preact/signals-react/runtime.
//   2. No `/api/overview`, EventSource/SSE, upstream source, PromQL string, mutation HTTP verb,
//      server-private import or overview-local snapshot validator.
//   3. The sole direct API path is history.ts's fixed `estate.liveness?range=1h` request, issued
//      through the single `apiFetch` call.
//   4. No uplot, TimeSeriesChart, private shared component file or local status-label map.
//   5. index.ts holds the dynamic `import("./view.js")` and no static `view` value import.
// Plus the build assertion: after the production build, overview view JS is absent from the
// initial-route entry outputs and present in exactly one lazy route chunk, and no CSS output is built
// from an overview source (the chunk's only CSS is uPlot's, folded in from the @/ui chart).
//
// Explicit NON-GOALS (08 §6.2): this lexical/import guard does NOT prove runtime authorization,
// application security as a whole, tree-shaking byte size, visual contrast, endpoint correctness,
// or accessibility. Those belong to the runtime (overview-*.test.ts), build (build-budget.test.ts)
// and browser (tests/browser/overview-*.test.ts) gates.
//
// Method: import inspection uses Bun.Transpiler.scanImports (value imports; type-only imports are
// elided) cross-checked against a narrow line-anchored lexical scan that also sees `import type`.
// Code-content checks run over Bun.Transpiler output, so comments and types never count.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import type { ClientManifest } from "../src/server/assets.js";
import type { BuildMetafile, ClientBuildResult } from "../scripts/build-client.js";

const WEB_ROOT = resolve(import.meta.dir, "..");
const SRC = join(WEB_ROOT, "src");
const CLIENT = join(SRC, "client");
const OVERVIEW = join(CLIENT, "views/overview");

/** Shared modules an overview production file may import (resolved absolute paths). */
const ALLOWED_SHARED = new Set(
  [
    "client/ui/index.ts",
    "client/a11y/index.ts",
    "client/theme/index.ts",
    "client/store/index.ts",
    "client/store/types.ts",
    "client/router.ts",
    "client/api/client.ts",
    "client/format.ts",
    "shared/registry.ts",
  ].map((p) => join(SRC, p)),
);
/** Allowlisted only for `import type` / `export type` (05 §3.1 SelectedTarget). */
const TYPE_ONLY_SHARED = new Set([join(SRC, "client/store/types.ts")]);
// `@/ui` is the vendored library barrel (src/client/ui/index.ts); deep `@/ui/...` stays forbidden.
const ALLOWED_BARE = new Set(["@pulse/web-data/wire", "react", "@preact/signals-react/runtime", "@/ui"]);

const HISTORY_PATH_LITERAL =
  "`/api/history/target/${encodeURIComponent(drilldownId)}/estate.liveness?range=1h`";

// ---------------------------------------------------------------------------------------------
// Production file inventory
// ---------------------------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const ALL_FILES = walk(OVERVIEW);
const CODE_FILES = ALL_FILES.filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f));
const CSS_FILES = ALL_FILES.filter((f) => f.endsWith(".css"));
const rel = (f: string): string => relative(OVERVIEW, f);

interface ImportStatement {
  readonly spec: string;
  readonly typeOnly: boolean;
  readonly statement: string;
}

interface CodeFile {
  readonly path: string;
  readonly raw: string;
  /** Transpiled JS: comments and types removed, string literals intact. */
  readonly code: string;
  /** Value imports as Bun's parser sees them (type-only imports elided). */
  readonly valueImports: readonly { path: string; kind: string }[];
  /** Every static import/export-from statement, including `import type`. */
  readonly statements: readonly ImportStatement[];
}

const STATIC_IMPORT_RE =
  /^[ \t]*(import|export)\b(\s+type\b)?([^;'"`]*?)\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT_RE = /^[ \t]*import\s*["']([^"']+)["']/gm;

function lexicalStatements(raw: string): ImportStatement[] {
  const out: ImportStatement[] = [];
  for (const m of raw.matchAll(STATIC_IMPORT_RE)) {
    const clause = m[3] ?? "";
    // `import { type A, type B } from` is type-only too (all named specifiers carry `type`).
    const inlineAllType =
      /^\s*\{[^}]*\}\s*$/.test(clause) &&
      clause
        .replace(/[{}]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .every((s) => s.startsWith("type "));
    out.push({ spec: m[4]!, typeOnly: m[2] !== undefined || inlineAllType, statement: m[0].trim() });
  }
  for (const m of raw.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    out.push({ spec: m[1]!, typeOnly: false, statement: m[0].trim() });
  }
  return out;
}

function loadCodeFile(path: string): CodeFile {
  const raw = readFileSync(path, "utf8");
  const transpiler = new Bun.Transpiler({ loader: path.endsWith(".tsx") ? "tsx" : "ts" });
  return {
    path,
    raw,
    code: transpiler.transformSync(raw),
    valueImports: transpiler.scanImports(raw),
    statements: lexicalStatements(raw),
  };
}

const FILES: readonly CodeFile[] = CODE_FILES.map(loadCodeFile);
const byRel = (name: string): CodeFile => {
  const f = FILES.find((x) => rel(x.path) === name);
  if (f === undefined) throw new Error(`overview production file ${name} not found`);
  return f;
};

/** Resolve a relative specifier to an existing source file (`.js` → `.ts`/`.tsx`), or null. */
function resolveSpecifier(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  const candidates =
    extname(base) === ".js"
      ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base]
      : [base];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const isRelative = (spec: string): boolean => spec.startsWith("./") || spec.startsWith("../");
const underOverview = (abs: string): boolean => abs === OVERVIEW || abs.startsWith(`${OVERVIEW}/`);

// ---------------------------------------------------------------------------------------------
// Static guard
// ---------------------------------------------------------------------------------------------

describe("overview boundaries — inventory", () => {
  test("scans only views/overview/** production sources, never tests or fixtures", () => {
    expect(CODE_FILES.length).toBeGreaterThan(10);
    for (const name of ["index.ts", "view.tsx", "history.ts", "model.ts", "a11y.ts"]) {
      expect(CODE_FILES.map(rel)).toContain(name);
    }
    expect(CSS_FILES.map(rel), "the overview styles with token classes; it ships no stylesheet").toEqual([]);
    for (const f of ALL_FILES) {
      expect(underOverview(f)).toBe(true);
      expect(f).not.toMatch(/\/tests?\/|\/fixtures?\/|\.test\.tsx?$/);
    }
  });

  test("the lexical scan sees every value import Bun's parser reports (no silent misses)", () => {
    for (const file of FILES) {
      const lexical = new Set(file.statements.map((s) => s.spec));
      for (const imp of file.valueImports) {
        // require-call entries are the transpiler's injected JSX runtime, not authored imports.
        if (imp.kind !== "import-statement") continue;
        expect(lexical.has(imp.path), `${rel(file.path)}: ${imp.path} missed by lexical scan`).toBe(
          true,
        );
      }
    }
  });
});

describe("protection 1 — resolved-path import allowlist", () => {
  test("every relative specifier resolves under views/overview/** or to one allowlisted module", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const specs = [
        ...file.statements.map((s) => s.spec),
        ...file.valueImports.filter((i) => i.kind === "dynamic-import").map((i) => i.path),
      ];
      for (const spec of specs) {
        if (!isRelative(spec)) {
          if (!ALLOWED_BARE.has(spec)) violations.push(`${rel(file.path)}: bare "${spec}"`);
          continue;
        }
        const target = resolveSpecifier(file.path, spec);
        if (target === null) {
          violations.push(`${rel(file.path)}: "${spec}" does not resolve to a source file`);
        } else if (!underOverview(target) && !ALLOWED_SHARED.has(target)) {
          violations.push(`${rel(file.path)}: "${spec}" → ${relative(SRC, target)} not allowlisted`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("client/store/types.ts is imported type-only (never as a value)", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      for (const s of file.statements) {
        if (!isRelative(s.spec)) continue;
        const target = resolveSpecifier(file.path, s.spec);
        if (target !== null && TYPE_ONLY_SHARED.has(target) && !s.typeOnly) {
          violations.push(`${rel(file.path)}: ${s.statement}`);
        }
      }
      for (const imp of file.valueImports) {
        if (!isRelative(imp.path)) continue;
        const target = resolveSpecifier(file.path, imp.path);
        if (target !== null && TYPE_ONLY_SHARED.has(target)) {
          violations.push(`${rel(file.path)}: value import of ${imp.path}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the allowlist accepts ../../ and ../../../ forms of the same shared module", () => {
    const top = join(OVERVIEW, "selectors.ts");
    const nested = join(OVERVIEW, "stats/StatHeader.tsx");
    expect(resolveSpecifier(top, "../../a11y/index.js")).toBe(join(CLIENT, "a11y/index.ts"));
    expect(resolveSpecifier(nested, "../../../a11y/index.js")).toBe(join(CLIENT, "a11y/index.ts"));
    expect(resolveSpecifier(nested, "../../../../shared/registry.js")).toBe(
      join(SRC, "shared/registry.ts"),
    );
    // A private shared file resolves fine but is NOT allowlisted.
    const privateFile = resolveSpecifier(top, "../../a11y/status-labels.js");
    expect(privateFile).not.toBeNull();
    expect(ALLOWED_SHARED.has(privateFile!)).toBe(false);
  });
});

describe("protection 2 — no direct feed, upstream, PromQL, mutation or local validator", () => {
  const FORBIDDEN: readonly [string, RegExp][] = [
    ["/api/overview", /\/api\/overview/],
    ["EventSource", /\bEventSource\b/],
    ["SSE content type", /text\/event-stream/],
    ["WebSocket", /\bWebSocket\b/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["sendBeacon", /\bsendBeacon\b/],
    ["upstream Prometheus/Alertmanager API", /\/api\/v[12]\/(?:query|query_range|alerts|silences|rules|series)\b/],
    ["upstream source name", /\b(?:prometheus|alertmanager)\b/i],
    ["PromQL function", /\b(?:irate|rate|increase|delta|deriv|histogram_quantile|\w+_over_time)\s*\(/],
    ["PromQL range selector", /\[\d+[smhdwy]\]/],
    ["PromQL label matcher", /\b[a-z_:][\w:]*\{\s*[a-z_]\w*\s*[=!]~?\s*\\?["']/],
    ["mutation HTTP verb", /["'`](?:POST|PUT|PATCH|DELETE)["'`]/],
    ["request method option", /\bmethod\s*:/],
    ["overview-local snapshot validator", /\bvalidate\w*Snapshot\w*/],
  ];

  test("no forbidden token in any overview production module (comments/types excluded)", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      for (const [label, re] of FORBIDDEN) {
        const m = file.code.match(re);
        if (m) violations.push(`${rel(file.path)}: ${label} (${JSON.stringify(m[0])})`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("no server-private, node or package-internal import", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      for (const s of file.statements) {
        if (/(?:^|\/)server\/|^node:|^bun:|\/packages\/|^@pulse\/(?!web-data\/wire$)/.test(s.spec)) {
          violations.push(`${rel(file.path)}: ${s.spec}`);
        }
        if (isRelative(s.spec)) {
          const target = resolveSpecifier(file.path, s.spec);
          if (target !== null && target.startsWith(`${join(SRC, "server")}/`)) {
            violations.push(`${rel(file.path)}: ${s.spec} → server`);
          }
        }
      }
      if (/\brequire\s*\(/.test(file.raw)) violations.push(`${rel(file.path)}: require()`);
    }
    expect(violations).toEqual([]);
  });
});

describe("protection 3 — the sole API request is history.ts's fixed liveness path", () => {
  test("apiFetch appears only in history.ts, called exactly once", () => {
    const users = FILES.filter((f) => /\bapiFetch\b/.test(f.raw)).map((f) => rel(f.path));
    expect(users).toEqual(["history.ts"]);
    expect(byRel("history.ts").code.match(/\bapiFetch\s*\(/g) ?? []).toHaveLength(1);
  });

  test("no module calls fetch directly", () => {
    const violations = FILES.filter((f) => /\bfetch\s*\(/.test(f.code)).map((f) => rel(f.path));
    expect(violations).toEqual([]);
  });

  test("the only /api/ literal is the fixed estate.liveness?range=1h template in history.ts", () => {
    const apiLiterals = FILES.flatMap((f) =>
      (f.code.match(/["'`]\/api\/[^"'`]*["'`]/g) ?? []).map((lit) => `${rel(f.path)}: ${lit}`),
    );
    expect(apiLiterals).toHaveLength(1);
    expect(apiLiterals[0]!.startsWith("history.ts: ")).toBe(true);
    expect(byRel("history.ts").raw).toContain(HISTORY_PATH_LITERAL);
  });

  test("the controller transport is only ever called with targetHistoryPath(...)", () => {
    const code = byRel("history.ts").code;
    const calls = code.match(/\bfetchHistory\s*\(/g) ?? [];
    const fixed = code.match(/\bfetchHistory\s*\(\s*targetHistoryPath\s*\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(fixed.length).toBe(calls.length);
    expect(code).not.toMatch(/\boptions\.fetch\s*\(/);
  });

  test("targetHistoryPath yields the fixed, encoded liveness request", async () => {
    const { targetHistoryPath } = await import("../src/client/views/overview/history.js");
    expect(targetHistoryPath("svc:host-001/a b")).toBe(
      "/api/history/target/svc%3Ahost-001%2Fa%20b/estate.liveness?range=1h",
    );
  });
});

describe("protection 4 — no uplot, TimeSeriesChart, private shared file or local label map", () => {
  test("no uplot or TimeSeriesChart in code or import specifiers", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      if (/uplot/i.test(file.code)) violations.push(`${rel(file.path)}: uplot`);
      if (/\bTimeSeriesChart\b/.test(file.code)) violations.push(`${rel(file.path)}: TimeSeriesChart`);
      for (const s of file.statements) {
        if (/uplot|TimeSeriesChart/i.test(s.spec)) violations.push(`${rel(file.path)}: ${s.spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("shared ui/a11y/theme are imported only through their barrels", () => {
    const privateRoots = ["ui", "a11y", "theme"].map((d) => join(CLIENT, d));
    const violations: string[] = [];
    for (const file of FILES) {
      for (const s of file.statements) {
        if (!isRelative(s.spec)) continue;
        const target = resolveSpecifier(file.path, s.spec);
        if (target === null) continue;
        for (const root of privateRoots) {
          if (target.startsWith(`${root}/`) && target !== join(root, "index.ts")) {
            violations.push(`${rel(file.path)}: ${s.spec}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("no locally implemented status-label map", () => {
    // A map keyed by TargetStatus → display label. Alert-severity maps (critical/warning/info) share
    // two keys with TargetStatus but are not status-label maps, so a match needs a status-only key
    // (ok/unknown/suppressed) or three distinct status keys.
    const violations: string[] = [];
    const statusKeyToLabel =
      /\b(ok|warning|critical|unknown|suppressed)\s*:\s*["'`](?:OK|Ok|Warning|Critical|Unknown|Suppressed)\b/g;
    for (const file of FILES) {
      if (/\b(?:const|let|var|function)\s+STATUS_LABELS?\b/.test(file.code)) {
        violations.push(`${rel(file.path)}: declares STATUS_LABEL`);
      }
      const keys = new Set([...file.code.matchAll(statusKeyToLabel)].map((m) => m[1]!));
      if (["ok", "unknown", "suppressed"].some((k) => keys.has(k)) || keys.size >= 3) {
        violations.push(`${rel(file.path)}: status-label pairs for ${[...keys].join(", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("a11y.ts is a pure re-export shim from the shared a11y barrel", () => {
    const shim = byRel("a11y.ts");
    const body = shim.raw.replace(/^\s*\/\/.*$/gm, "").trim();
    expect(body).toBe('export { STATUS_LABEL, cellLabel, serviceLabel } from "../../a11y/index.js";');
    expect(shim.statements.map((s) => s.spec)).toEqual(["../../a11y/index.js"]);
  });
});

describe("protection 5 — index.ts is thin and lazy", () => {
  test("index.ts dynamically imports ./view.js and has no static view value import", () => {
    const index = byRel("index.ts");
    const dynamic = index.valueImports.filter((i) => i.kind === "dynamic-import");
    expect(dynamic.map((i) => i.path)).toEqual(["./view.js"]);
    const viewFile = join(OVERVIEW, "view.tsx");
    const staticView = index.valueImports.filter(
      (i) => i.kind !== "dynamic-import" && isRelative(i.path) && resolveSpecifier(index.path, i.path) === viewFile,
    );
    expect(staticView).toEqual([]);
    for (const s of index.statements) {
      if (isRelative(s.spec) && resolveSpecifier(index.path, s.spec) === viewFile) {
        expect(s.typeOnly, s.statement).toBe(true);
      }
    }
    // Thin: its only value import is the lazy view.
    expect(index.valueImports.filter((i) => i.kind !== "dynamic-import")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Build assertion (08 §6.1) — the overview view is its own lazy chunk
// ---------------------------------------------------------------------------------------------
//
// Structural, from the build manifest + Bun metafile (the same subprocess build-budget.test.ts
// runs). The JS assertion is exact: overview view modules are inputs of exactly one lazy chunk.

const BUILD_CLIENT = resolve(WEB_ROOT, "scripts/build-client.ts");
const VIEW_KEY = "views/overview/view";
const OVERVIEW_JS_MARKER = "pulse.web.overview.v1"; // OVERVIEW_PREFERENCES_KEY, used only by the view

describe("overview lazy route chunk (production build)", () => {
  let outdir = "";
  let manifest: ClientManifest;
  let metafile: BuildMetafile;

  // A full client build takes 3–5 s on the 2-CPU host, at bun's 5 s default hook timeout.
  beforeAll(() => {
    outdir = mkdtempSync(join(tmpdir(), "pulse-overview-boundaries-"));
    const proc = Bun.spawnSync({
      cmd: ["bun", BUILD_CLIENT, "--outdir", outdir, "--minify", "--json"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`build-client.ts exited ${proc.exitCode}\nstderr=${proc.stderr.toString()}`);
    }
    const result = JSON.parse(proc.stdout.toString().trim()) as ClientBuildResult;
    if (!result.ok) throw new Error(`buildClient failed:\n${result.errors.join("\n")}`);
    manifest = result.manifest;
    metafile = result.metafile;
  }, 60_000);

  afterAll(() => {
    if (outdir) rmSync(outdir, { recursive: true, force: true });
  });

  const publicName = (p: string): string => basename(p);
  const isOverviewInput = (input: string): boolean => input.includes("src/client/views/overview/");
  const isViewModule = (input: string): boolean =>
    isOverviewInput(input) && !input.endsWith("src/client/views/overview/index.ts");

  test("overview view JS modules are absent from the initial-route entry", () => {
    const entryNames = new Set(manifest.entries.js.map(publicName));
    for (const [out, rec] of Object.entries(metafile.outputs)) {
      if (!entryNames.has(basename(out))) continue;
      const leaked = Object.keys(rec.inputs).filter(isViewModule);
      expect(leaked, `${out} carries overview view modules`).toEqual([]);
    }
    for (const p of manifest.entries.js) {
      expect(readFileSync(join(outdir, publicName(p)), "utf8")).not.toContain(OVERVIEW_JS_MARKER);
    }
  });

  test("overview view JS is present in exactly one lazy chunk", () => {
    const jsOutputs = Object.entries(metafile.outputs).filter(([out]) => out.endsWith(".js"));
    const owners = jsOutputs.filter(([, rec]) => Object.keys(rec.inputs).some(isViewModule));
    expect(owners.map(([out]) => basename(out))).toHaveLength(1);
    const [chunkOut, chunkRec] = owners[0]!;
    expect(chunkRec.entryPoint ?? "").toMatch(/src\/client\/views\/overview\/view\.tsx$/);
    expect(manifest.chunks.map(publicName)).toContain(basename(chunkOut));
    expect(manifest.entries.js.map(publicName)).not.toContain(basename(chunkOut));

    const marked = [...manifest.entries.js, ...manifest.chunks.filter((c) => c.endsWith(".js"))].filter(
      (p) => readFileSync(join(outdir, publicName(p)), "utf8").includes(OVERVIEW_JS_MARKER),
    );
    expect(marked.map(publicName)).toEqual([basename(chunkOut)]);
  });

  test("the overview ships no stylesheet of its own: no CSS output takes an input from views/overview/", () => {
    const offenders: string[] = [];
    for (const [out, rec] of Object.entries(metafile.outputs)) {
      if (!out.endsWith(".css")) continue;
      for (const input of Object.keys(rec.inputs)) if (isOverviewInput(input)) offenders.push(`${out} <- ${input}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the overview chunkCss entry, if any, carries only uPlot's CSS (plus the build's chunk tag)", () => {
    // Bun folds the CSS of lazily imported modules (the @/ui chart's uPlot sheet) into the importing
    // chunk's bundle, so the key may exist; it must never hold an overview stylesheet.
    const sheets = new Set((manifest.chunkCss?.[VIEW_KEY] ?? []).map(publicName));
    const foreign: string[] = [];
    for (const [out, rec] of Object.entries(metafile.outputs)) {
      if (!sheets.has(basename(out))) continue;
      for (const input of Object.keys(rec.inputs)) {
        if (!/uplot\/dist\/.*\.css$/.test(input) && !input.includes("pulse-chunk")) foreign.push(`${out} <- ${input}`);
      }
    }
    expect(foreign).toEqual([]);
  });
});
