// Push request schemas. Every schema is strict (unknown keys are refused and reported as `$`), every string is
// bounded, and each is typed ZodType<Out, ZodTypeDef, unknown> so it fits parseStrictBody.

import { z, type ZodType, type ZodTypeDef } from "zod";
import { APNS_TOKEN_PATTERN, CONTRACT_LIMITS, DEVICE_ID_PATTERN, DISPLAY_NAME_PATTERN } from "@pulse/web-data/contract";
import type { DeviceRegistrationRequest, PairingRedeemRequest, PushPreferences } from "@pulse/web-data/wire";

const UTF8 = new TextEncoder();
/** UTF-8 byte length. */
export const utf8Bytes = (s: string): number => UTF8.encode(s).byteLength;

/** Upper bound on the raw `token` string. The redeem handler applies the pairing-token pattern. */
export const REDEEM_TOKEN_MAX_BYTES = 64;
/**
 * Upper bound on the admin `baseUrl` before normalisation. A base too long to fit in a link still reaches the
 * handler's 409 address-too-long.
 */
export const ADMIN_BASE_URL_MAX_BYTES = 2048;

/**
 * Display name: String.prototype.trim(), then 1..64 UTF-8 bytes, then DISPLAY_NAME_PATTERN. The OUTPUT is the trimmed
 * string, and that is what the handler stores and logs. No Unicode normalisation is applied.
 */
export const displayNameSchema: ZodType<string, ZodTypeDef, unknown> = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => {
    const n = utf8Bytes(s);
    return n >= 1 && n <= CONTRACT_LIMITS.push.displayNameBytes;
  })
  .refine((s) => DISPLAY_NAME_PATTERN.test(s));

/** Body of POST /api/push/pairings/redeem. */
export const pairingRedeemRequestSchema: ZodType<PairingRedeemRequest, ZodTypeDef, unknown> = z
  .object({
    token: z.string().refine((s) => utf8Bytes(s) <= REDEEM_TOKEN_MAX_BYTES),
    displayName: displayNameSchema,
  })
  .strict();

const preferencesSchema: ZodType<PushPreferences, ZodTypeDef, unknown> = z
  .object({ critical: z.boolean(), warning: z.boolean(), info: z.boolean() })
  .strict();

/**
 * Body of PUT /api/push/device.
 * - apnsToken: at most 200 characters, lowercased, then checked against APNS_TOKEN_PATTERN. The output is the
 *   lowercased token.
 * - environment: exactly "sandbox" | "production".
 * - preferences: strict, with all three fields required.
 */
export const deviceRegistrationRequestSchema: ZodType<DeviceRegistrationRequest, ZodTypeDef, unknown> = z
  .object({
    apnsToken: z
      .string()
      .max(CONTRACT_LIMITS.push.apnsTokenMaxChars)
      .transform((s) => s.toLowerCase())
      .refine((s) => APNS_TOKEN_PATTERN.test(s)),
    environment: z.enum(["sandbox", "production"]),
    preferences: preferencesSchema,
  })
  .strict();

/** Body of POST /api/push/admin/pairing-tokens. Not a contract type. */
export interface AdminPairingRequest {
  /** The URL the CLI used. The handler normalises it before use. */
  readonly baseUrl?: string | undefined;
}
/** Schema of {@link AdminPairingRequest}. */
export const adminPairingRequestSchema: ZodType<AdminPairingRequest, ZodTypeDef, unknown> = z
  .object({ baseUrl: z.string().min(1).refine((s) => utf8Bytes(s) <= ADMIN_BASE_URL_MAX_BYTES).optional() })
  .strict();

/** Body of POST /api/push/admin/test. An absent `deviceId` means every registered device. */
export interface AdminTestRequest {
  /** The device to test, or absent for all. */
  readonly deviceId?: string | undefined;
}
/** Schema of {@link AdminTestRequest}. */
export const adminTestRequestSchema: ZodType<AdminTestRequest, ZodTypeDef, unknown> = z
  .object({ deviceId: z.string().regex(DEVICE_ID_PATTERN).optional() })
  .strict();
