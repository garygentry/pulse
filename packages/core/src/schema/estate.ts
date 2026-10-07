/** Estate-metadata shape (02-inventory-schema.md §4.1). Snake_case input; the
 *  normalizer (009) maps it onto the Estate model type (00 §3.1). schema_version is a
 *  plain required integer here — the version policy/short-circuit lives in 06/010. */

import { z } from "zod";

/** Estate-level metadata block. Exactly-one-per-load is a merge concern (DUPLICATE_ESTATE
 *  in 03); this validates a single block's shape. */
export const estateSchema = z
  .object({
    schema_version: z.number().int(),
    name: z.string().min(1),
    domains: z.array(z.string().min(1)).min(1),
    dns_resolver: z.string().min(1).optional(),
    timezone: z.string().min(1),
    deadman_hook: z.string().min(1),
    retention: z.string().min(1).optional(),
  })
  .strict();

/** snake_case input type inferred from the estate shape (pre-normalization). */
export type EstateInput = z.infer<typeof estateSchema>;
