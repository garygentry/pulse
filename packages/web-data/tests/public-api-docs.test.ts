/** public-api-docs.test.ts — the public-declaration documentation guard (01 §13).
 *
 *  Parses every `@pulse/web-data` package source plus the deterministic list of
 *  app-private, API-bearing files enumerated by the numbered specs, and fails when any
 *  exported interface property/method or exported object-type-literal property lacks a
 *  non-empty JSDoc node. The guard first asserts every listed app-private path exists so
 *  a rename cannot silently shrink coverage.
 *
 *  Protection set (01 §13):
 *   - all exported interface/type-alias declarations under `packages/web-data/src/**`;
 *   - the document-00 app-private files (dev CLI/config/mock-engine surface). Later specs
 *     (04, 05, 08, 10) extend `APP_PRIVATE_FILES` as their API-bearing files land.
 *
 *  Non-goals (01 §13): private locals, inferred implementation-only return objects, test
 *  declarations, generated `.d.ts`, and prose-style enforcement beyond non-empty text. */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PACKAGE_SRC_DIR = "packages/web-data/src";

/**
 * App-private, API-bearing files whose exported declarations are protected by the same
 * helper as the package sources. Only files that already exist are listed; each numbered
 * spec adds its own files as they are implemented (01 §13).
 *
 * Document-00 portion (exact): the four-origin dev CLI, shared constants, server config,
 * and the mock-engine dev modules.
 */
const APP_PRIVATE_FILES: readonly string[] = [
  "apps/web/scripts/dev.ts",
  "apps/web/src/shared/constants.ts",
  "apps/web/src/server/config.ts",
  "apps/web/src/server/dev/protocol.ts",
  "apps/web/src/server/dev/mock-engine.ts",
  "apps/web/src/server/dev/scenario.ts",
  "apps/web/src/server/dev/timeline.ts",
  "apps/web/src/server/dev/entry.ts",
];

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly member: string;
}

/** Whether the node has a leading `/** ... *\/` block comment with non-whitespace content. */
function hasJsDoc(node: ts.Node, sourceText: string): boolean {
  const ranges = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];
  for (const range of ranges) {
    if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const text = sourceText.slice(range.pos, range.end);
    if (!text.startsWith("/**")) continue;
    const inner = text.slice(3, text.length - 2).replace(/[*]/g, "").trim();
    if (inner.length > 0) return true;
  }
  return false;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function memberName(member: ts.TypeElement): string {
  const name = (member as ts.PropertySignature | ts.MethodSignature).name;
  return name && ts.isIdentifier(name) ? name.text
    : name && ts.isStringLiteral(name) ? name.text
    : "<member>";
}

/** Record a violation for each property/method signature in a type element list lacking JSDoc. */
function checkMembers(
  members: ts.NodeArray<ts.TypeElement>,
  sourceFile: ts.SourceFile,
  filePath: string,
  sourceText: string,
  out: Violation[],
): void {
  for (const member of members) {
    if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
    if (!hasJsDoc(member, sourceText)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
      out.push({ file: filePath, line: line + 1, member: memberName(member) });
    }
    if (ts.isPropertySignature(member) && member.type) {
      walkType(member.type, sourceFile, filePath, sourceText, out);
    }
  }
}

/** Recurse into a type node, checking every nested object-type-literal's members. */
function walkType(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  filePath: string,
  sourceText: string,
  out: Violation[],
): void {
  if (ts.isTypeLiteralNode(typeNode)) {
    checkMembers(typeNode.members, sourceFile, filePath, sourceText, out);
    return;
  }
  ts.forEachChild(typeNode, (child) => {
    if (ts.isTypeNode(child)) walkType(child, sourceFile, filePath, sourceText, out);
  });
}

/** Collect documentation violations for the given source text's exported declarations. */
function collectViolationsFromText(filePath: string, sourceText: string): Violation[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const out: Violation[] = [];

  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) continue;
    if (ts.isInterfaceDeclaration(statement)) {
      checkMembers(statement.members, sourceFile, filePath, sourceText, out);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      walkType(statement.type, sourceFile, filePath, sourceText, out);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (decl.type) walkType(decl.type, sourceFile, filePath, sourceText, out);
      }
    }
  }
  return out;
}

/** Collect documentation violations for one source file's exported declarations. */
function collectViolations(filePath: string): Violation[] {
  const absolute = resolve(REPO_ROOT, filePath);
  return collectViolationsFromText(filePath, readFileSync(absolute, "utf8"));
}

function listPackageSources(): string[] {
  const entries = readdirSync(resolve(REPO_ROOT, PACKAGE_SRC_DIR), {
    recursive: true,
    encoding: "utf8",
  });
  return entries
    .filter((e) => e.endsWith(".ts") && !e.endsWith(".d.ts") && !e.endsWith(".test.ts"))
    .map((e) => `${PACKAGE_SRC_DIR}/${e}`)
    .sort();
}

describe("public API documentation guard", () => {
  test("every listed app-private path exists", () => {
    const missing = APP_PRIVATE_FILES.filter((f) => !existsSync(resolve(REPO_ROOT, f)));
    expect(missing).toEqual([]);
  });

  test("package sources exist and are non-empty", () => {
    const sources = listPackageSources();
    expect(sources.length).toBeGreaterThan(0);
  });

  test("no exported interface/object-type property or method lacks semantic JSDoc", () => {
    const targets = [...listPackageSources(), ...APP_PRIVATE_FILES];
    const violations = targets.flatMap(collectViolations);
    const report = violations.map((v) => `${v.file}:${v.line} ${v.member}`);
    expect(report).toEqual([]);
  });

  test("the package source set includes every wire/source/cycle contract module", () => {
    // The guard must actually reach item 004's authoritative common declarations, not just
    // an empty barrel; otherwise a green run would be vacuous.
    const sources = listPackageSources();
    for (const required of [
      `${PACKAGE_SRC_DIR}/wire/common.ts`,
      `${PACKAGE_SRC_DIR}/sources/types.ts`,
      `${PACKAGE_SRC_DIR}/cycle/types.ts`,
    ]) {
      expect(sources).toContain(required);
    }
  });
});

describe("public API documentation guard is non-vacuous", () => {
  test("flags an undocumented exported interface property but not a documented sibling", () => {
    const synthetic = [
      "export interface Sample {",
      "  /** Documented field. */ readonly ok: boolean;",
      "  readonly missing: string;",
      "}",
    ].join("\n");
    const violations = collectViolationsFromText("synthetic.ts", synthetic);
    expect(violations.map((v) => v.member)).toEqual(["missing"]);
  });

  test("recurses into nested object-type literals", () => {
    const synthetic = [
      "export interface Nested {",
      "  /** Grouped context. */ readonly group: {",
      "    readonly inner: number;",
      "  } | null;",
      "}",
    ].join("\n");
    const violations = collectViolationsFromText("synthetic.ts", synthetic);
    expect(violations.map((v) => v.member)).toEqual(["inner"]);
  });

  test("ignores inferred implementation-only const object literals (§13 non-goal)", () => {
    // ERROR_MESSAGES et al. are `const X = { ... }` with an inferred type; the guard must not
    // demand per-key JSDoc on them.
    const synthetic = 'export const CATALOG = { a: "x", b: "y" } as const;';
    expect(collectViolationsFromText("synthetic.ts", synthetic)).toEqual([]);
  });

  test("ignores non-exported declarations", () => {
    const synthetic = "interface Internal {\n  readonly undocumented: string;\n}";
    expect(collectViolationsFromText("synthetic.ts", synthetic)).toEqual([]);
  });
});
