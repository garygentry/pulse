// apps/web/src/server/mutations/stores/proposal-store.ts — signed estate-edit proposal files
// (REQ-PROP-01/05/06, REQ-SEC-04/05/07).
//
// The web app's ONLY estate-related write: `<proposalsDir>/<id>.proposal.json`, created exclusively
// (never overwritten). It never writes `.result.json` sidecars — the CLI does. The proposal secret is
// read through `SecretProvider.bytes()` on each call and passed straight to sign/verify; it is never
// held in store state, logged, or returned (REQ-SEC-04).

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseProposalFileName,
  proposalFileName,
  resultFileName,
  proposalResultSchema,
  PROPOSAL_FILE_MAX_BYTES,
  type ProposalPayload,
  type ProposalFileV1,
  type ProposalState,
} from "@pulse/core/proposals";
import { signProposal, verifyProposal } from "@pulse/core/proposals/sign";
import { writeFileAtomic } from "./atomic-file.js";
import { PROPOSAL_LIST_MAX } from "../constants.js";
import type { WritePath } from "../write-path.js";
import type { SecretProvider } from "../../config.js";
import type { StoreWriteResult } from "./ack-store.js";
import type { ProposalListBody, ProposalView } from "../../../shared/mutations.js";

/** The proposal store. */
export interface ProposalStore {
  /** Sign + write <id>.proposal.json atomically with O_EXCL. */
  write(payload: ProposalPayload): Promise<StoreWriteResult<ProposalFileV1>>;
  /** Verified proposals for one target plus the invalid count. */
  listFor(kind: "host" | "service", drilldownId: string): Promise<ProposalListBody>;
}

const DISABLED: ProposalListBody = Object.freeze({ enabled: false, proposals: Object.freeze([]), invalidCount: 0 });

/** Sidecar-derived state for one proposal; `invalid` marks an unreadable sidecar (counted and not shown, like the CLI). */
interface SidecarState {
  readonly state: ProposalState;
  readonly reason: string | null;
  readonly commit: string | null;
  readonly invalid: boolean;
}

const PENDING: SidecarState = { state: "pending", reason: null, commit: null, invalid: false };
const PENDING_INVALID: SidecarState = { state: "pending", reason: null, commit: null, invalid: true };

function errnoOf(e: unknown): string | null {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : null;
}

/** Read a regular file of at most PROPOSAL_FILE_MAX_BYTES; null for a symlink, non-regular or oversize file. Rejects on I/O errors. */
async function readBounded(path: string): Promise<Uint8Array | null> {
  const st = await lstat(path);
  if (!st.isFile() || st.size > PROPOSAL_FILE_MAX_BYTES) return null;
  const bytes = await readFile(path);
  return bytes.byteLength > PROPOSAL_FILE_MAX_BYTES ? null : new Uint8Array(bytes);
}

/** Sidecar result state: ENOENT → pending; a valid sidecar for this id → applied/rejected; anything else → invalid. */
async function readSidecar(dir: string, id: string): Promise<SidecarState> {
  try {
    const bytes = await readBounded(join(dir, resultFileName(id)));
    if (bytes === null) return PENDING_INVALID;
    const parsed = proposalResultSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!parsed.success || parsed.data.id !== id) return PENDING_INVALID;
    const r = parsed.data;
    return r.state === "applied"
      ? { state: "applied", reason: null, commit: r.commit, invalid: false }
      : { state: "rejected", reason: r.reason, commit: null, invalid: false };
  } catch (e) {
    return errnoOf(e) === "ENOENT" ? PENDING : PENDING_INVALID;
  }
}

/**
 * Create the proposal store. `dir` is WritePathConfig.proposalsDir (absolute). `secret.bytes()` returns
 * the UTF-8 bytes of PULSE_PROPOSAL_SECRET. It is read on each call and never copied into store state, a
 * log, or a return value (REQ-SEC-04).
 */
export function createProposalStore(dir: string, secret: SecretProvider, deps: { readonly writePath: WritePath }): ProposalStore {
  return {
    async write(payload) {
      const key = secret.bytes();
      // Secret slot already degraded (the capability gate normally prevents this): not a store fault.
      if (key === null) return { ok: false, error: "write-failed" };
      // ProposalSecretError / TypeError propagate as programming faults (dispatcher → internal).
      const file = signProposal(payload, key);
      const path = join(dir, proposalFileName(payload.id));
      const bytes = new TextEncoder().encode(JSON.stringify(file, null, 2) + "\n");
      const written = await writeFileAtomic(path, bytes, { exclusive: true });
      if (written.ok) return { ok: true, value: file };
      // An id collision (same second + same 32 random bits) is not a health fault.
      if (written.kind !== "exists") deps.writePath.markFailed("proposals", "write-failed");
      return { ok: false, error: "write-failed" };
    },

    async listFor(kind, drilldownId) {
      try {
        const key = secret.bytes();
        if (key === null) return DISABLED;
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          return DISABLED; // reads never markFailed; probe() owns store health
        }
        names.sort();
        let invalidCount = 0;
        const matched: ProposalFileV1[] = [];
        for (const name of names) {
          const id = parseProposalFileName(name);
          if (id === null) continue; // not a proposal file: ignored, not counted
          try {
            const bytes = await readBounded(join(dir, name));
            if (bytes === null) {
              invalidCount++;
              continue;
            }
            const v = verifyProposal(bytes, key);
            if (!v.ok || v.file.payload.id !== id) {
              invalidCount++; // forged, tampered, or renamed
              continue;
            }
            const t = v.file.payload.target;
            if (t.kind === kind && t.id === drilldownId) matched.push(v.file);
          } catch {
            invalidCount++;
          }
        }
        const views: ProposalView[] = [];
        for (const file of matched) {
          const p = file.payload;
          const side = await readSidecar(dir, p.id);
          if (side.invalid) {
            // The decision is unknown, so the proposal is not shown as pending. The CLI also lists it as invalid (result-invalid).
            invalidCount++;
            continue;
          }
          views.push({
            id: p.id,
            createdAt: p.createdAt,
            proposer: p.proposer.displayName, // subject is never served
            changes: p.changes,
            rationale: p.rationale,
            state: side.state,
            reason: side.reason,
            commit: side.commit,
          });
        }
        views.sort((a, b) =>
          a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
        );
        return { enabled: true, proposals: views.slice(0, PROPOSAL_LIST_MAX), invalidCount };
      } catch {
        return DISABLED; // listFor never throws
      }
    },
  };
}

// ── Provider accessor (installed by bootstrap in proxy-header mode only) ────────────────────────────

let installed: ProposalStore | null = null;
/** Install the process's store (bootstrap) or clear it. */
export function setProposalStoreProvider(store: ProposalStore | null): void {
  installed = store;
}
/** Test seam: restore the default (null). Call in afterEach of any suite that installs a store. */
export function resetProposalStoreProvider(): void {
  installed = null;
}
/** The installed store, or null (auth mode none, or not bootstrapped). */
export function currentProposalStore(): ProposalStore | null {
  return installed;
}
