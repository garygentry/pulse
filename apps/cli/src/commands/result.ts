// apps/cli/src/commands/result.ts — the handler↔shell seam (05 §3).

import type { Finding } from "@pulse/core";

/**
 * The uniform return of every command handler (05 §1). It carries exactly what the shell
 * (`04-cli-surface.md`) needs to build the `--json` envelope (`00 §5`) and resolve the exit
 * code (`00 §2`, REQ-CLI-02):
 *
 *  - `findings` — core `Finding[]`, VERBATIM and already sorted by the producer
 *    (`loadAndValidate` pre-sorts; the renderer's `secret_literal` refusal is merged and the
 *    combined list is sorted once, `02 §5`). The shell emits it into `envelope.findings`
 *    WITHOUT re-sorting (REQ-VAL-02, CON-04). May be empty.
 *  - `data` — the command-specific payload (`00 §5.1`), or `null` when the command carries
 *    none (`validate`).
 *  - `outcomeFailed` — `true` for a NON-finding exit-1 outcome: a coverage gap (REQ-COV-01),
 *    `--check` drift (REQ-RND-07), or `init` would-clobber (REQ-INIT-03). These are
 *    deliberately NOT `Finding`s (tech spec §3.3.1) yet must trip exit 1; this flag is how a
 *    handler signals that to the shell. `false` when the only exit driver is the finding set
 *    (or the run is clean).
 */
export interface CommandResult<D> {
  /** core Finding[], verbatim + pre-sorted; never coverage/drift/clobber (those live in `data`). */
  findings: Finding[];
  /** command-specific payload, or `null` (validate). */
  data: D | null;
  /** true iff a non-finding exit-1 outcome occurred (gap / drift / would-clobber). */
  outcomeFailed: boolean;
}
