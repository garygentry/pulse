/** enums.test.ts — structure rules of the enum-fallback table. Whether each `as-member` member belongs to its
 *  union needs the extracted field shapes and is checked with the generated contract artifacts instead. */

import { describe, expect, test } from "bun:test";
import { ENUM_FALLBACKS, type EnumFallbackEntry } from "../../src/contract/enums.js";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const GROUP = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** `<Root>` then `.name`, `[]`, `{}`, `[n]` or `(field=value)` segments. */
const PATH = /^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+|\[\d*\]|\{\}|\([A-Za-z0-9_]+=[A-Za-z0-9_-]+\))+$/;

describe("ENUM_FALLBACKS structure", () => {
  test("the table is non-empty and every level is frozen", () => {
    expect(ENUM_FALLBACKS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(ENUM_FALLBACKS)).toBe(true);
    for (const entry of ENUM_FALLBACKS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.paths)).toBe(true);
      expect(Object.isFrozen(entry.fallback)).toBe(true);
    }
  });

  test("groups are kebab-case, unique and sorted ascending", () => {
    const groups = ENUM_FALLBACKS.map((entry) => entry.group);
    for (const group of groups) expect(group).toMatch(GROUP);
    expect(new Set(groups).size).toBe(groups.length);
    expect(groups).toEqual([...groups].sort(byCodeUnit));
  });

  test("paths are well-formed, non-empty and sorted inside each entry", () => {
    for (const entry of ENUM_FALLBACKS) {
      expect(entry.paths.length).toBeGreaterThan(0);
      for (const path of entry.paths) expect(path).toMatch(PATH);
      expect([...entry.paths]).toEqual([...entry.paths].sort(byCodeUnit));
    }
  });

  test("paths are unique across the whole table", () => {
    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const entry of ENUM_FALLBACKS) {
      for (const path of entry.paths) {
        const previous = owner.get(path);
        if (previous !== undefined) duplicates.push(`${path} (${previous}, ${entry.group})`);
        owner.set(path, entry.group);
      }
    }
    expect(duplicates).toEqual([]);
  });

  test("every fallback is a non-empty member or a non-empty display-rule sentence", () => {
    for (const entry of ENUM_FALLBACKS) {
      const fallback: EnumFallbackEntry["fallback"] = entry.fallback;
      if (fallback.kind === "as-member") {
        expect(fallback.member.length).toBeGreaterThan(0);
        expect(fallback.member).toBe(fallback.member.trim());
      } else {
        expect(fallback.kind).toBe("display-rule");
        expect(fallback.rule.trim().length).toBeGreaterThan(0);
        expect(fallback.rule).toMatch(/^[A-Z].*\.$/);
      }
    }
  });

  test("the baseline groups are present with their fallbacks", () => {
    const fallbackOf = (group: string): EnumFallbackEntry["fallback"] | undefined =>
      ENUM_FALLBACKS.find((entry) => entry.group === group)?.fallback;
    expect(fallbackOf("target-status")).toEqual({ kind: "as-member", member: "unknown" });
    expect(fallbackOf("alert-state")).toEqual({ kind: "as-member", member: "firing" });
    expect(fallbackOf("silence-state")).toEqual({ kind: "as-member", member: "expired" });
    expect(fallbackOf("availability-state")).toEqual({ kind: "as-member", member: "unavailable" });
    expect(fallbackOf("overview-severity")?.kind).toBe("display-rule");
    expect(fallbackOf("bundle-error-kind")?.kind).toBe("display-rule");
    expect(fallbackOf("view-id")?.kind).toBe("display-rule");
  });
});
