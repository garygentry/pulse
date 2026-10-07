// apps/cli/src/commands/proposals/dir.ts — read-only proposals-directory access plus the sidecar
// writer (REQ-PROP-11, REQ-SEC-05). The directory may live anywhere (inside or outside the
// git repo); every proposal is signature-verified before any of its content is used.

import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  PROPOSAL_FILE_MAX_BYTES,
  PROPOSAL_ID_RE,
  proposalFileName,
  proposalResultSchema,
  resultFileName,
} from "@pulse/core/proposals";
import type { ProposalFileV1, ProposalResultV1, ProposalState } from "@pulse/core/proposals";
import { verifyProposal } from "@pulse/core/proposals/sign";

import { ProposalToolError } from "./git.js";
import type { InvalidReason, ProposalSummary } from "./types.js";

// PROPOSAL_FILE_MAX_BYTES (core constants.ts): larger proposal/result files are "unparseable".

export type { InvalidReason } from "./types.js";

/** A proposal whose signature verified, joined with its sidecar. */
export interface VerifiedProposal {
  /** Proposal id (equals the file-name id and the signed payload id). */
  readonly id: string;
  /** The verified signed file. */
  readonly file: ProposalFileV1;
  /** The sidecar, or null when undecided. */
  readonly result: ProposalResultV1 | null;
  /** Derived state: the sidecar's state, else "pending". */
  readonly state: ProposalState;
}

/** A proposal file that failed to parse or verify. */
export interface InvalidProposal {
  /** File name within the proposals directory. */
  readonly file: string;
  /** Why it was rejected. */
  readonly reason: InvalidReason;
}

/** The result of listing a proposals directory. */
export interface ProposalDirListing {
  /** Newest first (createdAt desc, then id desc). */
  readonly proposals: readonly VerifiedProposal[];
  /** Sorted by file name. */
  readonly invalid: readonly InvalidProposal[];
}

/** Outcome of reading one proposal by id. */
export type ReadOne =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: InvalidReason }
  | { readonly kind: "ok"; readonly proposal: VerifiedProposal };

/** Outcome of reading one sidecar. */
export type ReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly result: ProposalResultV1 };

/**
 * List a proposals directory. Only files whose name is exactly `proposalFileName(id)` for an id
 * matching PROPOSAL_ID_RE are considered; sidecars, temp files and everything else are ignored.
 * Each candidate is verified (verifyProposal never throws) and joined with its sidecar.
 *
 * @throws {ProposalToolError} "io" when the directory cannot be listed.
 */
export function readProposalDir(dir: string, secret: Uint8Array): ProposalDirListing {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    throw new ProposalToolError("io", `cannot list proposals directory ${dir}: ${(err as Error).message}`);
  }
  const proposals: VerifiedProposal[] = [];
  const invalid: InvalidProposal[] = [];
  for (const name of names) {
    const id = idFromProposalFileName(name);
    if (id === null) continue;
    const one = readProposal(dir, id, secret);
    if (one.kind === "ok") proposals.push(one.proposal);
    else if (one.kind === "invalid") invalid.push({ file: name, reason: one.reason });
  }
  proposals.sort((a, b) =>
    a.file.payload.createdAt === b.file.payload.createdAt
      ? a.id < b.id
        ? 1
        : -1
      : a.file.payload.createdAt < b.file.payload.createdAt
        ? 1
        : -1,
  );
  return { proposals, invalid };
}

/** `<id>.proposal.json` → id, or null for any other name. */
export function idFromProposalFileName(name: string): string | null {
  const suffix = ".proposal.json";
  if (!name.endsWith(suffix)) return null;
  const id = name.slice(0, -suffix.length);
  return PROPOSAL_ID_RE.test(id) && proposalFileName(id) === name ? id : null;
}

/** Read + verify ONE proposal by validated id, joined with its sidecar. */
export function readProposal(dir: string, id: string, secret: Uint8Array): ReadOne {
  const text = readBounded(join(dir, proposalFileName(id)));
  if (text === "absent") return { kind: "absent" };
  if (text === "not-a-file") return { kind: "invalid", reason: "not-a-file" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "unparseable" };
  }
  const v = verifyProposal(parsed, secret); // constant-time; never throws
  if (!v.ok) return { kind: "invalid", reason: v.reason };
  if (v.file.payload.id !== id) return { kind: "invalid", reason: "id-mismatch" };
  const r = readResult(dir, id);
  if (r.kind === "invalid") return { kind: "invalid", reason: "result-invalid" };
  const result = r.kind === "ok" ? r.result : null;
  return {
    kind: "ok",
    proposal: { id, file: v.file, result, state: result === null ? "pending" : result.state },
  };
}

/** Read `<id>.result.json` (unsigned; the directory is the trust boundary). */
export function readResult(dir: string, id: string): ReadResult {
  const text = readBounded(join(dir, resultFileName(id)));
  if (text === "absent") return { kind: "absent" };
  if (text === "not-a-file") return { kind: "invalid" };
  try {
    const p = proposalResultSchema.safeParse(JSON.parse(text));
    return p.success && p.data.id === id ? { kind: "ok", result: p.data as ProposalResultV1 } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * Write the sidecar atomically: temp file (O_EXCL) → fsync → rename → dir fsync. The temp name
 * (`.<id>.result.json.tmp-<hex>`) never matches the proposal-file pattern, so readers ignore it.
 *
 * @throws {ProposalToolError} "io".
 */
export function writeResultFile(dir: string, result: ProposalResultV1): void {
  const final = join(dir, resultFileName(result.id));
  const tmp = join(dir, `.${resultFileName(result.id)}.tmp-${randomBytes(4).toString("hex")}`);
  try {
    const fd = openSync(tmp, "wx", 0o644);
    try {
      writeSync(fd, JSON.stringify(result, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, final);
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already renamed or never created */
    }
    throw new ProposalToolError("io", `cannot write ${resultFileName(result.id)}: ${(err as Error).message}`);
  }
}

/** Project a verified proposal onto the envelope summary. */
export function toSummary(p: VerifiedProposal): ProposalSummary {
  const pl = p.file.payload;
  return {
    id: p.id,
    createdAt: pl.createdAt,
    proposer: pl.proposer.displayName,
    target: pl.target,
    fields: pl.changes.map((c) => c.field),
    state: p.state,
  };
}

/** lstat-guarded bounded read: symlinks and non-regular files are "not-a-file". */
function readBounded(path: string): string | "absent" | "not-a-file" {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "absent";
  }
  if (!st.isFile()) return "not-a-file";
  if (st.size > PROPOSAL_FILE_MAX_BYTES) return "{"; // forces "unparseable"
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new ProposalToolError("io", `cannot read ${path}: ${(err as Error).message}`);
  }
}
