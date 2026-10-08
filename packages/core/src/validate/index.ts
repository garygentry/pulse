/** Semantic-invariant + normalization layer entry point
 *  (04-validation-and-normalization.md §2). Runs after the Zod shape pass: appends every
 *  semantic violation to the shared one-pass collector (REQ-VAL-02, REQ-VAL-06), then
 *  produces the thin-normalized EstateModel iff no error-severity finding was recorded (by
 *  this layer or an earlier one). Never throws on config content (tech-spec §3.8). */

import { z } from "zod";

import type { EstateModel } from "../model/index.js";
import type { FindingCollector } from "../findings/collect.js";
import type { ProvenanceIndex } from "../loader/index.js";
import { inventorySchema } from "../schema/index.js";
import {
  checkTimezone,
  checkSuppressionRationales,
  checkSecretLiterals,
  checkExactlyOneClass,
  checkNasApiCompleteness,
  checkTelegramOptions,
  checkCommandSignals,
  checkBackupCommandHost,
  checkHostLocalProbeHost,
  checkEndpointAlertBinding,
  checkGatusNames,
  checkCrossReferences,
} from "./invariants.js";
import { normalize } from "./normalize.js";

/** The validated, snake_case inventory tree (tech-spec §3.4). Field names are owned by
 *  02-inventory-schema.md; this alias tracks them structurally. */
export type MergedInventory = z.infer<typeof inventorySchema>;

/**
 * Semantic-invariant + normalization layer. Runs all six detectors (each to completion; none
 * short-circuits — §1.2), then produces the model iff no error-severity finding exists.
 *
 * @param merged  - the shape-validated, snake_case inventory (02); read defensively.
 * @param prov    - provenance index built by the loader's location-aware parse (03).
 * @param collector - the shared one-pass finding collector (05); mutated in place.
 * @returns the thin-normalized EstateModel, or `undefined` when any error-severity finding
 *          exists (the loader then returns `{ ok: false, findings }`). Never throws on
 *          config content.
 */
export function validateAndNormalize(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): EstateModel | undefined {
  // --- Layer 2: semantic invariants. Each runs fully; none short-circuits (§1.2). ---
  checkTimezone(merged, prov, collector); // REQ-META-02
  checkSuppressionRationales(merged, prov, collector); // REQ-SUPP-02
  checkSecretLiterals(merged, prov, collector); // REQ-SECR-01 / REQ-SEC-02
  checkExactlyOneClass(merged, prov, collector); // REQ-HOST-02 backstop
  checkNasApiCompleteness(merged, prov, collector); // issue #4: nas-api api-override both-or-neither
  checkTelegramOptions(merged, prov, collector); // issue #2: telegram requires options.chat_id
  checkCommandSignals(merged, prov, collector); // issue #3: unique command-signal names per host
  checkBackupCommandHost(merged, prov, collector); // issue #3: backup command → managed-linux host
  checkHostLocalProbeHost(merged, prov, collector); // issue #8: host_local probe → managed-linux host
  checkEndpointAlertBinding(merged, prov, collector); // issue #15: alerts: binding needs an endpoint
  checkGatusNames(merged, prov, collector); // issue #1: a quote/backslash/newline name crashes Gatus
  checkCrossReferences(merged, prov, collector); // service↔host, routing↔channel

  // --- Gate: build the model only when nothing (any layer) has erred (REQ-VAL-02). ---
  if (collector.hasErrors()) return undefined;

  // Post-gate: every invariant held, so normalization cannot fail (§4).
  return normalize(merged, prov);
}
