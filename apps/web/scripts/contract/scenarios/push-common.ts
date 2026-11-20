// Public-safe placeholder values shared by the push fixture modules and the connect-link pairing row.

/** The first pairing token a fresh, zero-seeded fixture runtime draws: 16 zero bytes as base64url. */
export const PAIR_TOKEN_PLACEHOLDER = "AAAAAAAAAAAAAAAAAAAAAA";
/** An APNs device token: 64 lower-case hex characters. */
export const APNS_TOKEN_PLACEHOLDER = "0123456789abcdef".repeat(4);
/** A device display name. */
export const DISPLAY_NAME_PLACEHOLDER = "Example iPhone";
/** Alertmanager fingerprint number `n`: 16 lower-case hex characters. */
export const FINGERPRINT = (n: number): string => n.toString(16).padStart(16, "0");
