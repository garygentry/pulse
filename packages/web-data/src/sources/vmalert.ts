// packages/web-data/src/sources/vmalert.ts — the vmalert source client
// (03-source-clients-and-validation.md §7). Supports exactly one operation:
//
//   - rules()  one GET /api/v1/rules
//
// `rules()` validates the full consumed nested envelope and returns every rule group and
// every rule — active, inactive, unhealthy, and deadman/canary entries alike. Each group
// retains its group name, source file, derived family, interval/evaluation timing, and its
// complete rule set. Each rule retains name, type, bounded upstream state, normalized health,
// last evaluation time, bounded last error, safe (allowlisted, bounded) labels/annotations,
// and a deterministic `deadman` marker derived from the configured/known rule identity —
// never from whether the rule is currently firing.
//
// Every consumed nested field is validated from `unknown` with a zod schema; additive
// upstream fields pass and are stripped; an unsupported rule discriminator or a
// missing/invalid consumed nested member fails the whole operation. The method resolves a
// SourceResult and never rejects. No response subset is published on failure.

import { z } from "zod";
import { SOURCE_MAX_BODY_BYTES, SOURCE_MAX_NAME_BYTES, SOURCE_TIMEOUT_MS } from "../wire/common.js";
import type { FetchLike, SourceClientOptions, SourceResult } from "./types.js";
import { fetchJsonUnknown, normalizeBaseUrl, sourceFailure, sourceSuccess } from "./fetch.js";
import { selectAnnotations } from "./annotations.js";

// ---------------------------------------------------------------------------
// §7 Consumed value types (source-level; the fold adds renderer attribution)
// ---------------------------------------------------------------------------

/** The supported vmalert rule discriminator; any other value fails the whole operation. */
export type VmalertRuleType = "alerting" | "recording";

/** Normalized vmalert rule evaluation health. */
export type VmalertRuleHealth = "healthy" | "unhealthy" | "unknown";

/** One validated vmalert rule, including inactive and deadman/canary entries. */
export interface VmalertRule {
  /** Bounded rule name. */
  readonly name: string;
  /** Supported rule discriminator. */
  readonly type: VmalertRuleType;
  /** Bounded upstream rule state (e.g. `firing`/`pending`/`inactive`); `""` for recording rules. */
  readonly state: string;
  /** Normalized evaluation health. */
  readonly health: VmalertRuleHealth;
  /** Latest rule evaluation time in UTC, or null when absent. */
  readonly lastEvaluationAt: string | null;
  /** Bounded safe evaluation error, or null when absent/oversized. */
  readonly lastError: string | null;
  /** Allowlisted bounded labels; unknown keys are dropped. */
  readonly labels: Readonly<Record<string, string>>;
  /** Allowlisted bounded annotations; unknown keys are dropped. */
  readonly annotations: Readonly<Record<string, string>>;
  /** Whether this is a configured deadman/canary rule, derived from identity not firing state. */
  readonly deadman: boolean;
}

/** One validated vmalert rule group with its evaluation timing and complete rule set. */
export interface VmalertRuleGroup {
  /** vmalert group name. */
  readonly group: string;
  /** Source file the group was loaded from. */
  readonly file: string;
  /** Rule family/source identity, derived deterministically from the source file. */
  readonly family: string;
  /** Group evaluation interval in whole seconds, or null when unavailable. */
  readonly intervalSeconds: number | null;
  /** Latest group evaluation time in UTC, or null when absent. */
  readonly lastEvaluationAt: string | null;
  /** Every validated rule in upstream order. */
  readonly rules: readonly VmalertRule[];
}

/** The vmalert source client. The single method resolves a SourceResult and never throws. */
export interface VmalertClient {
  /** GET /api/v1/rules once and return every validated group and rule. */
  rules(): Promise<SourceResult<readonly VmalertRuleGroup[]>>;
}

// ---------------------------------------------------------------------------
// Validation helpers and consumed-body schemas
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** Byte length of a string as UTF-8. */
function byteLen(s: string): number {
  return utf8.encode(s).length;
}

/** A non-empty consumed name/file bounded to the §2 512-byte limit. */
const boundedName = z
  .string()
  .min(1)
  .refine((s) => byteLen(s) <= SOURCE_MAX_NAME_BYTES);

/** Allowlisted safe rule label keys: severity plus host/service/instance identity. */
const LABEL_ALLOWLIST: ReadonlySet<string> = new Set(["alertname", "severity", "host", "service", "instance"]);

/** §2 safe-label bounds: at most 32 selected keys, key ≤128 bytes, value ≤256 bytes. Annotations are
 *  bounded separately (`selectAnnotations`). */
const MAX_TRIAGE_KEYS = 32;
const MAX_TRIAGE_KEY_BYTES = 128;
const MAX_TRIAGE_VALUE_BYTES = 256;

/**
 * Configured/known deadman-canary rule identities (case-insensitive). The `deadman` marker is
 * derived from this identity set — never from whether the rule is currently firing — so a
 * deadman rule remains marked even when inactive, and a firing non-canary rule never is.
 */
const DEADMAN_RULE_NAMES: ReadonlySet<string> = new Set(["deadmansswitch", "watchdog"]);

/** Internal classification thrown while mapping a validated envelope to a closed value. */
class MapError extends Error {
  constructor(readonly kind: "invalid-shape" | "incompatible") {
    super(kind);
    this.name = "MapError";
  }
}

/**
 * Select and bound the allowlisted subset of a label/annotation map. Unknown keys are dropped.
 * An over-bound selected map (too many keys, or an oversized selected key/value) fails the
 * whole operation with `incompatible` rather than truncating retained fields.
 */
function selectSafeMap(raw: Record<string, string>, allow: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const key of Object.keys(raw).sort()) {
    if (!allow.has(key)) continue;
    const value = raw[key] ?? "";
    if (byteLen(key) > MAX_TRIAGE_KEY_BYTES || byteLen(value) > MAX_TRIAGE_VALUE_BYTES) {
      throw new MapError("incompatible");
    }
    out[key] = value;
    count += 1;
    if (count > MAX_TRIAGE_KEYS) throw new MapError("incompatible");
  }
  return out;
}

/** Require a present timestamp to be a parseable finite UTC instant; absent/empty → null. */
function optionalTimestamp(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (!Number.isFinite(Date.parse(value))) throw new MapError("invalid-shape");
  return value;
}

/** A bounded non-empty error string, or null when absent/oversized. */
function boundedError(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  return byteLen(raw) <= SOURCE_MAX_NAME_BYTES ? raw : null;
}

/** Derive the rule family/source identity from a group file: its basename without extension. */
function deriveFamily(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem === "" ? file : stem;
}

/** Map an upstream vmalert health token to the normalized closed union. */
function normalizeHealth(raw: string): VmalertRuleHealth {
  return raw === "ok" ? "healthy" : raw === "err" ? "unhealthy" : "unknown";
}

const ruleSchema = z
  .object({
    name: boundedName,
    type: z.string(),
    state: z.string().optional(),
    health: z.string(),
    lastError: z.string().optional(),
    lastEvaluation: z.string().optional(),
    labels: z.record(z.string()).optional(),
    annotations: z.record(z.string()).optional(),
  })
  .passthrough();

const groupSchema = z
  .object({
    name: boundedName,
    file: boundedName,
    interval: z.number().optional(),
    lastEvaluation: z.string().optional(),
    rules: z.array(ruleSchema),
  })
  .passthrough();

const rulesResponseSchema = z
  .object({
    status: z.literal("success"),
    data: z.object({ groups: z.array(groupSchema) }).passthrough(),
  })
  .passthrough();

/** Map one validated rule envelope to the closed value, validating the discriminator and fields. */
function mapRule(r: z.infer<typeof ruleSchema>): VmalertRule {
  if (r.type !== "alerting" && r.type !== "recording") throw new MapError("invalid-shape");
  let state = "";
  if (r.type === "alerting") {
    if (r.state === undefined || r.state === "" || byteLen(r.state) > SOURCE_MAX_NAME_BYTES) {
      throw new MapError("invalid-shape");
    }
    state = r.state;
  }
  return {
    name: r.name,
    type: r.type,
    state,
    health: normalizeHealth(r.health),
    lastEvaluationAt: optionalTimestamp(r.lastEvaluation),
    lastError: boundedError(r.lastError),
    labels: selectSafeMap(r.labels ?? {}, LABEL_ALLOWLIST),
    annotations: selectAnnotations(r.annotations ?? {}),
    deadman: DEADMAN_RULE_NAMES.has(r.name.toLowerCase()),
  };
}

/** Map one validated group envelope to the closed value with its complete mapped rule set. */
function mapGroup(g: z.infer<typeof groupSchema>): VmalertRuleGroup {
  const intervalSeconds = g.interval !== undefined && Number.isFinite(g.interval) ? g.interval : null;
  return {
    group: g.name,
    file: g.file,
    family: deriveFamily(g.file),
    intervalSeconds,
    lastEvaluationAt: optionalTimestamp(g.lastEvaluation),
    rules: g.rules.map(mapRule),
  };
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Construct a {@link VmalertClient} bound to a validated vmalert base URL. Fails closed
 * (throws {@link SourceConfigError}) on a non-absolute, credential-bearing, or non-HTTP(S)
 * base URL so direct tests exercise the same validation as production config.
 */
export function createVmalertClient(baseUrl: string, options: SourceClientOptions = {}): VmalertClient {
  const base = normalizeBaseUrl(baseUrl);
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SOURCE_TIMEOUT_MS;

  return {
    async rules(): Promise<SourceResult<readonly VmalertRuleGroup[]>> {
      const raw = await fetchJsonUnknown(new URL(base + "/api/v1/rules"), {
        fetchImpl,
        timeoutMs,
        maxBytes: SOURCE_MAX_BODY_BYTES,
      });
      if (!raw.ok) return raw;
      const parsed = rulesResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      try {
        return sourceSuccess(parsed.data.data.groups.map(mapGroup));
      } catch (err) {
        return err instanceof MapError ? sourceFailure(err.kind) : sourceFailure("incompatible");
      }
    },
  };
}
