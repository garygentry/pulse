/** Composed inventory schema + the single import point for the schema/ module
 *  (02-inventory-schema.md §4.7). Every top-level section is .optional() because the loader
 *  merge is content-based (03): any file MAY contribute any subset of sections. .strict()
 *  at the top rejects a typo'd section (e.g. `hostz:`) as unrecognized_keys → UNKNOWN_FIELD. */

import { z } from "zod";

import { estateSchema } from "./estate.js";
import { hostSchema } from "./host.js";
import { serviceSchema } from "./service.js";
import { channelSchema, routingOverrideSchema } from "./channel.js";
import { suppressionSchema } from "./suppression.js";

/** The strict shape of a SINGLE estate-config YAML document (REQ-VAL-01). */
export const inventorySchema = z
  .object({
    estate: estateSchema.optional(),
    hosts: z.array(hostSchema).optional(),
    services: z.array(serviceSchema).optional(),
    channels: z.array(channelSchema).optional(),
    routing_overrides: z.array(routingOverrideSchema).optional(),
    suppressions: z.array(suppressionSchema).optional(),
  })
  .strict();

/** snake_case input type for a whole document (pre-normalization). */
export type InventoryInput = z.infer<typeof inventorySchema>;

// Re-exports so schema/ is the single import point for tooling/tests:
export { estateSchema } from "./estate.js";
export type { EstateInput } from "./estate.js";
export { hostSchema, probeSpecSchema } from "./host.js";
export type { HostInput } from "./host.js";
export { commandSignalSchema, durationStringSchema } from "./command-signal.js";
export type { CommandSignalInput } from "./command-signal.js";
export {
  serviceSchema,
  deepHealthProbeSchema,
  backupFreshnessSchema,
} from "./service.js";
export type { ServiceInput } from "./service.js";
export {
  channelSchema,
  channelKindSchema,
  channelOptionsSchema,
  routingOverrideSchema,
} from "./channel.js";
export type { ChannelInput, ChannelOptionsInput, RoutingOverrideInput } from "./channel.js";
export {
  suppressionSchema,
  suppressionMarkSchema,
  suppressionClassSchema,
} from "./suppression.js";
export type { SuppressionMarkInput, SuppressionInput } from "./suppression.js";
export { collectionClassSchema } from "./collection-class.js";
export {
  secretRefSchema,
  isEnvRef,
  isOpRef,
  isSecretRef,
  parseSecretRef,
} from "./secret-ref.js";
