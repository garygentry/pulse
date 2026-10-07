// apps/cli/src/commands/proposals/apply.ts — `pulse proposals apply <id>`
// (REQ-PROP-01, REQ-PROP-08, REQ-PROP-10). The ONLY code path that writes an estate YAML file or the
// rendered tree for a proposal (REQ-PROP-01). Steps run in the exact order pre → a0 → a → b → c →
// d → e → f; every refusal before (d) changes nothing, every failure at or after (d) restores the
// overlay bytes and outputRoot. Never pushes.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { loadAndValidate } from "@pulse/core";
import type { EstateModel, Finding, Host, Service } from "@pulse/core";
import { canonicalProposalJson, fieldApplies, readCoreValue, resultFileName } from "@pulse/core/proposals";
import type { ProposalPayload, ProposalResultV1, ProposalValue } from "@pulse/core/proposals";
import { materialize, renderOnly, RENDER_KINDS } from "@pulse/renderer";

import type { OutputWriter } from "../../output.js";
import type { CommandResult } from "../result.js";
import { buildCommitMessage, stripControl } from "./commit-message.js";
import { readProposal, readResult, writeResultFile } from "./dir.js";
import {
  alreadyDecided,
  dirtyTreeFinding,
  invalidEstateFinding,
  notFoundFinding,
  refused,
  signatureInvalidFinding,
  staleFinding,
  staleInapplicableFinding,
  staleTargetGoneFinding,
} from "./findings.js";
import { openGit, ProposalToolError } from "./git.js";
import type { GitRepo } from "./git.js";
import { applyChangesToOverlay, locateOverlay } from "./overlay-writer.js";
import type { EstateSection } from "./overlay-writer.js";
import type { ProposalsData } from "./types.js";

/** Inputs for {@link runApply}. */
export interface ApplyInputs {
  /** Validated proposal id. */
  readonly id: string;
  /** `--overlay <file>` (relative to estateDir, or absolute inside it), or null. */
  readonly overlayFlag: string | null;
  /** Resolved, existing proposals directory (absolute). */
  readonly proposalsDir: string;
  /** Resolved estate directory (absolute). */
  readonly estateDir: string;
  /** Resolved output root (absolute). */
  readonly outputRoot: string;
  /** Shared HMAC secret bytes (never printed). */
  readonly secret: Uint8Array;
  /** Process env (USER fallback for the actor name). Never serialized. */
  readonly env: NodeJS.ProcessEnv;
  /** Clock for the sidecar `at`. */
  readonly now: () => Date;
  /** Output writer (summary goes to stderr via `note`). */
  readonly out: OutputWriter;
}

/**
 * Apply one proposal (REQ-PROP-08). The steps run in the exact order pre → a0 → a → b → c → d → e → f.
 * Every refusal before (d) changes nothing. Every failure at or after (d) restores the overlay bytes and
 * outputRoot before returning or throwing. Never pushes.
 *
 * @returns exit-0 result (applied or already decided) or an exit-1 result (one PROPOSAL_* error finding,
 *   plus loader/render findings for INVALID_ESTATE).
 * @throws {ProposalToolError} git missing, not a repo, git failure, commit failure (after restore),
 *   restore failure, sidecar I/O.
 * @throws {RenderIoError} materialize failure, rethrown after restore.
 * @throws {ConfigIoError} propagated from loadAndValidate (estateDir missing/unreadable).
 */
export function runApply(inp: ApplyInputs): CommandResult<ProposalsData> {
  // (pre) Existence, idempotency, crash recovery (REQ-PROP-10).
  const git = openGit(inp.estateDir);
  const one = readProposal(inp.proposalsDir, inp.id, inp.secret);
  if (one.kind === "absent") return refused(notFoundFinding(inp.id));

  const existing = readResult(inp.proposalsDir, inp.id);
  if (existing.kind === "invalid") {
    throw new ProposalToolError("io", `${resultFileName(inp.id)} is unreadable or malformed; inspect it by hand`);
  }
  if (existing.kind === "ok") return alreadyDecided("apply", existing.result);

  const recovered = git.findProposalCommit(inp.id);
  if (recovered !== null) {
    if (one.kind === "invalid") return refused(signatureInvalidFinding(inp.id, one.reason));
    const result = appliedResult(inp, recovered, git.userName(inp.env));
    writeResultFile(inp.proposalsDir, result);
    return alreadyDecided("apply", result, true);
  }

  // (a0) Dirty check: staged anywhere, or tracked-dirty estate/rendered paths.
  const estateRel = git.rel(inp.estateDir);
  const outputRel = git.rel(inp.outputRoot);
  const proposalsRel = git.relOrNull(inp.proposalsDir);
  const staged = git.stagedPaths();
  const dirty = git.dirtyTrackedPaths([estateRel, outputRel], proposalsRel === null ? [] : [proposalsRel]);
  if (staged.length > 0 || dirty.length > 0) return refused(dirtyTreeFinding(staged, dirty));

  // (a) Signature (REQ-SEC-05).
  if (one.kind === "invalid") return refused(signatureInvalidFinding(inp.id, one.reason));
  const payload = one.proposal.file.payload;

  // (b) Staleness: every change's `seen` value must still match the estate's current value.
  const before = loadAndValidate(inp.estateDir);
  if (!before.ok) {
    return { findings: [invalidEstateFinding("before", payload), ...before.findings], data: null, outcomeFailed: false };
  }
  const entity = findEntity(before.model, payload.target);
  if (entity === null) return refused(staleTargetGoneFinding(payload));
  const stale: Finding[] = [];
  for (const ch of payload.changes) {
    if (!fieldApplies(ch.field, payload.target.kind, hostClassOf(entity))) {
      stale.push(staleInapplicableFinding(entity.provenance.file, payload, ch));
      continue;
    }
    const current = readCoreValue(entity, ch.field, before.model.suppressions);
    if (!current.applicable) {
      stale.push(staleInapplicableFinding(entity.provenance.file, payload, ch));
      continue;
    }
    if (!sameValue(current.value, ch.seen)) stale.push(staleFinding(entity.provenance.file, payload, ch, current.value));
  }
  if (stale.length > 0) return { findings: stale, data: null, outcomeFailed: false };

  // (c) Locate and edit the overlay. Nothing on disk has changed yet.
  const section = sectionOf(payload.target.kind);
  const loc = locateOverlay({
    estateDir: inp.estateDir,
    section,
    name: payload.target.name,
    ownerFile: entity.provenance.file,
    overlayFlag: inp.overlayFlag,
  });
  if (!loc.ok) return refused(loc.finding);
  const overlayRel = git.rel(loc.absPath);
  if (!git.isTracked(overlayRel)) return refused(dirtyTreeFinding([], [`?? ${overlayRel} (overlay is untracked)`]));
  const originalBytes = readFileSync(loc.absPath);
  const edit = applyChangesToOverlay({
    text: originalBytes.toString("utf8"),
    file: loc.file,
    section,
    name: payload.target.name,
    changes: payload.changes,
    baseDeclaredKeys: loc.baseDeclaredKeys,
  });
  if (!edit.ok) return refused(edit.finding);

  // (d) Write, validate, render, then (e) stage and commit.
  const rb = createRollback({
    git,
    overlayAbs: loc.absPath,
    originalBytes,
    outputRoot: inp.outputRoot,
    outputRel,
    untrackedBefore: new Set(git.untrackedPaths(outputRel)),
  });
  let sha: string;
  let changedFiles: string[];
  try {
    writeFileAtomicSync(loc.absPath, edit.text);
    rb.overlayWritten = true;
    const after = loadAndValidate(inp.estateDir);
    if (!after.ok) {
      rb.run();
      return {
        findings: [invalidEstateFinding("after", payload, loc.file), ...after.findings],
        data: null,
        outcomeFailed: false,
      };
    }
    const tookEffect = findEntity(after.model, payload.target);
    if (
      tookEffect === null ||
      payload.changes.some((c) => {
        const v = readCoreValue(tookEffect, c.field, after.model.suppressions);
        return !v.applicable || !sameValue(v.value, c.proposed);
      })
    ) {
      rb.run();
      return refused(invalidEstateFinding("no-effect", payload, loc.file));
    }
    // ANY error-severity render finding is a render failure: the commit never holds a refused artifact.
    const rendered = renderOnly(after.model, RENDER_KINDS, { findings: after.findings });
    if (!rendered.ok || rendered.findings.some((f) => f.severity === "error")) {
      rb.run();
      return {
        findings: [
          invalidEstateFinding("render", payload, loc.file),
          ...rendered.findings.filter((f) => f.severity === "error"),
        ],
        data: null,
        outcomeFailed: false,
      };
    }
    rb.outputTouched = true;
    materialize(rendered.tree, inp.outputRoot);

    const renderedChanged = git.changedPaths(outputRel);
    changedFiles = [overlayRel, ...renderedChanged];
    rb.staged = changedFiles;
    git.add(changedFiles);
    sha = git.commit(buildCommitMessage(payload));
  } catch (err) {
    rb.run(err);
    throw err;
  }

  // (f) Sidecar. A failed write does NOT roll the commit back; pre-2 recovery completes it.
  const result = appliedResult(inp, sha, git.userName(inp.env));
  try {
    writeResultFile(inp.proposalsDir, result);
  } catch (err) {
    throw new ProposalToolError(
      "io",
      `commit ${sha} was made but ${resultFileName(inp.id)} could not be written (${(err as Error).message}); re-run 'pulse proposals apply ${inp.id}' to record it`,
    );
  }
  printApplied(inp.out, payload, sha, changedFiles);
  // Loader/render warnings are not re-reported on success.
  return {
    findings: [],
    data: { verb: "apply", id: inp.id, state: "applied", commit: sha, reason: null, changedFiles, alreadyDecided: false },
    outcomeFailed: false,
  };
}

/**
 * Resolve the target by core identity (target.name), never by drilldown id. Name alone is
 * sufficient: host and service names are each unique estate-wide (a repeat is a DUPLICATE_IDENTITY
 * error), and apply refuses an invalid estate before it gets here, so the host in `svc:<host>/<name>`
 * cannot disambiguate anything.
 */
export function findEntity(model: EstateModel, target: ProposalPayload["target"]): Host | Service | null {
  return target.kind === "host"
    ? (model.hosts.find((h) => h.name === target.name) ?? null)
    : (model.services.find((s) => s.name === target.name) ?? null);
}

/** Deep equality on ProposalValue via the canonical JSON (key order independent). */
export function sameValue(a: ProposalValue, b: ProposalValue): boolean {
  return canonicalProposalJson(a) === canonicalProposalJson(b);
}

function hostClassOf(e: Host | Service): string | null {
  return "collectionClass" in e ? e.collectionClass : null;
}

function sectionOf(kind: ProposalPayload["target"]["kind"]): EstateSection {
  return kind === "host" ? "hosts" : "services";
}

/** `{ format, id, state: "applied", at: now ISO, by, commit }` — the applied result sidecar. */
function appliedResult(inp: ApplyInputs, commit: string, by: string): ProposalResultV1 {
  return { format: "pulse-proposal-result/v1", id: inp.id, state: "applied", at: inp.now().toISOString(), by, commit };
}

/** Print the apply summary. User strings pass through stripControl; the hint says nothing was pushed. */
export function printApplied(out: OutputWriter, payload: ProposalPayload, sha: string, changedFiles: readonly string[]): void {
  const short = sha.slice(0, 7);
  out.note(`applied ${payload.id} (${stripControl(`${payload.target.kind} ${payload.target.name}`)}) in commit ${short}`);
  for (const f of changedFiles) out.note(`  ${stripControl(f)}`);
  out.note(`not pushed — review with 'git show ${short}' and push when ready`);
}

/**
 * Write `text` to `path` atomically: sibling temp (O_EXCL) → fsync → rename. The overlay is never
 * observed half-written.
 */
function writeFileAtomicSync(path: string, text: string | Uint8Array): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomBytes(4).toString("hex")}`);
  try {
    const fd = openSync(tmp, "wx", 0o644);
    try {
      writeSync(fd, typeof text === "string" ? Buffer.from(text, "utf8") : text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already renamed or never created */
    }
    throw err;
  }
}

/** Mutable rollback state for one apply. `run()` is idempotent and best-effort across all steps. */
export interface Rollback {
  /** The overlay was rewritten (step 2 restores it). */
  overlayWritten: boolean;
  /** materialize was called (steps 3–4 restore outputRoot). */
  outputTouched: boolean;
  /** Paths passed to `git add` (step 1 unstages them). */
  staged: readonly string[];
  /**
   * Restore in this order: (1) `git restore --staged -- <staged>`; (2) atomically rewrite the original
   * overlay bytes; (3) `git restore --worktree -- <outputRel>`; (4) delete files under outputRoot that
   * are untracked now but were not in `untrackedBefore`, and remove outputRoot entirely when it did not
   * exist before. Every step is attempted even if an earlier one fails.
   * @throws {ProposalToolError} "restore" naming each failed step and `cause`, telling the operator
   *   to inspect `git status` (exit 2).
   */
  run(cause?: unknown): void;
}

/** Create the rollback for one apply; captures whether outputRoot existed before. */
export function createRollback(init: {
  git: GitRepo;
  overlayAbs: string;
  originalBytes: Buffer;
  outputRoot: string;
  outputRel: string;
  untrackedBefore: ReadonlySet<string>;
}): Rollback {
  const outputExisted = existsSync(init.outputRoot);
  let done = false;
  const rb: Rollback = {
    overlayWritten: false,
    outputTouched: false,
    staged: [],
    run(cause?: unknown): void {
      if (done) return;
      done = true;
      const failed: string[] = [];
      const attempt = (step: string, fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          failed.push(`${step}: ${stripControl((err as Error).message ?? String(err))}`);
        }
      };
      if (rb.staged.length > 0) attempt("unstage", () => init.git.unstage(rb.staged));
      if (rb.overlayWritten) attempt("overlay", () => writeFileAtomicSync(init.overlayAbs, init.originalBytes));
      if (rb.outputTouched) {
        if (outputExisted) attempt("restore rendered", () => init.git.restoreWorktree(init.outputRel));
        attempt("remove new rendered files", () => {
          if (!outputExisted) {
            rmSync(init.outputRoot, { recursive: true, force: true });
            return;
          }
          for (const rel of init.git.untrackedPaths(init.outputRel)) {
            if (!init.untrackedBefore.has(rel)) rmSync(join(init.git.repoRoot, rel), { force: true });
          }
        });
      }
      if (failed.length > 0) {
        const why = cause === undefined ? "" : ` after: ${stripControl((cause as Error)?.message ?? String(cause))}`;
        throw new ProposalToolError(
          "restore",
          `could not restore the estate repository (${failed.join("; ")})${why}; inspect 'git status' and restore by hand`,
        );
      }
    },
  };
  return rb;
}
