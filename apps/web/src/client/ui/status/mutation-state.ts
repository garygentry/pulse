import type { ProposalState } from "@pulse/core/proposals";
import type { ActionState } from "@/mutations/StateBadge";
import { defineStatusMap } from "@/ui/lib/status";

/** Every mutation action and proposal lifecycle state (`pending` is shared). */
export type MutationState = ActionState | ProposalState;

/** Mutation action / proposal state presentation. */
export const MUTATION_STATE = defineStatusMap<MutationState>({
  acked: { tone: "neutral", icon: "circle-check", label: "Acknowledged" },
  pending: { tone: "pending", icon: "clock", label: "Pending" },
  failed: { tone: "danger", icon: "circle-alert", label: "Failed" },
  applied: { tone: "ok", icon: "circle-check", label: "Applied" },
  rejected: { tone: "neutral", icon: "circle-x", label: "Rejected" },
});
