// packages/web-data/src/sources/vm.ts — the VictoriaMetrics source client
// (03-source-clients-and-validation.md §5). Supports exactly four operations:
//
//   - statusSignals()  one GET /api/v1/query with the fixed status union plus the seven
//                      engine projections, each aliased and joined with `or on (__name__)`;
//   - targets()        one GET /api/v1/targets;
//   - buildInfo()      one GET /api/v1/status/buildinfo;
//   - queryRange(req)  one cancellable GET /api/v1/query_range built only from the closed
//                      VmRangeRequest.
//
// Every consumed vector/matrix/target/buildinfo field is validated from `unknown` with a
// zod schema; additive upstream fields pass and are stripped; a missing/invalid consumed
// nested field fails the whole operation as `invalid-shape`. Missing, NaN, non-finite, and
// insufficient-window projections are retained as unavailable (`value: null`), never zero;
// absent projections simply do not appear. Every method resolves a SourceResult and never
// rejects. The current engine projections live entirely in this instant query — no history
// call is issued for current engine data.

import { z } from "zod";
import {
  SOURCE_MAX_BODY_BYTES,
  SOURCE_MAX_NAME_BYTES,
  SOURCE_TIMEOUT_MS,
} from "../wire/common.js";
import type {
  ScrapeTargetState,
  SourceClientOptions,
  SourceResult,
} from "./types.js";
import { fetchJsonUnknown, normalizeBaseUrl, sourceFailure, sourceSuccess } from "./fetch.js";

// ---------------------------------------------------------------------------
// §5 Consumed value types
// ---------------------------------------------------------------------------

/** One instant-query sample projected from the fixed status/engine union. */
export interface MetricSample {
  /** All labels except the reserved `__name__` metric name. */
  readonly metric: Readonly<Record<string, string>>;
  /** Sample instant in milliseconds since the UNIX epoch. */
  readonly timestampMs: number;
  /** Finite sample value, or null when unavailable (missing/NaN/non-finite). */
  readonly value: number | null;
  /** The projected metric name (`__name__`): a status selector or a unique engine alias. */
  readonly projection: string;
}

/** VictoriaMetrics build identity from `/api/v1/status/buildinfo`. */
export interface VmBuildInfo {
  /** Reported build version string. */
  readonly version: string;
  /** Process start instant in UTC, or null when the endpoint does not report one. */
  readonly startedAt: string | null;
}

/** The closed range request accepted by {@link VmClient.queryRange}; built by the curated binder. */
export interface VmRangeRequest {
  /** Server-authored PromQL expression; never client-supplied. */
  readonly promql: string;
  /** Inclusive range start in whole UNIX seconds. */
  readonly startSeconds: number;
  /** Inclusive range end in whole UNIX seconds. */
  readonly endSeconds: number;
  /** Fixed step width in whole seconds. */
  readonly stepSeconds: number;
}

/** One numeric matrix sample within a range series. */
export interface VmRangeSample {
  /** Sample instant in milliseconds since the UNIX epoch. */
  readonly timestampMs: number;
  /** Finite sample value, or null when unavailable (NaN/non-finite). */
  readonly value: number | null;
}

/** One matrix series returned by a range query. */
export interface VmRangeSeries {
  /** Series label set including the reserved `__name__` metric name. */
  readonly metric: Readonly<Record<string, string>>;
  /** Ascending-ordered samples across the requested window. */
  readonly samples: readonly VmRangeSample[];
}

/** Complete validated range-query result. */
export interface VmRangeResult {
  /** Every validated matrix series. */
  readonly series: readonly VmRangeSeries[];
}

/** The VictoriaMetrics source client. Every method resolves a SourceResult and never throws. */
export interface VmClient {
  /** Issue the one fixed status/engine instant union and return every projected sample. */
  statusSignals(additionalMetrics?: readonly string[]): Promise<SourceResult<readonly MetricSample[]>>;
  /** Issue the one `/api/v1/targets` discovery request and return validated scrape targets. */
  targets(): Promise<SourceResult<readonly ScrapeTargetState[]>>;
  /** Issue the one `/api/v1/status/buildinfo` request and return validated build identity. */
  buildInfo(): Promise<SourceResult<VmBuildInfo>>;
  /** Issue one cancellable `/api/v1/query_range` built only from the closed request. */
  queryRange(
    request: VmRangeRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SourceResult<VmRangeResult>>;
}

// ---------------------------------------------------------------------------
// §5 Fixed instant status/engine union
// ---------------------------------------------------------------------------

/** The existing status selectors preserved at the head of the instant union. */
const STATUS_UNION = "up or pulse_agent_up or pulse_deep_health_up" as const;

/** One aliased engine projection folded into the fixed instant union. */
interface EngineProjection {
  /** Unique `__name__` alias forced via `label_replace`. */
  readonly alias: string;
  /** Server-authored PromQL expression. */
  readonly expr: string;
}

/** The seven current engine projections from §5, in fixed order. */
const ENGINE_PROJECTIONS: readonly EngineProjection[] = [
  { alias: "pulse_web_engine_ingestion_rows_per_second", expr: 'sum(rate(vm_rows_inserted_total{job="victoriametrics"}[5m]))' },
  { alias: "pulse_web_engine_hourly_active_series", expr: 'sum(vm_cache_entries{job="victoriametrics",type="storage/hour_metric_ids"})' },
  { alias: "pulse_web_engine_data_bytes", expr: 'sum(vm_data_size_bytes{job="victoriametrics"})' },
  { alias: "pulse_web_engine_free_disk_bytes", expr: 'min(vm_free_disk_space_bytes{job="victoriametrics"})' },
  { alias: "pulse_web_engine_notification_failures_per_second", expr: 'sum by (integration) (rate(alertmanager_notifications_failed_total{job="alertmanager"}[5m]))' },
  { alias: "pulse_web_engine_notification_latency_p95_seconds", expr: 'histogram_quantile(0.95, sum by (le, integration) (rate(alertmanager_notification_latency_seconds_bucket{job="alertmanager"}[5m])))' },
  { alias: "pulse_web_engine_process_start_seconds", expr: 'process_start_time_seconds{job=~"victoriametrics|vmalert|alertmanager|gatus"}' },
];

/**
 * Build the fixed instant union: the status selectors followed by each engine projection
 * wrapped in `label_replace((EXPR), "__name__", "ALIAS", "job", ".*")`, joined with
 * `or on (__name__)`. Exported for evidence that the union is exact and complete.
 */
export function buildStatusUnionQuery(additionalMetrics: readonly string[] = []): string {
  const projections = ENGINE_PROJECTIONS.map(
    (p) => `label_replace((${p.expr}), "__name__", "${p.alias}", "job", ".*")`,
  );
  const metrics = [...new Set(additionalMetrics)]
    .filter((metric) => /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric))
    .filter((metric) => !["up", "pulse_agent_up", "pulse_deep_health_up"].includes(metric))
    .sort();
  return [STATUS_UNION, ...metrics, ...projections].join(" or on (__name__) ");
}

// ---------------------------------------------------------------------------
// Consumed-body zod schemas (upstream objects use passthrough for additive fields)
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** A non-empty consumed name/id bounded to the §2 512-byte limit. */
const boundedName = z
  .string()
  .min(1)
  .refine((s) => utf8.encode(s).length <= SOURCE_MAX_NAME_BYTES);

/** A raw Prometheus instant value pair `[unixSeconds, "stringValue"]`. */
const valuePair = z.tuple([z.number(), z.string()]);

const vectorSampleSchema = z
  .object({ metric: z.record(z.string()), value: valuePair })
  .passthrough();

const instantResponseSchema = z
  .object({
    status: z.literal("success"),
    data: z
      .object({ resultType: z.literal("vector"), result: z.array(vectorSampleSchema) })
      .passthrough(),
  })
  .passthrough();

const matrixSeriesSchema = z
  .object({ metric: z.record(z.string()), values: z.array(valuePair) })
  .passthrough();

const rangeResponseSchema = z
  .object({
    status: z.literal("success"),
    data: z
      .object({ resultType: z.literal("matrix"), result: z.array(matrixSeriesSchema) })
      .passthrough(),
  })
  .passthrough();

const targetsResponseSchema = z
  .object({
    status: z.literal("success"),
    data: z
      .object({
        activeTargets: z.array(
          z
            .object({
              labels: z.object({ job: boundedName, instance: boundedName }).passthrough(),
              scrapeUrl: z.string().optional(),
              health: z.string(),
              lastScrape: z.string().optional(),
              lastError: z.string().optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

const buildInfoResponseSchema = z
  .object({
    status: z.literal("success"),
    data: z.object({ version: boundedName }).passthrough(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse a Prometheus string-encoded value: finite → number; NaN/±Inf/empty → null. */
function parseSampleValue(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Strip any embedded credentials from a scrape URL; return null when unusable/oversized. */
function sanitizeScrapeUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    const clean = parsed.toString();
    return utf8.encode(clean).length <= SOURCE_MAX_NAME_BYTES ? clean : null;
  } catch {
    return null;
  }
}

/** A bounded non-empty error string, or null when absent/oversized. */
function boundedError(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  return utf8.encode(raw).length <= SOURCE_MAX_NAME_BYTES ? raw : null;
}

/** Map an upstream scrape-health token to the closed union. */
function normalizeHealth(raw: string): ScrapeTargetState["health"] {
  return raw === "up" ? "up" : raw === "down" ? "down" : "unknown";
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Construct a {@link VmClient} bound to a validated VictoriaMetrics base URL. Fails closed
 * (throws {@link SourceConfigError}) on a non-absolute, credential-bearing, or non-HTTP(S)
 * base URL so direct tests exercise the same validation as production config.
 */
export function createVmClient(baseUrl: string, options: SourceClientOptions = {}): VmClient {
  const base = normalizeBaseUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SOURCE_TIMEOUT_MS;

  /** Issue one bounded GET and return the raw decoded body as `unknown`. */
  async function requestJson(
    path: string,
    params: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<SourceResult<unknown>> {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return fetchJsonUnknown(url, {
      fetchImpl,
      timeoutMs,
      maxBytes: SOURCE_MAX_BODY_BYTES,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  return {
    async statusSignals(additionalMetrics = []): Promise<SourceResult<readonly MetricSample[]>> {
      const raw = await requestJson("/api/v1/query", { query: buildStatusUnionQuery(additionalMetrics) });
      if (!raw.ok) return raw;
      const parsed = instantResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      const samples: MetricSample[] = parsed.data.data.result.map((sample) => {
        const { __name__, ...labels } = sample.metric;
        return {
          metric: labels,
          timestampMs: Math.round(sample.value[0] * 1000),
          value: parseSampleValue(sample.value[1]),
          projection: __name__ ?? "",
        };
      });
      return sourceSuccess(samples);
    },

    async targets(): Promise<SourceResult<readonly ScrapeTargetState[]>> {
      const raw = await requestJson("/api/v1/targets", {});
      if (!raw.ok) return raw;
      const parsed = targetsResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      const targets: ScrapeTargetState[] = parsed.data.data.activeTargets.map((t) => ({
        job: t.labels.job,
        instance: t.labels.instance,
        scrapeUrl: sanitizeScrapeUrl(t.scrapeUrl),
        health: normalizeHealth(t.health),
        lastScrapeAt: t.lastScrape !== undefined && t.lastScrape !== "" ? t.lastScrape : null,
        lastError: boundedError(t.lastError),
      }));
      return sourceSuccess(targets);
    },

    async buildInfo(): Promise<SourceResult<VmBuildInfo>> {
      const raw = await requestJson("/api/v1/status/buildinfo", {});
      if (!raw.ok) return raw;
      const parsed = buildInfoResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      return sourceSuccess({ version: parsed.data.data.version, startedAt: null });
    },

    async queryRange(
      request: VmRangeRequest,
      rangeOptions?: { readonly signal?: AbortSignal },
    ): Promise<SourceResult<VmRangeResult>> {
      const raw = await requestJson(
        "/api/v1/query_range",
        {
          query: request.promql,
          start: String(request.startSeconds),
          end: String(request.endSeconds),
          step: String(request.stepSeconds),
        },
        rangeOptions?.signal,
      );
      if (!raw.ok) return raw;
      const parsed = rangeResponseSchema.safeParse(raw.data);
      if (!parsed.success) return sourceFailure("invalid-shape");
      const series: VmRangeSeries[] = [];
      for (const s of parsed.data.data.result) {
        const samples: VmRangeSample[] = [];
        let previousTs = Number.NEGATIVE_INFINITY;
        for (const pair of s.values) {
          const timestampMs = Math.round(pair[0] * 1000);
          // Validate finite, ascending sample instants; reject the whole operation otherwise.
          if (!Number.isFinite(timestampMs) || timestampMs < previousTs) {
            return sourceFailure("invalid-shape");
          }
          previousTs = timestampMs;
          samples.push({ timestampMs, value: parseSampleValue(pair[1]) });
        }
        series.push({ metric: s.metric, samples });
      }
      return sourceSuccess({ series });
    },
  };
}
