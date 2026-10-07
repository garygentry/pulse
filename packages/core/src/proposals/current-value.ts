/** current-value.ts — read a proposable field's current declared value from a normalized core entity
 *  Browser-safe: the model import is type-only. Parity twin of the web reader
 *  `apps/web/src/server/mutations/estate-values.ts`; both must return the same value. */
import type { Host, Service, Suppression } from "../model/index.js"; // types only: browser-safe
import { fieldApplies } from "./fields.js";
import type { ProposableField, ProposalValue } from "./schema.js";

/** A field's current declared value, or not applicable to this entity. */
export type CurrentValue = { readonly applicable: true; readonly value: ProposalValue } | { readonly applicable: false };

/**
 * Read `field` from a normalized core entity.
 * @param entity - A core `Host` (has `collectionClass`) or `Service` (has `host`).
 * @param suppressions - `EstateModel.suppressions`. When given, the service-`suppressed` standalone rule
 *   (a service targeted by a standalone suppression is not applicable) is applied; `apply` MUST pass it for parity with the web reader.
 */
export function readCoreValue(entity: Host | Service, field: ProposableField, suppressions?: readonly Suppression[]): CurrentValue {
  if ("collectionClass" in entity) {
    const host = entity;
    if (!fieldApplies(field, "host", host.collectionClass)) return { applicable: false };
    switch (field) {
      case "expectedChurn": return { applicable: true, value: host.expectedChurn ?? false };
      case "scrapeIntervalClass": return { applicable: true, value: host.scrapeIntervalClass ?? null };
      // cadvisor default false / heartbeat default true are applied by the host schema (host.ts:38,43).
      case "cadvisor": return host.collectionClass === "managed-linux" ? { applicable: true, value: host.cadvisor } : { applicable: false };
      case "heartbeat": return host.collectionClass === "managed-linux" ? { applicable: true, value: host.heartbeat } : { applicable: false };
      case "suppressed":
        return host.collectionClass === "excluded"
          ? { applicable: true, value: { class: host.suppressed.class, rationale: host.suppressed.rationale } }
          : { applicable: false };
    }
  }
  const svc = entity;
  if (!fieldApplies(field, "service", null)) return { applicable: false };
  // "suppressed" is the only service field.
  if (suppressions?.some((s) => s.target === `${svc.host}/${svc.name}` || s.target === svc.name)) return { applicable: false };
  return { applicable: true, value: svc.suppressed ? { class: svc.suppressed.class, rationale: svc.suppressed.rationale } : null };
}
