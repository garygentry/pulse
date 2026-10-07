// agent/prober/src/config.ts
//
// Load, parse, filter, and narrow the mounted `rendered/prober/config.yaml` into the
// deep-health probe set the prober executes (02-deep-health-prober.md §3, REQ-PROBE-05/06).
//
// Three distinct load states (§3.1):
//   - ABSENT file (ENOENT)        → `[]` — a non-event; the prober idles healthy.
//   - MALFORMED / unreadable file → `ProberConfigError` — FATAL at startup (failed healthcheck).
//   - WELL-FORMED file            → filter to `kind: "deep-health"` and narrow each entry.
//
// Only deep-health entries survive (REQ-PROBE-06); `backup-freshness`, `icmp`, and host
// reachability entries in the same shared file are silently ignored (they are owned
// elsewhere — tech-spec §3.4, §10 OTQ-A). `alertExpression` is carried opaquely and never
// evaluated here (REQ-PROBE-02, §9); `credential` crosses as `SecretRef.raw` only (§5).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml"; // yaml@^2.5.0 — pinned, matches renderer (format.ts)
import type { DeepHealthProbeConfig } from "../../contract/types.js";
import {
  DEEP_HEALTH_KIND,
  DEFAULT_PROBE_CADENCE_MS,
  DEFAULT_PROBE_CONCURRENCY,
  DEFAULT_PROBE_TIMEOUT_MS,
} from "../../contract/constants.js";
import { ProberConfigError } from "./errors.js";

/** Absolute path of the mounted prober config, from `PULSE_RENDERED_DIR` or the compose
 *  default mount `/rendered/prober/config.yaml` (tech-spec §3.4, §9). */
export const CONFIG_PATH: string = join(
  process.env.PULSE_RENDERED_DIR ?? "/rendered",
  "prober",
  "config.yaml",
);

/**
 * Load, parse, and filter the mounted `rendered/prober/config.yaml` into the deep-health
 * probes this prober executes (REQ-PROBE-05/06).
 *
 * - ABSENT file (ENOENT) → resolves to `[]` (non-event; the prober idles healthy — §3.1).
 * - MALFORMED file (unreadable, unparseable YAML, wrong top-level shape) → throws
 *   {@link ProberConfigError} (FATAL at startup → failed healthcheck). Never a silent stop.
 * - Non-`deep-health` kinds (`backup-freshness`, `icmp`, …) are IGNORED (REQ-PROBE-06).
 *
 * @param path - The config path; defaults to {@link CONFIG_PATH}.
 * @returns The narrowed deep-health probe set (possibly empty).
 * @throws {ProberConfigError} If the file exists but cannot be read/parsed into `{ probes: [...] }`,
 *   or any deep-health entry is structurally invalid (bad `name`, missing `responseMapping`).
 */
export async function loadProberConfig(
  path: string = CONFIG_PATH,
): Promise<DeepHealthProbeConfig[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    // ENOENT is the ABSENT case — a non-event, not an error (§3.1).
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ProberConfigError(path, `unreadable prober config: ${(err as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new ProberConfigError(path, `malformed YAML: ${(err as Error).message}`);
  }
  return filterDeepHealth(doc, path);
}

/**
 * Validate the parsed document as `{ probes: ProberEntry[] }`, keep only `deep-health`
 * entries (REQ-PROBE-06), and narrow each to a {@link DeepHealthProbeConfig}. Entries of any
 * other `kind` are silently dropped — they are owned elsewhere (tech-spec §3.4, §10 OTQ-A).
 *
 * @param doc - The parsed YAML document (untrusted shape).
 * @param path - The source path, for error context.
 * @returns The narrowed deep-health probes.
 * @throws {ProberConfigError} If `doc` is not `{ probes: array }`, or a `deep-health` entry
 *   has an unparseable `name` or a missing/empty `responseMapping`.
 */
export function filterDeepHealth(doc: unknown, path: string): DeepHealthProbeConfig[] {
  if (!isRecord(doc) || !Array.isArray(doc.probes)) {
    throw new ProberConfigError(path, `expected top-level { probes: [] }, got ${describe(doc)}`);
  }
  const out: DeepHealthProbeConfig[] = [];
  for (const entry of doc.probes) {
    if (!isRecord(entry) || entry.kind !== DEEP_HEALTH_KIND) continue;
    out.push(narrowDeepHealth(entry, path));
  }
  return out;
}

/**
 * Narrow one `deep-health` {@link ProberEntry} into a {@link DeepHealthProbeConfig}, parsing
 * `host`/`service` from `name` ("svc:<host>/<service>") and requiring a non-empty
 * `responseMapping` (a deep-health entry with no mappings emits no samples — a config error).
 *
 * `alertExpression` and `credential` are carried through only when present (kept opaque —
 * `alertExpression` is never evaluated here, §9; `credential` is `SecretRef.raw` only, §5).
 *
 * @throws {ProberConfigError} On a malformed `name` or a missing/empty `responseMapping`.
 */
export function narrowDeepHealth(entry: unknown, path: string): DeepHealthProbeConfig {
  if (!isRecord(entry) || entry.kind !== DEEP_HEALTH_KIND) {
    throw new ProberConfigError(path, "expected a deep-health probe object");
  }
  const parsed = typeof entry.name === "string" ? parseProbeName(entry.name) : null;
  if (parsed === null) {
    throw new ProberConfigError(
      path,
      `deep-health entry has malformed name: ${JSON.stringify(entry.name)}`,
    );
  }
  if (typeof entry.target !== "string" || entry.target.length === 0) {
    throw new ProberConfigError(path, `deep-health probe ${entry.name} has invalid target`);
  }
  const mapping = entry.responseMapping;
  if (!isRecord(mapping) || Object.keys(mapping).length === 0) {
    throw new ProberConfigError(path, `deep-health probe ${entry.name} has no responseMapping`);
  }
  for (const [metric, jsonPath] of Object.entries(mapping)) {
    if (metric.length === 0 || typeof jsonPath !== "string" || jsonPath.length === 0) {
      throw new ProberConfigError(path, `deep-health probe ${entry.name} has invalid responseMapping`);
    }
  }
  for (const key of ["alertExpression", "credential"] as const) {
    const value = entry[key];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new ProberConfigError(path, `deep-health probe ${entry.name} has invalid ${key}`);
    }
  }
  return {
    host: parsed.host,
    service: parsed.service,
    target: entry.target,
    metrics: mapping as Record<string, string>,
    ...(typeof entry.alertExpression === "string"
      ? { alertExpression: entry.alertExpression }
      : {}),
    ...(typeof entry.credential === "string" ? { credential: entry.credential } : {}),
  };
}

/** Validated process-level tuning applied by the prober entrypoint. */
export interface ProberRuntimeOptions {
  timeoutMs: number;
  cadenceMs: number;
  concurrency: number;
}

const RUNTIME_ENV = {
  timeoutMs: "PULSE_PROBE_TIMEOUT_MS",
  cadenceMs: "PULSE_PROBE_CADENCE_MS",
  concurrency: "PULSE_PROBE_CONCURRENCY",
} as const;

/** Read positive-integer runtime tuning from the environment, with bounded defaults. */
export function loadRuntimeOptions(
  env: Record<string, string | undefined> = process.env,
): ProberRuntimeOptions {
  return {
    timeoutMs: positiveInteger(env[RUNTIME_ENV.timeoutMs], DEFAULT_PROBE_TIMEOUT_MS, RUNTIME_ENV.timeoutMs),
    cadenceMs: positiveInteger(env[RUNTIME_ENV.cadenceMs], DEFAULT_PROBE_CADENCE_MS, RUNTIME_ENV.cadenceMs),
    concurrency: positiveInteger(
      env[RUNTIME_ENV.concurrency],
      DEFAULT_PROBE_CONCURRENCY,
      RUNTIME_ENV.concurrency,
    ),
  };
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ProberConfigError("<environment>", `${name} must be a positive integer`);
  }
  return parsed;
}

/** `{ host, service }` parsed from a "svc:<host>/<service>" probe name. */
export interface ParsedProbeName {
  host: string;
  service: string;
}

/**
 * Parse `"svc:<host>/<service>"` into its `host` and `service` label segments (tech-spec §3.4).
 * Returns `null` for any other shape (including the `#backup` and `host:` forms, which are not
 * deep-health and never reach here). `host`/`service` must be non-empty.
 *
 * @example parseProbeName("svc:web01/frigate") // → { host: "web01", service: "frigate" }
 */
export function parseProbeName(name: string): ParsedProbeName | null {
  const m = /^svc:([^/]+)\/(.+)$/.exec(name);
  if (m === null) return null;
  const host = m[1];
  const service = m[2];
  if (host === undefined || service === undefined || host.length === 0 || service.length === 0) {
    return null;
  }
  return { host, service };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Short human description of an unexpected value, for error messages. */
function describe(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}
