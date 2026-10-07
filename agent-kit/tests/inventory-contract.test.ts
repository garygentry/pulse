// agent-kit/tests/inventory-contract.test.ts
// inventory-schema contract lock (06-testing-and-eval.md §5.4; REQ-DRIFT-05).
//
// Asserts the taught `InventoryVocab` slot (00 §4.1) matches live `inventorySchema` introspection,
// and that the committed reference estate parses clean against that same schema. The vocabulary
// the primer teaches is DERIVED from the schema (04 §2), so a renamed/added/removed collection
// class, a new top-level section, or a schema-major bump fails the build (REQ-DRIFT-05).
//
// Discipline (spec §1): GATING — drives the REAL `inventorySchema` (no mock) and reads the REAL
// reference estate; a missing target throws at import/read (fails RED), never self-skips.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

import { inventorySchema, CURRENT_SCHEMA_MAJOR } from "@pulse/core";
import {
  buildInventoryVocab,
  collectionClasses,
  VOCAB_SUMMARIES,
} from "../src/slots/inventory-vocab.js"; // authoritative exports (04 §2/§7)

// The slot the content renders from, built exactly as buildSlots() builds it (04 §7).
const inventoryVocab = buildInventoryVocab(VOCAB_SUMMARIES);

describe("inventory-contract (REQ-DRIFT-05)", () => {
  test("taught collection classes == introspected host discriminated-union literals", () => {
    // Same object the content renders from == the freshly introspected literals (both sorted).
    expect([...inventoryVocab.collectionClasses]).toEqual(collectionClasses());
  });

  test("taught sections == inventorySchema.shape keys (schema-declared order)", () => {
    expect(inventoryVocab.sections.map((s) => s.key)).toEqual(Object.keys(inventorySchema.shape));
  });

  test("taught schema major == CURRENT_SCHEMA_MAJOR", () => {
    expect(inventoryVocab.schemaMajor).toBe(CURRENT_SCHEMA_MAJOR);
  });

  test("reference estate parses clean against inventorySchema (currency-by-construction)", () => {
    const yaml = readFileSync(
      resolve(import.meta.dir, "../../examples/reference/estate/estate.yaml"),
      "utf8",
    );
    expect(() => inventorySchema.parse(parse(yaml))).not.toThrow();
  });
});
