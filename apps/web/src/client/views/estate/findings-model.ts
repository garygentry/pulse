// src/client/views/estate/findings-model.ts — pure model for the `findings` tab of the /estate landing.
//
// Finding types, plain-text location, severity ordering/presentation, and the severity/code filter.
// The wire array arrives sorted by (file,path,code,severity,message) — a determinism contract, NOT
// display order — so rows are re-sorted most-severe-first client-side. Severity is NOT TargetStatus.

import type { WebFindingsArtifact } from "@pulse/renderer";

import { FINDING_SEVERITY_STATUS } from "../../status/target-status.js";
import type { IconName } from "@/ui";
import type { EstateQuery } from "./types.js";

// The @pulse/renderer barrel re-exports WebFindingsArtifact but not Finding/Severity/FindingCode, so
// they are derived structurally (shapes identical to @pulse/core's; no new package import).
/** One loader/renderer finding (packages/core/src/findings). */
export type Finding = WebFindingsArtifact["findings"][number];
/** `"error" | "warning" | "info"` — NOT TargetStatus. */
export type Severity = Finding["severity"];
/** The closed finding-code union. */
export type FindingCode = Finding["code"];

/** Plain-text location: `file · path`, or `file` alone for a file/estate-level finding (path ""). */
export function formatLocation(finding: Finding): string {
  return finding.path.length > 0 ? `${finding.file} · ${finding.path}` : finding.file;
}

/** Display rank — lower sorts earlier. The single source of truth for findings display order. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

/** Most-severe-first comparator; ties return 0 so a stable sort keeps wire order within a bucket. */
export function compareBySeverity(a: Finding, b: Finding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}

/** Re-sort into error → warning → info. Pure and stable; never mutates its input. */
export function bucketBySeverity(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareBySeverity);
}

/** Per-severity presentation. `token` names an EXISTING --l-status-{token}-* triple (color only),
 *  taken from FINDING_SEVERITY_STATUS. */
export interface SeverityPresentation {
  readonly label: "Error" | "Warning" | "Info";
  readonly icon: IconName;
  readonly token: "critical" | "warning" | "unknown";
}

/** Distinct glyph shapes per severity so it stays legible in grayscale. */
export const SEVERITY_PRESENTATION: Readonly<Record<Severity, SeverityPresentation>> = {
  error: { label: "Error", icon: "circle-alert", token: FINDING_SEVERITY_STATUS.error },
  warning: { label: "Warning", icon: "triangle", token: FINDING_SEVERITY_STATUS.warning },
  info: { label: "Info", icon: "info", token: FINDING_SEVERITY_STATUS.info },
};

/** Apply both filter axes; "" means no filter. An unknown value simply matches nothing. */
export function filterFindings(findings: readonly Finding[], query: EstateQuery): Finding[] {
  return findings.filter(
    (f) => (query.sev === "" || f.severity === query.sev) && (query.code === "" || f.code === query.code),
  );
}

/** Distinct codes in first-seen order — the code <select> options. */
export function distinctCodes(findings: readonly Finding[]): FindingCode[] {
  const seen = new Set<FindingCode>();
  const out: FindingCode[] = [];
  for (const f of findings) {
    if (!seen.has(f.code)) {
      seen.add(f.code);
      out.push(f.code);
    }
  }
  return out;
}
