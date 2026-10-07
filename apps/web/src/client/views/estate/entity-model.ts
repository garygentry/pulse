// src/client/views/estate/entity-model.ts — pure resolution and join logic for the per-entity
// pages `/estate/host/:name` and `/estate/service/:host/:name`.
//
// Resolves the declared model entity by its own identity fields, joins its live EstateTargetState by
// exact TargetIdentity `{kind, id === drilldownId}` (drilldownId is opaque — compared, never parsed),
// and derives the attributed-alert rows. A declared-but-not-live entity maps to `unknown`, never `ok`.

import type {
  WebEstateHostV2,
  WebEstateModelV2,
  WebEstateServiceV2,
  WebSuppressionInfo,
} from "@pulse/renderer";
import type {
  EstatePayload,
  EstateTargetState,
  TargetIdentity,
  TargetStatus,
} from "@pulse/web-data/wire";

import { toTargetStatus } from "./status.js";

/** Which entity a deep route addresses; built by view.tsx from `store.route.value.params`. */
export type EntityRouteTarget =
  | { readonly kind: "host"; readonly name: string }
  | { readonly kind: "service"; readonly host: string; readonly name: string };

/** Find the declared host named `name`, or `null` when absent from the current model. */
export function findHost(model: Readonly<WebEstateModelV2>, name: string): WebEstateHostV2 | null {
  return model.hosts.find((h) => h.name === name) ?? null;
}

/** Find the declared service `(host, name)`, or `null` when absent. */
export function findService(
  model: Readonly<WebEstateModelV2>,
  host: string,
  name: string,
): WebEstateServiceV2 | null {
  return model.services.find((s) => s.host === host && s.name === name) ?? null;
}

/** Locate the live row for a declared entity by exact TargetIdentity (both kind and id must match). */
export function findLiveTarget(
  liveTargets: readonly EstateTargetState[],
  identity: TargetIdentity,
): EstateTargetState | null {
  return liveTargets.find((t) => t.target.kind === identity.kind && t.target.id === identity.id) ?? null;
}

/** A resolved + joined entity ready to render. `live === null` ⇒ declared but not live (unknown). */
export interface JoinedEntity {
  readonly target: EntityRouteTarget;
  readonly declared:
    | { readonly kind: "host"; readonly host: WebEstateHostV2 }
    | { readonly kind: "service"; readonly service: WebEstateServiceV2 };
  readonly live: EstateTargetState | null;
  readonly status: TargetStatus;
  readonly staleNote: string | null;
}

/** Map an entity's suppression + optional live row to its header status (no live ⇒ unknown). */
function joinStatus(
  suppressed: WebSuppressionInfo | null,
  live: EstateTargetState | null,
): { status: TargetStatus; staleNote: string | null } {
  return toTargetStatus({
    health: live?.state ?? "unknown",
    suppressed: suppressed !== null,
    availability: live?.availability.state ?? "unavailable",
  });
}

/** Resolve the route target → declared entity → joined view model, or `null` when not found. */
export function resolveAndJoin(payload: EstatePayload, target: EntityRouteTarget): JoinedEntity | null {
  if (target.kind === "host") {
    const host = findHost(payload.estate, target.name);
    if (host === null) return null;
    const live = findLiveTarget(payload.liveTargets, { kind: "host", id: host.drilldownId });
    return {
      target: { kind: "host", name: host.name },
      declared: { kind: "host", host },
      live,
      ...joinStatus(host.suppressed, live),
    };
  }
  const service = findService(payload.estate, target.host, target.name);
  if (service === null) return null;
  const live = findLiveTarget(payload.liveTargets, { kind: "service", id: service.drilldownId });
  return {
    target: { kind: "service", host: service.host, name: service.name },
    declared: { kind: "service", service },
    live,
    ...joinStatus(service.suppressed, live),
  };
}

/** One attributed-alert row. Only `fingerprint` is known client-side today; `name`, `severity`, and
 *  `firedAt` stay `null` until web-data-tier supplies per-fingerprint metadata. NEVER fabricate them. */
export interface AttributedAlertRow {
  readonly fingerprint: string;
  readonly name: string | null;
  readonly severity: TargetStatus | null;
  readonly firedAt: string | null;
}

/** Fingerprint-only rows from a live target (there is no client-side metadata source today). */
export function toAttributedAlertRows(live: EstateTargetState | null): readonly AttributedAlertRow[] {
  if (live === null) return [];
  return live.alertFingerprints.map((fingerprint) => ({
    fingerprint,
    name: null,
    severity: null,
    firedAt: null,
  }));
}

/** Human age from an ISO timestamp, or `null` when absent/malformed (never throws). */
export function alertAge(firedAt: string | null, now: number = Date.now()): string | null {
  if (firedAt === null) return null;
  const t = Date.parse(firedAt);
  if (Number.isNaN(t)) return null;
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}
