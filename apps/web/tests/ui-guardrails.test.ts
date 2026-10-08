// apps/web/tests/ui-guardrails.test.ts
//
// Library guardrails: static scans over `apps/web/src/client/**/*.{ts,tsx}` that keep code on the `@/ui`
// library, its tokens, the signals bridge and the shared list keyboard. Reads sources from disk and
// compiles the real stylesheet with the installed Tailwind (token resolution); never renders.
// Allowlists only shrink, and a stale entry fails its test. Every rule has a synthetic case proving
// it fires.
//
// Two related rules live in their own suites and are not duplicated here:
// - no `preact` specifier anywhere in apps/web (src, tests, scripts, root files, package.json):
//   tests/no-preact.test.ts;
// - mutation dialogs are imported only through dynamic `import()`: tests/mutations-client-imports.test.ts.

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

import { cssEscape, hasClassRule, referenceCompiler } from "./support/tailwind.js";

const WEB_ROOT = resolve(import.meta.dir, "..");
const CLIENT_ROOT = join(WEB_ROOT, "src/client");

interface Source {
  readonly rel: string;
  readonly text: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files: readonly Source[] = walk(CLIENT_ROOT)
  .filter((path) => /\.tsx?$/.test(path) && !path.endsWith(".d.ts"))
  .sort()
  .map((path) => ({ rel: relative(WEB_ROOT, path), text: readFileSync(path, "utf8") }));
const tsx = files.filter(({ rel }) => rel.endsWith(".tsx"));

/** The vendored library and its pulse additions. */
const inLibrary = (rel: string): boolean => rel.startsWith("src/client/ui/");

/** Strip comments so prose that mentions a rule doesn't trip it (keeps `://` in URLs). */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── 1. Barrel-only `@/ui` imports outside the library ───────────────────────────────────────────────

const DEEP_IMPORT_ESCAPE = /\/\/\s*ui-deep-import:\s*\S/;
/** Static/re-export `from "…"` and dynamic `import("…")` specifiers. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
/** `@/ui/<anything>`, or a relative path into a library directory. */
const DEEP_UI = /^(?:@\/ui\/|(?:\.\.?\/)+(?:[\w-]+\/)*ui\/(?:primitives|patterns|hooks|lib|viz|status)\/)/;

function deepImports({ rel, text }: Source): string[] {
  if (inLibrary(rel)) return [];
  const lines = text.split("\n");
  const offenders: string[] = [];
  for (const m of text.matchAll(SPECIFIER)) {
    if (!DEEP_UI.test(m[1]!)) continue;
    const line = text.slice(0, m.index).split("\n").length - 1;
    // The escape sits on the specifier's line or on the line before the statement starts.
    const start = text.lastIndexOf("import", m.index);
    const startLine = text.slice(0, Math.max(start, 0)).split("\n").length - 1;
    const justified = [line, startLine - 1, startLine].some((i) => DEEP_IMPORT_ESCAPE.test(lines[i] ?? ""));
    if (!justified) offenders.push(`${rel}:${line + 1}`);
  }
  return offenders;
}

describe("imports: code outside the library uses the @/ui barrel", () => {
  test("the rule fires on a synthetic deep import and honours the escape", () => {
    const view = (text: string): Source => ({ rel: "src/client/views/demo/view.tsx", text });
    expect(deepImports(view('import { cn } from "@/ui/lib/utils";'))).toEqual(["src/client/views/demo/view.tsx:1"]);
    expect(deepImports(view('import {\n  Button,\n} from "@/ui/primitives/button";'))).toHaveLength(1);
    expect(deepImports(view('const m = await import("@/ui/viz/uplot-chart");'))).toHaveLength(1);
    expect(deepImports(view('import { cn } from "../../ui/lib/utils.js";'))).toHaveLength(1);
    expect(deepImports(view('import { cn } from "@/ui/lib/utils"; // ui-deep-import: test helper'))).toEqual([]);
    expect(deepImports(view('// ui-deep-import: geometry helper\nimport {\n  x,\n} from "@/ui/viz/status-marks";'))).toEqual([]);
    expect(deepImports(view('import { Button } from "@/ui";'))).toEqual([]);
    expect(deepImports(view('import { Badge } from "../../ui/index.js";'))).toEqual([]);
    expect(deepImports({ rel: "src/client/ui/patterns/demo.tsx", text: 'import { cn } from "@/ui/lib/utils";' })).toEqual([]);
  });

  test("never deep-imports @/ui/* outside the library without a justification", () => {
    expect(files.flatMap(deepImports), 'import from "@/ui", or justify with `// ui-deep-import: <why>`').toEqual([]);
  });
});

// ── 1b. Scoped Radix packages, never the `radix-ui` umbrella ────────────────────────────────────────

/** Static, re-export, bare and dynamic specifiers of the umbrella package or a subpath of it. */
const RADIX_UMBRELLA = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']radix-ui(?:\/[^"']*)?["']/g;

/** Bun.build puts every Radix package imported through the umbrella into one chunk the entry imports,
 *  so lazy-only Radix code (alert-dialog, checkbox, radio-group, …) would ride the initial route. */
function umbrellaImports({ rel, text }: Source): string[] {
  const src = code(text);
  return [...src.matchAll(RADIX_UMBRELLA)].map((m) => `${rel}:${src.slice(0, m.index).split("\n").length}`);
}

describe("imports: Radix through its scoped packages", () => {
  test("the rule fires on synthetic umbrella imports and ignores scoped ones", () => {
    const at = (text: string): string[] => umbrellaImports({ rel: "src/client/ui/primitives/demo.tsx", text });
    expect(at('import { Dialog as DialogPrimitive } from "radix-ui"')).toEqual(["src/client/ui/primitives/demo.tsx:1"]);
    expect(at('\nexport { Slot } from "radix-ui";')).toEqual(["src/client/ui/primitives/demo.tsx:2"]);
    expect(at("import 'radix-ui/internal';")).toHaveLength(1);
    expect(at('const m = await import("radix-ui");')).toHaveLength(1);
    expect(at('import * as DialogPrimitive from "@radix-ui/react-dialog"')).toEqual([]);
    expect(at('// was: import { Slot } from "radix-ui"')).toEqual([]);
  });

  test('no client module imports the "radix-ui" umbrella (use "@radix-ui/react-*")', () => {
    expect(files.flatMap(umbrellaImports)).toEqual([]);
  });
});

// ── 1c. Icons through the library ───────────────────────────────────────────────────────────────────

/** Static, re-export and dynamic specifiers of lucide-react or a subpath of it. */
const LUCIDE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']lucide-react(?:\/[^"']*)?["']/g;

/** Outside the library, icons come from `<Icon name>` (curated `ui/lib/icons.ts`), so the build-budget
 *  checks on curated names hold and no namespace or dynamic lucide import slips in. */
function lucideImports({ rel, text }: Source): string[] {
  if (inLibrary(rel)) return [];
  const src = code(text);
  return [...src.matchAll(LUCIDE)].map((m) => `${rel}:${src.slice(0, m.index).split("\n").length}`);
}

describe("imports: icons through <Icon name>", () => {
  test("the rule fires on synthetic lucide imports outside the library only", () => {
    const view = (text: string): string[] => lucideImports({ rel: "src/client/views/demo/view.tsx", text });
    expect(view('import { XIcon } from "lucide-react";')).toEqual(["src/client/views/demo/view.tsx:1"]);
    expect(view('const m = await import("lucide-react/dynamic");')).toHaveLength(1);
    expect(view('// was: import { XIcon } from "lucide-react"')).toEqual([]);
    expect(lucideImports({ rel: "src/client/ui/primitives/dialog.tsx", text: 'import { XIcon } from "lucide-react"' })).toEqual([]);
  });

  test("no module outside src/client/ui imports lucide-react", () => {
    expect(files.flatMap(lucideImports), 'render icons with <Icon name> from "@/ui"').toEqual([]);
  });
});

// ── 1d. Raw HTML sinks ──────────────────────────────────────────────────────────────────────────────

/** Where raw HTML may be rendered, and why. `Prose`/`CodeBlock` take pre-sanitized HTML; only the
 *  workbench passes it, as constants. Server data must never reach these props. */
const RAW_HTML_ALLOWLIST: Readonly<Record<string, string>> = {
  "src/client/ui/patterns/prose.tsx": "vendored: renders its sanitizedHtml prop",
  "src/client/ui/patterns/code-block.tsx": "vendored: renders its highlightedHtml prop",
  "src/client/views/_ui/sections/content.tsx": "workbench demo: constant HTML strings",
};

const RAW_HTML = /\bdangerouslySetInnerHTML\b|\b(?:sanitizedHtml|highlightedHtml)\s*=/;

function rawHtmlSinks({ rel, text }: Source): string[] {
  if (rel in RAW_HTML_ALLOWLIST) return [];
  return code(text)
    .split("\n")
    .flatMap((line, i) => (RAW_HTML.test(line) ? [`${rel}:${i + 1}`] : []));
}

describe("security: raw HTML only in allowlisted files", () => {
  test("the rule fires on synthetic sinks and ignores prose", () => {
    const view = (text: string): string[] => rawHtmlSinks({ rel: "src/client/views/demo/view.tsx", text });
    expect(view("<div dangerouslySetInnerHTML={{ __html: x }} />")).toHaveLength(1);
    expect(view("<Prose sanitizedHtml={alert.annotations.description} />")).toHaveLength(1);
    expect(view("<CodeBlock code={c} highlightedHtml={h} />")).toHaveLength(1);
    expect(view("// never use dangerouslySetInnerHTML here")).toEqual([]);
  });

  test("raw HTML (dangerouslySetInnerHTML, sanitizedHtml=, highlightedHtml=) appears only in allowlisted files", () => {
    expect(files.flatMap(rawHtmlSinks), "render text, or justify an allowlist entry").toEqual([]);
  });

  test("every raw-HTML allowlist entry still renders raw HTML (no stale entries)", () => {
    const stale = Object.keys(RAW_HTML_ALLOWLIST).filter((rel) => {
      const file = files.find((f) => f.rel === rel);
      return file === undefined || !RAW_HTML.test(code(file.text));
    });
    expect(stale).toEqual([]);
  });
});

// ── 2. No colour literals anywhere in src/client ────────────────────────────────────────────────────

const COLOUR_FUNCTION = /#[0-9a-fA-F]{3,8}\b(?![-\w])|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/;
const NAMED_COLOUR =
  "(?:black|white|red|green|blue|yellow|orange|purple|pink|brown|gr[ae]y|cyan|magenta|navy|teal|silver|maroon|olive|lime|aqua|fuchsia|gold|indigo|violet)";
/** A named colour as a style value (`color: "red"`) or an SVG/HTML colour attribute (`fill="red"`). */
const NAMED_COLOUR_USE = new RegExp(
  `(?:\\b(?:color|background(?:Color)?|border(?:Color)?|fill|stroke|stopColor|outlineColor)\\s*[:=]\\s*\\{?\\s*["'\`]${NAMED_COLOUR}["'\`])`,
  "i",
);

function colourLiterals({ rel, text }: Source): string[] {
  return code(text)
    .split("\n")
    .flatMap((line, i) => (COLOUR_FUNCTION.test(line) || NAMED_COLOUR_USE.test(line) ? [`${rel}:${i + 1}`] : []));
}

describe("styling: tokens, not literals", () => {
  test("the colour rule fires on synthetic literals and ignores tokens", () => {
    const at = (text: string): string[] => colourLiterals({ rel: "x.tsx", text });
    expect(at('<div style={{ color: "#ff0000" }} />')).toHaveLength(1);
    expect(at('<rect fill="#abc" />')).toHaveLength(1);
    expect(at('const c = "rgb(0 0 0)";')).toHaveLength(1);
    expect(at('const c = "rgba(0,0,0,.5)";')).toHaveLength(1);
    expect(at('const c = "hsl(10 20% 30%)";')).toHaveLength(1);
    expect(at('const c = "oklch(0.5 0.1 150)";')).toHaveLength(1);
    expect(at('<div style={{ background: "red" }} />')).toHaveLength(1);
    expect(at('<path stroke="black" />')).toHaveLength(1);
    expect(at('<path fill={"white"} />')).toHaveLength(1);
    expect(at('<span className="text-status-ok-fg bg-muted" />')).toEqual([]);
    expect(at('<path stroke="currentColor" fill="var(--chart-1)" />')).toEqual([]);
    expect(at('<a href="#main">Skip</a>')).toEqual([]);
    expect(at("// e.g. #fff or rgb(0 0 0) in prose")).toEqual([]);
  });

  test("has no colour literals anywhere in src/client", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap(colourLiterals), "use theme tokens (Tailwind classes, var(--…)) instead").toEqual([]);
  });
});

// ── 3. Inline style= only in allowlisted files ──────────────────────────────────────────────────────

/** Inline styles carry dynamic geometry only. */
const STYLE_ALLOWLIST: Readonly<Record<string, string>> = {
  // Vendored library + pulse additions.
  "src/client/ui/primitives/sidebar.tsx": "vendored shadcn: sidebar width CSS vars",
  "src/client/ui/primitives/toggle-group.tsx": "vendored shadcn: --gap CSS var",
  "src/client/ui/patterns/code-block.tsx": "maxHeight prop (dynamic geometry)",
  "src/client/ui/patterns/log-output.tsx": "maxHeight prop (dynamic geometry)",
  "src/client/ui/patterns/meter.tsx": "fill width from the value (dynamic geometry)",
  "src/client/ui/patterns/tree-view.tsx": "--tree-depth CSS var per row (indentation geometry)",
  "src/client/ui/patterns/data-table.tsx": "virtualized viewport height, spacer rows and row heights",
  "src/client/ui/viz/time-series-chart.tsx": "loading fallback height (chart geometry)",
  "src/client/ui/viz/uplot-chart.tsx": "chart container height (chart geometry)",
  // Migrated views.
  "src/client/views/_shared/timeseries/overlay.tsx": "overlay placement on the measured .u-over rect (dynamic geometry)",
  "src/client/views/overview/view.tsx": "kiosk fit: viewport offset of the page root (geometry)",
  "src/client/views/timeline/swimlane.tsx": "swimlane head height = sub-lane count × lane pitch",
};

const usesStyle = ({ text }: Source): boolean => /\bstyle=\{/.test(code(text));

function styleViolations(
  sources: readonly Source[],
  allowlist: Readonly<Record<string, string>>,
): { offenders: string[]; stale: string[] } {
  const using = new Set(sources.filter(usesStyle).map(({ rel }) => rel));
  return {
    offenders: [...using].filter((rel) => !(rel in allowlist)),
    stale: Object.keys(allowlist).filter((rel) => !using.has(rel)),
  };
}

describe("styling: inline style= is allowlisted", () => {
  test("the rule fires on a synthetic unlisted file and on a stale entry", () => {
    const sources: Source[] = [
      { rel: "a.tsx", text: "<div style={{ height: 3 }} />" },
      { rel: "b.tsx", text: "// style={{ only in prose }}\n<div />" },
    ];
    expect(styleViolations(sources, {})).toEqual({ offenders: ["a.tsx"], stale: [] });
    expect(styleViolations(sources, { "a.tsx": "geometry", "b.tsx": "stale" })).toEqual({ offenders: [], stale: ["b.tsx"] });
  });

  test("uses inline style= only in allowlisted files", () => {
    expect(styleViolations(tsx, STYLE_ALLOWLIST).offenders, "use Tailwind classes; inline styles are for dynamic geometry only").toEqual([]);
  });

  test("has no stale style= allowlist entries", () => {
    expect(styleViolations(tsx, STYLE_ALLOWLIST).stale, "remove these entries: the file no longer uses style=").toEqual([]);
  });
});

// ── 4/5. Library component conventions ──────────────────────────────────────────────────────────────

const missingDataSlot = (sources: readonly Source[]): string[] =>
  sources
    .filter(({ rel }) => /^src\/client\/ui\/patterns\/[^/]+\.tsx$/.test(rel))
    .filter(({ text }) => !/data-slot=/.test(text))
    .map(({ rel }) => rel);

const dataIconUses = (sources: readonly Source[]): string[] =>
  sources.filter(({ text }) => /data-icon\b/.test(code(text))).map(({ rel }) => rel);

describe("library components", () => {
  test("the data-slot rule fires on a synthetic pattern without one", () => {
    expect(
      missingDataSlot([
        { rel: "src/client/ui/patterns/bare.tsx", text: "export const Bare = () => <div />;" },
        { rel: "src/client/ui/patterns/slotted.tsx", text: 'export const S = () => <div data-slot="s" />;' },
        { rel: "src/client/views/demo/x.tsx", text: "export const X = () => <div />;" },
      ]),
    ).toEqual(["src/client/ui/patterns/bare.tsx"]);
  });

  test("roots every pattern in a data-slot", () => {
    expect(missingDataSlot(files)).toEqual([]);
  });

  test("the data-icon rule fires on a synthetic attribute", () => {
    expect(dataIconUses([{ rel: "x.tsx", text: '<span data-icon="bell" />' }])).toEqual(["x.tsx"]);
    expect(dataIconUses([{ rel: "y.tsx", text: '<Icon name="bell" />' }])).toEqual([]);
  });

  test("never sets data-icon (use <Icon>)", () => {
    expect(dataIconUses(files)).toEqual([]);
  });
});

// ── 6. Legacy tokens ─────────────────────────────────────────────────────────────────────────────────

/** Legacy custom properties: `--l-*`, `--surface-<n>`, `--text-<n|inverse>`, `--border-<1|2|strong>`,
 *  the old z-index, type, spacing, family and weight scales, and the legacy status vocabulary. The
 *  theme's `--status-<tone>-{fg,bg,border}` tokens are not legacy. */
const LEGACY_TOKEN =
  /var\(\s*--(?:l-[\w-]+|surface-[\w-]+|text-(?:\d|inverse)[\w-]*|border-(?:1|2|strong)\b|z-[\w-]+|space-\d|fs-[\w-]+|ff-[\w-]+|fw-[\w-]+|status-(?!(?:ok|warn|danger|info|pending|neutral)-(?:fg|bg|border)\b)[\w-]+)/;

const legacyTokenUses = (sources: readonly Source[]): string[] =>
  sources.filter(({ text }) => LEGACY_TOKEN.test(code(text))).map(({ rel }) => rel);

/** Client stylesheets: the Tailwind entry and the theme files. */
const stylesheets: readonly Source[] = walk(CLIENT_ROOT)
  .filter((path) => path.endsWith(".css"))
  .sort()
  .map((path) => ({ rel: relative(WEB_ROOT, path), text: readFileSync(path, "utf8") }));

describe("no legacy styling", () => {
  test("the legacy-token rule fires on synthetic legacy var() uses", () => {
    for (const legacy of ["var(--l-status-ok-fill)", "var(--surface-2)", "var(--text-1)", "var(--status-critical-fill)", "var(--space-5)", "var(--z-dialog)"]) {
      expect(legacyTokenUses([{ rel: "x.tsx", text: `<rect fill="${legacy}" />` }]), legacy).toEqual(["x.tsx"]);
    }
    for (const token of ["var(--status-ok-fg)", "var(--status-neutral-bg)", "var(--chart-1)", "var(--background)", "var(--spacing)", "var(--text-sm)"]) {
      expect(legacyTokenUses([{ rel: "x.tsx", text: `<rect fill="${token}" />` }]), token).toEqual([]);
    }
  });

  test("references no legacy tokens in client source or stylesheets", () => {
    expect(legacyTokenUses(files)).toEqual([]);
    expect(stylesheets.length).toBeGreaterThan(0);
    expect(legacyTokenUses(stylesheets)).toEqual([]);
  });

  test("no stylesheet declares or imports into a legacy cascade layer", () => {
    expect(stylesheets.filter(({ text }) => /\blayer\(\s*legacy\s*\)|@layer[^{;]*\blegacy\b/.test(text)).map(({ rel }) => rel)).toEqual([]);
  });
});

// ── 7. Signals: components that read a signal during render call useSignals() ───────────────────────
//
// Heuristic, per top-level function. A `.value` read counts as a signal read when its receiver
// resolves (lexically, no type checker) to something plausibly a signal: an import, a `signal()`/
// `computed()`/`useSignal()`/`useComputed()` binding, an alias of a property chain (`store.route`), a
// parameter or member typed `Signal`/`ReadonlySignal`, or a member of a parameter whose type isn't
// declared in the file (e.g. `store: AppStore`). Unannotated callback parameters, loop variables,
// casts and `.target`/`.current` receivers are data. Reads inside deferred callbacks (event handlers,
// effects, computed bodies, timers) are not render reads. Lower-case functions that read signals are
// helpers (exported ones are matched by name across files); a component calling one reads signals too.

const DEFERRED_CALLEES = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useCallback",
  "useImperativeHandle",
  "useSignalEffect",
  "useComputed",
  "computed",
  "effect",
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "queueMicrotask",
  "addEventListener",
  "subscribe",
  "then",
  "catch",
  "finally",
  "startTransition",
]);
const SIGNAL_FACTORIES = new Set(["signal", "computed", "useSignal", "useComputed"]);
const SIGNAL_TYPE = /\b(?:Readonly)?Signal\b/;
const NOT_SIGNAL_MEMBER = new Set(["target", "currentTarget", "current", "srcElement"]);
const HANDLER_NAME = /^(?:on|handle)[A-Z]/;

interface FnUnit {
  readonly rel: string;
  readonly name: string;
  readonly exported: boolean;
  readonly reads: number;
  readonly calls: readonly string[];
  readonly callsUseSignals: boolean;
}

const calleeName = (callee: ts.Expression): string | null =>
  ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;

function unwrap(e: ts.Expression): ts.Expression {
  let out = e;
  while (
    ts.isParenthesizedExpression(out) ||
    ts.isAsExpression(out) ||
    ts.isNonNullExpression(out) ||
    ts.isSatisfiesExpression(out)
  ) {
    out = out.expression;
  }
  return out;
}

/** Top-level functions: declarations, `const X = () => …` and `const X = memo(function …)`. */
function topLevelFunctions(sf: ts.SourceFile): { name: string; fn: ts.FunctionLikeDeclaration; exported: boolean }[] {
  const exported = (n: ts.Node): boolean =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const fnOf = (e: ts.Expression | undefined): ts.FunctionLikeDeclaration | null => {
    if (e === undefined) return null;
    const x = unwrap(e);
    if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return x;
    if (ts.isCallExpression(x)) {
      for (const arg of x.arguments) {
        const f = fnOf(arg);
        if (f !== null) return f;
      }
    }
    return null;
  };
  const out: { name: string; fn: ts.FunctionLikeDeclaration; exported: boolean }[] = [];
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name !== undefined && s.body !== undefined) {
      out.push({ name: s.name.text, fn: s, exported: exported(s) });
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const f = ts.isIdentifier(d.name) ? fnOf(d.initializer) : null;
        if (f !== null && ts.isIdentifier(d.name)) out.push({ name: d.name.text, fn: f, exported: exported(s) });
      }
    }
  }
  return out;
}

/** A nested function that does not run during render. */
function isDeferred(fn: ts.Node): boolean {
  const p = fn.parent;
  if (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)) {
    const attr = p.parent.name.getText();
    return /^on[A-Z]/.test(attr) || attr === "ref";
  }
  if (ts.isCallExpression(p) && p.arguments.some((a) => a === fn)) {
    const name = calleeName(p.expression);
    return name !== null && DEFERRED_CALLEES.has(name);
  }
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return HANDLER_NAME.test(p.name.text);
  if (ts.isPropertyAssignment(p)) return /^on[A-Z]/.test(p.name.getText());
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) {
    return HANDLER_NAME.test(fn.name.getText());
  }
  return false;
}

type Binding =
  | { kind: "param"; decl: ts.ParameterDeclaration; path: string[] }
  | { kind: "var"; decl: ts.VariableDeclaration; path: string[] }
  | { kind: "import" }
  | { kind: "data" };

/** Member path from a binding pattern's root to `id` (`{ a: { b } }` → ["a", "b"]); null if absent. */
function bindingPath(name: ts.BindingName, id: string, path: string[] = []): string[] | null {
  if (ts.isIdentifier(name)) return name.text === id ? path : null;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    const key = el.propertyName !== undefined ? el.propertyName.getText() : ts.isIdentifier(el.name) ? el.name.text : "";
    const found = bindingPath(el.name, id, ts.isObjectBindingPattern(name) ? [...path, key] : [...path, "[]"]);
    if (found !== null) return found;
  }
  return null;
}

/** Nearest lexical binding of `id` visible from `at`. */
function resolveBinding(at: ts.Node, id: string): Binding | null {
  for (let n: ts.Node | undefined = at.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) {
        const path = bindingPath(p.name, id);
        if (path !== null) return { kind: "param", decl: p, path };
      }
    }
    if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n)) &&
      n.initializer !== undefined &&
      ts.isVariableDeclarationList(n.initializer) &&
      n.initializer.declarations.some((d) => bindingPath(d.name, id) !== null)
    ) {
      return { kind: "data" };
    }
    if (ts.isCatchClause(n) && n.variableDeclaration !== undefined && bindingPath(n.variableDeclaration.name, id) !== null) {
      return { kind: "data" };
    }
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) {
      for (const s of n.statements) {
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            const path = bindingPath(d.name, id);
            if (path !== null) return { kind: "var", decl: d, path };
          }
        }
        if (ts.isFunctionDeclaration(s) && s.name?.text === id) return { kind: "data" };
        if (ts.isImportDeclaration(s) && s.importClause !== undefined && !s.importClause.isTypeOnly) {
          const c = s.importClause;
          if (c.name?.text === id) return { kind: "import" };
          const named = c.namedBindings;
          if (named !== undefined && ts.isNamedImports(named) && named.elements.some((e) => e.name.text === id && !e.isTypeOnly)) {
            return { kind: "import" };
          }
        }
      }
    }
  }
  return null;
}

/** Declared type text of `path` under `type`, when the type is a literal or declared in this file. */
function memberType(type: ts.TypeNode | undefined, path: readonly string[], sf: ts.SourceFile): string | null {
  if (type === undefined) return null;
  const [head, ...rest] = path;
  if (head === undefined) return type.getText();
  let members: ts.NodeArray<ts.TypeElement> | null = null;
  if (ts.isTypeLiteralNode(type)) members = type.members;
  else if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText();
    for (const s of sf.statements) {
      if (ts.isInterfaceDeclaration(s) && s.name.text === name) members = s.members;
      if (ts.isTypeAliasDeclaration(s) && s.name.text === name && ts.isTypeLiteralNode(s.type)) members = s.type.members;
    }
  }
  const member = members?.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.name.getText() === head);
  if (member === undefined) return null;
  return rest.length === 0 ? (member.type?.getText() ?? null) : memberType(member.type, rest, sf);
}

/** Is `root.<path>` plausibly a signal? */
function isSignalPath(root: ts.Identifier, path: readonly string[]): boolean {
  const b = resolveBinding(root, root.text);
  if (b === null || b.kind === "data") return false;
  if (b.kind === "import") return true;
  const full = [...b.path, ...path];
  const declared = memberType(b.decl.type, full, root.getSourceFile());
  if (declared !== null) return SIGNAL_TYPE.test(declared);
  if (b.kind === "param") return b.decl.type !== undefined; // unannotated callback params are data
  const init = b.decl.initializer === undefined ? undefined : unwrap(b.decl.initializer);
  if (init === undefined) return false;
  if (full.length === 0 && ts.isCallExpression(init)) {
    const name = calleeName(init.expression);
    return name !== null && SIGNAL_FACTORIES.has(name);
  }
  if (ts.isIdentifier(init)) return isSignalPath(init, full);
  return ts.isPropertyAccessExpression(init);
}

function isSignalRead(pa: ts.PropertyAccessExpression): boolean {
  if (pa.name.text !== "value") return false;
  const p = pa.parent;
  if (ts.isBinaryExpression(p) && p.left === pa && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return false;
  if (ts.isParenthesizedExpression(pa.expression) || ts.isAsExpression(pa.expression)) return false; // DOM casts
  const path: string[] = [];
  let r = unwrap(pa.expression);
  while (ts.isPropertyAccessExpression(r)) {
    if (NOT_SIGNAL_MEMBER.has(r.name.text)) return false;
    path.unshift(r.name.text);
    r = unwrap(r.expression);
  }
  return ts.isIdentifier(r) && isSignalPath(r, path);
}

function analyse(src: Source): FnUnit[] {
  const kind = src.rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(src.rel, src.text, ts.ScriptTarget.Latest, true, kind);
  return topLevelFunctions(sf).map(({ name, fn, exported }) => {
    let reads = 0;
    let callsUseSignals = false;
    const calls: string[] = [];
    const visit = (n: ts.Node): void => {
      if (n !== fn && ts.isFunctionLike(n) && isDeferred(n)) return;
      if (ts.isPropertyAccessExpression(n) && isSignalRead(n)) reads += 1;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        if (n.expression.text === "useSignals") callsUseSignals = true;
        else calls.push(n.expression.text);
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body !== undefined) visit(fn.body);
    return { rel: src.rel, name, exported, reads, calls, callsUseSignals };
  });
}

const isComponent = (u: FnUnit): boolean => /^[A-Z]/.test(u.name);

/** Signal-reading helpers: exported ones by name, file-local ones as `rel#name`. */
function signalHelpers(units: readonly FnUnit[]): Set<string> {
  const helpers = new Set<string>();
  const key = (u: FnUnit): string => (u.exported ? u.name : `${u.rel}#${u.name}`);
  for (let changed = true; changed; ) {
    changed = false;
    for (const u of units) {
      if (isComponent(u) || u.callsUseSignals || helpers.has(key(u))) continue;
      if (u.reads > 0 || u.calls.some((c) => helpers.has(c) || helpers.has(`${u.rel}#${c}`))) {
        helpers.add(key(u));
        changed = true;
      }
    }
  }
  return helpers;
}

/** `rel#Component` for every .tsx component that reads signals in render without `useSignals()`. */
function signalsOffenders(sources: readonly Source[]): string[] {
  const units = sources.flatMap(analyse);
  const helpers = signalHelpers(units);
  return units
    .filter((u) => u.rel.endsWith(".tsx") && isComponent(u) && !u.callsUseSignals)
    .filter((u) => u.reads > 0 || u.calls.some((c) => helpers.has(c) || helpers.has(`${u.rel}#${c}`)))
    .map((u) => `${u.rel}#${u.name}`);
}

/** Components the heuristic flags wrongly, `rel#Component` → reason. */
const SIGNALS_ALLOWLIST: Readonly<Record<string, string>> = {};

describe("signals: render-time reads call useSignals()", () => {
  const STORE_TYPES = 'import type { AppStore } from "../store/index.js";\n';

  test("fires on a component reading a store signal directly", () => {
    const bad = {
      rel: "src/client/views/demo/view.tsx",
      text: `${STORE_TYPES}export function Demo(p: { store: AppStore }) {\n  return <p>{p.store.theme.value}</p>;\n}`,
    };
    expect(signalsOffenders([bad])).toEqual(["src/client/views/demo/view.tsx#Demo"]);
    const good = { ...bad, text: bad.text.replace("{\n  return", "{\n  useSignals();\n  return") };
    expect(signalsOffenders([good])).toEqual([]);
  });

  test("fires on a component calling a signal-reading helper from another module", () => {
    const helper = {
      rel: "src/client/mutations/gate.ts",
      text: `${STORE_TYPES}export function canDo(store: AppStore): boolean {\n  return store.session.value !== null;\n}`,
    };
    const indirect = {
      rel: "src/client/mutations/gated.ts",
      text: `${STORE_TYPES}export function gateOf(store: AppStore) {\n  return canDo(store) ? "on" : "off";\n}`,
    };
    const view = {
      rel: "src/client/views/demo/view.tsx",
      text: [
        STORE_TYPES,
        "export function Direct({ store }: { store: AppStore }) {",
        "  return canDo(store) ? <button /> : null;",
        "}",
        "export const Indirect = memo(function Indirect(p: { store: AppStore }) {",
        "  return <span>{gateOf(p.store)}</span>;",
        "});",
      ].join("\n"),
    };
    expect(signalsOffenders([helper, indirect, view])).toEqual([
      "src/client/views/demo/view.tsx#Direct",
      "src/client/views/demo/view.tsx#Indirect",
    ]);
  });

  test("covers local signals, file-local helpers and render-time callbacks", () => {
    const view = {
      rel: "src/client/views/demo/view.tsx",
      text: [
        STORE_TYPES,
        "const open = signal(false);",
        "function label(): string { return open.value ? 'open' : 'closed'; }",
        "export function Local() { const n = useSignal(0); return <i>{n.value}</i>; }",
        "export function ViaLocal() { return <i>{label()}</i>; }",
        "export function InMap(p: { rows: readonly string[]; store: AppStore }) {",
        "  return <ul>{p.rows.map((r) => <li key={r}>{p.store.density.value}</li>)}</ul>;",
        "}",
        "export function Typed(p: { on: ReadonlySignal<boolean> }) { return <b>{String(p.on.value)}</b>; }",
      ].join("\n"),
    };
    expect(signalsOffenders([view]).map((o) => o.split("#")[1])).toEqual(["Local", "ViaLocal", "InMap", "Typed"]);
  });

  test("ignores deferred reads, writes, DOM values and plain data", () => {
    const view = {
      rel: "src/client/views/demo/view.tsx",
      text: [
        STORE_TYPES,
        "export function Handlers(p: { store: AppStore }) {",
        "  useEffect(() => { void p.store.theme.value; }, []);",
        "  const onToggle = () => { p.store.theme.value = 'dark'; };",
        "  return <input onChange={(e) => go(e.currentTarget.value, p.store.route.value)} onClick={onToggle} />;",
        "}",
        "export function Data(p: { value: number; options: readonly { value: string }[] }) {",
        "  return <select>{p.options.map((o) => <option key={o.value}>{o.value}{p.value}</option>)}</select>;",
        "}",
        "export function Cast() { const el = useRef<HTMLInputElement>(null); return <i>{(el as unknown as HTMLInputElement).value}{el.current?.value}</i>; }",
      ].join("\n"),
    };
    expect(signalsOffenders([view])).toEqual([]);
  });

  test("finds the known signal-reading helpers in the tree", () => {
    const helpers = signalHelpers(files.flatMap(analyse));
    for (const name of ["canAct", "readAlerts", "readEstate"]) expect(helpers.has(name), name).toBe(true);
  });

  test("every component that reads signals during render calls useSignals()", () => {
    const offenders = signalsOffenders(files).filter((o) => !(o in SIGNALS_ALLOWLIST));
    expect(offenders, "call useSignals() at the top of these components").toEqual([]);
  });

  test("has no stale signals allowlist entries", () => {
    const flagged = new Set(signalsOffenders(files));
    expect(Object.keys(SIGNALS_ALLOWLIST).filter((o) => !flagged.has(o))).toEqual([]);
  });
});

// ── 8. Token resolution: every token utility and var(--…) reference resolves to a defined token ─────
//
// The defined set is derived, never listed by hand:
// - Tailwind utilities: the installed Tailwind compiler builds the real entry (`styles/app.css`, which
//   imports theme.css and theme-pulse.css) over every class candidate in src/client. A theme-backed
//   utility resolves when the compiled sheet has a rule for it (variants included, so `dark:bg-mutd`
//   fails). Theme-backed roots: the colour roots (`bg-`, `text-`, `border-*`, `ring-`, `inset-ring-`,
//   `outline-`, `fill-`, `stroke-`, `divide-`, `from-`/`via-`/`to-`, `shadow-`, `inset-shadow-`,
//   `accent-`, `caret-`, `decoration-`, `placeholder-`) plus `font-`, `rounded-*`, `tracking-`,
//   `leading-`, `animate-`, `ease-`, `drop-shadow-`, `blur-`, `backdrop-blur-` and `max-w-`.
// - Colour utilities must also name a colour of the app theme (`--color-*` in `@theme` blocks of the
//   client stylesheets), or an absolute/keyword colour (black, white, transparent, current, inherit).
//   Tailwind's chromatic default palette (`bg-red-500`) compiles but bypasses the tones, so it fails.
// - Custom properties: the declarations in that compiled sheet, split by theme: light (`:root`), dark
//   (`.dark`) and wallboard (`:root[data-density="wallboard"]`). Tailwind emits only the theme
//   variables some utility uses, so a `var(--text-lg)` read only from an inline style fails here as it
//   would in the browser. A name the SAME module sets at runtime (a `"--x": …` style key or
//   `setProperty("--x", …)`) counts as defined there; so do the `--radix-*` names the installed Radix
//   packages set (read from their dist, not listed) and `--tw-*` (Tailwind internals).
// - Theme parity: every dark token overrides a light one, every light colour token has a dark value,
//   and every wallboard token overrides a real (Tailwind or app) theme variable.
//
// Class candidates (static, no type checker) are the tokens of string/template literals in a class
// context: a JSX `className`/`class`/`*ClassName` attribute; an argument (keys and values, nested
// objects, arrays and conditionals included) of `cn`/`cva`/`clsx`/`twMerge`/`cx`; or a variable or
// property initializer, return value, arrow-function body, parameter/binding default or indexed object
// literal (`({…})[tone]`) whose every token is class-shaped (tone → class records and helpers,
// `const CELL = "…"`, `className = "…"`).
// Literals passed to any other call (`setAttribute("stroke-width")`, `getPropertyValue(…)`) and
// prose are not candidates. A `${…}` interpolation becomes a wildcard: `text-status-${tone}-fg` must
// match at least one theme colour and `--status-${tone}-fg` at least one defined property; the values
// the expression can take are not checked. Not seen: classes assembled by concatenation
// (`"bg-" + x`), returned from a helper function, or read from data. A bare `"--x"` literal outside
// `var()` is a reference only as a `getPropertyValue` argument or when its first segment names a
// declared namespace (`--chart-9` fails, `--help` is ignored). Layout utilities without a theme
// namespace (`flx`) are out of scope; ui-tailwind-classes covers the library's classes against the
// bundler's compiler.

const SENTINEL = "\u0000";

/** Every string/template literal fragment in a module; `${…}` becomes SENTINEL. Skips module specifiers. */
function literalFragments(src: Source): { text: string; node: ts.Node }[] {
  const kind = src.rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(src.rel, src.text, ts.ScriptTarget.Latest, true, kind);
  const out: { text: string; node: ts.Node }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ text: n.text, node: n });
    else if (ts.isTemplateExpression(n)) {
      out.push({ text: n.head.text + n.templateSpans.map((s) => SENTINEL + s.literal.text).join(""), node: n });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Class-like tokens (lower-case start, variants, arbitrary values, important, negative). */
const CLASS_TOKEN = /^[!a-z@*[(-][^\s]*$/;

/** Class-composition helpers whose arguments are class strings (or cva variant maps). */
const CLASS_FNS = new Set(["cn", "cva", "clsx", "twMerge", "cx"]);
const CLASS_ATTR = /^(?:className|class|\w+ClassName)$/;

/** Is this literal a class string? `strict`: in a className attribute or a class helper call;
 *  `shaped`: a variable/property initializer, a return value or arrow body, a parameter/binding
 *  default, or a value of an indexed object literal; accepted when every token is class-like. */
function classContext(node: ts.Node): "strict" | "shaped" | null {
  let n: ts.Node = node;
  for (;;) {
    const p: ts.Node = n.parent;
    if (
      ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p) ||
      ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isArrayLiteralExpression(p) ||
      ts.isObjectLiteralExpression(p) || ts.isSpreadElement(p) || ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p) || ts.isJsxExpression(p) ||
      ts.isComputedPropertyName(p)
    ) {
      n = p;
      continue;
    }
    if (ts.isPropertyAssignment(p)) {
      if (CLASS_ATTR.test(p.name.getText())) return "strict";
      n = p;
      continue;
    }
    // `({ ok: "…", warn: "…" })[tone]`: the map's values are what the lookup yields.
    if (ts.isElementAccessExpression(p) && p.expression === n) {
      n = p;
      continue;
    }
    // A helper's result (`return cond ? "…" : TONE[t]`, `(t) => "…"`) and a default (`className = "…"`).
    if (ts.isReturnStatement(p)) return "shaped";
    if (ts.isArrowFunction(p) && p.body === n) return "shaped";
    if ((ts.isParameter(p) || ts.isBindingElement(p)) && p.initializer === n) return "shaped";
    if (ts.isJsxAttribute(p)) return CLASS_ATTR.test(p.name.getText()) ? "strict" : null;
    if (ts.isCallExpression(p)) {
      const name = calleeName(p.expression);
      return name !== null && CLASS_FNS.has(name) && p.arguments.some((a) => a === n) ? "strict" : null;
    }
    if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) && p.initializer === n) return "shaped";
    return null;
  }
}

/** The class strings of a module: literal fragments in a class context. */
function classFragments(src: Source): string[] {
  return literalFragments(src).flatMap(({ text, node }) => {
    const context = classContext(node);
    if (context === null) return [];
    const tokens = text.split(/\s+/).filter((t) => t !== "");
    if (context === "shaped" && !tokens.every((t) => CLASS_TOKEN.test(t.replaceAll(SENTINEL, "x")))) return [];
    return [text];
  });
}

/** Split a candidate at its top-level `:` (not inside `[]`/`()`): variants and the utility. */
function splitVariants(token: string): { variants: string[]; base: string } {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of token) {
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    if (ch === ":" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  return { variants: parts, base: cur };
}

const COLOUR_ROOTS =
  "bg|text|border(?:-[xytrblse])?|ring-offset|inset-ring|ring|outline|fill|stroke|divide|from|via|to|inset-shadow|shadow|accent|caret|decoration|placeholder";
const OTHER_THEME_ROOTS =
  "font|rounded(?:-(?:[trblse]|tl|tr|br|bl|ss|se|es|ee))?|tracking|leading|animate|ease|drop-shadow|backdrop-blur|blur|max-w";
const THEME_ROOT = new RegExp(`^(${COLOUR_ROOTS}|${OTHER_THEME_ROOTS})-(.+)$`);
const COLOUR_ROOT = new RegExp(`^(?:${COLOUR_ROOTS})$`);
/** Colour values that are not theme colours but are allowed: keywords and the absolute black/white
 *  (the vendored shadcn scrim `bg-black/50` and on-destructive `text-white`). */
const COLOUR_KEYWORDS = new Set(["transparent", "current", "inherit", "black", "white"]);

interface TokenUtility {
  readonly token: string;
  readonly root: string;
  /** The value after `root-`, without the `/opacity` modifier. */
  readonly value: string;
}

/** A theme-backed utility (`bg-muted`, `dark:text-status-ok-fg/80`), or null (layout, arbitrary, prose). */
function tokenUtility(token: string): TokenUtility | null {
  if (!CLASS_TOKEN.test(token.replaceAll(SENTINEL, "x"))) return null;
  const base = splitVariants(token).base.replace(/^!|!$/g, "").replace(/^-/, "");
  const m = THEME_ROOT.exec(base);
  if (m === null) return null;
  const value = m[2]!.replace(/\/[\w.\[\]%-]+$/, "");
  if (/^[[(]/.test(value) || !/^[a-z0-9\u0000][\w.\u0000-]*$/.test(value)) return null; // arbitrary value
  return { token, root: m[1]!, value };
}

/** Escape a string for a RegExp, turning SENTINEL into a wildcard. */
const wildcard = (s: string): RegExp =>
  new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(SENTINEL, "[\\w-]+")}$`);

/** Every token utility in the sources, as `{ rel, utility }`. */
function tokenUtilities(sources: readonly Source[]): { rel: string; utility: TokenUtility }[] {
  return sources.flatMap((src) =>
    classFragments(src).flatMap((text) =>
      text.split(/\s+/).flatMap((t) => {
        const utility = tokenUtility(t);
        return utility === null ? [] : [{ rel: src.rel, utility }];
      }),
    ),
  );
}

/** The `--color-*` names of every `@theme` block in the client stylesheets (the app's colour set). */
function themeColours(sheets: readonly Source[]): Set<string> {
  const out = new Set<string>();
  for (const { text } of sheets) {
    for (const block of text.matchAll(/@theme[^{]*\{([^}]*)\}/g)) {
      for (const m of block[1]!.matchAll(/--color-([\w-]+)\s*:/g)) out.add(m[1]!);
    }
  }
  return out;
}

/**
 * Token utilities that do not resolve: no rule in the compiled sheet (static tokens), no theme colour
 * matching a wildcard (dynamic tokens), or a colour outside the app theme.
 */
function unresolvedUtilities(
  found: readonly { rel: string; utility: TokenUtility }[],
  compiled: string,
  colours: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const { rel, utility } of found) {
    const isColour = COLOUR_ROOT.test(utility.root) && !/^\d/.test(utility.value) && !/^(?:x|y|t|r|b|l|s|e)$/.test(utility.value);
    if (utility.token.includes(SENTINEL)) {
      // Dynamic: only colour roots can be matched against the theme; others are out of scope.
      if (!isColour) continue;
      const re = wildcard(utility.value);
      if (![...colours].some((c) => re.test(c))) out.add(`${rel}: ${utility.token.replaceAll(SENTINEL, "${…}")}`);
      continue;
    }
    if (!hasClassRule(compiled, utility.token)) {
      out.add(`${rel}: ${utility.token}`);
      continue;
    }
    // Compiles; a colour utility must also name an app theme colour. Non-colour values of colour
    // roots (`text-sm`, `border-2`, `shadow-xs`, `outline-none`) compile to non-colour rules: skip
    // them by asking whether the compiled rule reads a `--color-*` variable.
    if (isColour && !colours.has(utility.value) && !COLOUR_KEYWORDS.has(utility.value) && readsPaletteColour(compiled, utility.token)) {
      out.add(`${rel}: ${utility.token} (Tailwind palette colour, not a theme token)`);
    }
  }
  return [...out].sort();
}

/** True when the compiled rule for class `token` reads a `--color-*` variable (a palette colour). */
function readsPaletteColour(css: string, token: string): boolean {
  const selector = `.${cssEscape(token)}`;
  for (let at = css.indexOf(selector); at !== -1; at = css.indexOf(selector, at + 1)) {
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    if (/var\(--color-/.test(css.slice(open, close))) return true;
  }
  return false;
}

// Custom properties.

interface VarUse {
  readonly rel: string;
  /** `--name`; may contain SENTINEL for a `${…}` interpolation. */
  readonly name: string;
  /** A bare `"--x"` literal (not `var()`, not a getPropertyValue argument): a reference only when its
   *  first segment names a declared namespace, so an unrelated `"--help"` is not one. */
  readonly bare?: boolean;
}

const VAR_REF = /var\(\s*(--[\w\u0000-]+)/g;
/** Tailwind v4 shorthand: `duration-(--motion-base)`, `w-(--sidebar-width)`, typed `border-(color:--x)`. */
const PAREN_REF = /-\((?:[\w-]+:)?(--[\w\u0000-]+)\)/g;
const BARE_PROP = /^--[\w\u0000-]+$/;

/** References to custom properties in TS/TSX literals, and the names each module sets at runtime. */
function propertyUses(sources: readonly Source[]): { refs: VarUse[]; set: Map<string, Set<string>> } {
  const refs: VarUse[] = [];
  const set = new Map<string, Set<string>>();
  for (const src of sources) {
    for (const { text, node } of literalFragments(src)) {
      for (const m of text.matchAll(VAR_REF)) refs.push({ rel: src.rel, name: m[1]! });
      for (const m of text.matchAll(PAREN_REF)) refs.push({ rel: src.rel, name: m[1]! });
      if (!BARE_PROP.test(text)) continue;
      const p = node.parent;
      const isStyleKey = ts.isPropertyAssignment(p) && p.name === node;
      const call = ts.isCallExpression(p) && p.arguments[0] === node ? calleeName(p.expression) : null;
      if (isStyleKey || call === "setProperty") {
        if (!set.has(src.rel)) set.set(src.rel, new Set());
        set.get(src.rel)!.add(text);
      } else {
        // A read by name. `getPropertyValue` arguments always count; any other bare literal counts
        // when it is in a declared namespace (checked in unresolvedProperties via `bare`).
        refs.push({ rel: src.rel, name: text, bare: call !== "getPropertyValue" });
      }
    }
  }
  return { refs, set };
}

/** `var()` references in stylesheets (theme blocks reference each other; app.css reads `--ring`). */
function stylesheetRefs(sheets: readonly Source[]): VarUse[] {
  return sheets.flatMap(({ rel, text }) =>
    [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(VAR_REF)].map((m) => ({ rel, name: m[1]! })),
  );
}

type ThemeBlocks = Readonly<Record<"light" | "dark" | "wallboard" | "other", ReadonlyMap<string, string>>>;

/** Custom-property declarations of a compiled sheet, grouped by the theme their selector applies to. */
function declaredProperties(css: string): ThemeBlocks {
  const blocks = { light: new Map<string, string>(), dark: new Map<string, string>(), wallboard: new Map<string, string>(), other: new Map<string, string>() };
  for (const m of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim().replace(/\s+/g, " ");
    const target =
      selector === ":root" || selector === ":root, :host"
        ? blocks.light
        : selector === ".dark"
          ? blocks.dark
          : selector === ':root[data-density="wallboard"]'
            ? blocks.wallboard
            : blocks.other;
    for (const d of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]*)/g)) target.set(d[1]!, d[2]!.trim());
  }
  // `@property --x { … }` registrations declare a property too.
  for (const m of css.matchAll(/@property\s+(--[\w-]+)/g)) blocks.other.set(m[1]!, "");
  return blocks;
}

/** The `--radix-*` properties the installed scoped Radix packages set (read from their dist). */
function radixProperties(): Set<string> {
  const { dependencies } = JSON.parse(readFileSync(join(WEB_ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const out = new Set<string>();
  for (const name of Object.keys(dependencies).filter((d) => d.startsWith("@radix-ui/"))) {
    const dist = join(dirname(Bun.resolveSync(`${name}/package.json`, WEB_ROOT)), "dist/index.mjs");
    for (const m of readFileSync(dist, "utf8").matchAll(/["'`](--radix-[\w-]+)["'`]/g)) out.add(m[1]!);
  }
  return out;
}

/** References whose name no theme block, same-module runtime setter, Radix or Tailwind internal defines. */
function unresolvedProperties(
  refs: readonly VarUse[],
  blocks: ThemeBlocks,
  runtime: ReadonlyMap<string, ReadonlySet<string>>,
  radix: ReadonlySet<string>,
): string[] {
  const defined = new Set([...blocks.light.keys(), ...blocks.dark.keys(), ...blocks.wallboard.keys(), ...blocks.other.keys(), ...radix]);
  const namespaces = new Set([...defined].map((d) => d.split("-")[2]));
  const out = new Set<string>();
  for (const { rel, name, bare } of refs) {
    if (name.startsWith("--tw-")) continue;
    if (bare === true && !namespaces.has(name.split("-")[2])) continue;
    const local = runtime.get(rel) ?? new Set<string>();
    const re = name.includes(SENTINEL) ? wildcard(name) : null;
    const ok = re === null ? defined.has(name) || local.has(name) : [...defined, ...local].some((d) => re.test(d));
    if (!ok) out.add(`${rel}: ${name.replaceAll(SENTINEL, "${…}")}`);
  }
  return [...out].sort();
}

/** Theme parity: dark overrides only light tokens, every light colour has a dark value, wallboard
 *  overrides only real theme variables (`themeVars`: Tailwind's and the app's `@theme` names). */
function themeParity(blocks: ThemeBlocks, themeVars: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const name of blocks.dark.keys()) if (!blocks.light.has(name)) out.push(`dark-only token ${name}`);
  for (const [name, value] of blocks.light) {
    if (/^oklch\(/.test(value) && !blocks.dark.has(name)) out.push(`light colour ${name} has no dark value`);
  }
  for (const name of blocks.wallboard.keys()) {
    if (!themeVars.has(name) && !blocks.light.has(name)) out.push(`wallboard overrides unknown token ${name}`);
  }
  return out;
}

/** Names declared in `@theme` blocks: Tailwind's default theme and the client stylesheets. */
function themeVariables(sheets: readonly Source[]): Set<string> {
  const tailwindTheme = readFileSync(join(dirname(Bun.resolveSync("tailwindcss/package.json", WEB_ROOT)), "theme.css"), "utf8");
  const out = new Set<string>();
  for (const text of [tailwindTheme, ...sheets.map((s) => s.text)]) {
    for (const block of text.matchAll(/@theme[^{]*\{([^}]*)\}/g)) {
      for (const m of block[1]!.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]!);
    }
  }
  return out;
}

describe("tokens: every token utility and var(--…) resolves to a defined theme token", () => {
  let compiler: Awaited<ReturnType<typeof referenceCompiler>>;
  let compiled = "";
  let blocks: ThemeBlocks;
  const found = tokenUtilities(files);
  const colours = themeColours(stylesheets);
  const radix = radixProperties();

  beforeAll(async () => {
    compiler = await referenceCompiler();
    const candidates = new Set<string>();
    for (const src of files) {
      for (const text of classFragments(src)) {
        for (const t of text.split(/\s+/)) if (CLASS_TOKEN.test(t)) candidates.add(t);
      }
    }
    compiled = compiler.build([...candidates]);
    blocks = declaredProperties(compiled);
  }, 60_000);

  test("parses token utilities, variants and modifiers", () => {
    expect(tokenUtility("bg-muted")).toEqual({ token: "bg-muted", root: "bg", value: "muted" });
    expect(tokenUtility("dark:hover:text-status-ok-fg/80")?.value).toBe("status-ok-fg");
    expect(tokenUtility("group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent")?.value).toBe("transparent");
    expect(tokenUtility("!border-l-status-warn-border")).toMatchObject({ root: "border-l", value: "status-warn-border" });
    expect(tokenUtility("rounded-tl-lg")).toMatchObject({ root: "rounded-tl", value: "lg" });
    expect(tokenUtility("w-[var(--sidebar-width)]")).toBeNull();
    expect(tokenUtility("bg-[var(--x)]")).toBeNull();
    expect(tokenUtility("flex")).toBeNull();
    expect(tokenUtility("Firing")).toBeNull();
    expect(tokenUtility("tracking-tight")).toMatchObject({ root: "tracking", value: "tight" });
    expect(tokenUtility("max-w-prose")).toMatchObject({ root: "max-w", value: "prose" });
  });

  test("only class contexts are candidates: className, class helpers, class-shaped initializers", () => {
    const frag = (text: string): string[] => classFragments({ rel: "src/client/views/demo/view.tsx", text });
    expect(frag('<p className={cn("bg-muted", ok && "text-sm", { "border-2": wide })} />')).toEqual(["bg-muted", "text-sm", "border-2"]);
    expect(frag('const v = cva("p-2", { variants: { tone: { ok: "text-status-ok-fg" } }, defaultVariants: { tone: "ok" } });')).toEqual([
      "p-2",
      "text-status-ok-fg",
      "ok",
    ]);
    expect(frag('const TONE = { ok: "bg-status-ok-bg", warn: "bg-status-warn-bg" }; const CELL = "border-b px-2";')).toEqual([
      "bg-status-ok-bg",
      "bg-status-warn-bg",
      "border-b px-2",
    ]);
    expect(frag('createElement("td", { className: `${CELL} whitespace-nowrap` });')).toEqual(["\u0000 whitespace-nowrap"]);
    expect(frag('function edge(s) { return outline(s) ? "border-dashed border-input" : EDGE[s]; }')).toEqual(["border-dashed border-input"]);
    expect(frag('const align = (c) => (c.end ? "text-right" : undefined);')).toEqual(["text-right"]);
    expect(frag('const cls = { ok: "bg-status-ok-bg", warn: "bg-status-warn-bg" }[tone];')).toEqual(["bg-status-ok-bg", "bg-status-warn-bg"]);
    expect(frag('function Chip({ className = "rounded-md bg-muted" }) {} function f(c = "text-sm") {}')).toEqual(["rounded-md bg-muted", "text-sm"]);
    expect(frag('function label() { return "Loading hosts…"; }')).toEqual([]);
    // Not class strings: other calls' arguments, prose, attribute values.
    expect(frag('el.setAttribute("stroke-width", "2"); cs.getPropertyValue("border-top-color");')).toEqual([]);
    expect(frag('const hint = "Use text-red-500 sparingly";')).toEqual([]);
    expect(frag('<a title="bg-red-500" aria-label="text-mutd" />')).toEqual([]);
  });

  test("the rule fires on a typo'd token, a typo'd variant, a palette colour and a dynamic miss", () => {
    const at = (text: string): string[] => {
      const synthetic = tokenUtilities([{ rel: "src/client/views/demo/view.tsx", text }]);
      // Compile the synthetic candidates too (incremental: the scan's sheet is already captured).
      return unresolvedUtilities(synthetic, compiler.build(synthetic.map((u) => u.utility.token)), colours);
    };
    expect(at('<p className="text-status-wran-fg bg-muted" />')).toEqual(["src/client/views/demo/view.tsx: text-status-wran-fg"]);
    expect(at('const c = cn("rounded-lg", open && "bg-mutd");')).toEqual(["src/client/views/demo/view.tsx: bg-mutd"]);
    expect(at('const v = cva("", { variants: { tone: { ok: "dark:border-status-ok-bordr" } } });')).toHaveLength(1);
    expect(at('<p className="bg-red-500" />')).toEqual(["src/client/views/demo/view.tsx: bg-red-500 (Tailwind palette colour, not a theme token)"]);
    expect(at("const c = `text-status-${tone}-fgg`;")).toEqual(["src/client/views/demo/view.tsx: text-status-${…}-fgg"]);
    // Resolving tokens, keywords, non-colour values of colour roots and arbitrary values pass.
    expect(at("const c = `text-status-${tone}-fg ${x}`;")).toEqual([]);
    expect(
      at('<p className="bg-black/50 text-white border-transparent text-sm border-2 shadow-xs outline-none font-mono rounded-md ring-ring/50 dark:bg-input/30 w-[var(--x)] flex" />'),
    ).toEqual([]);
  });

  test("the property rule fires on an undefined var(), honours runtime setters and wildcards", () => {
    const view = (text: string): Source => ({ rel: "src/client/views/demo/view.tsx", text });
    const check = (text: string): string[] => {
      const { refs, set } = propertyUses([view(text)]);
      return unresolvedProperties(refs, blocks, set, radix);
    };
    expect(check('const s = "calc(var(--spacng) * 2)";')).toEqual(["src/client/views/demo/view.tsx: --spacng"]);
    expect(check('<i className="duration-(--motion-bse)" />')).toEqual(["src/client/views/demo/view.tsx: --motion-bse"]);
    expect(check('read("--chart-9")')).toEqual(["src/client/views/demo/view.tsx: --chart-9"]);
    expect(check("const v = `--status-${tone}-fgg`;")).toEqual(["src/client/views/demo/view.tsx: --status-${…}-fgg"]);
    expect(check("const v = `--status-${tone}-fg`; read(\"--border\"); const s = \"var(--spacing)\";")).toEqual([]);
    expect(check('<i style={{ "--depth": 2 }} className="pl-[calc(var(--depth)*1rem)]" />')).toEqual([]);
    expect(check('el.style.setProperty("--kiosk-top", "4px"); const s = "var(--kiosk-top)";')).toEqual([]);
    expect(check('const s = "var(--radix-select-trigger-width) var(--tw-ring-shadow)";')).toEqual([]);
    expect(check('const s = "var(--radix-select-trigger-widht)";')).toEqual(["src/client/views/demo/view.tsx: --radix-select-trigger-widht"]);
    expect(check('<i className="border-(color:--bordr) w-(length:--spacing)" />')).toEqual(["src/client/views/demo/view.tsx: --bordr"]);
    expect(check('const args = ["--help", "--verbose"];')).toEqual([]);
    expect(check('cs.getPropertyValue("--nonesuch")')).toEqual(["src/client/views/demo/view.tsx: --nonesuch"]);
    // A runtime setter defines the name for its own module only.
    const { refs, set } = propertyUses([view('<i style={{ "--depth": 2 }} />'), { rel: "src/client/views/demo/other.tsx", text: 'const s = "var(--depth)";' }]);
    expect(unresolvedProperties(refs, blocks, set, radix)).toEqual(["src/client/views/demo/other.tsx: --depth"]);
    expect(unresolvedProperties([{ rel: "x.css", name: "--undefined-token" }], blocks, new Map(), radix)).toEqual(["x.css: --undefined-token"]);
  });

  test("the parity rule fires on dark-only, light-only colour and unknown wallboard tokens", () => {
    const synthetic = declaredProperties(
      ':root { --a: oklch(1 0 0); --b: oklch(0 0 0); --c: 1rem; }\n.dark { --a: oklch(0 0 0); --z: oklch(1 0 0); }\n:root[data-density="wallboard"] { --spacing: 1px; --spacng: 1px; }',
    );
    expect(themeParity(synthetic, new Set(["--spacing"]))).toEqual([
      "dark-only token --z",
      "light colour --b has no dark value",
      "wallboard overrides unknown token --spacng",
    ]);
  });

  test("the compiled sheet carries the light, dark and wallboard theme blocks", () => {
    expect(blocks.light.has("--background")).toBe(true);
    expect(blocks.dark.has("--background")).toBe(true);
    expect(blocks.wallboard.has("--spacing")).toBe(true);
    expect(colours.has("status-ok-fg")).toBe(true);
    expect(radix.has("--radix-select-trigger-width")).toBe(true);
    // Sanity: the scan sees the app's token utilities (hundreds), not a handful.
    expect(found.length).toBeGreaterThan(300);
  });

  test("every token utility in src/client resolves to a theme token", () => {
    expect(unresolvedUtilities(found, compiled, colours), "fix the class or add the token to the theme").toEqual([]);
  });

  test("every var(--…) reference in src/client (sources and stylesheets) resolves", () => {
    const { refs, set } = propertyUses(files);
    expect(refs.length).toBeGreaterThan(10);
    expect(unresolvedProperties([...refs, ...stylesheetRefs(stylesheets)], blocks, set, radix), "define the token or fix the name").toEqual([]);
  });

  test("dark overrides light tokens, every light colour has a dark value, wallboard overrides real tokens", () => {
    expect(themeParity(blocks, themeVariables(stylesheets))).toEqual([]);
  });
});

// ── 9. List keyboards go through useListNavigation ───────────────────────────────────────────────────
//
// A list, table or tree keyboard is `useListNavigation` (or a pattern built on it: DataTable,
// TreeView, CardGrid). This flags a module that hand-rolls one instead:
// - a vertical list key compared with the event's key: `e.key === "ArrowUp"`, `case "ArrowDown":`,
//   `e.key.toLowerCase() === "j"`, `e.code === "KeyJ"`, any member chain ending in `.key`/`.code`;
// - an inline key list tested against it: `["ArrowUp", "ArrowDown"].includes(e.key)`,
//   `new Set(["j", "k"]).has(event.key)`;
// - a `rovingTabindex(…)` call that is not `orientation: "horizontal"` (vertical and 2-D roving are
//   list/grid keyboards; horizontal roving is a toolbar or radio group);
// - `registerShortcut` of a list key, alone or with Shift (`"j"`, `"shift+j"`, `"arrowdown"`; `"mod+k"` is a command).
// Limits: AST, per module, no data flow. A key list held in a named constant (`KEYS.has(e.key)`,
// e.g. DataTable's scroll-key set), a key read through a map, or a handler that only uses
// ArrowLeft/ArrowRight (a cursor or a horizontal widget) is not flagged.

/** The list-navigation building blocks themselves. */
const LIST_NAV_INFRA = new Set([
  "src/client/ui/hooks/use-list-navigation.ts",
  "src/client/ui/lib/list-navigation.ts",
  "src/client/a11y/roving-tabindex.ts",
]);

/** Bespoke list keyboards that predate the rule. Only shrinks; a stale entry fails. Follow-up: migrate
 *  the first two once useListNavigation can drive a virtualized cursor and a roving tab stop (what
 *  each lacks is in its reason); until then a migration would change behaviour. */
const BESPOKE_LIST_KEYBOARDS: Readonly<Record<string, string>> = {
  "src/client/views/alerts/keyboard.ts":
    "j/k triage cursor over a virtualized DataTable: a signal cursor that scrolls a virtualized-out row into view and retries focus, aria-current, Firing-tab gating, document-level registry so Enter/Escape coexist with the detail Sheet. useListNavigation focuses only mounted items.",
  "src/client/views/timeline/lanes.tsx":
    "lane tree: rovingTabindex keeps ONE tab stop starting at the selected lane, plus →/← parent/child moves. useListNavigation has no roving tabindex, so migrating would change the Tab order.",
  "src/client/views/overview/grid/navigation.ts":
    "the overview host grid: a 2-D spatial role=grid with change markers, documented as bespoke in docs/architecture/ui.md (Overview grid).",
};

/** Vertical widgets that are not lists (a slider, a spin button, a vertical splitter) may handle
 *  ArrowUp/ArrowDown themselves: list them here, one reason each (rel → why). None today. */
const VERTICAL_WIDGET_EXEMPTIONS: Readonly<Record<string, string>> = {};

const VERTICAL_KEYS = new Set(["ArrowUp", "ArrowDown"]);
const VIM_KEYS = new Set(["j", "k", "J", "K", "KeyJ", "KeyK"]);
const SHORTCUT_LIST_KEYS = new Set(["j", "k", "arrowup", "arrowdown", "up", "down"]);

/** `rel:line` for every bespoke list-key handler construct in a module. */
function bespokeListKeys(src: Source): string[] {
  if (LIST_NAV_INFRA.has(src.rel)) return [];
  const kind = src.rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(src.rel, src.text, ts.ScriptTarget.Latest, true, kind);
  const hits: string[] = [];
  const at = (n: ts.Node): void => void hits.push(`${src.rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
  const literal = (e: ts.Expression): string | null => {
    const x = unwrap(e);
    return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null;
  };
  /** The event key: a member chain ending in `.key`/`.code`, optionally case-folded. */
  const isKeyRead = (e: ts.Expression): boolean => {
    let x = unwrap(e);
    if (ts.isCallExpression(x) && x.arguments.length === 0 && ts.isPropertyAccessExpression(x.expression) && /^to(?:Lower|Upper|LocaleLower|LocaleUpper)Case$/.test(x.expression.name.text)) {
      x = unwrap(x.expression.expression);
    }
    return (ts.isPropertyAccessExpression(x) && (x.name.text === "key" || x.name.text === "code")) || (ts.isIdentifier(x) && (x.text === "key" || x.text === "code"));
  };
  /** A list key compared with the event key (`ArrowUp`/`ArrowDown` against anything, `j`/`k` against a key read). */
  const listKey = (lit: string | null, other: ts.Expression): boolean =>
    lit !== null && (VERTICAL_KEYS.has(lit) || (VIM_KEYS.has(lit) && isKeyRead(other)));
  /** An inline array/Set literal of keys containing a list key. */
  const inlineKeyList = (e: ts.Expression): boolean => {
    let x = unwrap(e);
    if (ts.isNewExpression(x) && x.arguments?.[0] !== undefined) x = unwrap(x.arguments[0]);
    return ts.isArrayLiteralExpression(x) && x.elements.some((el) => {
      const lit = literal(el as ts.Expression);
      return lit !== null && (VERTICAL_KEYS.has(lit) || VIM_KEYS.has(lit));
    });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
      if (listKey(literal(n.right), n.left) || listKey(literal(n.left), n.right)) at(n);
    }
    if (ts.isCaseClause(n) && ts.isSwitchStatement(n.parent.parent) && listKey(literal(n.expression), n.parent.parent.expression)) at(n);
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (
        (name === "includes" || name === "has" || name === "indexOf") &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.arguments[0] !== undefined &&
        isKeyRead(n.arguments[0]) &&
        inlineKeyList(n.expression.expression)
      ) {
        at(n);
      }
      if (name === "rovingTabindex") {
        const opts = n.arguments[1] === undefined ? null : unwrap(n.arguments[1]);
        const orientation =
          opts !== null && ts.isObjectLiteralExpression(opts)
            ? opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "orientation")
            : undefined;
        if (orientation === undefined || literal(orientation.initializer) !== "horizontal") at(n);
      }
      if (name === "registerShortcut" && n.arguments[0] !== undefined) {
        const combo = literal(n.arguments[0]);
        // A list key alone or with Shift moves through a list; with Ctrl/Cmd/Alt (`mod+k`) it is a command.
        const parts = combo?.toLowerCase().split("+") ?? [];
        const key = parts.pop();
        if (key !== undefined && SHORTCUT_LIST_KEYS.has(key) && parts.every((m) => m === "shift")) at(n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** Every exempt module, bespoke list keyboards and vertical non-list widgets alike. */
const isExempt = (rel: string): boolean => rel in BESPOKE_LIST_KEYBOARDS || rel in VERTICAL_WIDGET_EXEMPTIONS;

describe("keyboard: list keyboards go through useListNavigation", () => {
  const view = (text: string, rel = "src/client/views/demo/list.tsx"): string[] => bespokeListKeys({ rel, text });

  test("the rule fires on synthetic bespoke list handlers", () => {
    expect(view('const onKeyDown = (e) => { if (e.key === "ArrowDown") next(); };')).toEqual(["src/client/views/demo/list.tsx:1"]);
    expect(view('switch (event.key) {\n  case "ArrowUp": prev(); break;\n}')).toEqual(["src/client/views/demo/list.tsx:2"]);
    expect(view('if ("ArrowUp" === e.key) prev();')).toHaveLength(1);
    expect(view('if (e.key === "j") next();')).toHaveLength(1);
    expect(view('switch (ev.key) { case "k": prev(); }')).toHaveLength(1);
    expect(view("rovingTabindex(list, { itemSelector: \"li\" });")).toHaveLength(1);
    expect(view('rovingTabindex(grid, { orientation: "both" });')).toHaveLength(1);
    expect(view('registerShortcut("j", () => move(1));')).toHaveLength(1);
    expect(view('registerShortcut("ArrowDown", () => move(1));')).toHaveLength(1);
    expect(view('registerShortcut("shift+j", () => move(5));')).toHaveLength(1);
    expect(view('if (["ArrowUp", "ArrowDown"].includes(e.key)) move(e.key);')).toHaveLength(1);
    expect(view('if (new Set(["j", "k"]).has(event.key)) move();')).toHaveLength(1);
    expect(view('if (e.key.toLowerCase() === "j") next();')).toHaveLength(1);
    expect(view('if (e.nativeEvent.key === "k") prev();')).toHaveLength(1);
    expect(view('if (e.code === "KeyJ") next();')).toHaveLength(1);
    expect(view('switch (e.key.toLowerCase()) { case "k": prev(); }')).toHaveLength(1);
  });

  test("the rule ignores horizontal widgets, non-list keys, key sets and the infrastructure", () => {
    expect(view('if (e.key === "ArrowLeft" || e.key === "ArrowRight") step();')).toEqual([]);
    expect(view('rovingTabindex(toolbar, { orientation: "horizontal" });')).toEqual([]);
    expect(view('registerShortcut("mod+k", open); registerShortcut("[", prev);')).toEqual([]);
    expect(view('const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp"]); if (SCROLL_KEYS.has(e.key)) cancel();')).toEqual([]);
    expect(view('if (["ArrowLeft", "ArrowRight"].includes(e.key)) step();')).toEqual([]);
    expect(view('registerShortcut("shift+[", prev);')).toEqual([]);
    expect(view('if (mode === "j") jump();')).toEqual([]);
    expect(view("useListNavigation({ getItems, keys: \"arrows\" });")).toEqual([]);
    expect(view('switch (e.key) { case "ArrowDown": next(); }', "src/client/ui/lib/list-navigation.ts")).toEqual([]);
  });

  test("no new bespoke list keyboards (use useListNavigation, or a pattern built on it)", () => {
    const offenders = files.flatMap(bespokeListKeys).filter((hit) => !isExempt(hit.split(":")[0]!));
    expect(offenders, "drive the list with useListNavigation (or DataTable/TreeView/CardGrid)").toEqual([]);
  });

  test("every bespoke-keyboard exemption still applies (no stale entries)", () => {
    const flagged = new Set(files.flatMap(bespokeListKeys).map((hit) => hit.split(":")[0]!));
    expect([...Object.keys(BESPOKE_LIST_KEYBOARDS), ...Object.keys(VERTICAL_WIDGET_EXEMPTIONS)].filter((rel) => !flagged.has(rel))).toEqual([]);
  });
});
