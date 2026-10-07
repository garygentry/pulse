/** The fixed proposal allowlist and its applicability rules (browser-safe). */

import type { ProposableField, ProposableFieldSpec } from "./schema.js";

/**
 * The fixed proposal allowlist (REQ-PROP-03). Read by the web dialog, the server submission check and
 * `pulse proposals apply`, so an inapplicable field is refused at submission, never discovered at apply.
 * Channel fields and any identity/topology field are absent by construction. `hostClasses` restricts
 * the **host** kind only; it never affects services.
 */
export const PROPOSABLE_FIELDS: readonly ProposableFieldSpec[] = Object.freeze([
  { field: "expectedChurn",       yamlKey: "expected_churn",        kinds: ["host"],            hostClasses: null,              nullable: { host: false, service: false }, valueKind: "boolean" },
  { field: "scrapeIntervalClass", yamlKey: "scrape_interval_class", kinds: ["host"],            hostClasses: null,              nullable: { host: true,  service: false }, valueKind: "string" },
  { field: "cadvisor",            yamlKey: "cadvisor",              kinds: ["host"],            hostClasses: ["managed-linux"], nullable: { host: false, service: false }, valueKind: "boolean" },
  { field: "heartbeat",           yamlKey: "heartbeat",             kinds: ["host"],            hostClasses: ["managed-linux"], nullable: { host: false, service: false }, valueKind: "boolean" },
  // Host: excluded arm only, SET only (the mark is required there). Service: set or clear.
  { field: "suppressed",          yamlKey: "suppressed",            kinds: ["host", "service"], hostClasses: ["excluded"],      nullable: { host: false, service: true  }, valueKind: "suppression" },
] as const satisfies readonly ProposableFieldSpec[]);

/** Every allowlisted field name, in table order (for `z.enum`). */
export const PROPOSABLE_FIELD_NAMES = ["expectedChurn", "scrapeIntervalClass", "cadvisor", "heartbeat", "suppressed"] as const satisfies readonly ProposableField[];

/**
 * Look up a field's row.
 * @throws TypeError on a name outside the allowlist. That is a programming fault: callers pass zod-validated names.
 */
export function fieldSpec(field: ProposableField): ProposableFieldSpec {
  const spec = PROPOSABLE_FIELDS.find((s) => s.field === field);
  if (spec === undefined) throw new TypeError(`not an allowlisted proposal field: ${String(field)}`);
  return spec;
}

/**
 * Whether `field` applies to an entity.
 * @param kind - Entity kind.
 * @param hostClass - The host's collection class (`CollectionClass` value); **ignored** for services (pass null).
 * @returns true iff the kind is listed and, for hosts, `hostClasses` is null or contains `hostClass`.
 */
export function fieldApplies(field: ProposableField, kind: "host" | "service", hostClass: string | null): boolean {
  const spec = fieldSpec(field);
  if (!spec.kinds.includes(kind)) return false;
  if (kind === "service" || spec.hostClasses === null) return true;
  return hostClass !== null && spec.hostClasses.includes(hostClass);
}
