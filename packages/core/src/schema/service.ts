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

/** Per-endpoint alert binding (issue #15). Declaring a binding on a service makes its synthetic
 *  (blackbox) Gatus ingress check page: stack/alerting renders a `GatusCheckFailed` vmalert rule
 *  over the check's `gatus_results_total` series (issue #1 retired the Gatus→Alertmanager push
 *  provider, which could not resolve alerts correctly). `failure_threshold` F (default 3) fires the
 *  rule once ≥F failed checks and no pass fall in one window (F min + 30s, or 4·F min for slowed
 *  checks); `success_threshold` S (default 2) resolves it once ≥S passes and no failure fall in
 *  ceil(1.5·S) + 1 minutes (each 1–60; see EndpointAlert). `enabled: false` renders no rule; `description` becomes the alert
 *  annotation. `type` and `send_on_resolved` are retained for compatibility and select/affect
 *  nothing (resolve notifications follow each Alertmanager receiver's `send_resolved`).
 *  Additive/optional → schema_version stays 1. A binding only takes effect on a service that
 *  renders a Gatus endpoint (i.e. has `ingress_url` and is not suppressed); on any other service it
 *  is inert (checkEndpointAlertBinding warns). */
export const endpointAlertSchema = z
  .object({
    type: z.string().min(1),
    enabled: z.boolean().optional(),
    description: z.string().min(1).optional(),
    // Capped at 60 checks (an hour at Gatus's 60s cadence): the rendered rule's windows scale with
    // the thresholds, and an unbounded value would render an unbounded look-back.
    failure_threshold: z.number().int().positive().max(60).optional(),
    success_threshold: z.number().int().positive().max(60).optional(),
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
