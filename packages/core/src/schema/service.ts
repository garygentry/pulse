/** Services, deep-health, backup-freshness (02-inventory-schema.md §4.3). deep_health
 *  presence alone distinguishes a deep-health service (REQ-SVC-04); cross-element host
 *  resolution (UNRESOLVED_HOST) is a semantic check in 009. */

import { z } from "zod";

import { secretRefSchema } from "./secret-ref.js";
import { suppressionMarkSchema } from "./suppression.js";
import { durationStringSchema } from "./command-signal.js";

/** Deep-health probe declaration (REQ-SVC-02). Normalizes to DeepHealthProbe (00 §3.3).
 *  `host_local` (issue #8) marks a probe whose endpoint is only reachable from the service's own
 *  host — a loopback/bridge-local target the CENTRAL prober (a container elsewhere) cannot reach.
 *  When true, the renderer routes this probe to a PER-HOST prober config
 *  (agent/<host>/prober/config.yaml) run by a prober on that host under network_mode: host, instead
 *  of the central prober/config.yaml. Additive/optional → schema_version stays 1. A host_local
 *  probe must resolve to a managed-linux host (checkHostLocalProbeHost), the only class that runs
 *  the agent bundle. */
export const deepHealthProbeSchema = z
  .object({
    endpoint: z.string().min(1),
    response_mapping: z.record(z.string(), z.string()),
    alert_expression: z.string().min(1),
    credential: secretRefSchema.optional(),
    host_local: z.boolean().optional(),
  })
  .strict();

/** Backup-freshness spec (REQ-SVC-03). Normalizes to BackupFreshness (00 §3.3).
 *  `command` (issue #3) is the optional argv that prints the newest-backup AGE IN SECONDS; when
 *  present, the renderer synthesizes a scalar command-signal on the service's host so the
 *  `pulse_backup_freshness_age_seconds`/`_up` series `stack/alerting` selects is actually
 *  delivered. Without it, backup_freshness stays a declaration-only prober entry
 *  (backward-compatible). `interval` is the optional check cadence (renderer default "15m"). A
 *  backup service with a `command` must resolve to a managed-linux host (checkBackupCommandHost). */
export const backupFreshnessSchema = z
  .object({
    signal: z.string().min(1),
    threshold: z.string().min(1),
    command: z.array(z.string().min(1)).min(1).optional(),
    interval: durationStringSchema.optional(),
  })
  .strict();

/** Per-endpoint alert binding (issue #15, V-002). Maps 1:1 onto a Gatus `endpoints[].alerts[]`
 *  entry so a synthetic (blackbox) check pages through the Gatus→Alertmanager provider
 *  (`stack/gatus/alerting-provider.yaml`). Declaring even a single `{ type: custom }` binding on a
 *  service is what flips its ingress check from DEFINED-BUT-NOT-FIRING to firing; omitted fields
 *  inherit the provider's `default-alert` thresholds. `type` names the Gatus provider to bind
 *  (`custom` = the shipped Alertmanager provider). Additive/optional → schema_version stays 1. A
 *  binding only takes effect on a service that renders a Gatus endpoint (i.e. has `ingress_url` and
 *  is not suppressed); on any other service it is inert (checkEndpointAlertBinding warns). */
export const endpointAlertSchema = z
  .object({
    type: z.string().min(1),
    enabled: z.boolean().optional(),
    description: z.string().min(1).optional(),
    failure_threshold: z.number().int().positive().optional(),
    success_threshold: z.number().int().positive().optional(),
    send_on_resolved: z.boolean().optional(),
  })
  .strict();

/** Strict shape of a single service (02 §4.3). Normalizes to Service (00 §3.3). */
export const serviceSchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    kind: z.string().min(1),
    managed: z.boolean(),
    ingress_url: z.string().url().optional(),
    deep_health: deepHealthProbeSchema.optional(),
    backup_freshness: backupFreshnessSchema.optional(),
    alerts: z.array(endpointAlertSchema).min(1).optional(),
    suppressed: suppressionMarkSchema.optional(),
  })
  .strict();

/** snake_case input type for a single service (pre-normalization). */
export type ServiceInput = z.infer<typeof serviceSchema>;
