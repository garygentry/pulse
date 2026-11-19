/**
 * Shape extraction: turns the contract wire types into a `ShapeSnapshot` with the TypeScript
 * compiler API. Dev-time only; nothing under `src/` imports this file.
 *
 * The program is built from `packages/web-data/src/wire/index.ts` with `@pulse/renderer` and
 * `@pulse/core` mapped to their sources, so no prior build is needed.
 */
import { join } from "node:path";
import ts from "typescript";
import { CONTRACT_VERSION } from "@pulse/web-data/contract";
import { ContractToolError } from "./errors.js";
import { SHAPE_ROOTS } from "./shape-types.js";
import type { ShapeKind, ShapeNode, ShapeSnapshot } from "./shape-types.js";

const WEB_DATA_TSCONFIG = "packages/web-data/tsconfig.json";
const WIRE_BARREL = "packages/web-data/src/wire/index.ts";
const MAX_DEPTH = 40;

type Primitive = "string" | "number" | "boolean";

/**
 * Working form of a node. Children are keyed by their path suffix: `.name`, `[]`, `{}`, `[n]`, or
 * `(field=value).name` for a field that belongs to one variant of a discriminated union.
 */
interface Tree {
  kind: ShapeKind;
  optional: boolean;
  nullable: boolean;
  members?: string[];
  /** Primitive the literal members belong to. Not part of the snapshot. */
  literalOf?: Primitive;
  children: Map<string, Tree>;
}

function unsupported(subject: string, message: string): ContractToolError {
  return new ContractToolError("SHAPE_UNSUPPORTED_TYPE", subject, `${subject}: ${message}`);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function leaf(kind: ShapeKind, extra: Partial<Tree> = {}): Tree {
  return { kind, optional: false, nullable: false, children: new Map(), ...extra };
}

function flatten(tree: Tree, path: string, out: ShapeNode[]): void {
  out.push({
    path,
    kind: tree.kind,
    optional: tree.optional,
    nullable: tree.nullable,
    ...(tree.members !== undefined ? { members: [...tree.members] } : {}),
  });
  for (const [suffix, child] of tree.children) flatten(child, path + suffix, out);
}

/** Canonical text of a subtree, for structural equality. */
function fingerprint(tree: Tree): string {
  const nodes: ShapeNode[] = [];
  flatten(tree, "", nodes);
  nodes.sort((a, b) => compareText(a.path, b.path));
  return JSON.stringify(nodes);
}

function isLiteralKind(kind: ShapeKind): boolean {
  return kind === "literal" || kind === "literal-union";
}

/** Merge two shapes of the same position in a union that has no discriminant. */
function merge(a: Tree, b: Tree, path: string): Tree {
  const optional = a.optional || b.optional;
  const nullable = a.nullable || b.nullable;
  if (a.kind === "null") return { ...b, optional, nullable: true };
  if (b.kind === "null") return { ...a, optional, nullable: true };

  if (isLiteralKind(a.kind) && isLiteralKind(b.kind) && a.literalOf === b.literalOf) {
    const members = sortedUnique([...(a.members ?? []), ...(b.members ?? [])]);
    return {
      kind: members.length === 1 ? "literal" : "literal-union",
      optional,
      nullable,
      members,
      ...(a.literalOf !== undefined ? { literalOf: a.literalOf } : {}),
      children: new Map(),
    };
  }
  if (a.kind !== b.kind || isLiteralKind(a.kind)) {
    throw unsupported(path, `union variants disagree on kind (${a.kind} vs ${b.kind})`);
  }

  const children = new Map<string, Tree>();
  for (const suffix of new Set([...a.children.keys(), ...b.children.keys()])) {
    const left = a.children.get(suffix);
    const right = b.children.get(suffix);
    if (left !== undefined && right !== undefined) {
      children.set(suffix, merge(left, right, path + suffix));
    } else if (a.kind === "object") {
      // A field one variant lacks may be absent on the wire.
      children.set(suffix, { ...(left ?? right)!, optional: true });
    } else {
      throw unsupported(path, `union variants disagree on ${a.kind} layout at ${suffix}`);
    }
  }
  return {
    kind: a.kind,
    optional,
    nullable,
    ...(a.kind === "scalar-union" ? { members: sortedUnique([...(a.members ?? []), ...(b.members ?? [])]) } : {}),
    children,
  };
}

/**
 * The discriminant of a union of objects: the first property name (code-unit order) that every
 * variant carries as one required string literal, with all values distinct.
 */
function findDiscriminant(variants: readonly Tree[]): string | null {
  const first = variants[0];
  if (first === undefined) return null;
  const candidates = [...first.children.keys()].filter((suffix) => suffix.startsWith(".")).sort(compareText);
  for (const suffix of candidates) {
    const values = new Set<string>();
    const qualifies = variants.every((variant) => {
      const field = variant.children.get(suffix);
      const value = field?.members?.[0];
      if (field === undefined || value === undefined) return false;
      if (field.kind !== "literal" || field.literalOf !== "string" || field.optional || field.nullable) return false;
      values.add(value);
      return true;
    });
    if (qualifies && values.size === variants.length) return suffix;
  }
  return null;
}

function combineObjectUnion(variants: readonly Tree[], path: string): Tree {
  const discriminant = variants.every((v) => v.kind === "object") ? findDiscriminant(variants) : null;
  if (discriminant === null) {
    return variants.reduce((acc, variant) => merge(acc, variant, path));
  }

  const valueOf = (variant: Tree): string => variant.children.get(discriminant)!.members![0]!;
  const children = new Map<string, Tree>();
  children.set(
    discriminant,
    leaf("literal-union", { members: sortedUnique(variants.map(valueOf)), literalOf: "string" }),
  );

  const fieldNames = new Set<string>();
  for (const variant of variants) {
    for (const suffix of variant.children.keys()) if (suffix !== discriminant) fieldNames.add(suffix);
  }
  for (const suffix of fieldNames) {
    const fields = variants.map((variant) => variant.children.get(suffix));
    const firstField = fields[0];
    const shared =
      firstField !== undefined &&
      fields.every((field) => field !== undefined && fingerprint(field) === fingerprint(firstField));
    if (shared) {
      children.set(suffix, firstField);
      continue;
    }
    // The field differs between variants (or some lack it): emit it under each variant's segment.
    variants.forEach((variant, i) => {
      const field = fields[i];
      if (field !== undefined) children.set(`(${discriminant.slice(1)}=${valueOf(variant)})${suffix}`, field);
    });
  }
  return leaf("object", { children });
}

class Walker {
  private readonly stack = new Set<ts.Type>();

  constructor(private readonly checker: ts.TypeChecker) {}

  visit(type: ts.Type, path: string, optional: boolean): Tree {
    if (this.stack.size > MAX_DEPTH) throw unsupported(path, "wire type is nested deeper than 40 levels");

    let nullable = false;
    const parts: ts.Type[] = [];
    for (const part of type.isUnion() ? type.types : [type]) {
      if (part.flags & ts.TypeFlags.Null) {
        nullable = true;
      } else if (part.flags & ts.TypeFlags.Undefined) {
        if (!optional) throw unsupported(path, "required member admits undefined; use ?:");
      } else {
        parts.push(part);
      }
    }

    const tree = this.classify(parts, type, path);
    tree.optional = optional;
    tree.nullable = nullable || tree.kind === "null";
    return tree;
  }

  private describe(type: ts.Type): string {
    return this.checker.typeToString(type);
  }

  private classify(parts: readonly ts.Type[], whole: ts.Type, path: string): Tree {
    if (parts.length === 0) {
      if (whole.flags & ts.TypeFlags.Null || whole.isUnion()) return leaf("null");
      throw unsupported(path, `cannot classify ${this.describe(whole)}`);
    }

    const objects: ts.Type[] = [];
    const literals = new Map<Primitive, Set<string>>();
    const wide = new Set<Primitive>();
    let template = false;
    for (const part of parts) {
      const f = part.flags;
      if (f & (ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral)) {
        throw unsupported(path, `enum ${this.describe(part)} is not a wire type; use a literal union`);
      } else if (f & ts.TypeFlags.StringLiteral) {
        addTo(literals, "string", (part as ts.StringLiteralType).value);
      } else if (f & ts.TypeFlags.NumberLiteral) {
        addTo(literals, "number", String((part as ts.NumberLiteralType).value));
      } else if (f & ts.TypeFlags.BooleanLiteral) {
        addTo(literals, "boolean", this.describe(part));
      } else if (f & ts.TypeFlags.String) {
        wide.add("string");
      } else if (f & ts.TypeFlags.Number) {
        wide.add("number");
      } else if (f & ts.TypeFlags.Boolean) {
        wide.add("boolean");
      } else if (f & ts.TypeFlags.TemplateLiteral) {
        template = true;
      } else if (f & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
        objects.push(part);
      } else {
        throw unsupported(path, `cannot classify ${this.describe(part)}`);
      }
    }

    // `true | false` is `boolean`.
    if (literals.get("boolean")?.size === 2) {
      literals.delete("boolean");
      wide.add("boolean");
    }

    const scalarCount = literals.size + wide.size + (template ? 1 : 0);
    if (objects.length > 0) {
      if (scalarCount > 0) throw unsupported(path, `union mixes objects and primitives: ${this.describe(whole)}`);
      const variants = objects.map((object) => this.visitObject(object, path));
      return variants.length === 1 ? variants[0]! : combineObjectUnion(variants, path);
    }

    if (template) {
      if (scalarCount > 1) throw unsupported(path, `union mixes a template literal: ${this.describe(whole)}`);
      return leaf("template");
    }

    const kinds = sortedUnique([...literals.keys(), ...wide]) as Primitive[];
    if (kinds.length > 1) return leaf("scalar-union", { members: kinds });
    const only = kinds[0]!;
    if (wide.has(only)) return leaf(only);
    const members = sortedUnique(literals.get(only)!);
    return leaf(members.length === 1 ? "literal" : "literal-union", { members, literalOf: only });
  }

  private visitObject(type: ts.Type, path: string): Tree {
    if (this.stack.has(type)) throw unsupported(path, `recursive wire type ${this.describe(type)}`);
    this.stack.add(type);
    try {
      return this.classifyObject(type, path);
    } finally {
      this.stack.delete(type);
    }
  }

  private classifyObject(type: ts.Type, path: string): Tree {
    const { checker } = this;
    if (checker.isTupleType(type)) {
      const tree = leaf("tuple");
      checker.getTypeArguments(type as ts.TypeReference).forEach((element, i) => {
        tree.children.set(`[${i}]`, this.visit(element, `${path}[${i}]`, false));
      });
      return tree;
    }
    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(type as ts.TypeReference)[0];
      if (element === undefined) throw unsupported(path, `array without an element type: ${this.describe(type)}`);
      const tree = leaf("array");
      tree.children.set("[]", this.visit(element, `${path}[]`, false));
      return tree;
    }
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      throw unsupported(path, `function type ${this.describe(type)} is not a wire type`);
    }

    const properties = checker.getPropertiesOfType(type);
    const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
    if (index !== undefined) {
      if (properties.length > 0) {
        throw unsupported(path, `type mixes named members with an index signature: ${this.describe(type)}`);
      }
      // `Record<string, never>` is an object that never has members.
      if (index.type.flags & ts.TypeFlags.Never) return leaf("object");
      const tree = leaf("record");
      tree.children.set("{}", this.visit(index.type, `${path}{}`, false));
      return tree;
    }
    if (checker.getIndexInfosOfType(type).length > 0) {
      throw unsupported(path, `non-string index signature: ${this.describe(type)}`);
    }

    const tree = leaf("object");
    for (const property of [...properties].sort((a, b) => compareText(a.name, b.name))) {
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      const childPath = `${path}.${property.name}`;
      tree.children.set(`.${property.name}`, this.visit(checker.getTypeOfSymbol(property), childPath, optional));
    }
    return tree;
  }
}

function addTo(map: Map<Primitive, Set<string>>, key: Primitive, value: string): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

function createWireProgram(repoRoot: string): { program: ts.Program; barrel: ts.SourceFile } {
  const configPath = join(repoRoot, WEB_DATA_TSCONFIG);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw unsupported(WEB_DATA_TSCONFIG, ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (parsed === undefined) throw unsupported(WEB_DATA_TSCONFIG, "tsconfig could not be read");

  const { outDir: _outDir, rootDir: _rootDir, tsBuildInfoFile: _info, ...base } = parsed.options;
  const options: ts.CompilerOptions = {
    ...base,
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    skipLibCheck: true,
    baseUrl: repoRoot,
    // Resolve the workspace packages to source, so no `dist/` is needed.
    paths: {
      "@pulse/renderer": ["packages/renderer/src/index.ts"],
      "@pulse/core": ["packages/core/src/index.ts"],
    },
  };
  const barrelPath = join(repoRoot, WIRE_BARREL);
  const program = ts.createProgram({ rootNames: [barrelPath], options });
  const barrel = program.getSourceFile(barrelPath);
  if (barrel === undefined) throw unsupported(WIRE_BARREL, "wire barrel is not part of the program");
  return { program, barrel };
}

/**
 * Extract the ShapeSnapshot for SHAPE_ROOTS at CONTRACT_VERSION.
 *
 * The result is deterministic: roots are inserted in sorted order, nodes are sorted by path
 * (code-unit order) and members are sorted.
 *
 * @param repoRoot absolute path of the repository root
 * @throws {ContractToolError} SHAPE_UNSUPPORTED_TYPE (subject = offending path) for a type that cannot be classified
 * @throws {ContractToolError} SHAPE_UNSUPPORTED_TYPE (subject = root name) when a root is not exported
 */
export function extractShape(repoRoot: string): ShapeSnapshot {
  const { program, barrel } = createWireProgram(repoRoot);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(barrel);
  if (moduleSymbol === undefined) throw unsupported(WIRE_BARREL, "wire barrel has no module symbol");
  const exports = new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]));

  const roots: Record<string, readonly ShapeNode[]> = {};
  for (const name of [...SHAPE_ROOTS].sort(compareText)) {
    const exported = exports.get(name);
    if (exported === undefined) throw unsupported(name, "shape root is not exported from the wire barrel");
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const type = checker.getDeclaredTypeOfSymbol(symbol);

    const nodes: ShapeNode[] = [];
    flatten(new Walker(checker).visit(type, name, false), name, nodes);
    nodes.sort((a, b) => compareText(a.path, b.path));
    roots[name] = nodes.filter((node, i) => i === 0 || JSON.stringify(node) !== JSON.stringify(nodes[i - 1]));
  }
  return { version: { major: CONTRACT_VERSION.major, minor: CONTRACT_VERSION.minor }, roots };
}
