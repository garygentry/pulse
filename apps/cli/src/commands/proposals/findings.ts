// apps/cli/src/commands/proposals/findings.ts — PROPOSAL_* finding builders, each with
// its file/path/fix columns filled. Every message and fix passes through stripControl (REQ-SEC-07),
// so proposal-originated text can never drive the operator's terminal.

import { FINDING_CODES } from "@pulse/core";
import type { Finding } from "@pulse/core";
import {
  PROPOSABLE_FIELDS,
  canonicalProposalJson,
  proposalFileName,
  resultFileName,
} from "@pulse/core/proposals";
import type {
  ProposalChange,
  ProposalPayload,
  ProposalResultV1,
  ProposalValue,
} from "@pulse/core/proposals";

import type { CommandResult } from "../result.js";
import { stripControl } from "./commit-message.js";
import type { InvalidReason, ProposalsData } from "./types.js";

/** Max paths listed in a PROPOSAL_DIRTY_TREE message before `… and N more`. */
export const DIRTY_TREE_MAX_PATHS = 50;

/** Build a proposal finding; `message`/`fix` pass through stripControl. */
export function proposalFinding(
  code: Finding["code"],
  severity: Finding["severity"],
  file: string,
  path: string,
  message: string,
  fix: string,
): Finding {
  return { severity, code, file, path, message: stripControl(message), fix: stripControl(fix) };
}

/** `{ findings: [f], data: null, outcomeFailed: false }` — the error severity drives exit 1. */
export function refused(f: Finding): CommandResult<ProposalsData> {
  return { findings: [f], data: null, outcomeFailed: false };
}

/** `<kind> <name>` as shown in messages. */
function targetLabel(payload: ProposalPayload): string {
  return `${payload.target.kind} ${payload.target.name}`;
}

/** The estate YAML key for a proposable field. */
function yamlKeyOf(field: ProposalChange["field"]): string {
  return PROPOSABLE_FIELDS.find((s) => s.field === field)?.yamlKey ?? field;
}

/** Single-line JSON of a value for messages (canonical, key-order independent). */
function json(v: ProposalValue): string {
  return canonicalProposalJson(v);
}

/** Short commit id for messages. */
function sha7(commit: string): string {
  return commit.slice(0, 7);
}

/** PROPOSAL_NOT_FOUND: no `<id>.proposal.json` in the proposals directory (error). */
export const notFoundFinding = (id: string): Finding =>
  proposalFinding(
    FINDING_CODES.PROPOSAL_NOT_FOUND,
    "error",
    proposalFileName(id),
    "",
    `No proposal ${id} in the proposals directory.`,
    "Check the id and --proposals-dir / PULSE_PROPOSALS_DIR.",
  );

/** PROPOSAL_SIGNATURE_INVALID: the proposal file failed parsing, schema or HMAC verification (error). */
export const signatureInvalidFinding = (id: string, reason: InvalidReason): Finding =>
  proposalFinding(
    FINDING_CODES.PROPOSAL_SIGNATURE_INVALID,
    "error",
    proposalFileName(id),
    "",
    `Proposal ${id} failed verification (${reason}).`,
    reason === "result-invalid"
      ? `The proposal is signed, but its result sidecar ${resultFileName(id)} is unreadable or malformed, so its decision is unknown; inspect or remove the sidecar, then re-run.`
      : "The file is unsigned, tampered, or signed with a different PULSE_PROPOSAL_SECRET; it will not be applied or rejected.",
  );

/**
 * Staged or tracked-dirty paths block an apply (REQ-PROP-08 a0). Paths are listed in the message,
 * at most {@link DIRTY_TREE_MAX_PATHS}, then `… and N more`; diff content is never printed.
 */
export function dirtyTreeFinding(staged: readonly string[], dirty: readonly string[]): Finding {
  const all = [...staged.map((p) => `staged: ${p}`), ...dirty.map((p) => `modified: ${p}`)];
  const shown = all.slice(0, DIRTY_TREE_MAX_PATHS);
  const more = all.length - shown.length;
  const list = shown.join(", ") + (more > 0 ? ` … and ${more} more` : "");
  return proposalFinding(
    FINDING_CODES.PROPOSAL_DIRTY_TREE,
    "error",
    "",
    "",
    `The estate repository has uncommitted changes: ${list}.`,
    "Commit or stash these changes first, then re-run the apply.",
  );
}

/**
 * One mismatched field (REQ-PROP-08 b). `file` is the entity's provenance file (estateDir-relative);
 * `path` is the YAML key.
 */
export function staleFinding(
  file: string,
  _payload: ProposalPayload,
  change: ProposalChange,
  current: ProposalValue,
): Finding {
  return proposalFinding(
    FINDING_CODES.PROPOSAL_STALE,
    "error",
    file,
    yamlKeyOf(change.field),
    `${change.field}: seen ${json(change.seen)}, current ${json(current)}`,
    "The estate changed since the proposal was made; ask the proposer to re-propose from the current value.",
  );
}

/** The field no longer applies to the target (class changed, standalone suppression added). */
export function staleInapplicableFinding(file: string, payload: ProposalPayload, change: ProposalChange): Finding {
  return proposalFinding(
    FINDING_CODES.PROPOSAL_STALE,
    "error",
    file,
    yamlKeyOf(change.field),
    `${change.field} no longer applies to ${targetLabel(payload)}.`,
    "The estate changed since the proposal was made; ask the proposer to re-propose from the current value.",
  );
}

/** The target entity no longer exists in the estate. */
export function staleTargetGoneFinding(payload: ProposalPayload): Finding {
  return proposalFinding(
    FINDING_CODES.PROPOSAL_STALE,
    "error",
    "",
    "",
    `${targetLabel(payload)} no longer exists in the estate.`,
    "The estate changed since the proposal was made; ask the proposer to re-propose against the current estate.",
  );
}

/** An overlay cannot delete a key the base layer declares (REQ-PROP-08 c). */
export function cannotClearBaseFinding(file: string, section: string, name: string, yamlKey: string): Finding {
  return proposalFinding(
    FINDING_CODES.PROPOSAL_CANNOT_CLEAR_BASE,
    "error",
    file,
    `${section}.${name}.${yamlKey}`,
    `Cannot clear ${yamlKey} on ${section} ${name}: the base layer declares it and an overlay cannot delete a base key.`,
    "Edit the base layer by hand; an overlay cannot delete a base key.",
  );
}

/** No single overlay file can be chosen for the edit (REQ-PROP-08 c; see locateOverlay's rules 1–4). */
export const overlayAmbiguousFinding = (message: string): Finding =>
  proposalFinding(
    FINDING_CODES.PROPOSAL_OVERLAY_AMBIGUOUS,
    "error",
    "",
    "",
    message,
    "Pass --overlay <file> naming the one layer: overlay file to edit (or create one).",
  );

/** Invalid-estate phases: before the edit (staleness check) or after it (validate/render). */
export type InvalidEstatePhase = "before" | "after" | "no-effect" | "render";

const INVALID_ESTATE_TEXT: Record<InvalidEstatePhase, string> = {
  before: "the estate is already invalid; nothing was changed",
  after: "the edited estate does not validate; the overlay was restored",
  "no-effect": "the overlay edit did not take effect on the merged estate; the overlay was restored",
  render: "the edited estate failed to render; the overlay was restored",
};

/** The estate is invalid before, or becomes invalid after, the edit (REQ-PROP-08 d). */
export function invalidEstateFinding(phase: InvalidEstatePhase, payload: ProposalPayload, overlayFile?: string): Finding {
  return proposalFinding(
    FINDING_CODES.PROPOSAL_INVALID_ESTATE,
    "error",
    overlayFile ?? "",
    "",
    `Proposal ${payload.id} (${targetLabel(payload)}): ${INVALID_ESTATE_TEXT[phase]}.`,
    "Fix the estate (pulse validate) and re-apply.",
  );
}

/**
 * Report an existing decision and change nothing (REQ-PROP-10): one INFO PROPOSAL_ALREADY_DECIDED
 * finding (exit 0) and envelope data carrying the existing state.
 *
 * @param verb - The sub-verb that was asked for.
 * @param result - The existing (or just-recovered) sidecar.
 * @param recovered - True when apply's crash recovery just wrote the missing applied sidecar.
 */
export function alreadyDecided(
  verb: "apply" | "reject",
  result: ProposalResultV1,
  recovered = false,
): CommandResult<ProposalsData> {
  const message =
    result.state === "applied"
      ? recovered
        ? `Proposal ${result.id} is already applied; recorded the missing applied result for commit ${sha7(result.commit)}.`
        : `Proposal ${result.id} is already applied (commit ${sha7(result.commit)}); nothing changed.`
      : `Proposal ${result.id} is already rejected: ${result.reason}; nothing changed.`;
  const finding = proposalFinding(
    FINDING_CODES.PROPOSAL_ALREADY_DECIDED,
    "info",
    resultFileName(result.id),
    "",
    message,
    `None: the proposal is already ${result.state}.`,
  );
  const commit = result.state === "applied" ? result.commit : null;
  const reason = result.state === "rejected" ? result.reason : null;
  const data: ProposalsData =
    verb === "apply"
      ? { verb, id: result.id, state: result.state, commit, reason, changedFiles: [], alreadyDecided: true }
      : { verb, id: result.id, state: result.state, commit, reason, alreadyDecided: true };
  return { findings: [finding], data, outcomeFailed: false };
}
