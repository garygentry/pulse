// packages/web-data/src/contract/push.ts — push-gateway contract constants: pairing-token, credential, device-id,
// APNs-token and display-name grammars, the bearer header form, the capability name and the category list.
// Browser-safe leaf module; its only import is type-only.

import type { PushCategory } from "../wire/push.js";

/** Connect-link parameter that carries a pairing token. */
export const PAIR_LINK_PARAM = "pair" as const;
/** Pairing token: 16 random bytes as unpadded base64url. */
export const PAIR_TOKEN_PATTERN: RegExp = /^[A-Za-z0-9_-]{22}$/;
/** Device credential: 32 random bytes as unpadded base64url. */
export const DEVICE_CREDENTIAL_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;
/** Device id: `dev_` + 8 random bytes as unpadded base64url. */
export const DEVICE_ID_PATTERN: RegExp = /^dev_[A-Za-z0-9_-]{11}$/;
/** Lowercase hex APNs device token, after the server lowercases input. */
export const APNS_TOKEN_PATTERN: RegExp = /^[0-9a-f]{64,200}$/;
/** Display-name charset. The length (1–64 UTF-8 bytes after trim) is checked separately. */
export const DISPLAY_NAME_PATTERN: RegExp = /^[\p{L}\p{N} '’.\-_()#]+$/u;
/** Device-credential Authorization header, exactly. */
export const BEARER_CREDENTIAL_PATTERN: RegExp = /^Bearer [A-Za-z0-9_-]{43}$/;
/** Capability name advertised while push is available. */
export const PUSH_CAPABILITY = "push" as const;
/** All notification categories, in contract order. */
export const PUSH_CATEGORIES: readonly PushCategory[] = Object.freeze([
  "PULSE_ALERT_FIRING", "PULSE_ALERT_RESOLVED", "PULSE_ALERT_SUMMARY", "PULSE_TEST",
] as const);
