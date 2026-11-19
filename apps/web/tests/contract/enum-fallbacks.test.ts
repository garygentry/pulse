// apps/web/tests/contract/enum-fallbacks.test.ts — the enum fallback table against the extracted shape:
// every closed field has exactly one fallback, no fallback path is stale, and each group has its fixture.

import { expect, test } from "bun:test";

import { ENUM_FALLBACKS } from "@pulse/web-data/contract";

import type { ShapeNode } from "../../scripts/contract/shape-types.js";
import { currentShape, fixtureIndex, GENERATION_TIMEOUT } from "./generated.js";

async function nodesByPath(): Promise<Map<string, ShapeNode>> {
  const shape = await currentShape();
  return new Map(Object.values(shape.roots).flatMap((nodes) => nodes.map((node) => [node.path, node] as const)));
}

function groupsByPath(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of ENUM_FALLBACKS) {
    for (const path of entry.paths) groups.set(path, [...(groups.get(path) ?? []), entry.group]);
  }
  return groups;
}

test("every literal-union path is in exactly one fallback entry", async () => {
  const groups = groupsByPath();
  const problems: string[] = [];
  let unions = 0;
  for (const node of (await nodesByPath()).values()) {
    if (node.kind !== "literal-union") continue;
    unions += 1;
    const owners = groups.get(node.path) ?? [];
    if (owners.length === 0) problems.push(`uncovered: ${node.path} (${(node.members ?? []).join(" | ")})`);
    else if (owners.length > 1) problems.push(`duplicate: ${node.path} (${owners.join(", ")})`);
  }
  expect(problems).toEqual([]);
  expect(unions).toBeGreaterThan(0);
}, GENERATION_TIMEOUT);

test("every fallback path exists in the shape as a literal-union, literal or object node", async () => {
  const nodes = await nodesByPath();
  const problems: string[] = [];
  for (const entry of ENUM_FALLBACKS) {
    for (const path of entry.paths) {
      const kind = nodes.get(path)?.kind;
      if (kind !== "literal-union" && kind !== "literal" && kind !== "object") {
        problems.push(`stale fallback path: ${path} (${entry.group}, ${kind ?? "absent"})`);
      }
    }
  }
  expect(problems).toEqual([]);
}, GENERATION_TIMEOUT);

test("an as-member fallback names a member of every path's union", async () => {
  const nodes = await nodesByPath();
  const problems: string[] = [];
  let checked = 0;
  for (const entry of ENUM_FALLBACKS) {
    if (entry.fallback.kind !== "as-member") continue;
    for (const path of entry.paths) {
      checked += 1;
      const members = nodes.get(path)?.members ?? [];
      if (!members.includes(entry.fallback.member)) {
        problems.push(`${entry.group}: ${entry.fallback.member} is not a member at ${path} (${members.join(" | ")})`);
      }
    }
  }
  expect(problems).toEqual([]);
  expect(checked).toBeGreaterThan(0);
}, GENERATION_TIMEOUT);

test("groups are kebab-case and unique", () => {
  const groups = ENUM_FALLBACKS.map((entry) => entry.group);
  for (const group of groups) expect(group).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  expect(new Set(groups).size).toBe(groups.length);
});

test("every group has exactly one unknown-enum fixture in the index", async () => {
  const scenarios = (await fixtureIndex()).fixtures
    .map((entry) => entry.scenario)
    .filter((scenario) => scenario.startsWith("unknown-enum-"))
    .sort();
  expect(scenarios).toEqual(ENUM_FALLBACKS.map((entry) => `unknown-enum-${entry.group}`).sort());
}, GENERATION_TIMEOUT);
