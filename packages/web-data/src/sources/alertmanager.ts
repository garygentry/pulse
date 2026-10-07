// packages/web-data/src/sources/alertmanager.ts — the Alertmanager v2 source client
// (03-source-clients-and-validation.md §6, 09-identity-audit-and-dark-mutation-seams.md §9).
//
// Reads (createAlertmanagerClient):
//   - alerts()     one GET /api/v2/alerts?active=true&silenced=true&inhibited=true
//   - silences()   one GET /api/v2/silences
//   - status()     one GET /api/v2/status
//   - receivers()  one GET /api/v2/receivers
//
// Reads retain every firing/silenced/inhibited alert with its suppression relations, timing,
// allowlisted triage labels/annotations, complete silences with validated matchers, and safe
// status/receiver summaries. Raw config and credential-bearing fields never enter a result.
//
// Dark writes (createAlertmanagerWriteClient — no M1 apps/web caller may select these):
//   - createSilence(request)  POST   /api/v2/silences  (validated closed input)
//   - expireSilence(id)       DELETE /api/v2/silence/:encodedId
// Writes validate closed bounded input, never retry, and surface every failure as SourceResult
// data. The darkness guard in 09 §11 proves no production import path selects them.
//
// Every consumed nested field is validated from `unknown`; additive upstream fields pass and
// are stripped; a missing/invalid consumed member fails the whole operation. No method rejects.

import { z } from "zod";
import { SOURCE_MAX_BODY_BYTES, SOURCE_MAX_NAME_BYTES, SOURCE_TIMEOUT_MS } from "../wire/common.js";
import type { SilenceMatcher } from "../wire/alerts.js";
import type { FetchLike, SourceClientOptions, SourceResult } from "./types.js";
import { fetchJsonUnknown, normalizeBaseUrl, sourceFailure, sourceSuccess } from "./fetch.js";
import { selectAnnotations } from "./annotations.js";

// ---------------------------------------------------------------------------
// §6 Consumed value types (source-level; the fold adds renderer attribution)
// ---------------------------------------------------------------------------

/** The single derived Alertmanager delivery state, silenced/inhibited taking precedence over firing. */
export type AlertmanagerAlertState = "firing" | "silenced" | "inhibited";

/** One current Alertmanager alert with its derived state, suppression relations, and triage fields. */
export interface AlertmanagerAlert {
  /** Stable non-empty Alertmanager fingerprint. */
  readonly fingerprint: string;
  /** Derived delivery state: silenced > inhibited > firing. */
  readonly state: AlertmanagerAlertState;
  /** Alert name from the `alertname` label. */
  readonly name: string;
  /** Severity from the `severity` label; unknown values remain explicit strings, "" when absent. */
  readonly severity: string;
  /** Alert start in UTC. */
  readonly startsAt: string;
  /** Alert end in UTC. */
  readonly endsAt: string;
  /** Allowlisted bounded triage labels; unknown keys are dropped. */
  readonly labels: Readonly<Record<string, string>>;
  /** Allowlisted bounded triage annotations; unknown keys are dropped. */
  readonly annotations: Readonly<Record<string, string>>;
  /** Matched receiver names, sorted and deduped. */
  readonly receivers: readonly string[];
  /** Matching silence ids, sorted and deduped. */
  readonly silencedBy: readonly string[];
  /** Inhibiting alert fingerprints, sorted and deduped. */
  readonly inhibitedBy: readonly string[];
  /** Optional upstream group identity, null when absent. */
  readonly group: string | null;
}

/** Current lifecycle state of an Alertmanager silence. */
export type AlertmanagerSilenceState = "active" | "pending" | "expired";

/** One Alertmanager silence with validated matchers and lifecycle state. */
export interface AlertmanagerSilence {
  /** Alertmanager silence id. */
  readonly id: string;
  /** Complete validated matcher set. */
  readonly matchers: readonly SilenceMatcher[];
  /** Bounded creator display value. */
  readonly createdBy: string;
  /** Bounded operator comment. */
  readonly comment: string;
  /** Silence start in UTC. */
  readonly startsAt: string;
  /** Silence expiry in UTC. */
  readonly endsAt: string;
  /** Current silence lifecycle state. */
  readonly state: AlertmanagerSilenceState;
}

/** Safe Alertmanager cluster summary; never carries peer addresses or raw config. */
export interface AlertmanagerClusterSummary {
  /** Bounded cluster status token (e.g. `ready`, `settling`, `disabled`). */
  readonly status: string;
  /** Number of cluster peers, or null when the endpoint does not report peers. */
  readonly peerCount: number | null;
}

/** Safe Alertmanager status summary; version and cluster only, never raw config. */
export interface AlertmanagerStatus {
  /** Reported Alertmanager version string. */
  readonly version: string;
  /** Process uptime instant in UTC, or null when absent. */
  readonly uptime: string | null;
  /** Safe cluster summary. */
  readonly cluster: AlertmanagerClusterSummary;
}

/** One configured Alertmanager receiver with its safe integration names. */
export interface AlertmanagerReceiver {
  /** Bounded receiver name. */
  readonly name: string;
  /** Integration names, sorted and deduped; empty when the endpoint reports names only. */
  readonly integrations: readonly string[];
}

/** The read-only Alertmanager source client. Every method resolves a SourceResult and never throws. */
export interface AlertmanagerClient {
  /** GET the full active/silenced/inhibited alert set and return every alert with relations. */
  alerts(): Promise<SourceResult<readonly AlertmanagerAlert[]>>;
  /** GET all silences and return complete validated silence records. */
  silences(): Promise<SourceResult<readonly AlertmanagerSilence[]>>;
  /** GET the cluster/version status and return the safe summary only. */
  status(): Promise<SourceResult<AlertmanagerStatus>>;
  /** GET the configured receivers and return safe receiver summaries. */
  receivers(): Promise<SourceResult<readonly AlertmanagerReceiver[]>>;
}

// ---------------------------------------------------------------------------
// §6.3 Dark write contracts
// ---------------------------------------------------------------------------

/** The closed, validated request accepted by {@link AlertmanagerWriteClient.createSilence}. */
export interface CreateSilenceRequest {
  /** One or more validated matchers scoping the silence. */
  readonly matchers: readonly SilenceMatcher[];
  /** Silence start in UTC (parseable finite instant). */
  readonly startsAt: string;
  /** Silence expiry in UTC (parseable finite instant). */
  readonly endsAt: string;
  /** Bounded non-empty creator identity. */
  readonly createdBy: string;
  /** Bounded non-empty operator comment. */
  readonly comment: string;
}

/** Result of a successful {@link AlertmanagerWriteClient.createSilence}. */
export interface CreatedSilence {
  /** Non-empty id of the created silence. */
  readonly id: string;
}

/** The dark Alertmanager write client. No M1 apps/web production module may select these methods. */
export interface AlertmanagerWriteClient {
  /** Validate the closed request then POST one silence; success requires a non-empty returned id. Never retries. */
  createSilence(
    request: CreateSilenceRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SourceResult<CreatedSilence>>;
  /** Validate/bound an id then DELETE one silence; success is an accepted 2xx. Never retries. */
  expireSilence(
    id: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SourceResult<null>>;
}

// ---------------------------------------------------------------------------
// Validation helpers and consumed-body schemas
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** Byte length of a string as UTF-8. */
function byteLen(s: string): number {
  return utf8.encode(s).length;
}

/** A non-empty consumed name/id bounded to the §2 512-byte limit. */
const boundedName = z
  .string()
  .min(1)
  .refine((s) => byteLen(s) <= SOURCE_MAX_NAME_BYTES);

/** A bounded free-text value (creator/comment) up to the §2 512-byte name limit. */
const boundedText = z.string().refine((s) => byteLen(s) <= SOURCE_MAX_NAME_BYTES);

/** Allowlisted triage label keys (§6.2): alert name, severity, host/service/instance identity. */
const LABEL_ALLOWLIST: ReadonlySet<string> = new Set(["alertname", "severity", "host", "service", "instance"]);

/** §2 triage-label bounds: at most 32 selected keys, key ≤128 bytes, value ≤256 bytes. Annotations are
 *  bounded separately (`selectAnnotations`). */
const MAX_TRIAGE_KEYS = 32;
const MAX_TRIAGE_KEY_BYTES = 128;
const MAX_TRIAGE_VALUE_BYTES = 256;

/** Internal classification thrown while mapping a validated envelope to a closed value. */
class MapError extends Error {
  constructor(readonly kind: "invalid-shape" | "incompatible") {
    super(kind);
    this.name = "MapError";
  }
}

/**
 * Select and bound the allowlisted subset of a triage map. Unknown keys are dropped. An
 * over-bound selected map (too many keys, or an oversized selected key/value) fails the whole
 * operation with `incompatible` rather than truncating relationships required for triage.
 */
function selectTriageMap(raw: Record<string, string>, allow: ReadonlySet<string>): Record<string, string> {
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

/** Sort, dedupe, and bound a relationship-id array; any empty/oversized member fails the operation. */
function sortDedupeBounded(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value === "" || byteLen(value) > SOURCE_MAX_NAME_BYTES) throw new MapError("invalid-shape");
    seen.add(value);
  }
  return [...seen].sort();
}

/** Require a parseable finite UTC instant; otherwise fail the operation. */
function requireTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new MapError("invalid-shape");
  return value;
}

const alertSchema = z
  .object({
    fingerprint: boundedName,
    labels: z.record(z.string()),
    annotations: z.record(z.string()).optional(),
    startsAt: z.string(),
    endsAt: z.string(),
    status: z
      .object({
        state: z.string(),
        silencedBy: z.array(z.string()).optional(),
        inhibitedBy: z.array(z.string()).optional(),
      })
      .passthrough(),
    receivers: z.array(z.object({ name: z.string() }).passthrough()).optional(),
    group: z.string().optional(),
  })
  .passthrough();

const alertsResponseSchema = z.array(alertSchema);

const matcherSchema = z
  .object({
    name: boundedName,
    value: boundedText,
    isRegex: z.boolean(),
    isEqual: z.boolean().optional(),
  })
  .passthrough();

const silenceSchema = z
  .object({
    id: boundedName,
    matchers: z.array(matcherSchema),
    createdBy: boundedText,
    comment: boundedText,
    startsAt: z.string(),
    endsAt: z.string(),
    status: z.object({ state: z.string() }).passthrough(),
  })
  .passthrough();

const silencesResponseSchema = z.array(silenceSchema);

const statusResponseSchema = z
  .object({
    versionInfo: z.object({ version: boundedName }).passthrough(),
    cluster: z
      .object({ status: boundedName, peers: z.array(z.unknown()).optional() })
      .passthrough(),
    uptime: z.string().optional(),
  })
  .passthrough();

const receiversResponseSchema = z.array(
  z
    .object({
      name: boundedName,
      integrations: z.array(z.object({ name: z.string() }).passthrough()).optional(),
    })
    .passthrough(),
);

/** Strict closed schema for the dark createSilence request; extra keys are rejected. */
const createSilenceRequestSchema = z
  .object({
    matchers: z
      .array(
        z
          .object({
            name: boundedName,
            value: boundedText,
            isRegex: z.boolean(),
            isEqual: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    startsAt: z.string().refine((s) => Number.isFinite(Date.parse(s))),
    endsAt: z.string().refine((s) => Number.isFinite(Date.parse(s))),
    createdBy: boundedName,
    comment: boundedName,
  })
  .strict();

const createSilenceResponseSchema = z.object({ silenceID: boundedName }).passthrough();

/** Map one validated alert envelope to the closed value, deriving state and bounding triage maps. */
function mapAlert(a: z.infer<typeof alertSchema>): AlertmanagerAlert {
  const alertname = a.labels["alertname"];
  if (alertname === undefined || alertname === "" || byteLen(alertname) > SOURCE_MAX_NAME_BYTES) {
    throw new MapError("invalid-shape");
  }
  const labels = selectTriageMap(a.labels, LABEL_ALLOWLIST);
  const annotations = selectAnnotations(a.annotations ?? {});
  const silencedBy = sortDedupeBounded(a.status.silencedBy ?? []);
  const inhibitedBy = sortDedupeBounded(a.status.inhibitedBy ?? []);
  const receivers = sortDedupeBounded((a.receivers ?? []).map((r) => r.name));
  const state: AlertmanagerAlertState =
    silencedBy.length > 0 ? "silenced" : inhibitedBy.length > 0 ? "inhibited" : "firing";
  const group = a.group !== undefined && a.group !== "" ? a.group : null;
  if (group !== null && byteLen(group) > SOURCE_MAX_NAME_BYTES) throw new MapError("invalid-shape");
  return {
    fingerprint: a.fingerprint,
    state,
    name: alertname,
    severity: a.labels["severity"] ?? "",
    startsAt: requireTimestamp(a.startsAt),
    endsAt: requireTimestamp(a.endsAt),
    labels,
    annotations,
    receivers,
    silencedBy,
    inhibitedBy,
    group,
  };
}

/** Map one validated silence envelope to the closed value, validating the lifecycle state. */
function mapSilence(s: z.infer<typeof silenceSchema>): AlertmanagerSilence {
  const rawState = s.status.state;
  if (rawState !== "active" && rawState !== "pending" && rawState !== "expired") {
    throw new MapError("invalid-shape");
  }
  const matchers: SilenceMatcher[] = s.matchers.map((m) => ({
    name: m.name,
    value: m.value,
    isRegex: m.isRegex,
    isEqual: m.isEqual ?? true,
  }));
  return {
    id: s.id,
    matchers,
    createdBy: s.createdBy,
    comment: s.comment,
    startsAt: requireTimestamp(s.startsAt),
    endsAt: requireTimestamp(s.endsAt),
    state: rawState,
  };
}

/** Validate/bound a silence id for the expire DELETE: non-empty, ≤512 bytes, control-free. */
function isValidSilenceId(id: string): boolean {
  if (id === "" || byteLen(id) > SOURCE_MAX_NAME_BYTES) return false;
  // Reject any C0/C1 control, DEL, or line break in the path segment.
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------

/** Shared per-client request context bound to a validated base URL. */
interface RequestContext {
  readonly base: string;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
}

function resolveContext(baseUrl: string, options: SourceClientOptions): RequestContext {
  return {
    base: normalizeBaseUrl(baseUrl),
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? SOURCE_TIMEOUT_MS,
  };
}

/**
 * Construct an {@link AlertmanagerClient} bound to a validated Alertmanager base URL. Fails
 * closed ({@link SourceConfigError}) on a non-absolute, credential-bearing, or non-HTTP(S) URL.
 */
export function createAlertmanagerClient(
  baseUrl: string,
  options: SourceClientOptions = {},
): AlertmanagerClient {
  const ctx = resolveContext(baseUrl, options);

  async function getJson(
    path: string,
    params: Readonly<Record<string, string>>,
  ): Promise<SourceResult<unknown>> {
    const url = new URL(ctx.base + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return fetchJsonUnknown(url, { fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs, maxBytes: SOURCE_MAX_BODY_BYTES });
  }

  return {
    async alerts(): Promise<SourceResult<readonly AlertmanagerAlert[]>> {
      const raw = await getJson("/api/v2/alerts", { active: "true", silenced: "true", inhibited: "true" });
      if (!raw.ok) return raw;
      const parsed = alertsResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      try {
        const alerts = parsed.data.map(mapAlert);
        alerts.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
        return sourceSuccess(alerts);
      } catch (err) {
        return err instanceof MapError ? sourceFailure(err.kind) : sourceFailure("incompatible");
      }
    },

    async silences(): Promise<SourceResult<readonly AlertmanagerSilence[]>> {
      const raw = await getJson("/api/v2/silences", {});
      if (!raw.ok) return raw;
      const parsed = silencesResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      try {
        const silences = parsed.data.map(mapSilence);
        silences.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return sourceSuccess(silences);
      } catch (err) {
        return err instanceof MapError ? sourceFailure(err.kind) : sourceFailure("incompatible");
      }
    },

    async status(): Promise<SourceResult<AlertmanagerStatus>> {
      const raw = await getJson("/api/v2/status", {});
      if (!raw.ok) return raw;
      const parsed = statusResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      const peers = parsed.data.cluster.peers;
      return sourceSuccess({
        version: parsed.data.versionInfo.version,
        uptime: parsed.data.uptime !== undefined && parsed.data.uptime !== "" ? parsed.data.uptime : null,
        cluster: { status: parsed.data.cluster.status, peerCount: peers !== undefined ? peers.length : null },
      });
    },

    async receivers(): Promise<SourceResult<readonly AlertmanagerReceiver[]>> {
      const raw = await getJson("/api/v2/receivers", {});
      if (!raw.ok) return raw;
      const parsed = receiversResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      try {
        const receivers: AlertmanagerReceiver[] = parsed.data.map((r) => ({
          name: r.name,
          integrations: sortDedupeBounded((r.integrations ?? []).map((i) => i.name)),
        }));
        receivers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return sourceSuccess(receivers);
      } catch (err) {
        return err instanceof MapError ? sourceFailure(err.kind) : sourceFailure("incompatible");
      }
    },
  };
}

/**
 * Construct an {@link AlertmanagerWriteClient} for the dark M1 silence mutations. Fails closed on
 * an invalid base URL. The write methods validate closed bounded input, never retry, and surface
 * every failure as SourceResult data. No M1 apps/web production module may import this factory;
 * the darkness guard in 09 §11 proves it.
 */
export function createAlertmanagerWriteClient(
  baseUrl: string,
  options: SourceClientOptions = {},
): AlertmanagerWriteClient {
  const ctx = resolveContext(baseUrl, options);

  return {
    async createSilence(
      request: CreateSilenceRequest,
      writeOptions?: { readonly signal?: AbortSignal },
    ): Promise<SourceResult<CreatedSilence>> {
      const validated = createSilenceRequestSchema.safeParse(request);
      if (!validated.success) return sourceFailure("invalid-shape");
      const body = JSON.stringify({
        matchers: validated.data.matchers.map((m) => ({
          name: m.name,
          value: m.value,
          isRegex: m.isRegex,
          isEqual: m.isEqual,
        })),
        startsAt: validated.data.startsAt,
        endsAt: validated.data.endsAt,
        createdBy: validated.data.createdBy,
        comment: validated.data.comment,
      });
      const raw = await fetchJsonUnknown(new URL(ctx.base + "/api/v2/silences"), {
        fetchImpl: ctx.fetchImpl,
        timeoutMs: ctx.timeoutMs,
        maxBytes: SOURCE_MAX_BODY_BYTES,
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        ...(writeOptions?.signal !== undefined ? { signal: writeOptions.signal } : {}),
      });
      if (!raw.ok) return raw;
      const parsed = createSilenceResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      return sourceSuccess({ id: parsed.data.silenceID });
    },

    async expireSilence(
      id: string,
      writeOptions?: { readonly signal?: AbortSignal },
    ): Promise<SourceResult<null>> {
      if (!isValidSilenceId(id)) return sourceFailure("invalid-shape");
      const raw = await fetchJsonUnknown(new URL(ctx.base + `/api/v2/silence/${encodeURIComponent(id)}`), {
        fetchImpl: ctx.fetchImpl,
        timeoutMs: ctx.timeoutMs,
        maxBytes: SOURCE_MAX_BODY_BYTES,
        method: "DELETE",
        allowEmptyBody: true,
        ...(writeOptions?.signal !== undefined ? { signal: writeOptions.signal } : {}),
      });
      if (!raw.ok) return raw;
      return sourceSuccess(null);
    },
  };
}
