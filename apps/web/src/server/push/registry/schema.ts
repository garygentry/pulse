// Device registry data model: the persisted record, the on-disk file and its strict schema.

import { z, type ZodType, type ZodTypeDef } from "zod";
import type { LastDelivery, PushEnvironment, PushPreferences } from "@pulse/web-data/wire";
import {
  APNS_TOKEN_PATTERN,
  CONTRACT_LIMITS,
  DEVICE_ID_PATTERN,
  DISPLAY_NAME_PATTERN,
} from "@pulse/web-data/contract";

/** One persisted device. `credentialHash` is the only credential-derived value stored. */
export interface DeviceRecord {
  /** Device id (`DEVICE_ID_PATTERN`). */
  readonly id: string;
  /** Name given at redemption (`DISPLAY_NAME_PATTERN`, 1–64 UTF-8 bytes). */
  readonly displayName: string;
  /** Lowercase hex sha256(credential). */
  readonly credentialHash: string;
  /** Lowercase hex APNs token; `null` until the first registration. */
  readonly apnsToken: string | null;
  /** APNs environment; `null` until the first registration. */
  readonly environment: PushEnvironment | null;
  /** Per-severity switches (all `true` until the first registration sets them). */
  readonly preferences: PushPreferences;
  /** ISO-8601 UTC instant of redemption. */
  readonly pairedAt: string;
  /** ISO-8601 UTC instant the device was last seen (a soft field). */
  readonly seenAt: string;
  /** Most recent delivery attempt (a soft field); `null` when none yet. */
  readonly lastDelivery: LastDelivery | null;
}

/** On-disk file `<dataDir>/push/devices.json`, mode 0600. */
export interface DevicesFile {
  /** On-disk format version; always 1. */
  readonly formatVersion: 1;
  /** Every paired device. */
  readonly devices: readonly DeviceRecord[];
}

/** Why a device left the registry (log field and metric event source). */
export type DeviceRemovalReason = "revoked" | "self" | "expired" | "dead-token" | "superseded";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ENCODER = new TextEncoder();
/** Longest accepted ISO-8601 instant string (bounded so a corrupt file cannot hold huge strings). */
const INSTANT_MAX_CHARS = 64;
/** Longest accepted delivery reason (sanitised APNs reasons and fixed local reasons are far shorter). */
const REASON_MAX_CHARS = 64;

const instantSchema = z
  .string()
  .max(INSTANT_MAX_CHARS)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "not an ISO-8601 instant" });

const displayNameSchema = z
  .string()
  .regex(DISPLAY_NAME_PATTERN)
  .refine(
    (s) => {
      const n = ENCODER.encode(s).byteLength;
      return n >= 1 && n <= CONTRACT_LIMITS.push.displayNameBytes;
    },
    { message: "display name must be 1–64 UTF-8 bytes" },
  );

const preferencesSchema = z
  .object({ critical: z.boolean(), warning: z.boolean(), info: z.boolean() })
  .strict();

const lastDeliverySchema = z
  .object({
    outcome: z.enum(["delivered", "failed", "dropped"]),
    at: instantSchema,
    reason: z.string().max(REASON_MAX_CHARS).nullable(),
  })
  .strict();

const deviceRecordSchema = z
  .object({
    id: z.string().regex(DEVICE_ID_PATTERN),
    displayName: displayNameSchema,
    credentialHash: z.string().regex(SHA256_HEX_PATTERN),
    apnsToken: z.string().max(CONTRACT_LIMITS.push.apnsTokenMaxChars).regex(APNS_TOKEN_PATTERN).nullable(),
    environment: z.enum(["sandbox", "production"]).nullable(),
    preferences: preferencesSchema,
    pairedAt: instantSchema,
    seenAt: instantSchema,
    lastDelivery: lastDeliverySchema.nullable(),
  })
  .strict();

/** Strict schema of `devices.json`: unknown members are refused at every level. */
export const devicesFileSchema: ZodType<DevicesFile, ZodTypeDef, unknown> = z
  .object({
    formatVersion: z.literal(1),
    devices: z.array(deviceRecordSchema),
  })
  .strict();
