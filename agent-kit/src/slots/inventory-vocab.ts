// agent-kit/src/slots/inventory-vocab.ts
// inventory-schema lock via Zod introspection (REQ-DRIFT-05, REQ-INTEG-04).
//
// Produces the `InventoryVocab` slot value that the vocab-primer
// (REQ-GUIDE-02) and estate-authoring skill (REQ-SKILL-01) render from — and the same three
// derived enumerations the contract test asserts the content against. This is the ONLY place
// Zod-object-shape coupling lives; a Zod major bump or an upstream schema
// restructuring touches only this file, and every shape assumption throws SlotMismatchError
// rather than silently deriving a wrong vocabulary.

import { inventorySchema, CURRENT_SCHEMA_MAJOR } from "@pulse/core"; // packages/core/src/index.ts:36,39
import { z } from "zod"; // transitively via @pulse/core; monorepo-pinned ^3.23.0

import type { InventoryVocab, VocabSection } from "../emit/types.js";
import { SlotMismatchError } from "../emit/errors.js";

/**
 * Enumerate host collection classes from the `hosts` discriminated union. Localizes ALL
 * Zod-object-shape coupling to this function. Sorted for determinism
 * (REQ-PERF-02) and to give the contract test a stable comparison basis.
 *
 * @throws {SlotMismatchError} If the schema shape is not the expected
 *   optional-array-of-discriminated-union — i.e. a Zod major bump or an upstream
 *   restructuring changed the surface this helper depends on. Failing loudly here is the
 *   intended "fail the build rather than ship stale vocabulary" behavior (REQ-DRIFT-05).
 */
export function collectionClasses(): string[] {
  const hostsField = inventorySchema.shape.hosts;
  if (!(hostsField instanceof z.ZodOptional)) {
    throw new SlotMismatchError("inventoryVocab", "inventorySchema.shape.hosts is not ZodOptional");
  }
  const array = hostsField.unwrap();
  if (!(array instanceof z.ZodArray)) {
    throw new SlotMismatchError("inventoryVocab", "hosts is not an optional ZodArray");
  }
  const union = array.element;
  if (!(union instanceof z.ZodDiscriminatedUnion)) {
    throw new SlotMismatchError("inventoryVocab", "host element is not a ZodDiscriminatedUnion");
  }
  // `options` is the array of arm ZodObjects; each carries a z.literal discriminant.
  const options = union.options as z.ZodObject<z.ZodRawShape>[];
  return options
    .map((arm) => {
      const disc = arm.shape.collection_class;
      if (!(disc instanceof z.ZodLiteral)) {
        throw new SlotMismatchError("inventoryVocab", "arm discriminant is not a ZodLiteral");
      }
      return String(disc.value);
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // raw code-point order (determinism)
}

/**
 * Derive the top-level estate-config section keys in schema-declared order, straight from
 * `Object.keys(inventorySchema.shape)`. Expected order (verified schema/index.ts):
 * ["estate","hosts","services","channels","routing_overrides","suppressions"].
 */
export function sectionKeys(): string[] {
  return Object.keys(inventorySchema.shape);
}

/** True iff the section is required (not wrapped in ZodOptional). All sections are optional today. */
function isRequired(key: string): boolean {
  const field = (inventorySchema.shape as Record<string, z.ZodTypeAny>)[key];
  if (field === undefined) {
    throw new SlotMismatchError("inventoryVocab", `no schema field for section '${key}'`);
  }
  return !(field instanceof z.ZodOptional);
}

/**
 * Authored per-section teaching prose, keyed by top-level schema section. The KEYS are NOT
 * contract-checked (the derived `sectionKeys()` are); the prose is what the vocab-primer teaches.
 * `buildInventoryVocab` throws if a derived section has no entry here — a new schema section
 * shipped upstream without kit content is a genuine drift that must fail the build.
 */
export const VOCAB_SUMMARIES: Readonly<Record<string, string>> = {
  estate: "Estate-wide identity and defaults — the fleet name plus fallbacks other sections inherit.",
  hosts: "The machines under management, each tagged with a collection_class that fixes how Pulse reaches and probes it.",
  services: "The workloads to watch on those hosts — what 'healthy' means and which probes prove it.",
  channels: "Where alerts are delivered (chat, email, webhook), referenced by name from routing.",
  routing_overrides: "Per-target exceptions to default severity routing — send a given entity's alerts to a specific channel.",
  suppressions: "Deliberate, rationale-bearing silences — an entity is intentionally unmonitored for a stated reason.",
};

/**
 * Build the taught inventory vocabulary slot. The three checked enumerations
 * (`schemaMajor`, `sections[].key`, `collectionClasses`) are DERIVED here from the live
 * schema, so the value the content renders from is definitionally the value the contract
 * test asserts against — a claim can never render one thing and be tested as another.
 * Only the per-section `summary` prose is authored (not contract-checked).
 *
 * @param summaries - Authored teaching prose per section key (the co-located `VOCAB_SUMMARIES`).
 * @throws {SlotMismatchError} If a derived section key has no authored summary (a new schema
 *   section shipped upstream without kit content — a genuine drift, must fail the build).
 */
export function buildInventoryVocab(summaries: Readonly<Record<string, string>>): InventoryVocab {
  const sections: VocabSection[] = sectionKeys().map((key) => {
    const summary = summaries[key];
    if (summary === undefined) {
      throw new SlotMismatchError("inventoryVocab", `no authored summary for schema section '${key}'`);
    }
    return { key, required: isRequired(key), summary };
  });
  return {
    schemaMajor: CURRENT_SCHEMA_MAJOR,
    sections,
    collectionClasses: collectionClasses(),
  };
}
