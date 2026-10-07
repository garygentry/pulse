/** The three suppression classes and their shapes (02-inventory-schema.md §4.5).
 *  `rationale` is required-as-a-string here; the non-empty/meaningful invariant
 *  (MISSING_RATIONALE) is enforced in the semantic layer (009). */

import { z } from "zod";

/** The three suppression classes (REQ-SUPP-01). Mirrors SuppressionClass (00 §3.5). */
export const suppressionClassSchema = z.enum([
  "excluded",
  "expected-churn",
  "known-expected",
]);

/** In-place suppression flag on a host/service target. Mirrors SuppressionMark (00 §3.5). */
export const suppressionMarkSchema = z
  .object({
    class: suppressionClassSchema,
    rationale: z.string(),
  })
  .strict();

/** A standalone suppression entry (a standing silenced condition). Mirrors Suppression
 *  (00 §3.5). Restates class/rationale rather than .extend()-ing so both stay .strict(). */
export const suppressionSchema = z
  .object({
    class: suppressionClassSchema,
    rationale: z.string(),
    target: z.string().min(1),
  })
  .strict();

export type SuppressionMarkInput = z.infer<typeof suppressionMarkSchema>;
export type SuppressionInput = z.infer<typeof suppressionSchema>;
