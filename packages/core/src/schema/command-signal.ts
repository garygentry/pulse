/** Command-signal spec (issue #3 / #1). A read-only command a managed-linux host runs on a
 *  cadence, whose output the command-exporter publishes as metrics. Two output modes, discriminated
 *  on `output`:
 *   - `scalar`     — the command prints ONE number; the exporter emits `metric{labels}` (the value)
 *                    and `up_metric{labels}` (1 ok / 0 blind). `metric`/`up_metric` are required.
 *   - `exposition` — the command prints Prometheus text; the exporter passes it through and adds a
 *                    generic `pulse_command_signal_up{signal}` liveness. No `metric`/`labels`.
 *  The discriminated union makes scalar-requires-`metric`/`up_metric` a SHAPE guarantee (a scalar
 *  signal without them is invalid_union/invalid_type), mirroring the host union (02 §4.2). Both arms
 *  are `.strict()`, so an exposition signal that carries `metric`/`labels` is unknown_keys. */

import { z } from "zod";

import { secretRefSchema } from "./secret-ref.js";

/** A Prometheus-style duration string (`"30s"`, `"15m"`, `"1d12h"`) — one or more unit groups,
 *  no leading/trailing junk. Validated at shape time so the renderer can trust it (it parses the
 *  string to milliseconds for the exporter). Mirrors the grammar `stack/alerting` parses. */
export const durationStringSchema = z
  .string()
  .regex(/^(?:\d+(?:y|w|d|h|m|s))+$/, "must be a duration like \"30s\", \"15m\", or \"1d12h\"");

/** Fields common to both command-signal arms. Spread into each arm so each stays a ZodObject
 *  (required by z.discriminatedUnion). */
const commandSignalBaseShape = {
  /** Signal identity — unique among a host's `command_signals`; the `signal` liveness label. */
  name: z.string().min(1),
  /** Read-only argv, executed verbatim (no shell). Non-empty. */
  command: z.array(z.string().min(1)).min(1),
  /** Cadence as a duration string. */
  interval: durationStringSchema,
  /** Optional credential reference — SecretRef only, never a literal (REQ-SEC-01). Injected into
   *  the command's environment by the exporter; core only validates the reference syntax. */
  credential: secretRefSchema.optional(),
} as const;

export const commandSignalSchema = z.discriminatedUnion("output", [
  // scalar → the command prints one number; declares the emitted series names + baked labels.
  z
    .object({
      output: z.literal("scalar"),
      ...commandSignalBaseShape,
      metric: z.string().min(1),
      up_metric: z.string().min(1),
      /** Fixed non-host labels baked onto both series (e.g. `{ service }`). `host` is scrape-applied. */
      labels: z.record(z.string().min(1), z.string()).optional(),
    })
    .strict(),
  // exposition → the command prints Prometheus text; the exporter adds pulse_command_signal_up.
  z
    .object({
      output: z.literal("exposition"),
      ...commandSignalBaseShape,
    })
    .strict(),
]);

/** snake_case input type for a single command-signal (pre-normalization). */
export type CommandSignalInput = z.infer<typeof commandSignalSchema>;
