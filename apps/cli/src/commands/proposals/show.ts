// apps/cli/src/commands/proposals/show.ts — `pulse proposals show <id>` (REQ-PROP-07).
// Unverified content is never displayed (REQ-SEC-05).

import { canonicalProposalJson } from "@pulse/core/proposals";

import type { OutputWriter } from "../../output.js";
import type { CommandResult } from "../result.js";
import { stripControl } from "./commit-message.js";
import { readProposal, toSummary } from "./dir.js";
import type { VerifiedProposal } from "./dir.js";
import { notFoundFinding, refused, signatureInvalidFinding } from "./findings.js";
import type { ProposalsData } from "./types.js";

/** Inputs for {@link runShow}. */
export interface ShowInputs {
  /** Resolved, existing proposals directory. */
  readonly proposalsDir: string;
  /** Shared HMAC secret bytes (never printed). */
  readonly secret: Uint8Array;
  /** Validated proposal id. */
  readonly id: string;
  /** Output writer (details go to stderr via `note`). */
  readonly out: OutputWriter;
}

/** `pulse proposals show <id>` (REQ-PROP-07). Unverified content is never displayed (REQ-SEC-05). */
export function runShow(inp: ShowInputs): CommandResult<ProposalsData> {
  const one = readProposal(inp.proposalsDir, inp.id, inp.secret);
  if (one.kind === "absent") return refused(notFoundFinding(inp.id));
  if (one.kind === "invalid") return refused(signatureInvalidFinding(inp.id, one.reason));
  printShow(inp.out, one.proposal);
  return {
    findings: [],
    data: { verb: "show", proposal: { ...toSummary(one.proposal), payload: one.proposal.file.payload } },
    outcomeFailed: false,
  };
}

/** Print one verified proposal. Every user string passes through stripControl. */
export function printShow(out: OutputWriter, p: VerifiedProposal): void {
  const pl = p.file.payload;
  out.note(`proposal  ${p.id}`);
  out.note(`state     ${p.state}`);
  if (p.result?.state === "applied") out.note(`commit    ${p.result.commit}`);
  if (p.result?.state === "rejected") out.note(`reason    ${stripControl(p.result.reason)}`);
  out.note(`created   ${pl.createdAt}`);
  out.note(`proposer  ${stripControl(pl.proposer.displayName)}`);
  out.note(`target    ${stripControl(`${pl.target.kind} ${pl.target.name}`)} (${stripControl(pl.target.id)})`);
  out.note("changes");
  for (const c of pl.changes) {
    out.note(`  ${c.field}: ${stripControl(canonicalProposalJson(c.seen))} -> ${stripControl(canonicalProposalJson(c.proposed))}`);
  }
  out.note("rationale");
  for (const line of stripControl(pl.rationale, true).split("\n")) out.note(`  ${line}`);
}
