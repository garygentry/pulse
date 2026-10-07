/** order.test.ts — the code-point comparator and the fixed collection-class order (02 §6.1).
 *
 *  Asserts: compareString is raw UTF-16 code-point comparison ('Z' < 'a', non-ASCII), NEVER
 *  locale collation; COLLECTION_CLASSES is the fixed 5-class order. */

import { expect, test, describe } from "bun:test";

import { compareString, COLLECTION_CLASSES } from "../src/order.js";

describe("compareString", () => {
  test("returns -1 / 0 / 1", () => {
    expect(compareString("a", "b")).toBe(-1);
    expect(compareString("b", "a")).toBe(1);
    expect(compareString("a", "a")).toBe(0);
  });

  test("is code-point, not locale: 'Z' sorts before 'a' (uppercase < lowercase)", () => {
    // Under ASCII/UTF-16 code points 'Z' (0x5A) < 'a' (0x61). A locale collator would
    // typically order 'a' < 'Z' (case-insensitive-ish). This proves we do NOT collate.
    expect(compareString("Z", "a")).toBe(-1);
    expect("Z".localeCompare("a")).toBeGreaterThan(0); // documents the locale disagreement
  });

  test("non-ASCII compares by code point", () => {
    // 'ä' (U+00E4) > 'z' (U+007A) by code point, though a locale collator often orders 'ä'
    // near 'a'. Raw code-point comparison must put 'z' first.
    expect(compareString("z", "ä")).toBe(-1);
    expect(compareString("ä", "z")).toBe(1);
    // Emoji / astral-adjacent BMP ordering is still deterministic by code unit.
    expect(compareString("€", "$")).toBe(1); // U+20AC > U+0024
  });

  test("sorting an array with compareString is stable and code-point ordered", () => {
    const input = ["banana", "Apple", "apple", "Zebra", "ä"];
    const sorted = [...input].sort(compareString);
    expect(sorted).toEqual(["Apple", "Zebra", "apple", "banana", "ä"]);
  });
});

describe("COLLECTION_CLASSES", () => {
  test("is the fixed 5-class order", () => {
    expect([...COLLECTION_CLASSES]).toEqual([
      "managed-linux",
      "hypervisor-api",
      "nas-api",
      "probe-only",
      "excluded",
    ]);
  });
});
