// packages/web-data/src/wire/push.ts — browser-safe push-gateway wire types: the client-contract request/response
// bodies, the APNs payload, and the operator/web-only push bodies shared by the server, web client and CLI.
// Types only; nothing here is evaluated at runtime.

/** APNs environment a device registered for. Sandbox = development builds, production = TestFlight/App Store. */
export type PushEnvironment = "sandbox" | "production";

/**
 * Severity carried in a payload. `unknown` is any Alertmanager `labels.severity` value other than the
 * three known ones (including a missing label). Filtering treats `unknown` as `warning`.
 */
export type PushSeverity = "critical" | "warning" | "info" | "unknown";

/** Status of the alert a notification is about. */
export type PushAlertStatus = "firing" | "resolved";

/** Payload kind. */
export type PushKind = "alert" | "summary" | "test";

/** APNs `interruption-level` values used in v1. `critical` is never used (no entitlement). */
export type PushInterruptionLevel = "passive" | "active" | "time-sensitive";

/** Notification category identifiers registered by the iOS app. */
export type PushCategory =
  | "PULSE_ALERT_FIRING"
  | "PULSE_ALERT_RESOLVED"
  | "PULSE_ALERT_SUMMARY"
  | "PULSE_TEST";

/** Per-severity notification switches. All three are required; the app's default is all `true`. */
export interface PushPreferences {
  /** Deliver `critical`-severity alerts to this device. */
  readonly critical: boolean;
  /** Deliver `warning`-severity alerts (and `unknown`, which filters as `warning`) to this device. */
  readonly warning: boolean;
  /** Deliver `info`-severity alerts to this device. */
  readonly info: boolean;
}

/** Body of `POST /api/push/pairings/redeem`. */
export interface PairingRedeemRequest {
  /** The `pair` connect-link parameter, 22 base64url characters (`PAIR_TOKEN_PATTERN`). */
  readonly token: string;
  /** 1–64 UTF-8 bytes after trimming, matching `DISPLAY_NAME_PATTERN`. */
  readonly displayName: string;
}

/** 201 response to a successful redemption. `credential` appears in no other response, ever. */
export interface PairingRedeemResponse {
  /** Non-secret device id, `dev_` + 11 base64url characters (`DEVICE_ID_PATTERN`). */
  readonly deviceId: string;
  /** Device credential, 43 base64url characters (`DEVICE_CREDENTIAL_PATTERN`). The client keeps it in the Keychain. */
  readonly credential: string;
}

/** Body of `PUT /api/push/device`. Every field is required; the request replaces all three. */
export interface DeviceRegistrationRequest {
  /** APNs device token as hex. The server lowercases it and checks it against `APNS_TOKEN_PATTERN`. */
  readonly apnsToken: string;
  /** APNs environment the token belongs to (sandbox or production). */
  readonly environment: PushEnvironment;
  /** Per-severity switches; replaces the stored set. */
  readonly preferences: PushPreferences;
}

/** 200 response to a registration or refresh. */
export interface DeviceRegistrationResponse {
  /** The calling device's id (`DEVICE_ID_PATTERN`). */
  readonly deviceId: string;
  /** APNs environment now stored for the device. */
  readonly environment: PushEnvironment;
  /** Preferences now stored for the device. */
  readonly preferences: PushPreferences;
  /** ISO-8601 UTC instant recorded as last seen. */
  readonly seenAt: string;
}

/** Deep-link target. A discriminated union on `screen`. */
export type PushTarget =
  | {
      /** Open one alert's detail screen. */
      readonly screen: "alert";
      /** Alertmanager fingerprint, 16 lowercase hex characters (`AM_FINGERPRINT_PATTERN`). */
      readonly fingerprint: string;
    }
  | {
      /** Open the alerts list. */
      readonly screen: "alerts";
    }
  | {
      /** Open the home screen. */
      readonly screen: "home";
    };

/**
 * The APNs JSON body. Serialised size ≤ `CONTRACT_LIMITS.push.payloadBytes`.
 * Per-kind presence rules (CONTRACT.md prose, pinned by fixtures):
 * - `pulse.alert` is present iff `pulse.kind === "alert"`;
 * - `pulse.summary` is present iff `pulse.kind === "summary"`;
 * - `pulse.collapseId` is `null` iff `pulse.kind === "test"`;
 * - `aps.sound` is present iff the notification is audible.
 */
export interface PushPayload {
  /** Apple-defined keys. */
  readonly aps: {
    /** Visible text of the notification. */
    readonly alert: {
      /** Title, at most `CONTRACT_LIMITS.push.titleBytes` UTF-8 bytes. */
      readonly title: string;
      /** Body, at most `CONTRACT_LIMITS.push.bodyBytes` UTF-8 bytes. */
      readonly body: string;
    };
    /** Notification category, one of `PUSH_CATEGORIES`. */
    readonly category: PushCategory;
    /** APNs interruption level for this notification. */
    readonly "interruption-level": PushInterruptionLevel;
    /** Present only on audible notifications. */
    readonly sound?: "default";
    /** Current firing-alert count. Absent when the read model is unavailable. */
    readonly badge?: number;
  };
  /** Pulse-defined keys. */
  readonly pulse: {
    /** Pulse payload format version. Always 1 in contract 1.x. */
    readonly v: 1;
    /** Payload kind; selects which of `alert`/`summary` is present. */
    readonly kind: PushKind;
    /** Equal to the `apns-collapse-id` header; `null` only for `test`. */
    readonly collapseId: string | null;
    /** Screen the app opens when the notification is tapped. */
    readonly target: PushTarget;
    /** The single alert this notification is about; absent unless `kind === "alert"`. */
    readonly alert?: {
      /** Alertmanager fingerprint, 16 lowercase hex characters. */
      readonly fingerprint: string;
      /** Whether the alert is firing or resolved. */
      readonly status: PushAlertStatus;
      /** The real severity (quiet delivery never rewrites it). */
      readonly severity: PushSeverity;
    };
    /** Group roll-up; absent unless `kind === "summary"`. */
    readonly summary?: {
      /** Group collapse key: `g-` + 16 hex characters. */
      readonly group: string;
      /** Count of firing alerts in the webhook group. */
      readonly firing: number;
      /** Count of resolved alerts in the webhook group. */
      readonly resolved: number;
      /** Highest severity among firing alerts not already notified; `null` when none. */
      readonly severity: PushSeverity | null;
    };
  };
}

/** Outcome of the last delivery attempt to a device. */
export type DeliveryOutcome = "delivered" | "failed" | "dropped";

/** Last delivery record. `reason` is a sanitised APNs reason (`APNS_REASON_PATTERN`) or a fixed local reason. */
export interface LastDelivery {
  /** Outcome of the attempt. */
  readonly outcome: DeliveryOutcome;
  /** ISO-8601 UTC instant the outcome was recorded. */
  readonly at: string;
  /** Sanitised or fixed local reason; `null` when there is none (a successful delivery). */
  readonly reason: string | null;
}

/** A device as shown to operators. It never contains the credential, its hash, or the full APNs token. */
export interface DeviceSummary {
  /** Device id (`DEVICE_ID_PATTERN`). */
  readonly id: string;
  /** Name given at redemption (`DISPLAY_NAME_PATTERN`, 1–64 UTF-8 bytes). */
  readonly displayName: string;
  /** ISO-8601 UTC instant the device was paired. */
  readonly pairedAt: string;
  /** ISO-8601 UTC instant the device was last seen. */
  readonly seenAt: string;
  /** `null` until the device first registers. */
  readonly environment: PushEnvironment | null;
  /** Current per-severity switches. */
  readonly preferences: PushPreferences;
  /** Last 6 hex characters of the APNs token, or `null` before registration. */
  readonly tokenSuffix: string | null;
  /** Most recent delivery attempt; `null` when none has been recorded. */
  readonly lastDelivery: LastDelivery | null;
}

/** Push gateway state. */
export type PushState = "disabled" | "configured" | "misconfigured";

/** `GET /api/push/status` body (web-only). For `misconfigured`, `devices` is `[]` and `outstanding` is `null`. */
export interface PushStatusPayload {
  /** Gateway state; never `disabled`, because the route does not exist then. */
  readonly state: Exclude<PushState, "disabled">;
  /** Paired devices; `[]` when `misconfigured`. */
  readonly devices: readonly DeviceSummary[];
  /** The most recent outstanding **web-issued** token's expiry, or `null`. Never the token. */
  readonly outstanding: {
    /** ISO-8601 UTC instant the token expires. */
    readonly expiresAt: string;
  } | null;
  /** The configured device cap, so the UI can say "n of m". */
  readonly maxDevices: number;
}

/** 201 body of `POST /api/push/pairing-tokens` and `POST /api/push/admin/pairing-tokens`. A secret. */
export interface PairingTokenIssued {
  /** `pulse://connect?…&pair=<token>`. */
  readonly link: string;
  /** ISO-8601 UTC instant the token expires. */
  readonly expiresAt: string;
}

/** Per-device test outcome. */
export type PushTestOutcome = "delivered" | "rejected" | "token-removed" | "unreachable";

/** `POST /api/push/admin/test` 200 body. `results` is empty when no device is registered. */
export interface PushTestResult {
  /** One entry per registered device that was tested. */
  readonly results: readonly {
    /** Device id (`DEVICE_ID_PATTERN`). */
    readonly deviceId: string;
    /** The device's display name. */
    readonly displayName: string;
    /** Test outcome for this device. */
    readonly outcome: PushTestOutcome;
    /** Sanitised APNs reason, `"timeout"`/`"connection"` for unreachable, or absent. */
    readonly reason?: string;
  }[];
}

/** `GET /api/push/admin/devices` 200 body. */
export interface PushDevicesPayload {
  /** Every paired device; `[]` when none. */
  readonly devices: readonly DeviceSummary[];
}
