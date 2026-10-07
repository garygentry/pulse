// apps/web/src/client/mutations/proposals/format.ts — proposal value text, shared by the proposal list
// and the propose dialog. Imports `@pulse/core/proposals` TYPES only (erased).
import type { ProposalValue } from "@pulse/core/proposals";

/** true→"yes", false→"no", null→"(cleared)", string→itself, mark→"<class>: <rationale>". */
export function formatValue(v: ProposalValue): string {
  if (v === true) return "yes";
  if (v === false) return "no";
  if (v === null) return "(cleared)";
  if (typeof v === "string") return v;
  return `${v.class}: ${v.rationale}`;
}
