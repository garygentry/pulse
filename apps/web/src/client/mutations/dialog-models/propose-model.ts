// apps/web/src/client/mutations/dialog-models/propose-model.ts — pure logic behind the propose-edit dialog
// (client side): core mirrors, the current-value twin, offered fields, row
// state and validation, and the request-body builder. No JSX, no React.
//
// BUNDLE RULE: `@pulse/core/proposals` is imported for TYPES ONLY. Its barrel builds zod schemas at module
// load, and build-budget.test.ts forbids any packages/core or zod source in an emitted client chunk (lazy
// chunks included). So the allowlist (`PROPOSABLE_FIELDS`, `fieldApplies`), the per-field value rule
// (`fieldValueSchema`) and the value equality (`proposalValuesEqual`) are mirrored here as plain code.
// mutations-propose-dialog.test.ts pins each mirror against the core original, and pins
// readDeclaredValue against the server's readProposableValue, so drift fails the suite.
import type {
  CurrentValue, PROPOSAL_CHANGES_MAX, ProposableField, ProposableFieldSpec, ProposalValue, SuppressionMarkValue,
} from "@pulse/core/proposals";
import type { WebEstateHostV2, WebEstateModelV2, WebEstateServiceV2 } from "@pulse/renderer";
import { RATIONALE_MAX_CHARS, RATIONALE_MIN_CHARS } from "../../../shared/mutations.js";
import type { CreateProposalBody } from "../../../shared/mutations.js";
import { codePoints } from "../client.js";

// ── Core mirrors (pinned by tests; see the header) ───────────────────────────

/** Mirror of core PROPOSABLE_FIELDS, same rows, same order. */
export const CLIENT_PROPOSABLE_FIELDS: readonly ProposableFieldSpec[] = Object.freeze([
  { field: "expectedChurn",       yamlKey: "expected_churn",        kinds: ["host"],            hostClasses: null,              nullable: { host: false, service: false }, valueKind: "boolean" },
  { field: "scrapeIntervalClass", yamlKey: "scrape_interval_class", kinds: ["host"],            hostClasses: null,              nullable: { host: true,  service: false }, valueKind: "string" },
  { field: "cadvisor",            yamlKey: "cadvisor",              kinds: ["host"],            hostClasses: ["managed-linux"], nullable: { host: false, service: false }, valueKind: "boolean" },
  { field: "heartbeat",           yamlKey: "heartbeat",             kinds: ["host"],            hostClasses: ["managed-linux"], nullable: { host: false, service: false }, valueKind: "boolean" },
  { field: "suppressed",          yamlKey: "suppressed",            kinds: ["host", "service"], hostClasses: ["excluded"],      nullable: { host: false, service: true  }, valueKind: "suppression" },
] as const satisfies readonly ProposableFieldSpec[]);

/** Mirror of core PROPOSAL_CHANGES_MAX; the type annotation fails typecheck if the core literal drifts. */
export const CLIENT_PROPOSAL_CHANGES_MAX: typeof PROPOSAL_CHANGES_MAX = 5;

function clientFieldSpec(field: ProposableField): ProposableFieldSpec {
  const spec = CLIENT_PROPOSABLE_FIELDS.find((s) => s.field === field);
  if (spec === undefined) throw new TypeError(`not an allowlisted proposal field: ${String(field)}`);
  return spec;
}

/** Mirror of core fieldApplies(field, kind, hostClass). */
export function clientFieldApplies(field: ProposableField, kind: "host" | "service", hostClass: string | null): boolean {
  const spec = clientFieldSpec(field);
  if (!spec.kinds.includes(kind)) return false;
  if (kind === "service" || spec.hostClasses === null) return true;
  return hostClass !== null && spec.hostClasses.includes(hostClass);
}

/** Copies of core's proposal regexes (client code may import core as types only); a test pins them equal. */
export const ANY_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
/** Control and bidi-override characters, except \n (not allowed in a rationale). */
export const CONTROL_EXCEPT_LF_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const SCRAPE_CLASS_MAX = 128;
const SUPPRESSION_RATIONALE_MAX = 500;
const SUPPRESSION_CLASSES = ["excluded", "expected-churn", "known-expected"] as const;
/** One of the suppression classes a proposal may set. */
export type SuppressionClass = (typeof SUPPRESSION_CLASSES)[number];

/**
 * Mirror of `fieldValueSchema(field, kind).safeParse(v).success`: null iff accepted, else a
 * display-safe reason. Lengths are UTF-16 units, as zod's `.min/.max` count them.
 */
export function proposedValueIssue(field: ProposableField, kind: "host" | "service", v: ProposalValue): string | null {
  const spec = clientFieldSpec(field);
  if (v === null) return spec.nullable[kind] ? null : "This field cannot be cleared.";
  switch (spec.valueKind) {
    case "boolean":
      return typeof v === "boolean" ? null : "Choose yes or no.";
    case "string":
      if (typeof v !== "string" || v.length === 0) return "Enter a value.";
      if (v.length > SCRAPE_CLASS_MAX) return `Use at most ${SCRAPE_CLASS_MAX} characters.`;
      if (ANY_CONTROL_RE.test(v)) return "Remove control characters.";
      if (v.trim() !== v) return "Remove leading and trailing spaces.";
      return null;
    case "suppression": {
      if (typeof v !== "object" || Object.keys(v).length !== 2) return "Choose a suppression class and rationale.";
      const m = v as unknown as Record<string, unknown>;
      if (!(SUPPRESSION_CLASSES as readonly unknown[]).includes(m["class"])) return "Choose a suppression class.";
      const r = m["rationale"];
      if (typeof r !== "string") return "Enter a suppression rationale.";
      if (r.trim().length === 0) return "Enter a suppression rationale.";
      if (r.length > SUPPRESSION_RATIONALE_MAX) return `Use at most ${SUPPRESSION_RATIONALE_MAX} characters in the suppression rationale.`;
      if (CONTROL_EXCEPT_LF_RE.test(r)) return "Remove control characters (line breaks are allowed).";
      return null;
    }
  }
}

/** Mirror of core proposalValuesEqual for the ProposalValue domain (marks compare by class + rationale). */
export function clientValuesEqual(a: ProposalValue, b: ProposalValue): boolean {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  return a.class === b.class && a.rationale === b.rationale;
}

// ── Current value (client twin of server readProposableValue) ───────────────

/** True when a standalone `suppressions[]` entry of the web model covers this service (the server's suppression rule). */
export function coveredByStandaloneSuppression(model: WebEstateModelV2, svc: WebEstateServiceV2): boolean {
  return model.suppressions.some((x) => x.resolves.includes(svc.drilldownId));
}

const markOf = (s: { readonly class: SuppressionClass; readonly rationale: string }): SuppressionMarkValue =>
  ({ class: s.class, rationale: s.rationale });

/**
 * Client mirror of the server `readProposableValue(model, target, field)`. It returns exactly
 * what the server compares `seen` against, with the same applicability, else the submission is refused
 * (stale-proposal / invalid-body). A null model (unknown) fails closed for the service suppression rule.
 */
export function readDeclaredValue(
  model: WebEstateModelV2 | null,
  kind: "host" | "service",
  e: WebEstateHostV2 | WebEstateServiceV2,
  field: ProposableField,
): CurrentValue {
  if (kind === "host") {
    const h = e as WebEstateHostV2;
    if (!clientFieldApplies(field, "host", h.collectionClass)) return { applicable: false };
    switch (field) {
      case "expectedChurn": return { applicable: true, value: h.expectedChurn };
      case "scrapeIntervalClass": return { applicable: true, value: h.scrapeIntervalClass };
      case "cadvisor": return h.collectionClass === "managed-linux" ? { applicable: true, value: h.detail.cadvisor } : { applicable: false };
      case "heartbeat": return h.collectionClass === "managed-linux" ? { applicable: true, value: h.detail.heartbeat } : { applicable: false };
      case "suppressed": return h.suppressed === null ? { applicable: false } : { applicable: true, value: markOf(h.suppressed) };
    }
  }
  const s = e as WebEstateServiceV2;
  if (!clientFieldApplies(field, "service", null)) return { applicable: false };
  if (model === null || coveredByStandaloneSuppression(model, s)) return { applicable: false };
  return { applicable: true, value: s.suppressed === null ? null : markOf(s.suppressed) };
}

/** Offered rows: applicable allowlist fields with their prefilled `seen` value. */
export function offeredFields(
  model: WebEstateModelV2 | null, kind: "host" | "service", e: WebEstateHostV2 | WebEstateServiceV2,
): readonly { readonly spec: ProposableFieldSpec; readonly seen: ProposalValue }[] {
  const out: { spec: ProposableFieldSpec; seen: ProposalValue }[] = [];
  for (const spec of CLIENT_PROPOSABLE_FIELDS) {
    const cur = readDeclaredValue(model, kind, e, spec.field);
    if (cur.applicable) out.push({ spec, seen: cur.value });
  }
  return out;
}

// ── Form rows and validation ─────────────────────────────────────────────────

/** Display label per proposable field. */
export const FIELD_LABEL: Readonly<Record<ProposableField, string>> = {
  expectedChurn: "Expected churn",
  scrapeIntervalClass: "Scrape interval class",
  cadvisor: "cAdvisor",
  heartbeat: "Heartbeat",
  suppressed: "Suppression",
};
/** Radio options for the suppression class. */
export const CLASS_OPTIONS = SUPPRESSION_CLASSES.map((c) => ({ value: c, label: c }));
/** Radio options for a boolean field. */
export const YES_NO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] as const;

/** Rationale rule (same as the server's): 10–500 code points after trim; no control chars except \n. */
export function proposalRationaleError(raw: string): string | null {
  const t = raw.trim();
  const n = codePoints(t);
  if (n < RATIONALE_MIN_CHARS) return `Enter at least ${RATIONALE_MIN_CHARS} characters.`;
  if (n > RATIONALE_MAX_CHARS) return `Use at most ${RATIONALE_MAX_CHARS} characters.`;
  if (CONTROL_EXCEPT_LF_RE.test(t)) return "Remove control characters (line breaks are allowed).";
  return null;
}

/** The form state of one offered row. */
export interface RowState {
  readonly include: boolean;
  readonly bool: "yes" | "no";
  readonly text: string;
  readonly cls: SuppressionClass;
  readonly markRationale: string;
  readonly clear: boolean;
}

/** A row's initial (unedited) state, seeded from its current value. */
export function initialRow(seen: ProposalValue): RowState {
  const mark = seen !== null && typeof seen === "object" ? seen : null;
  return {
    include: false,
    bool: seen === true ? "yes" : "no",
    text: typeof seen === "string" ? seen : "",
    cls: mark?.class ?? "known-expected",
    markRationale: mark?.rationale ?? "",
    clear: false,
  };
}

/** The value a row proposes. */
export function proposedOf(spec: ProposableFieldSpec, r: RowState): ProposalValue {
  switch (spec.valueKind) {
    case "boolean": return r.bool === "yes";
    case "string": return r.clear ? null : r.text.trim();
    case "suppression": return r.clear ? null : { class: r.cls, rationale: r.markRationale.trim() };
  }
}

/** Client-side error for one included row (core mirror + "no change"), or null. */
export function rowIssue(spec: ProposableFieldSpec, kind: "host" | "service", seen: ProposalValue, r: RowState): string | null {
  const proposed = proposedOf(spec, r);
  return proposedValueIssue(spec.field, kind, proposed)
    ?? (clientValuesEqual(proposed, seen) ? "No change from the current value." : null);
}

/** The create-proposal request body for the included rows (by index into `rows` / `state`). */
export function buildProposalBody(
  target: { readonly kind: "host" | "service"; readonly id: string },
  rows: readonly { readonly spec: ProposableFieldSpec; readonly seen: ProposalValue }[],
  state: readonly RowState[],
  includedIdx: readonly number[],
  rationale: string,
): CreateProposalBody {
  return {
    target: { kind: target.kind, id: target.id },
    changes: includedIdx.map((i) => ({ field: rows[i]!.spec.field, seen: rows[i]!.seen, proposed: proposedOf(rows[i]!.spec, state[i]!) })),
    rationale: rationale.trim(),
  };
}
