// Push configuration: parse the PULSE_PUSH_* environment (plus PULSE_WEB_DATA_DIR) into a PushConfigState.
// Total and silent: it never throws and never logs; the runtime bootstrap logs the reasons once. No value read here
// is ever carried into a reason, warning or error.

import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

import { APNS_ID_PATTERN, APNS_TOPIC_PATTERN, PUSH_APNS_ENV_NAMES, PUSH_ENV, PUSH_LIMITS } from "./constants.js";
import { PushConfigParseError } from "./refusal.js";
import { loadPushSecret, readApnsKey } from "./secrets.js";
import type { PushSecret } from "./secrets.js";

/** Why a push variable was rejected. The value itself is never carried. */
export type PushConfigReasonKind =
  | "missing"
  | "invalid"
  | "unreadable"
  | "not-absolute"
  | "too-short"
  | "data-dir-missing"
  | "data-dir-unwritable"
  | "registry-corrupt";

/** One rejected (or warned-about) variable. */
export interface PushConfigReason {
  /** One of PUSH_ENV's values, or `"devices.json"` for registry-corrupt. */
  readonly envVar: string;
  /** Why that variable was rejected. */
  readonly reason: PushConfigReasonKind;
}

/** Validated APNs settings. `key` is the parsed P-256 private key; the file bytes are discarded. */
export interface ApnsSettings {
  /** Parsed P-256 signing key from `PULSE_PUSH_APNS_KEY_FILE`. */
  readonly key: KeyObject;
  /** APNs key id, 10 characters (`APNS_ID_PATTERN`). */
  readonly keyId: string;
  /** Apple team id, 10 characters (`APNS_ID_PATTERN`). */
  readonly teamId: string;
  /** App bundle id used as `apns-topic` (`APNS_TOPIC_PATTERN`, ≤ 155 bytes). */
  readonly topic: string;
}

/** On/off state of the optional surfaces (webhook, operator admin). */
export type PushSurface = "on" | "off";

/** Result of parsePushConfig. Never thrown; a push misconfiguration is never fatal. */
export type PushConfigState =
  | {
      /** None of the four APNs variables is set. */
      readonly state: "disabled";
    }
  | {
      /** Push was requested but cannot start. */
      readonly state: "misconfigured";
      /** Every rejected variable; never empty. */
      readonly reasons: readonly PushConfigReason[];
    }
  | {
      /** Push is active. */
      readonly state: "configured";
      /** Validated APNs settings. */
      readonly apns: ApnsSettings;
      /** Absolute `PULSE_WEB_DATA_DIR`; the registry lives under `<dataDir>/push/`. */
      readonly dataDir: string;
      /** Device cap, in `PUSH_LIMITS.minMaxDevices..maxMaxDevices` (default 20). */
      readonly maxDevices: number;
      /** `on` iff a usable webhook secret is loaded. */
      readonly webhook: PushSurface;
      /** `on` iff a usable operator secret is loaded. */
      readonly admin: PushSurface;
      /** Webhook secret; `null` when unset or rejected (webhook surface off). */
      readonly webhookSecret: PushSecret | null;
      /** Operator secret; `null` when unset or rejected (admin surface off). */
      readonly operatorSecret: PushSecret | null;
      /** Non-fatal warnings (unset or short optional secrets), logged once as config_warning. */
      readonly warnings: readonly PushConfigReason[];
    };

/** The disabled state. Returned (by identity) whenever no APNs variable is set. */
export const DISABLED_PUSH_CONFIG: PushConfigState = Object.freeze({ state: "disabled" });

/** Raw-value control-character class (same class as the server config's control-character check). */
const CONTROL_CHAR: RegExp = /[\u0000-\u001f\u007f-\u009f]/;
/** Device-cap syntax: 1–3 decimal digits. */
const MAX_DEVICES_PATTERN: RegExp = /^[0-9]{1,3}$/;

type Env = Readonly<Record<string, string | undefined>>;

/** `undefined` / "" / whitespace → undefined; otherwise the trimmed value. */
function nonEmpty(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t === "" ? undefined : t;
}

/** Throw a PushConfigParseError for `envVar` with `reason`. Never includes the value. */
function fail(envVar: string, reason: PushConfigReasonKind): never {
  throw new PushConfigParseError(Object.freeze({ envVar, reason }));
}

function parseKeyFile(env: Env, readFile: (path: string) => Uint8Array): KeyObject {
  const name = PUSH_ENV.keyFile;
  const raw = env[name];
  if (raw !== undefined && CONTROL_CHAR.test(raw)) fail(name, "invalid");
  const value = nonEmpty(raw);
  if (value === undefined) fail(name, "missing");
  if (!isAbsolute(value)) fail(name, "not-absolute");
  const result = readApnsKey(normalize(value), readFile);
  if (!result.ok) fail(name, result.reason);
  return result.key;
}

function parseApnsId(env: Env, name: string): string {
  const value = nonEmpty(env[name]);
  if (value === undefined) fail(name, "missing");
  if (!APNS_ID_PATTERN.test(value)) fail(name, "invalid");
  return value;
}

function parseTopic(env: Env): string {
  const name = PUSH_ENV.topic;
  const value = nonEmpty(env[name]);
  if (value === undefined) fail(name, "missing");
  if (!APNS_TOPIC_PATTERN.test(value) || Buffer.byteLength(value, "utf8") > PUSH_LIMITS.topicMaxBytes) {
    fail(name, "invalid");
  }
  return value;
}

function parseDataDir(env: Env): string {
  const dir = parsePushDataDir(env);
  if (dir === null) fail(PUSH_ENV.dataDir, "data-dir-missing");
  if (dir === "invalid") fail(PUSH_ENV.dataDir, "invalid");
  return dir;
}

function parseMaxDevices(env: Env): number {
  const name = PUSH_ENV.maxDevices;
  const value = nonEmpty(env[name]);
  if (value === undefined) return PUSH_LIMITS.defaultMaxDevices;
  if (!MAX_DEVICES_PATTERN.test(value)) fail(name, "invalid");
  const n = Number(value);
  if (n < PUSH_LIMITS.minMaxDevices || n > PUSH_LIMITS.maxMaxDevices) fail(name, "invalid");
  return n;
}

/**
 * Read PULSE_WEB_DATA_DIR for push, independently of the auth mode. Never throws.
 * - a control character in the raw value → "invalid"
 * - unset / "" / whitespace → null
 * - not absolute after trimming → "invalid"
 * - otherwise path.normalize(trimmed)
 */
export function parsePushDataDir(env: Env): string | null | "invalid" {
  const raw = env[PUSH_ENV.dataDir];
  if (raw !== undefined && CONTROL_CHAR.test(raw)) return "invalid";
  const value = nonEmpty(raw);
  if (value === undefined) return null;
  if (!isAbsolute(value)) return "invalid";
  return normalize(value);
}

/** Reason recorded when an unexpected (non-parse) exception ends the parse before any reason was collected. */
const DEFECT_REASON: PushConfigReason = Object.freeze({ envVar: PUSH_ENV.keyFile, reason: "invalid" });

/**
 * Parse push configuration from the environment. Total: never throws, never logs.
 *
 * Rules, in order: D (disabled when all four APNs variables are unset; nothing else is read), K1 key file, K2 key id,
 * K3 team id, K4 topic, P data directory, M device cap (K1–M are all evaluated, each contributing at most one reason),
 * then S optional secrets (only when K1–M passed; a failed secret turns off its own surface and adds a warning).
 *
 * Reads the APNs key file synchronously through `deps.readFile` (default `readFileSync`) when
 * PULSE_PUSH_APNS_KEY_FILE passes its path checks. The file bytes are zero-filled after parsing.
 *
 * @param env  - Environment map (test seam). Not mutated.
 * @param deps - `readFile`: synchronous file reader; must throw on any read failure. Default `readFileSync`.
 * @returns `disabled`, `misconfigured` with every reason found (in rule order), or `configured`.
 */
export function parsePushConfig(
  env: Env,
  deps: { readonly readFile?: (path: string) => Uint8Array } = {},
): PushConfigState {
  if (PUSH_APNS_ENV_NAMES.every((name) => nonEmpty(env[name]) === undefined)) return DISABLED_PUSH_CONFIG;

  const readFile = deps.readFile ?? ((path: string): Uint8Array => readFileSync(path));
  const reasons: PushConfigReason[] = [];
  const misconfigured = (): PushConfigState =>
    Object.freeze({
      state: "misconfigured",
      reasons: Object.freeze(reasons.length > 0 ? [...reasons] : [DEFECT_REASON]),
    });

  /** Run one rule; a PushConfigParseError becomes a reason, anything else propagates to the outer catch. */
  function rule<T>(run: () => T): T | undefined {
    try {
      return run();
    } catch (err) {
      if (err instanceof PushConfigParseError) {
        reasons.push(err.reason);
        return undefined;
      }
      throw err;
    }
  }

  try {
    const key = rule(() => parseKeyFile(env, readFile));
    const keyId = rule(() => parseApnsId(env, PUSH_ENV.keyId));
    const teamId = rule(() => parseApnsId(env, PUSH_ENV.teamId));
    const topic = rule(() => parseTopic(env));
    const dataDir = rule(() => parseDataDir(env));
    const maxDevices = rule(() => parseMaxDevices(env));

    if (
      reasons.length > 0 ||
      key === undefined ||
      keyId === undefined ||
      teamId === undefined ||
      topic === undefined ||
      dataDir === undefined ||
      maxDevices === undefined
    ) {
      return misconfigured();
    }

    const warnings: PushConfigReason[] = [];
    const surface = (name: string): { readonly on: PushSurface; readonly secret: PushSecret | null } => {
      const loaded = loadPushSecret(env, name);
      if (loaded.ok) return { on: "on", secret: loaded.secret };
      warnings.push(Object.freeze({ envVar: name, reason: loaded.reason }));
      return { on: "off", secret: null };
    };
    const webhook = surface(PUSH_ENV.webhookSecret);
    const admin = surface(PUSH_ENV.operatorSecret);

    const apns: ApnsSettings = Object.freeze({ key, keyId, teamId, topic });
    return Object.freeze({
      state: "configured",
      apns,
      dataDir,
      maxDevices,
      webhook: webhook.on,
      admin: admin.on,
      webhookSecret: webhook.secret,
      operatorSecret: admin.secret,
      warnings: Object.freeze(warnings),
    });
  } catch {
    return misconfigured();
  }
}
