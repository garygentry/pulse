/** estate-values.ts — read a proposable field's current value from the rendered V2 estate model.
 *  Parity twin of `readCoreValue` (`@pulse/core/proposals`); the parity is pinned by
 *  apps/web/tests/proposals-parity.test.ts (REQ-PROP-08). Server-only: the client mirrors the
 *  applicability filter itself and never imports this module. */
import type { WebEstateHostV2, WebEstateModelV2, WebEstateServiceV2 } from "@pulse/renderer";
import { fieldApplies, type CurrentValue, type ProposableField } from "@pulse/core/proposals";

/** A resolved proposal target in the rendered model. */
export type ResolvedEntity =
  | { readonly kind: "host"; readonly entity: WebEstateHostV2; readonly name: string }
  | { readonly kind: "service"; readonly entity: WebEstateServiceV2; readonly name: string };

/**
 * Resolve a drilldown id (`host:<name>` | `svc:<host>/<name>`) by exact `drilldownId` match within the
 * requested kind. Linear scan (estates are small). `name` is the core identity (the
 * `name` field; `loader/merge.ts identityOf`), which is recorded as `target.name`.
 */
export function resolveTarget(model: WebEstateModelV2, kind: "host" | "service", id: string): ResolvedEntity | null {
  if (kind === "host") {
    const h = model.hosts.find((x) => x.drilldownId === id);
    return h ? { kind, entity: h, name: h.name } : null;
  }
  const s = model.services.find((x) => x.drilldownId === id);
  return s ? { kind, entity: s, name: s.name } : null;
}

/** Parity twin of readCoreValue over the rendered V2 model. */
export function readProposableValue(model: WebEstateModelV2, target: ResolvedEntity, field: ProposableField): CurrentValue {
  if (target.kind === "host") {
    const h = target.entity;
    if (!fieldApplies(field, "host", h.collectionClass)) return { applicable: false };
    switch (field) {
      case "expectedChurn": return { applicable: true, value: h.expectedChurn };
      case "scrapeIntervalClass": return { applicable: true, value: h.scrapeIntervalClass };
      case "cadvisor": return h.collectionClass === "managed-linux" ? { applicable: true, value: h.detail.cadvisor } : { applicable: false };
      case "heartbeat": return h.collectionClass === "managed-linux" ? { applicable: true, value: h.detail.heartbeat } : { applicable: false };
      case "suppressed":
        // Excluded host: the in-target mark wins over standalone (web-model.ts:451-456), so effective == declared.
        return h.suppressed === null
          ? { applicable: false }
          : { applicable: true, value: { class: h.suppressed.class, rationale: h.suppressed.rationale } };
    }
  }
  const s = target.entity;
  if (!fieldApplies(field, "service", null)) return { applicable: false };
  if (model.suppressions.some((x) => x.resolves.includes(s.drilldownId))) return { applicable: false }; // a service targeted by a standalone suppression is not applicable
  return { applicable: true, value: s.suppressed === null ? null : { class: s.suppressed.class, rationale: s.suppressed.rationale } };
}
