import type { ShapeChange, ShapeDiff, ShapeKind, ShapeNode, ShapeSnapshot } from "./shape-types.js";

/** Version bump a diff class requires: breaking → major, additive → minor. */
export type VersionBump = "none" | "minor" | "major";

/** Map a diff class to the contract version component that must be bumped. */
export function requiredVersionBump(diff: ShapeDiff): VersionBump {
  if (diff.class === "breaking") return "major";
  return diff.class === "additive" ? "minor" : "none";
}

/** `literal` and `literal-union` are the same kind for comparison: both are sets of literal members. */
function comparableKind(kind: ShapeKind): ShapeKind {
  return kind === "literal" ? "literal-union" : kind;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function diffNode(previous: ShapeNode, current: ShapeNode, out: ShapeChange[]): void {
  const path = current.path;
  const kind = comparableKind(current.kind);
  if (comparableKind(previous.kind) !== kind) {
    out.push({ path, change: "kind-changed", class: "breaking" });
  } else if (kind === "literal-union" || kind === "scalar-union") {
    const before = new Set(previous.members ?? []);
    const after = new Set(current.members ?? []);
    const gained = [...after].some((member) => !before.has(member));
    const lost = [...before].some((member) => !after.has(member));
    // A scalar union that gains a primitive kind is a retype, so it is breaking in both directions.
    if (gained) out.push({ path, change: "member-added", class: kind === "scalar-union" ? "breaking" : "additive" });
    if (lost) out.push({ path, change: "member-removed", class: "breaking" });
  }
  if (previous.optional !== current.optional) out.push({ path, change: "optional-changed", class: "breaking" });
  if (previous.nullable !== current.nullable) out.push({ path, change: "nullable-changed", class: "breaking" });
}

/**
 * Compare two snapshots root by root and node by node (matched on path). Pure; never throws.
 *
 * A root that exists on one side only yields a single `root-added` / `root-removed` change. Inside
 * a shared root, every path that exists on one side only is reported, including the children of an
 * added or removed subtree.
 */
export function classifyShapeDiff(previous: ShapeSnapshot, current: ShapeSnapshot): ShapeDiff {
  const changes: ShapeChange[] = [];
  const rootNames = new Set([...Object.keys(previous.roots), ...Object.keys(current.roots)]);
  for (const root of rootNames) {
    const before = Object.hasOwn(previous.roots, root) ? previous.roots[root] : undefined;
    const after = Object.hasOwn(current.roots, root) ? current.roots[root] : undefined;
    if (before === undefined) {
      changes.push({ path: root, change: "root-added", class: "additive" });
      continue;
    }
    if (after === undefined) {
      changes.push({ path: root, change: "root-removed", class: "breaking" });
      continue;
    }
    const beforeByPath = new Map(before.map((node) => [node.path, node]));
    const afterByPath = new Map(after.map((node) => [node.path, node]));
    for (const [path, node] of afterByPath) {
      const old = beforeByPath.get(path);
      if (old === undefined) changes.push({ path, change: "field-added", class: "additive" });
      else diffNode(old, node, changes);
    }
    for (const path of beforeByPath.keys()) {
      if (!afterByPath.has(path)) changes.push({ path, change: "field-removed", class: "breaking" });
    }
  }
  changes.sort((a, b) => compareText(a.path, b.path) || compareText(a.change, b.change));
  const cls = changes.some((c) => c.class === "breaking") ? "breaking" : changes.length > 0 ? "additive" : "none";
  return { class: cls, changes };
}
