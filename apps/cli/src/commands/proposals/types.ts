// apps/cli/src/commands/proposals/types.ts — the `proposals` envelope payload types.
// Types only: re-exported from envelope.ts next to the other command payloads.

import type { ProposableField, ProposalPayload, ProposalState } from "@pulse/core/proposals";

/** `proposals` payload, discriminated by sub-verb. */
export type ProposalsData =
  | {
      /** Sub-verb. */ readonly verb: "list";
      /** Verified proposals, newest first. */ readonly proposals: readonly ProposalSummary[];
      /** Files that failed parse/verify, with the reason. */ readonly invalid: readonly { file: string; reason: string }[];
    }
  | {
      /** Sub-verb. */ readonly verb: "show";
      /** The summary plus the full signed payload. */ readonly proposal: ProposalSummary & { readonly payload: ProposalPayload };
    }
  | {
      /** Sub-verb. */ readonly verb: "apply";
      /** Proposal id. */ readonly id: string;
      /** Final state: an apply of an already-rejected proposal reports "rejected". */ readonly state: "applied" | "rejected";
      /** Commit SHA when applied, else null. */ readonly commit: string | null;
      /** Reject reason when rejected, else null. */ readonly reason: string | null;
      /** Estate files the apply changed. */ readonly changedFiles: readonly string[];
      /** True when the proposal was already decided (info finding, exit 0). */ readonly alreadyDecided: boolean;
    }
  | {
      /** Sub-verb. */ readonly verb: "reject";
      /** Proposal id. */ readonly id: string;
      /** Final state: a reject of an already-applied proposal reports "applied". */ readonly state: "applied" | "rejected";
      /** Commit SHA when applied, else null. */ readonly commit: string | null;
      /** Reject reason when rejected, else null. */ readonly reason: string | null;
      /** True when the proposal was already decided (info finding, exit 0). */ readonly alreadyDecided: boolean;
    };

/** One proposal as listed by the CLI. */
export interface ProposalSummary {
  /** Proposal id. */ readonly id: string;
  /** ISO-8601 UTC. */ readonly createdAt: string;
  /** Proposer displayName. */ readonly proposer: string;
  /** Target (kind, drilldown id, core name). */ readonly target: ProposalPayload["target"];
  /** Fields the proposal changes. */ readonly fields: readonly ProposableField[];
  /** Derived state. */ readonly state: ProposalState;
}

/** Why a proposal file was not accepted. `dir.ts` re-exports this. */
export type InvalidReason =
  | "unparseable"
  | "schema"
  | "alg"
  | "signature"
  | "id-mismatch"
  | "result-invalid"
  | "not-a-file";
