// apps/cli/src/commands/proposals/reject.ts — `pulse proposals reject <id> --reason <text>`
// (REQ-PROP-09, REQ-PROP-10, REQ-SEC-05). Writes only the `<id>.result.json` sidecar; the proposal
// file is never deleted or modified. Works without git (the actor name falls back to $USER).

import type { ProposalResultV1 } from "@pulse/core/proposals";

import type { OutputWriter } from "../../output.js";
import type { CommandResult } from "../result.js";
import { stripControl } from "./commit-message.js";
import { readProposal, writeResultFile } from "./dir.js";
import type { VerifiedProposal } from "./dir.js";
import { alreadyDecided, notFoundFinding, refused, signatureInvalidFinding } from "./findings.js";
import { ProposalToolError, openGit, runGit } from "./git.js";
import type { ProposalsData } from "./types.js";

/** Max characters of an actor name. */
const ACTOR_NAME_MAX_CHARS = 128;

/** Inputs for {@link runReject}. */
export interface RejectInputs {
  /** Validated proposal id. */
  readonly id: string;
  /** Reason, already validated by args.ts (trimmed, 10–500, no controls). */
  readonly reason: string;
  /** Resolved, existing proposals directory. */
  readonly proposalsDir: string;
  /** Shared HMAC secret bytes (never printed). */
  readonly secret: Uint8Array;
  /** Resolved estate directory (for `git config user.name`; need not be a repo). */
  readonly estateDir: string;
  /** Process env ($USER / $USERNAME fallback). Never serialized. */
  readonly env: NodeJS.ProcessEnv;
  /** Clock for the sidecar `at`. */
  readonly now: () => Date;
  /** Output writer (summary goes to stderr via `note`). */
  readonly out: OutputWriter;
}

/**
 * Mark a proposal rejected with a reason. The signature is verified FIRST, so a forged file cannot be
 * "rejected" into existence. An existing decision is reported unchanged (REQ-PROP-10).
 */
export function runReject(inp: RejectInputs): CommandResult<ProposalsData> {
  const one = readProposal(inp.proposalsDir, inp.id, inp.secret);
  if (one.kind === "absent") return refused(notFoundFinding(inp.id));
  if (one.kind === "invalid") return refused(signatureInvalidFinding(inp.id, one.reason));
  if (one.proposal.result !== null) return alreadyDecided("reject", one.proposal.result);
  // An apply that committed but crashed before writing its sidecar has already decided this proposal:
  // record that (as apply's own recovery would) instead of marking a committed change "rejected".
  const applied = committedApply(inp);
  if (applied !== null) {
    writeResultFile(inp.proposalsDir, applied);
    return alreadyDecided("reject", applied, true);
  }
  const result: ProposalResultV1 = {
    format: "pulse-proposal-result/v1",
    id: inp.id,
    state: "rejected",
    at: inp.now().toISOString(),
    by: actorName(inp.estateDir, inp.env),
    reason: inp.reason,
  };
  writeResultFile(inp.proposalsDir, result);
  printRejected(inp.out, one.proposal, inp.reason);
  return {
    findings: [],
    data: { verb: "reject", id: inp.id, state: "rejected", commit: null, reason: inp.reason, alreadyDecided: false },
    outcomeFailed: false,
  };
}

/**
 * The applied result for a commit carrying this proposal's `Proposal-Id` trailer, or null. Reject works
 * without git, so a missing git, a non-repo estateDir, or a repo git cannot search means "no commit
 * found" and reject proceeds as before, rather than faulting.
 */
function committedApply(inp: RejectInputs): ProposalResultV1 | null {
  let commit: string | null;
  try {
    commit = openGit(inp.estateDir).findProposalCommit(inp.id);
  } catch (err) {
    if (err instanceof ProposalToolError) return null;
    throw err;
  }
  if (commit === null) return null;
  return {
    format: "pulse-proposal-result/v1",
    id: inp.id,
    state: "applied",
    at: inp.now().toISOString(),
    by: actorName(inp.estateDir, inp.env),
    commit,
  };
}

/**
 * The deciding actor: `git -C <estateDir> config user.name`, else $USER, else $USERNAME, else
 * "unknown"; controls stripped and ≤ 128 characters. Never fails: a missing git or a non-repo
 * estateDir simply falls through.
 */
export function actorName(estateDir: string, env: NodeJS.ProcessEnv): string {
  let fromGit = "";
  try {
    const r = runGit(estateDir, ["config", "user.name"]);
    if (r.code === 0) fromGit = stripControl(r.stdout);
  } catch {
    /* git missing: fall back to the environment */
  }
  const candidates = [fromGit, env["USER"] ?? "", env["USERNAME"] ?? ""].map((s) => stripControl(s));
  const name = candidates.find((s) => s.length > 0) ?? "unknown";
  return [...name].slice(0, ACTOR_NAME_MAX_CHARS).join("");
}

/** Print the reject summary; user strings pass through stripControl. */
function printRejected(out: OutputWriter, p: VerifiedProposal, reason: string): void {
  const pl = p.file.payload;
  out.note(`rejected ${p.id} (${stripControl(`${pl.target.kind} ${pl.target.name}`)}): ${stripControl(reason)}`);
}
