// src/server/config.ts — env → ServerConfig parsing.
//
// Parses the complete env contract once at startup into `ServerConfig`. The four engine
// URLs are hard-required — a missing/empty one throws `ConfigError` (fatal → red healthcheck):
// the web-service slot always injects them (item 001), so absence means a mis-deployed container.
// The model path is NOT hard-required: unset/empty yields a `null` path and servable error-page
// mode (REQ-MODEL-03), the same state as an unreadable mount. The optional vars (TZ, Grafana
// origin, Gatus staleness) fall back
// to their documented defaults with a `config_warning` when malformed. The listen port is NOT here
// — it is the fixed `LISTEN_PORT` constant, deliberately not env-configurable.

import { isAbsolute, join, normalize } from "node:path";

import { PROPOSAL_SECRET_MIN_BYTES } from "@pulse/core/proposals"; // single source in core; not redefined
import { parseIdentityConfig, type IdentityConfig } from "@pulse/web-data/identity";
import type { AuthMode } from "@pulse/web-data/identity";

import { ENV, GATUS_STALE_SECONDS_DEFAULT } from "../shared/constants.js";
import { ConfigError } from "../shared/errors.js";
import { log } from "./log.js";
import { WRITE_PATH_DEFAULTS, WRITE_PATH_ENV } from "./mutations/constants.js";

/**
 * The app's complete parsed runtime configuration (the env table). Built once at startup by
 * {@link loadServerConfig} and carried on `ServerContext.config`. Engine URLs are the ONLY
 * engine addresses the process ever sees (REQ-PKG-02); no address is hardcoded.
 */
export interface ServerConfig {
  /** `PULSE_VM_URL` — VictoriaMetrics base (e.g. `http://victoriametrics:8428`). Required. */
  readonly vmUrl: string;
  /** `PULSE_ALERTMANAGER_URL` — Alertmanager base (e.g. `http://alertmanager:9093`). Required. */
  readonly alertmanagerUrl: string;
  /** `PULSE_GATUS_URL` — Gatus base (e.g. `http://gatus:8080`). Required. */
  readonly gatusUrl: string;
  /** `PULSE_VMALERT_URL` — vmalert base (e.g. `http://vmalert:8880`). Required (00 §5): the fourth
   *  fixed engine origin. Validated here so four-origin mode is bootable; no production
   *  `VmalertClient` consumes it yet. */
  readonly vmalertUrl: string;
  /** `PULSE_WEB_ESTATE_MODEL` — in-container model path, or `null` when unset/empty. A `null` path
   *  (like an unreadable file) is a servable state: the server renders error-page mode rather than
   *  refusing to boot (REQ-MODEL-03). */
  readonly estateModelPath: string | null;
  /** `PULSE_ESTATE_TZ` — validated IANA zone, or `null` when unset/invalid → the snapshot renders
   *  UTC with an explicit "TZ not configured" marker (REQ-LIVE-02; `tzFallback` in `04`). */
  readonly estateTz: string | null;
  /** `PULSE_GRAFANA_URL` — browser-facing Grafana origin, or `null` → deep links disabled with an
   *  actionable tooltip (REQ-DRILL-02, CON-04; consumed by `04` `links.ts`). */
  readonly grafanaUrl: string | null;
  /** `PULSE_GATUS_STALE_SECONDS` — Gatus evaluation-freshness threshold; default 300 (`04` liveness). */
  readonly gatusStaleSeconds: number;
  /** Validated deny-by-default trusted-proxy identity configuration (09 §2), parsed from
   *  `PULSE_WEB_AUTH_MODE` / `PULSE_WEB_AUTH_HEADER` / `PULSE_WEB_TRUSTED_PROXIES`. Defaults to
   *  `none` mode (identity always null). A malformed value is a fatal startup {@link ConfigError}. */
  readonly identity: IdentityConfig;
  /** Write-path configuration. In mode "none" every path is null and the secret is absent. */
  readonly writePath: WritePathConfig;
}

// ── Write-path configuration ───────────────────────────────────────────────────────────────────

/** Parsed write-path configuration. In mode "none" every field is null and the secret is absent. */
export interface WritePathConfig {
  /** PULSE_WEB_DATA_DIR — absolute, or null. */ readonly dataDir: string | null;
  /** Audit JSONL file (explicit or `$DATA/audit/audit.jsonl`), or null → not-configured. */ readonly auditPath: string | null;
  /** Ack store file (explicit or `$DATA/acks.json`), or null. */ readonly ackStorePath: string | null;
  /** Proposals dir (explicit or `$DATA/proposals`), or null. */ readonly proposalsDir: string | null;
  /** Secret status only (mirrors SecretProvider.status; `secret-missing` in none mode) — bytes never live here. */ readonly secret: SecretStatus;
}
/** Status of PULSE_PROPOSAL_SECRET. */
export type SecretStatus =
  | {
      /** The secret is set and at least PROPOSAL_SECRET_MIN_BYTES UTF-8 bytes long. */ readonly present: true;
    }
  | {
      /** The secret is unusable; proposals degrade with {@link reason}. */ readonly present: false;
      /** Why the secret is unusable: unset/empty, or shorter than the minimum byte length. */
      readonly reason: "secret-missing" | "secret-too-short";
    };

/** Closure accessor for the secret bytes; never attached to ServerConfig. */
export interface SecretProvider {
  /** Secret bytes, or null when the status is not present; never serialized or logged. */ bytes(): Uint8Array | null;
  /** Presence/length status of PULSE_PROPOSAL_SECRET. */ readonly status: SecretStatus;
}

/** The inert write-path configuration used in auth mode "none" (REQ-CFG-03). */
export const NONE_WRITE_PATH_CONFIG: WritePathConfig = Object.freeze({
  dataDir: null,
  auditPath: null,
  ackStorePath: null,
  proposalsDir: null,
  secret: Object.freeze({ present: false, reason: "secret-missing" }) as SecretStatus,
});

/** C0 controls, DEL and C1 controls — a path containing any is malformed. */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

// ── Estate timezone decision (rendered-model-v2) ────────────────────────────────────────────────
// Shared v2 timezone-decision contract, homed here (00-core-definitions.md §9). Item 011 implements
// `resolveEstateTimezone` against this shape (valid override wins with one mismatch warning, else
// model timezone, else defensive UTC in error mode). Declared once here; later modules import it
// type-only. The current `estateTz`/`validateTz` config behavior is unchanged pending that cutover.

/** Effective timezone and optional warning for one authoritative bundle. */
export interface EstateTimezoneDecision {
  /** Explicit valid override, else model timezone, else defensive UTC. */
  timezone: string;
  /** True only when defensive UTC was required because no valid bundle existed. */
  fallback: boolean;
  /** Structured warning when a valid override differs from the model. */
  warning: {
    /** Operator-configured timezone value. */ configured: string;
    /** Rendered-model timezone value. */ rendered: string;
  } | null;
}

/**
 * Resolve the effective estate timezone for one authoritative bundle (06 §7.1). Pure and total.
 *
 * 1. A valid explicit override always wins (`fallback:false`); it carries a mismatch `warning`
 *    only when the model declares a different non-null timezone.
 * 2. Otherwise the model timezone wins when present (`fallback:false`, no warning).
 * 3. Otherwise defensive `UTC` (`fallback:true`) — reached only in bundle-error mode, where no
 *    authoritative model timezone exists.
 *
 * The renderer/web validators guarantee an authoritative model timezone is a valid non-empty IANA
 * zone; this helper never re-reads the environment or mutates configuration.
 *
 * @param configured    - `ServerConfig.estateTz` (a valid override, or `null` when absent/invalid).
 * @param modelTimezone - The authoritative model's `estate.timezone`, or `null` in error mode.
 */
export function resolveEstateTimezone(
  configured: string | null,
  modelTimezone: string | null,
): EstateTimezoneDecision {
  if (configured !== null) {
    const warning =
      modelTimezone !== null && modelTimezone !== configured
        ? { configured, rendered: modelTimezone }
        : null;
    return { timezone: configured, fallback: false, warning };
  }
  if (modelTimezone !== null) {
    return { timezone: modelTimezone, fallback: false, warning: null };
  }
  return { timezone: "UTC", fallback: true, warning: null };
}

/**
 * Parse and validate the env contract into a {@link ServerConfig}.
 *
 * - The four engine URLs are hard-required: a missing/empty one throws {@link ConfigError}
 *   (fatal at startup → red healthcheck).
 * - `PULSE_WEB_ESTATE_MODEL` unset/empty → `null` (servable error-page mode, REQ-MODEL-03), NOT a
 *   throw — an unset env var and an unreadable file are the same servable failure.
 * - `PULSE_ESTATE_TZ` is validated with `Intl.DateTimeFormat`; an invalid zone logs a warning and
 *   falls back to `null` (→ UTC marker, REQ-LIVE-02) rather than crashing.
 * - `PULSE_GRAFANA_URL` unset → `null` (deep links disabled).
 * - `PULSE_GATUS_STALE_SECONDS` parses to a positive integer; a non-numeric value logs a warning
 *   and uses {@link GATUS_STALE_SECONDS_DEFAULT}.
 *
 * @param env - The environment map (test seam). Default: `process.env`.
 * @returns The parsed, validated configuration.
 * @throws {ConfigError} (code `CONFIG_MISSING_ENV`) if any of `PULSE_VM_URL` /
 *   `PULSE_ALERTMANAGER_URL` / `PULSE_GATUS_URL` / `PULSE_VMALERT_URL` is missing or empty.
 */
export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  // Existing literal kept byte-identical and evaluated FIRST, so the order in which pre-existing
  // ConfigErrors are raised (engine URLs, then identity) is unchanged; write-path errors come last.
  const base = {
    vmUrl: required(env, ENV.VM_URL),
    alertmanagerUrl: required(env, ENV.ALERTMANAGER_URL),
    gatusUrl: required(env, ENV.GATUS_URL),
    vmalertUrl: required(env, ENV.VMALERT_URL),
    estateModelPath: nonEmpty(env[ENV.WEB_ESTATE_MODEL]) ?? null,
    estateTz: validateTz(env[ENV.ESTATE_TZ]),
    grafanaUrl: nonEmpty(env[ENV.GRAFANA_URL]) ?? null,
    gatusStaleSeconds: parseStaleSeconds(env[ENV.GATUS_STALE_SECONDS]),
    identity: parseIdentity(env),
  };
  return { ...base, writePath: parseWritePath(env, base.identity.mode) };
}

/**
 * Parse the write-path env (REQ-CFG-01/03).
 *
 * - Mode `none`: every write-path variable is ignored WITHOUT validation (a malformed value cannot fail
 *   start-up). If any of the five is set (non-empty), ONE `config_warning` names the variables — never
 *   their values. Returns {@link NONE_WRITE_PATH_CONFIG}.
 * - Mode `proxy-header`: each path is validated by {@link parseAbsolutePath}; unset explicit paths fall
 *   back to `$DATA/<WRITE_PATH_DEFAULTS.x>` or `null`. The secret is reduced to a status only.
 *
 * @throws {ConfigError} (proxy-header only) when a set path is relative or contains a control character.
 */
export function parseWritePath(env: Record<string, string | undefined>, mode: AuthMode): WritePathConfig {
  if (mode !== "proxy-header") {
    const set = Object.values(WRITE_PATH_ENV).filter((name) => (env[name] ?? "") !== "");
    if (set.length > 0) {
      log({
        event: "config_warning",
        ok: false,
        error: `write-path configuration ignored because PULSE_WEB_AUTH_MODE is not proxy-header: ${set.join(", ")}`,
      });
    }
    return NONE_WRITE_PATH_CONFIG;
  }
  const dataDir = parseAbsolutePath(env, WRITE_PATH_ENV.dataDir);
  const derive = (name: string, rel: string): string | null =>
    parseAbsolutePath(env, name) ?? (dataDir === null ? null : join(dataDir, rel));
  return Object.freeze({
    dataDir,
    auditPath: derive(WRITE_PATH_ENV.auditPath, WRITE_PATH_DEFAULTS.audit),
    ackStorePath: derive(WRITE_PATH_ENV.ackStorePath, WRITE_PATH_DEFAULTS.acks),
    proposalsDir: derive(WRITE_PATH_ENV.proposalsDir, WRITE_PATH_DEFAULTS.proposals),
    secret: secretStatusOf(env[WRITE_PATH_ENV.secret]),
  });
}

/**
 * Read one optional absolute-path variable. Unset/empty/whitespace → `null`.
 * @throws {ConfigError} `(name, "<name> must be an absolute path")` or
 *   `(name, "<name> must not contain control characters")` — value never echoed.
 */
function parseAbsolutePath(env: Record<string, string | undefined>, name: string): string | null {
  const raw = env[name];
  // Control characters are checked on the RAW value (before trim) so "\n/data" is rejected, not trimmed.
  if (raw !== undefined && CONTROL_CHAR_RE.test(raw)) {
    throw new ConfigError(name, `${name} must not contain control characters`);
  }
  const value = nonEmpty(raw);
  if (value === undefined) return null;
  if (!isAbsolute(value)) throw new ConfigError(name, `${name} must be an absolute path`);
  return normalize(value);
}

/**
 * Classify a raw secret value (pure; the value is not retained). Not trimmed: the secret is exact bytes.
 * `undefined`/`""` → `secret-missing`; UTF-8 length < PROPOSAL_SECRET_MIN_BYTES → `secret-too-short`.
 */
export function secretStatusOf(raw: string | undefined): SecretStatus {
  if (raw === undefined || raw === "") return { present: false, reason: "secret-missing" };
  if (Buffer.byteLength(raw, "utf8") < PROPOSAL_SECRET_MIN_BYTES) return { present: false, reason: "secret-too-short" };
  return { present: true };
}

/**
 * Read PULSE_PROPOSAL_SECRET into a closure. Called ONLY by index.ts inside the
 * `if (config.identity.mode === "proxy-header") {` branch, so mode `none` never reads it. Never throws; never logs; the bytes are
 * never a property of any object.
 *
 * - `status` is computed by {@link secretStatusOf}, so it always equals `config.writePath.secret`.
 * - `bytes()` returns a fresh copy (callers cannot mutate the held key) or `null` when not present.
 * - The returned object is frozen and has exactly two own properties (`status`, `bytes`); `JSON.stringify`
 *   of it yields `{"status":{…}}` — the key cannot leak through serialization or structured logging.
 */
export function loadProposalSecret(env: Readonly<Record<string, string | undefined>>): SecretProvider {
  const raw = env[WRITE_PATH_ENV.secret];
  const status = Object.freeze(secretStatusOf(raw)) as SecretStatus;
  const held: Uint8Array | null = status.present ? new TextEncoder().encode(raw) : null;
  return Object.freeze({
    status,
    bytes: (): Uint8Array | null => (held === null ? null : held.slice()),
  });
}

/**
 * Parse and validate the trusted-proxy identity configuration (09 §2) via the package's
 * {@link parseIdentityConfig}. Empty/whitespace values normalize to `null` so an unset env var
 * takes the package default (`none` mode, `Remote-User`, empty deny-list). A malformed mode /
 * header / CIDR list is a fatal startup {@link ConfigError} — its text is exactly the package
 * error message (naming the env key, never the rejected value) so binding is prevented. Non-fatal
 * categorical warnings are logged (never a configured value).
 *
 * @throws {ConfigError} when the identity configuration is malformed.
 */
function parseIdentity(env: Record<string, string | undefined>): IdentityConfig {
  const result = parseIdentityConfig({
    mode: nonEmpty(env[ENV.WEB_AUTH_MODE]) ?? null,
    headerName: nonEmpty(env[ENV.WEB_AUTH_HEADER]) ?? null,
    trustedProxies: nonEmpty(env[ENV.WEB_TRUSTED_PROXIES]) ?? null,
  });
  if (!result.ok) {
    throw new ConfigError(result.error.envVar, result.error.message);
  }
  for (const warning of result.warnings) {
    log({ event: "config_warning", ok: false, error: warning.message });
  }
  return result.config;
}

/** Read a required env var; a missing/empty value is a hard startup failure. */
function required(env: Record<string, string | undefined>, name: string): string {
  const value = nonEmpty(env[name]);
  if (value === undefined) {
    throw new ConfigError(
      name,
      `required environment variable ${name} is unset or empty — the web service slot injects it; ` +
        `an absent value means a mis-deployed container`,
    );
  }
  return value;
}

/** `undefined`/`""`/whitespace → `undefined`; otherwise the trimmed value. */
function nonEmpty(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t === "" ? undefined : t;
}

/** Validate an IANA time-zone id with `Intl.DateTimeFormat`; invalid/absent → `null` + a warning. */
function validateTz(raw: string | undefined): string | null {
  const tz = nonEmpty(raw);
  if (tz === undefined) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    log({
      event: "config_warning",
      ok: false,
      error:
        `invalid PULSE_ESTATE_TZ "${tz}" — ignoring invalid override; rendered estate timezone ` +
        `will be used when a valid bundle is available`,
    });
    return null;
  }
}

/** Parse a positive-integer seconds value; non-numeric → default + a warning. */
function parseStaleSeconds(raw: string | undefined): number {
  const s = nonEmpty(raw);
  if (s === undefined) return GATUS_STALE_SECONDS_DEFAULT;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    log({
      event: "config_warning",
      ok: false,
      error: `invalid PULSE_GATUS_STALE_SECONDS "${s}" — using default ${GATUS_STALE_SECONDS_DEFAULT}`,
    });
    return GATUS_STALE_SECONDS_DEFAULT;
  }
  return Math.floor(n);
}
