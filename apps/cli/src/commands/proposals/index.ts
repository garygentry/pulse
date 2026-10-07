// apps/cli/src/commands/proposals/index.ts — the `pulse proposals` dispatcher
// (REQ-PROP-07).

import { statSync } from "node:fs";

import { ConfigIoError } from "@pulse/core";
import { PROPOSAL_SECRET_MIN_BYTES } from "@pulse/core/proposals";

import type { CommandContext } from "../../index.js"; // type-only: erased, no runtime cycle
import type { CommandResult } from "../result.js";
import type { ProposalsInvocation } from "./args.js";
import { runApply } from "./apply.js";
import { runList } from "./list.js";
import { runReject } from "./reject.js";
import { runShow } from "./show.js";
import type { ProposalsData } from "./types.js";

/** Env var carrying the shared HMAC secret (REQ-SEC-04). Read here and nowhere else in apps/cli. */
export const PROPOSAL_SECRET_ENV = "PULSE_PROPOSAL_SECRET" as const;

/** Process facilities the proposals handlers need beyond CommandContext (injectable for tests). */
export interface ProposalsDeps {
  /** Process env: the secret, USER fallback. Never serialized. */
  readonly env: NodeJS.ProcessEnv;
  /** Clock for sidecar `at` (ISO-8601 UTC). */
  readonly now: () => Date;
}

/**
 * Run one `pulse proposals` sub-verb (REQ-PROP-07). Synchronous, like every CLI handler.
 *
 * @throws {ConfigIoError} proposals dir unresolved/missing/not a dir, or the secret absent/short → exit 2.
 * @throws {ProposalToolError} git/tool faults → exit 2.
 * @throws {RenderIoError} materialize failure during apply, rethrown after rollback → exit 2.
 */
export function runProposals(
  inv: ProposalsInvocation,
  ctx: CommandContext,
  deps: ProposalsDeps,
): CommandResult<ProposalsData> {
  const proposalsDir = requireProposalsDir(ctx.config.proposalsDir);
  const secret = readProposalSecret(deps.env);
  switch (inv.sub) {
    case "list":
      return runList({ proposalsDir, secret, state: inv.state, out: ctx.out });
    case "show":
      return runShow({ proposalsDir, secret, id: inv.id, out: ctx.out });
    case "apply":
      return runApply({
        id: inv.id,
        overlayFlag: inv.overlay,
        proposalsDir,
        secret,
        estateDir: ctx.config.estateDir,
        outputRoot: ctx.config.outputRoot,
        env: deps.env,
        now: deps.now,
        out: ctx.out,
      });
    case "reject":
      return runReject({
        id: inv.id,
        reason: inv.reason,
        proposalsDir,
        secret,
        estateDir: ctx.config.estateDir,
        env: deps.env,
        now: deps.now,
        out: ctx.out,
      });
  }
}

/** Resolve the dir or fail as a config fault (flag > env > config file > error: the last step of the precedence chain). */
export function requireProposalsDir(dir: string | undefined): string {
  if (dir === undefined) {
    throw new ConfigIoError(
      "INVALID_ARG",
      "proposals directory not configured: pass --proposals-dir, set PULSE_PROPOSALS_DIR, or add proposalsDir to pulse.config.yaml",
    );
  }
  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    throw new ConfigIoError("DIR_NOT_FOUND", `proposals directory not found: ${dir}`, dir);
  }
  if (!isDir) throw new ConfigIoError("NOT_A_DIRECTORY", `proposals directory is not a directory: ${dir}`, dir);
  return dir;
}

/**
 * Read the secret from the environment ONLY (REQ-SEC-04), as UTF-8 bytes — the same encoding as
 * the web's `loadProposalSecret`. The value is never logged or echoed; messages carry
 * only its byte length.
 */
export function readProposalSecret(env: NodeJS.ProcessEnv): Uint8Array {
  const raw = env[PROPOSAL_SECRET_ENV];
  if (raw === undefined || raw === "") {
    throw new ConfigIoError(
      "INVALID_ARG",
      `${PROPOSAL_SECRET_ENV} is not set; it must hold the secret shared with the web app`,
    );
  }
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength < PROPOSAL_SECRET_MIN_BYTES) {
    throw new ConfigIoError(
      "INVALID_ARG",
      `${PROPOSAL_SECRET_ENV} is too short (${bytes.byteLength} bytes; need ≥ ${PROPOSAL_SECRET_MIN_BYTES})`,
    );
  }
  return bytes;
}
