// apps/cli/src/commands/proposals/list.ts — `pulse proposals list [--state]` (REQ-PROP-07).

import type { ProposalState } from "@pulse/core/proposals";

import type { OutputWriter } from "../../output.js";
import type { CommandResult } from "../result.js";
import { stripControl } from "./commit-message.js";
import { readProposalDir, toSummary } from "./dir.js";
import type { InvalidProposal } from "./dir.js";
import type { ProposalsData, ProposalSummary } from "./types.js";

/** Inputs for {@link runList}. */
export interface ListInputs {
  /** Resolved, existing proposals directory. */
  readonly proposalsDir: string;
  /** Shared HMAC secret bytes (never printed). */
  readonly secret: Uint8Array;
  /** Filter by derived state, or null for all. */
  readonly state: ProposalState | null;
  /** Output writer (table goes to stderr via `note`). */
  readonly out: OutputWriter;
}

/** `pulse proposals list [--state]` (REQ-PROP-07). Never fails on invalid files; they are reported in `data.invalid`. */
export function runList(inp: ListInputs): CommandResult<ProposalsData> {
  const listing = readProposalDir(inp.proposalsDir, inp.secret);
  const rows = listing.proposals.filter((p) => inp.state === null || p.state === inp.state).map(toSummary);
  printList(inp.out, rows, listing.invalid); // stderr, inert text
  return { findings: [], data: { verb: "list", proposals: rows, invalid: listing.invalid }, outcomeFailed: false };
}

/** Print the table and the invalid-file line. Every user string passes through stripControl. */
export function printList(
  out: OutputWriter,
  rows: readonly ProposalSummary[],
  invalid: readonly InvalidProposal[],
): void {
  const table = [
    ["ID", "STATE", "TARGET", "FIELDS", "PROPOSER"],
    ...rows.map((r) => [
      r.id,
      r.state,
      stripControl(`${r.target.kind} ${r.target.name}`),
      r.fields.join(","),
      stripControl(r.proposer),
    ]),
  ];
  if (rows.length === 0) {
    out.note("no proposals");
  } else {
    const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
    for (const row of table) {
      out.note(row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]! + 2))).join("").trimEnd());
    }
  }
  if (invalid.length > 0) {
    const files = invalid.map((f) => `${stripControl(f.file)} (${f.reason})`).join(", ");
    out.note(`${invalid.length} invalid proposal file${invalid.length === 1 ? "" : "s"} skipped: ${files}`);
  }
}
