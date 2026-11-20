// Push gateway constants: environment names, route paths, numeric bounds and validation patterns.

/** Environment variable names. Also listed in ENV in apps/web/src/shared/constants.ts. */
export const PUSH_ENV = Object.freeze({
  keyFile: "PULSE_PUSH_APNS_KEY_FILE",
  keyId: "PULSE_PUSH_APNS_KEY_ID",
  teamId: "PULSE_PUSH_APNS_TEAM_ID",
  topic: "PULSE_PUSH_APNS_TOPIC",
  webhookSecret: "PULSE_PUSH_WEBHOOK_SECRET",
  operatorSecret: "PULSE_PUSH_OPERATOR_SECRET",
  maxDevices: "PULSE_PUSH_MAX_DEVICES",
  dataDir: "PULSE_WEB_DATA_DIR", // existing variable, read independently of auth mode
} as const);

/** The four APNs variables whose presence activates push. */
export const PUSH_APNS_ENV_NAMES: readonly string[] = Object.freeze([
  PUSH_ENV.keyFile,
  PUSH_ENV.keyId,
  PUSH_ENV.teamId,
  PUSH_ENV.topic,
]);

/** Route paths. `:id` segments match DEVICE_ID_PATTERN. */
export const PUSH_PATHS = Object.freeze({
  prefix: "/api/push/",
  redeem: "/api/push/pairings/redeem",
  device: "/api/push/device",
  webhook: "/api/push/alertmanager",
  status: "/api/push/status",
  pairingTokens: "/api/push/pairing-tokens",
  pairingTokenCurrent: "/api/push/pairing-tokens/current",
  deviceById: "/api/push/devices/:id",
  adminPairingTokens: "/api/push/admin/pairing-tokens",
  adminDevices: "/api/push/admin/devices",
  adminDeviceById: "/api/push/admin/devices/:id",
  adminTest: "/api/push/admin/test",
} as const);

/** Every numeric bound. Times are milliseconds unless the name says otherwise. */
export const PUSH_LIMITS = Object.freeze({
  // pairing
  tokenTtlMs: 10 * 60_000,
  maxOutstandingTokens: 8,
  limiterMaxFailures: 10,
  limiterWindowMs: 10 * 60_000,
  // devices
  defaultMaxDevices: 20,
  minMaxDevices: 1,
  maxMaxDevices: 100,
  deviceExpiryMs: 90 * 24 * 3_600_000,
  sweepIntervalMs: 3_600_000,
  softFlushMs: 5_000,
  // secrets
  secretMinBytes: 32,
  topicMaxBytes: 155,
  // webhook
  webhookMaxBytes: 1_048_576,
  webhookMaxAlerts: 2048,
  webhookMaxLabelValueBytes: 1024,
  // planning
  summaryThreshold: 5, // > 5 alerts after filtering → one summary
  memoryMaxPerDevice: 4096,
  // delivery
  queueMaxPerDevice: 256,
  retryDeadlineMs: 5 * 60_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  backoffJitterLow: 0.8,
  backoffJitterHigh: 1.2,
  testRetryDelaysMs: Object.freeze([1_000, 2_000, 4_000]),
  // apns
  apnsRequestTimeoutMs: 10_000,
  apnsPingIntervalMs: 60_000,
  apnsIdleCloseMs: 10 * 60_000,
  jwtRefreshMs: 50 * 60_000,
  alertExpirationSeconds: 3_600,
  testExpirationSeconds: 300,
  // logging
  deliveryFailedLogIntervalMs: 60_000,
} as const);

/** Sanitised APNs `reason` values; anything else is replaced with "other". */
export const APNS_REASON_PATTERN: RegExp = /^[A-Za-z]{1,64}$/;
/** Alertmanager fingerprint (push-side tightening). */
export const AM_FINGERPRINT_PATTERN: RegExp = /^[0-9a-f]{16}$/;
/** APNs key and team id. */
export const APNS_ID_PATTERN: RegExp = /^[A-Z0-9]{10}$/;
/** Bundle id / topic. */
export const APNS_TOPIC_PATTERN: RegExp = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** Cache-Control on every push response. */
export const PUSH_CACHE_CONTROL = "private, no-store" as const;
