// src/client/views/alerts/detail/history-client.ts — the alerts view's ONLY on-demand upstream fetch:
// one GET /api/history/alerts?range=<RangeId> per pane open.
//
// Deliberately not routed through api/client.ts's apiFetch: this endpoint discriminates success and
// failure bodies by shape (`operation === "alert-intervals"`) and maps them to HistoryViewState.
// apiFetch would flatten an ErrorEnvelope into an incorrectly typed successful result.
import type { ErrorEnvelope, IntervalHistoryPayload, RangeId } from "@pulse/web-data/wire";
import type { HistoryViewState } from "./history-model.js";

/** The settled outcomes of one history request. */
export type AlertHistoryResult = Extract<HistoryViewState, { readonly kind: "ready" | "error" }>;

/** Type guard: a successful interval-history payload vs. an ErrorEnvelope. Total, pure. */
function isIntervalHistoryPayload(
  body: IntervalHistoryPayload | ErrorEnvelope,
): body is IntervalHistoryPayload {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { operation?: unknown }).operation === "alert-intervals"
  );
}

/** Error code carried by a non-payload body; a malformed body without a string code is a network fault. */
function errorCode(body: unknown): string {
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "NETWORK_ERROR";
}

/**
 * Fetch the alert firing history for `range`. Never throws: resolves to a ready/error state, or to
 * null when `signal` aborted mid-flight (a lifecycle event the caller drops, never a rendered error).
 */
export async function fetchAlertHistory(
  range: RangeId,
  signal: AbortSignal,
): Promise<AlertHistoryResult | null> {
  try {
    // Read through globalThis at call time (not a bare `fetch` binding) so tests can stub it.
    const res = await globalThis.fetch(`/api/history/alerts?range=${encodeURIComponent(range)}`, {
      signal,
      headers: { accept: "application/json" },
    });
    // Overflow/error responses are ErrorEnvelope bodies regardless of HTTP status.
    const body = (await res.json()) as IntervalHistoryPayload | ErrorEnvelope;
    if (signal.aborted) return null; // closed/re-opened mid-flight — drop the stale result
    if (isIntervalHistoryPayload(body)) return { kind: "ready", payload: body };
    return { kind: "error", code: errorCode(body) };
  } catch (err) {
    // AbortError on close/re-open is a lifecycle event, never a rendered error.
    if (signal.aborted || (err instanceof Error && err.name === "AbortError")) return null;
    return { kind: "error", code: "NETWORK_ERROR" };
  }
}
