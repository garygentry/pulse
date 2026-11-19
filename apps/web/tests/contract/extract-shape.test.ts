import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONTRACT_VERSION } from "@pulse/web-data/contract";
import { classifyShapeDiff } from "../../scripts/contract/classify-shape-diff.js";
import { ContractToolError } from "../../scripts/contract/errors.js";
import { extractShape } from "../../scripts/contract/extract-shape.js";
import { SHAPE_ROOTS } from "../../scripts/contract/shape-types.js";
import type { ShapeNode } from "../../scripts/contract/shape-types.js";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
/** Each extraction builds a TypeScript program; allow for a loaded host. */
const SLOW = { timeout: 120_000 };

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repo root whose wire barrel is `source`, plus a trivial export for every other root. */
function fakeRepo(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "pulse-shape-"));
  scratch.push(root);
  mkdirSync(join(root, "packages/web-data/src/wire"), { recursive: true });
  writeFileSync(
    join(root, "packages/web-data/tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, exactOptionalPropertyTypes: true },
      include: ["src/**/*.ts"],
    }),
  );
  const filler = SHAPE_ROOTS.filter((name) => !new RegExp(`\\b(interface|type) ${name}\\b`).test(source))
    .map((name) => `export interface ${name} { readonly ok: true }`)
    .join("\n");
  writeFileSync(join(root, "packages/web-data/src/wire/index.ts"), `${source}\n${filler}\n`);
  return root;
}

function n(path: string, kind: ShapeNode["kind"], extra: Partial<Omit<ShapeNode, "path" | "kind">> = {}): ShapeNode {
  return { path, kind, optional: false, nullable: false, ...extra };
}

function expectUnsupported(source: string, subject: string, message: RegExp): void {
  let thrown: unknown;
  try {
    extractShape(fakeRepo(source));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractToolError);
  const error = thrown as ContractToolError;
  expect(error.code).toBe("SHAPE_UNSUPPORTED_TYPE");
  expect(error.subject).toBe(subject);
  expect(error.message).toMatch(message);
}

describe("extractShape over the real wire types", () => {
  test("two consecutive runs return the same snapshot, in the same key order", () => {
    const first = extractShape(REPO_ROOT);
    const second = extractShape(REPO_ROOT);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(classifyShapeDiff(first, second)).toEqual({ class: "none", changes: [] });

    expect(first.version).toEqual({ major: CONTRACT_VERSION.major, minor: CONTRACT_VERSION.minor });
    expect(Object.keys(first.roots)).toEqual([...SHAPE_ROOTS].sort());
    for (const [root, nodes] of Object.entries(first.roots)) {
      const paths = nodes.map((node) => node.path);
      expect(paths).toEqual([...paths].sort());
      expect(new Set(paths).size).toBe(paths.length);
      expect(nodes[0]).toEqual(n(root, "object"));
      for (const node of nodes) {
        expect(Object.keys(node)).toEqual(["path", "kind", "optional", "nullable", ...(node.members ? ["members"] : [])]);
        if (node.members) expect([...node.members]).toEqual([...node.members].sort());
      }
    }

    const find = (root: string, path: string) => first.roots[root]?.find((node) => node.path === path);
    expect(find("SessionPayload", "SessionPayload.contract.major")).toEqual(n("SessionPayload.contract.major", "number"));
    expect(find("BundleErrorBody", "BundleErrorBody.kind")?.kind).toBe("literal-union");
    expect(find("ErrorEnvelope", "ErrorEnvelope.details{}")).toMatchObject({
      kind: "scalar-union",
      nullable: true,
      members: ["boolean", "number", "string"],
    });
    expect(find("HistoryPayload", "HistoryPayload.series[].points[]")?.kind).toBe("tuple");
    expect(find("EstatePayload", "EstatePayload.estate.hosts[](collectionClass=managed-linux).detail.exporterPorts[]")).toEqual(
      n("EstatePayload.estate.hosts[](collectionClass=managed-linux).detail.exporterPorts[]", "number"),
    );
    expect(find("EstatePayload", "EstatePayload.coverage.value")).toEqual(n("EstatePayload.coverage.value", "object", { nullable: true }));
  }, SLOW);
});

describe("extractShape traversal rules", () => {
  test("scalars, literals, containers and unions of objects", () => {
    const shape = extractShape(
      fakeRepo(`
        export type Hash = \`sha256:\${string}\`;
        type Level = "warn" | "info";
        export interface SessionPayload {
          readonly text: string;
          readonly count?: number;
          readonly flag: boolean | null;
          readonly formatVersion: 2;
          readonly acked?: true;
          readonly level: Level;
          readonly levelAgain: Readonly<{ readonly inner: Level }>["inner"];
          readonly hash: Hash;
          readonly mixed: number | string | boolean | null;
          readonly nothing: null;
          readonly list: readonly string[];
          readonly pair: readonly [at: number, value: number | null];
          readonly labels: Readonly<Record<string, string>>;
          readonly empty: Record<string, never>;
          readonly finite: Readonly<Record<"b" | "a", number>>;
          readonly both: { readonly x: string } & { readonly y?: number };
        }
        export type OverviewSnapshotV2 =
          | { readonly kind: "host"; readonly id: string }
          | { readonly kind: "service"; readonly id: string };
        export interface AlertsPayload {
          readonly items: readonly (
            | { readonly kind: "a"; readonly id: string; readonly only: number; readonly differs: string }
            | { readonly kind: "b"; readonly id: string; readonly differs?: string }
          )[];
        }
        type Section<T> = { readonly why: string; readonly value: T } | { readonly why: string; readonly value: null; readonly hint: "x" };
        export interface EstatePayload {
          readonly section: Section<{ readonly n: number }>;
          readonly lit: { readonly v: "p" } | { readonly v: "q" | "r" };
        }
      `),
    );

    expect(shape.roots.SessionPayload).toEqual([
      n("SessionPayload", "object"),
      n("SessionPayload.acked", "literal", { optional: true, members: ["true"] }),
      n("SessionPayload.both", "object"),
      n("SessionPayload.both.x", "string"),
      n("SessionPayload.both.y", "number", { optional: true }),
      n("SessionPayload.count", "number", { optional: true }),
      n("SessionPayload.empty", "object"),
      n("SessionPayload.finite", "object"),
      n("SessionPayload.finite.a", "number"),
      n("SessionPayload.finite.b", "number"),
      n("SessionPayload.flag", "boolean", { nullable: true }),
      n("SessionPayload.formatVersion", "literal", { members: ["2"] }),
      n("SessionPayload.hash", "template"),
      n("SessionPayload.labels", "record"),
      n("SessionPayload.labels{}", "string"),
      n("SessionPayload.level", "literal-union", { members: ["info", "warn"] }),
      n("SessionPayload.levelAgain", "literal-union", { members: ["info", "warn"] }),
      n("SessionPayload.list", "array"),
      n("SessionPayload.list[]", "string"),
      n("SessionPayload.mixed", "scalar-union", { nullable: true, members: ["boolean", "number", "string"] }),
      n("SessionPayload.nothing", "null", { nullable: true }),
      n("SessionPayload.pair", "tuple"),
      n("SessionPayload.pair[0]", "number"),
      n("SessionPayload.pair[1]", "number", { nullable: true }),
      n("SessionPayload.text", "string"),
    ]);

    // Variants identical apart from the discriminant collapse into one object.
    expect(shape.roots.OverviewSnapshotV2).toEqual([
      n("OverviewSnapshotV2", "object"),
      n("OverviewSnapshotV2.id", "string"),
      n("OverviewSnapshotV2.kind", "literal-union", { members: ["host", "service"] }),
    ]);

    // Differing variants: shared fields once, the rest under a `(field=value)` segment.
    expect(shape.roots.AlertsPayload).toEqual([
      n("AlertsPayload", "object"),
      n("AlertsPayload.items", "array"),
      n("AlertsPayload.items[]", "object"),
      n("AlertsPayload.items[](kind=a).differs", "string"),
      n("AlertsPayload.items[](kind=a).only", "number"),
      n("AlertsPayload.items[](kind=b).differs", "string", { optional: true }),
      n("AlertsPayload.items[].id", "string"),
      n("AlertsPayload.items[].kind", "literal-union", { members: ["a", "b"] }),
    ]);

    // No discriminant: the variants merge.
    expect(shape.roots.EstatePayload).toEqual([
      n("EstatePayload", "object"),
      n("EstatePayload.lit", "object"),
      n("EstatePayload.lit.v", "literal-union", { members: ["p", "q", "r"] }),
      n("EstatePayload.section", "object"),
      n("EstatePayload.section.hint", "literal", { optional: true, members: ["x"] }),
      n("EstatePayload.section.value", "object", { nullable: true }),
      n("EstatePayload.section.value.n", "number"),
      n("EstatePayload.section.why", "string"),
    ]);

    expect(shape.roots.LiveTick).toEqual([n("LiveTick", "object"), n("LiveTick.ok", "literal", { members: ["true"] })]);
  }, SLOW);

  test("unclassifiable types throw SHAPE_UNSUPPORTED_TYPE with the offending path", () => {
    expectUnsupported("export interface LiveTick { readonly a: { readonly bad: unknown } }", "LiveTick.a.bad", /unknown/);
    expectUnsupported("export interface LiveTick { readonly fn: () => void }", "LiveTick.fn", /function type/);
    expectUnsupported("export interface LiveTick { readonly u: string | undefined }", "LiveTick.u", /use \?:/);
    expectUnsupported("export interface LiveTick { readonly m: string | { readonly a: number } }", "LiveTick.m", /mixes objects and primitives/);
    expectUnsupported(
      "export interface Node { readonly children: readonly Node[] }\nexport interface LiveTick { readonly tree: Node }",
      "LiveTick.tree.children[]",
      /recursive wire type/,
    );
    expectUnsupported(
      "export enum Colour { Red = 'red' }\nexport interface LiveTick { readonly c: Colour }",
      "LiveTick.c",
      /enum/,
    );
    expectUnsupported(
      "export interface LiveTick { readonly v: { readonly a: string } | { readonly a: number } }",
      "LiveTick.v.a",
      /disagree on kind/,
    );
  }, SLOW);

  test("a root missing from the wire barrel throws with the root name as subject", () => {
    const root = fakeRepo("");
    writeFileSync(join(root, "packages/web-data/src/wire/index.ts"), "export interface SessionPayload { readonly ok: true }\n");
    let thrown: unknown;
    try {
      extractShape(root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractToolError);
    expect((thrown as ContractToolError).code).toBe("SHAPE_UNSUPPORTED_TYPE");
    expect(SHAPE_ROOTS as readonly string[]).toContain((thrown as ContractToolError).subject);
    expect((thrown as ContractToolError).subject).not.toBe("SessionPayload");
  }, SLOW);
});
