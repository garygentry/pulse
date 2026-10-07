// apps/cli/src/commands/proposals/commit-message.ts — control-character neutralizer and the proposal
// commit-message builder (REQ-PROP-08 e, REQ-SEC-07).

import { canonicalProposalJson } from "@pulse/core/proposals";
import type { ProposalPayload, ProposalValue } from "@pulse/core/proposals";

/** Column at which the commit-message rationale is wrapped. */
export const COMMIT_WRAP_COLUMNS = 72;
/** Max rendered length of one value in the Changes trailer. */
export const TRAILER_VALUE_MAX_CHARS = 120;
const CONTROL_G = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * Neutralize user text for a commit message or terminal (REQ-SEC-07). CR/CRLF → LF. Tabs → space.
 * Other C0/DEL/C1/bidi controls are removed. LF is kept only when `multiline`; otherwise it becomes a space.
 */
export function stripControl(s: string, multiline = false): string {
  const t = s.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROL_G, "");
  return multiline ? t : t.replace(/\n+/g, " ").trim();
}

/** Greedy word wrap at `width`; a single word longer than width stays on its own line. */
export function wrapText(line: string, width = COMMIT_WRAP_COLUMNS): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(/ +/).filter((w) => w.length > 0)) {
    if (cur === "") cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

/**
 * Build the proposal commit message:
 *
 *   estate: apply proposal <id> (<kind> <name>)
 *
 *   <rationale: controls stripped, paragraphs kept, each line wrapped at 72>
 *
 *   Proposal-Id: <id>
 *   Proposed-By: <displayName>
 *   Changes: <field>: <seen> -> <proposed>; ...
 *
 * The trailer block is always the LAST paragraph, so git's trailer parser only ever sees ours. A
 * rationale line that imitates a trailer stays in the body and is ignored by findProposalCommit.
 */
export function buildCommitMessage(p: ProposalPayload): string {
  const subject = `estate: apply proposal ${p.id} (${p.target.kind} ${stripControl(p.target.name)})`;
  const body = stripControl(p.rationale, true)
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split("\n")
        .flatMap((l) => wrapText(l.trim()))
        .join("\n"),
    )
    .filter((para) => para.length > 0)
    .join("\n\n");
  const changes = p.changes
    .map((c) => `${c.field}: ${trailerValue(c.seen)} -> ${trailerValue(c.proposed)}`)
    .join("; ");
  return [
    subject,
    "",
    body,
    "",
    `Proposal-Id: ${p.id}`,
    `Proposed-By: ${stripControl(p.proposer.displayName) || p.proposer.subject}`,
    `Changes: ${changes}`,
    "",
  ].join("\n");
}

/** Single-line canonical JSON of a value, controls stripped, truncated with "…". */
export function trailerValue(v: ProposalValue): string {
  const s = stripControl(canonicalProposalJson(v));
  return [...s].length > TRAILER_VALUE_MAX_CHARS ? [...s].slice(0, TRAILER_VALUE_MAX_CHARS - 1).join("") + "…" : s;
}
