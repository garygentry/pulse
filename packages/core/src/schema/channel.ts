/** Channels + routing overrides (02-inventory-schema.md §4.4). credential is slotted as a
 *  non-empty string; the literal-in-slot check (SECRET_LITERAL) and channel-name resolution
 *  (UNRESOLVED_CHANNEL) are semantic checks in 009. */

import { z } from "zod";

import { secretRefSchema } from "./secret-ref.js";

/** The v1 channel kinds (REQ-CHAN-01). Mirrors ChannelKind (00 §3.4). `telegram` (issue #2)
 *  is an additive value on this closed enum — a minor, backward-compatible change (06 §6.1):
 *  every prior config still validates and `schema_version` stays 1. */
export const channelKindSchema = z.enum(["chat", "email", "push", "telegram", "webhook"]);

/** A channel's generic, per-kind, NON-secret options map (issue #2). Carries provider knobs a
 *  channel kind needs beyond its credential — e.g. Telegram's `chat_id` (int64 or `@name`). Values
 *  are plain scalars, never a credential (secrets stay in `credential`, checked by SECRET_LITERAL).
 *  Open by design (any string key) so new kinds add options without a schema change; the channel
 *  object itself stays `.strict()`, so the typo-guard on top-level channel keys is preserved. */
export const channelOptionsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

/** Strict shape of a single channel (02 §4.4). credential is a secret-ref string; `options` is the
 *  optional non-secret per-kind map (issue #2). `.strict()` still rejects a typo'd top-level key. */
export const channelSchema = z
  .object({
    name: z.string().min(1),
    kind: channelKindSchema,
    credential: secretRefSchema,
    options: channelOptionsSchema.optional(),
  })
  .strict();

/** Severity→channel routing override — the declaration surface only (REQ-CHAN-03). */
export const routingOverrideSchema = z
  .object({
    severity: z.string().min(1),
    channels: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ChannelInput = z.infer<typeof channelSchema>;
export type ChannelOptionsInput = z.infer<typeof channelOptionsSchema>;
export type RoutingOverrideInput = z.infer<typeof routingOverrideSchema>;
