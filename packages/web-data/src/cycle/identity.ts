// packages/web-data/src/cycle/identity.ts — per-view semantic identity and representation
// materialization (04-cycle-and-current-view-folds.md §5). Given the prior materialized
// payload, the freshly folded value, and the semantic material (the value with
// observation-only metadata excluded), this decides whether the representation may be
// reused or must be rebuilt, and classifies every construction failure as data. No
// expected failure rejects; the composing cycle (item 039) aggregates results.

import { canonicalJson, deterministicGzip, sha256Id } from "../canonical.js";
import {
  CURRENT_MAX_GZIP_BYTES,
  CURRENT_MAX_PLAIN_BYTES,
  ERROR_MESSAGES,
} from "../wire/common.js";
import type { HashId, ViewId } from "../wire/common.js";
import type {
  CycleBuildFailure,
  CycleBuildFailureKind,
  EncodedRepresentation,
  MaterializedPayload,
} from "./types.js";

/** Outcome of materializing one view: the reused/rebuilt payload, or a classified failure. */
export type ViewMaterializationResult<T> =
  | {
      /** Success discriminator. */ readonly ok: true;
      /** Reused prior payload or a freshly materialized one. */ readonly payload: MaterializedPayload<T>;
    }
  | {
      /** Failure discriminator. */ readonly ok: false;
      /** Classified safe construction failure for this view. */ readonly error: CycleBuildFailure;
    };

/** Deep-freeze retained roots only in development/tests; production freezes the root alone. */
const DEEP_FREEZE = detectDeepFreeze();

function detectDeepFreeze(): boolean {
  const env = typeof process !== "undefined" ? process.env.NODE_ENV : undefined;
  return env !== "production";
}

function failure<T>(view: ViewId, kind: CycleBuildFailureKind): ViewMaterializationResult<T> {
  return { ok: false, error: { kind, view, message: ERROR_MESSAGES.CYCLE_BUILD_FAILED } };
}

/** Recursively freeze a canonicalizable (already acyclic) value; frozen roots are skipped. */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
}

/**
 * Materialize one current view. `semanticMaterial` is the value stripped of observation
 * sequence/time and successful-attempt timestamps; when its canonical identity matches the
 * prior view, the previous payload (object, bytes, `generatedAt`, identity, and both ETags)
 * is reused verbatim. Otherwise the fresh `value` is encoded to canonical plain and
 * deterministic gzip bytes with independent strong SHA-256 ETags. Canonicalization, hash,
 * compression, and 5 MiB plain / 1 MiB gzip limit failures are returned as classified
 * `CycleBuildFailure` data rather than thrown.
 */
export async function materializeView<T>(
  view: ViewId,
  previous: MaterializedPayload<T> | null,
  value: T,
  semanticMaterial: unknown,
): Promise<ViewMaterializationResult<T>> {
  let semanticBytes: Uint8Array;
  try {
    semanticBytes = canonicalJson(semanticMaterial);
  } catch {
    return failure<T>(view, "canonicalization");
  }

  let identity: HashId;
  try {
    identity = await sha256Id(semanticBytes);
  } catch {
    return failure<T>(view, "hash");
  }

  // Sequence-only / success-timestamp-only cycles keep an identical semantic identity and
  // reuse every prior artifact, so no re-encoding, re-hashing, or re-compression occurs.
  if (previous !== null && previous.identity === identity) {
    return { ok: true, payload: previous };
  }

  let plainBytes: Uint8Array;
  try {
    plainBytes = canonicalJson(value);
  } catch {
    return failure<T>(view, "canonicalization");
  }
  if (plainBytes.byteLength > CURRENT_MAX_PLAIN_BYTES) {
    return failure<T>(view, "payload-limit");
  }

  let plainEtag: HashId;
  try {
    plainEtag = await sha256Id(plainBytes);
  } catch {
    return failure<T>(view, "hash");
  }

  let gzipBytes: Uint8Array;
  try {
    gzipBytes = await deterministicGzip(plainBytes);
  } catch {
    return failure<T>(view, "compression");
  }
  if (gzipBytes.byteLength > CURRENT_MAX_GZIP_BYTES) {
    return failure<T>(view, "payload-limit");
  }

  let gzipEtag: HashId;
  try {
    gzipEtag = await sha256Id(gzipBytes);
  } catch {
    return failure<T>(view, "hash");
  }

  if (DEEP_FREEZE) deepFreeze(value);
  else Object.freeze(value);

  const plain: EncodedRepresentation = { etag: plainEtag, bytes: plainBytes };
  const gzip: EncodedRepresentation = { etag: gzipEtag, bytes: gzipBytes };
  return { ok: true, payload: { identity, value, plain, gzip } };
}
