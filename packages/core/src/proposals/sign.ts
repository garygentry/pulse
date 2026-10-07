/** `@pulse/core/proposals/sign` — node-only HMAC signing and verification of proposal files.
 *  Imports `node:crypto`, so it is never re-exported by the browser-safe `index.ts` barrel. The `secret`
 *  parameter is always the UTF-8 encoding of PULSE_PROPOSAL_SECRET; it is never stored, returned,
 *  stringified or put in an error message (SEC-04). */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalProposalJson } from "./canonical.js";
import { PROPOSAL_SECRET_MIN_BYTES } from "./constants.js";
import { proposalFileSchema, proposalPayloadSchema, SIGNATURE_VALUE_RE } from "./schema.js";
import type { ProposalFileV1, ProposalPayload } from "./schema.js";

/** Thrown only by signProposal for a short secret. Carries the length, never the bytes. */
export class ProposalSecretError extends Error {
  readonly code = "PROPOSAL_SECRET_TOO_SHORT" as const;
  /** Actual byte length (never the bytes). */
  readonly length: number;
  constructor(length: number) {
    super(`proposal secret must be at least ${PROPOSAL_SECRET_MIN_BYTES} bytes (got ${length})`);
    this.name = "ProposalSecretError";
    this.length = length;
  }
}

/** Why verification failed. */
export type VerifyFailure = "unparseable" | "schema" | "alg" | "signature";
/** The verified proposal file, or why verification failed. */
export type VerifyResult = { readonly ok: true; readonly file: ProposalFileV1 } | { readonly ok: false; readonly reason: VerifyFailure };

/** The exact signed bytes: canonical JSON of `{format, payload}` (format is inside the MAC). */
function signedBytes(payload: ProposalPayload): string {
  return canonicalProposalJson({ format: "pulse-proposal/v1", payload });
}
function mac(secret: Uint8Array, payload: ProposalPayload): Buffer {
  return createHmac("sha256", secret).update(signedBytes(payload), "utf8").digest();
}

/**
 * Sign a payload.
 * @param secret - UTF-8 bytes of PULSE_PROPOSAL_SECRET.
 * @throws ProposalSecretError when `secret.byteLength < PROPOSAL_SECRET_MIN_BYTES`.
 * @throws TypeError when `payload` fails `proposalPayloadSchema` (only valid payloads are ever signed).
 */
export function signProposal(payload: ProposalPayload, secret: Uint8Array): ProposalFileV1 {
  if (secret.byteLength < PROPOSAL_SECRET_MIN_BYTES) throw new ProposalSecretError(secret.byteLength);
  const parsed = proposalPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new TypeError("refusing to sign an invalid proposal payload");
  return {
    format: "pulse-proposal/v1",
    payload: parsed.data,
    signature: { alg: "HMAC-SHA256", value: mac(secret, parsed.data).toString("base64url") },
  };
}

/** Envelope pre-check so a wrong `alg` is distinguishable from other schema failures. */
const envelopeSchema = z.object({
  format: z.literal("pulse-proposal/v1"),
  payload: z.unknown(),
  signature: z.object({ alg: z.string(), value: z.string() }).strict(),
}).strict();

/**
 * Constant-time verification. **Never throws.**
 * Order: (1) a `string`/`Uint8Array` input is JSON-parsed (failure, incl. invalid UTF-8 → `unparseable`);
 * (2) envelope shape → `schema`; (3) `alg !== "HMAC-SHA256"` → `alg`; (4) full `proposalFileSchema` →
 * `schema`; (5) secret shorter than the minimum, value not 43-char base64url, decoded length ≠ 32, or
 * `timingSafeEqual` false → `signature`.
 */
export function verifyProposal(file: unknown, secret: Uint8Array): VerifyResult {
  try {
    let raw: unknown = file;
    if (typeof file === "string" || file instanceof Uint8Array) {
      try { raw = JSON.parse(typeof file === "string" ? file : new TextDecoder("utf-8", { fatal: true }).decode(file)); }
      catch { return { ok: false, reason: "unparseable" }; }
    }
    const env = envelopeSchema.safeParse(raw);
    if (!env.success) return { ok: false, reason: "schema" };
    if (env.data.signature.alg !== "HMAC-SHA256") return { ok: false, reason: "alg" };
    const full = proposalFileSchema.safeParse(raw);
    if (!full.success) return { ok: false, reason: "schema" };
    if (secret.byteLength < PROPOSAL_SECRET_MIN_BYTES || !SIGNATURE_VALUE_RE.test(full.data.signature.value)) {
      return { ok: false, reason: "signature" };
    }
    const provided = Buffer.from(full.data.signature.value, "base64url");
    const expected = mac(secret, full.data.payload);
    if (provided.length !== expected.length) return { ok: false, reason: "signature" };
    return timingSafeEqual(provided, expected) ? { ok: true, file: full.data } : { ok: false, reason: "signature" };
  } catch {
    return { ok: false, reason: "signature" }; // defensive: canonicalization of parsed JSON cannot throw
  }
}
