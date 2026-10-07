/** Hosts + collection-class discriminated union (02-inventory-schema.md §4.2). Each of the
 *  five arms validates against ONLY its class's fields: a wrong-arm field → unrecognized_keys,
 *  a missing class field → invalid_type, an unknown/absent discriminant →
 *  invalid_union_discriminator. Per-arm z.literal(...) because discriminatedUnion requires
 *  literal discriminators. */

import { z } from "zod";

import { secretRefSchema } from "./secret-ref.js";
import { suppressionMarkSchema } from "./suppression.js";
import { commandSignalSchema } from "./command-signal.js";

/** Host-level synthetic reachability probe for a probe-only host (00 §3.2 ProbeSpec). */
export const probeSpecSchema = z
  .object({
    kind: z.string().min(1),
    target: z.string().min(1),
    expect: z.string().min(1).optional(),
  })
  .strict();

/** Fields common to every host regardless of class. Spread into each union arm so each arm
 *  stays a ZodObject (required by z.discriminatedUnion). */
const hostBaseShape = {
  name: z.string().min(1),
  addresses: z.array(z.string().min(1)).min(1),
  expected_churn: z.boolean().optional(),
  scrape_interval_class: z.string().min(1).optional(),
} as const;

export const hostSchema = z.discriminatedUnion("collection_class", [
  // managed-linux → exporter_ports (REQ-HOST-03)
  z
    .object({
      collection_class: z.literal("managed-linux"),
      ...hostBaseShape,
      exporter_ports: z.array(z.number().int().min(1).max(65535)).min(1),
      cadvisor: z.boolean().optional().default(false),
      // Heartbeat opt-out (issue #30). Defaults ON to preserve every existing estate's
      // behavior; set `heartbeat: false` for a node-exporter-only host (e.g. a native
      // node_exporter binary with no container runtime), so no :9110 target is rendered.
      // node-exporter (:9100) stays mandatory — HostDown depends on it.
      heartbeat: z.boolean().optional().default(true),
      delivery_form: z.enum(["compose", "systemd"]),
      // Optional per-host read-only command signals (issue #3 / #1). Only managed-linux hosts run
      // the agent bundle, so `command_signals` lives on this arm alone — a wrong-arm placement is
      // unknown_keys. Emptiness/uniqueness is a semantic check (checkCommandSignals).
      command_signals: z.array(commandSignalSchema).optional(),
    })
    .strict(),
  // hypervisor-api → api_endpoint + credential reference (REQ-HOST-03)
  z
    .object({
      collection_class: z.literal("hypervisor-api"),
      ...hostBaseShape,
      api_endpoint: z.string().min(1),
      credential: secretRefSchema,
    })
    .strict(),
  // nas-api → DIRECT node_exporter scrape by default (issue #4). `api_endpoint` +
  // `credential` are OPTIONAL, reserved fields used only by the documented opt-in
  // TrueNAS-API-exporter override recipe; the shipped renderer emits a node_exporter direct
  // target and ignores them. They are both-or-neither, enforced as a semantic invariant
  // (checkNasApiCompleteness) since a discriminatedUnion arm cannot carry `.refine`.
  z
    .object({
      collection_class: z.literal("nas-api"),
      ...hostBaseShape,
      api_endpoint: z.string().min(1).optional(),
      credential: secretRefSchema.optional(),
    })
    .strict(),
  // probe-only → probe (REQ-HOST-03)
  z
    .object({
      collection_class: z.literal("probe-only"),
      ...hostBaseShape,
      probe: probeSpecSchema,
    })
    .strict(),
  // excluded → suppressed mark (REQ-HOST-03; the excluded suppression class, REQ-SUPP-01)
  z
    .object({
      collection_class: z.literal("excluded"),
      ...hostBaseShape,
      suppressed: suppressionMarkSchema,
    })
    .strict(),
]);

/** snake_case input type for a single host (pre-normalization). */
export type HostInput = z.infer<typeof hostSchema>;
