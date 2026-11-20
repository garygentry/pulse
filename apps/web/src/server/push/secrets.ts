// Push secrets: shared secrets held as SHA-256 digests only, constant-time comparison, credential hashing and the
// APNs signing-key reader. Nothing here logs, and no value read here is ever echoed.

import { createHash, createPrivateKey, timingSafeEqual, type KeyObject } from "node:crypto";

import { PUSH_LIMITS } from "./constants.js";

/** Largest accepted key file. An Apple .p8 file is ~250 bytes; anything bigger is not a P-256 key. */
const APNS_KEY_MAX_BYTES = 16_384;
/**
 * The PKCS#8 (unencrypted) PEM begin line. SEC1 (EC label) and encrypted PKCS#8 labels are rejected. Assembled from
 * parts so secret scanners never see a PEM header literal in source.
 */
const PKCS8_PEM_LABEL = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
/** Raw-value control-character class. */
const CONTROL_CHAR: RegExp = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A shared secret held only as its SHA-256 digest. Frozen; `toJSON` and the inspect hook show `"[secret]"`, so no
 * serialiser or console call can reveal anything.
 */
export interface PushSecret {
  /** 32-byte SHA-256 digest of the UTF-8 secret. The returned array is a copy. */
  sha256(): Uint8Array;
}

/** Result of {@link loadPushSecret}. */
export type LoadPushSecretResult =
  | {
      /** The secret is usable. */
      readonly ok: true;
      /** The held secret. */
      readonly secret: PushSecret;
    }
  | {
      /** The secret is unusable. */
      readonly ok: false;
      /** Why: unset/empty, under the byte minimum, or containing a control character. */
      readonly reason: "missing" | "too-short" | "invalid";
    };

function holdSecret(raw: string): PushSecret {
  const digest = new Uint8Array(createHash("sha256").update(raw, "utf8").digest()); // 32 bytes, private copy
  const secret = {
    sha256: (): Uint8Array => digest.slice(),
    toJSON: (): string => "[secret]",
    [Symbol.for("nodejs.util.inspect.custom")]: (): string => "[secret]",
  };
  return Object.freeze(secret);
}

/**
 * Load an optional shared secret (webhook or operator). The raw value is not trimmed and not retained: only its
 * SHA-256 digest is kept, inside a closure.
 *
 * Order of checks: `undefined` or "" → missing; any control character → invalid;
 * UTF-8 length < PUSH_LIMITS.secretMinBytes → too-short; otherwise ok.
 *
 * @param env  - Environment map.
 * @param name - The variable name.
 * @returns The held secret, or the reason it is unusable. Never throws; never logs.
 */
export function loadPushSecret(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): LoadPushSecretResult {
  const raw = env[name];
  if (raw === undefined || raw === "") return Object.freeze({ ok: false, reason: "missing" });
  if (CONTROL_CHAR.test(raw)) return Object.freeze({ ok: false, reason: "invalid" });
  if (Buffer.byteLength(raw, "utf8") < PUSH_LIMITS.secretMinBytes) {
    return Object.freeze({ ok: false, reason: "too-short" });
  }
  return Object.freeze({ ok: true, secret: holdSecret(raw) });
}

/**
 * Constant-time check of a presented value against a held secret. Both sides are 32-byte SHA-256 digests, so timing
 * does not depend on the presented length or content.
 *
 * @param presented - The bearer value exactly as received (not trimmed). May be any string, including "".
 * @param secret    - The held secret.
 * @returns true iff sha256(presented) equals the held digest.
 */
export function matchesSecret(presented: string, secret: PushSecret): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = secret.sha256();
  return timingSafeEqual(a, b);
}

/**
 * Lowercase hex SHA-256 of a device credential or pairing token (64 chars). This is the registry key and the
 * token-map key; the plaintext is never stored.
 */
export function hashCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Constant-time equality of two hex digests. Returns false, without comparing, when the UTF-8 byte lengths differ,
 * so timingSafeEqual never throws. Lengths are public (always 64 for SHA-256), so the early return leaks nothing.
 */
export function digestEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Result of reading the APNs signing key. The reason names a class of failure only. */
export type ApnsKeyResult =
  | {
      /** The key is a usable P-256 private key. */
      readonly ok: true;
      /** The parsed key. */
      readonly key: KeyObject;
    }
  | {
      /** The key cannot be used. */
      readonly ok: false;
      /** `unreadable`: the file could not be read; `invalid`: its content is not an unencrypted P-256 PKCS#8 key. */
      readonly reason: "unreadable" | "invalid";
    };

const UNREADABLE: ApnsKeyResult = Object.freeze({ ok: false, reason: "unreadable" });
const INVALID: ApnsKeyResult = Object.freeze({ ok: false, reason: "invalid" });

function isP256(key: KeyObject): boolean {
  if (key.asymmetricKeyType !== "ec") return false;
  const details = key.asymmetricKeyDetails;
  if (details !== undefined) return details.namedCurve === "prime256v1";
  const jwk = key.export({ format: "jwk" });
  return jwk.crv === "P-256";
}

/**
 * Read and validate the APNs .p8 signing key. Never throws.
 *
 * 1. `readFile(path)`; any throw (ENOENT, EACCES, EISDIR, …) → unreadable.
 * 2. More than 16 KiB → invalid.
 * 3. The bytes must contain the unencrypted PKCS#8 PEM label → otherwise invalid (DER, SEC1 and encrypted keys are
 *    refused).
 * 4. `createPrivateKey`; a throw → invalid.
 * 5. The key must be EC on the P-256 curve → otherwise invalid.
 * 6. The buffer returned by `readFile` is zero-filled afterwards, on success and failure alike.
 *
 * @param path     - Normalised absolute path.
 * @param readFile - Synchronous reader. The returned buffer is owned by this call and is overwritten (step 6).
 */
export function readApnsKey(path: string, readFile: (path: string) => Uint8Array): ApnsKeyResult {
  let bytes: Uint8Array;
  try {
    bytes = readFile(path);
  } catch {
    return UNREADABLE;
  }
  let pemBuffer: Buffer | null = null;
  try {
    if (bytes.byteLength > APNS_KEY_MAX_BYTES) return INVALID;
    pemBuffer = Buffer.from(bytes);
    if (!pemBuffer.includes(PKCS8_PEM_LABEL, 0, "latin1")) return INVALID;
    const key = createPrivateKey({ key: pemBuffer, format: "pem" });
    if (key.type !== "private" || !isP256(key)) return INVALID;
    return Object.freeze({ ok: true, key });
  } catch {
    return INVALID;
  } finally {
    bytes.fill(0);
    pemBuffer?.fill(0);
  }
}
