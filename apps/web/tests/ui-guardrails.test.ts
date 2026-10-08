// apps/web/tests/ui-guardrails.test.ts
//
// Library guardrails: static scans over `apps/web/src/client/**/*.{ts,tsx}` that keep code on the `@/ui`
// library, its tokens and the signals bridge. Reads sources from disk; never renders. Allowlists only
// shrink, and a stale entry fails its test. Every rule has a synthetic case proving it fires.
//
// Two related rules live in their own suites and are not duplicated here:
// - no `preact` specifier anywhere in apps/web (src, tests, scripts, root files, package.json):
//   tests/no-preact.test.ts;
// - mutation dialogs are imported only through dynamic `import()`: tests/mutations-client-imports.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

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
  "src/client/ui/patterns/tree-view.tsx": "--tree-depth CSS var per row (indentation geometry); virtualized spacer heights",
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
