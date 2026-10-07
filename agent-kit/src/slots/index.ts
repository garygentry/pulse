// agent-kit/src/slots/index.ts
// Slots aggregator — `buildSlots`.
//
// The per-slot builders (buildInventoryVocab, CLI_CONTRACT, severityTaxonomy) are
// composed into the single `Slots` bundle every `ContentUnit.render()` consumes.
// This is the one aggregator `scripts/generate.ts` imports.

import type { Slots } from "../emit/types.js";
import { buildInventoryVocab, VOCAB_SUMMARIES } from "./inventory-vocab.js"; // §2
import { CLI_CONTRACT } from "./cli-contract.js"; // §3
import { severityTaxonomy } from "./severity.js"; // §4

/**
 * Assemble the three contract-checked data blocks into the `Slots` bundle the content
 * renders from. Pure and deterministic — the same objects the drift/contract tests assert
 * against, so a rendered claim and its test can never diverge.
 */
export function buildSlots(): Slots {
  return {
    inventoryVocab: buildInventoryVocab(VOCAB_SUMMARIES),
    cliContract: CLI_CONTRACT,
    severity: severityTaxonomy(),
  };
}
