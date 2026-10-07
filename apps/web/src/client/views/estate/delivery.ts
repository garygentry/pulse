// src/client/views/estate/delivery.ts — pure delivery-state adapter and per-artifact availability
// classifier for the estate view. The renderers live in degrade.tsx.

import type { AvailabilitySection, EstatePayload } from "@pulse/web-data/wire";

import type { EstateDeliveryState } from "./types.js";

/**
 * The store delivery input. `toDeliveryState` still accepts `unknown` so malformed or older values
 * fail safe. Recognized: an already-adapted `EstateDeliveryState`; the phase-based
 * `ViewDeliveryState` with an optional failure; and an HTTP-status-flavored `{ status }`.
 */
export type RawDelivery =
  | EstateDeliveryState
  | {
      readonly phase: "initial" | "current" | "stale";
      readonly identity: unknown;
      readonly failure?: { readonly code?: string; readonly status: number; readonly message: string } | null;
    }
  | { readonly status: number }
  | null
  | undefined;

/** Configuration guidance shown when no rendered estate tree exists. */
export const DEFAULT_MODEL_ABSENT_GUIDANCE =
  "No rendered estate is loaded. Run a render cycle (or check that the estate " +
  "source is configured) to populate /estate.";

type Rec = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null;
}

/** Re-validate a candidate `EstateDeliveryState` field-by-field so a half-formed object never
 *  passes through (e.g. `{kind:"error"}` without a message). */
function asDeliveryState(raw: Rec): EstateDeliveryState | null {
  switch (raw["kind"]) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      return { kind: "ready" };
    case "not-ready":
      return { kind: "not-ready", retryable: true };
    case "model-absent":
      return {
        kind: "model-absent",
        guidance: typeof raw["guidance"] === "string" ? raw["guidance"] : DEFAULT_MODEL_ABSENT_GUIDANCE,
      };
    case "error":
      return {
        kind: "error",
        message: typeof raw["message"] === "string" ? raw["message"] : "Request failed",
        retryable: true,
      };
    default:
      return null;
  }
}

/**
 * Map the raw store-provided delivery signal into `EstateDeliveryState`. THE SINGLE ADAPTER SITE:
 * view.tsx calls this once per render; no other module inspects the raw shape. First match wins.
 * Safe default: an unrecognized shape is `ready` ONLY when a real payload is
 * present — otherwise `loading`, never `ready`.
 */
export function toDeliveryState(raw: unknown, payload: EstatePayload | null): EstateDeliveryState {
  const fallback: EstateDeliveryState = payload !== null ? { kind: "ready" } : { kind: "loading" };
  if (!isRecord(raw)) return fallback;

  const adapted = asDeliveryState(raw);
  if (adapted !== null) return adapted;

  const failure = raw["failure"];
  if (isRecord(failure)) {
    const failureCode = failure["code"];
    const failureStatus = failure["status"];
    const failureMessage = failure["message"];
    if (typeof failureStatus === "number" && Number.isFinite(failureStatus)) {
      if (failureCode === "NOT_READY") return { kind: "not-ready", retryable: true };
      if (typeof failureCode === "string" && failureCode.startsWith("ESTATE_BUNDLE_")) {
        return { kind: "model-absent", guidance: DEFAULT_MODEL_ABSENT_GUIDANCE };
      }
      // Older delivery values did not retain an envelope code. Preserve their documented 503
      // fallback while all current live-state failures use the semantic branches above.
      if (failureCode === undefined && failureStatus === 503) return { kind: "not-ready", retryable: true };
      return {
        kind: "error",
        message: typeof failureMessage === "string" ? failureMessage : "Request failed",
        retryable: true,
      };
    }
  }

  const status = raw["status"];
  if (typeof status === "number" && Number.isFinite(status)) {
    if (status === 503) return { kind: "not-ready", retryable: true };
    if (status >= 400) return { kind: "error", message: `Request failed (${status})`, retryable: true };
  }

  switch (raw["phase"]) {
    case "initial":
      return fallback;
    case "current":
      return payload !== null
        ? { kind: "ready" }
        : { kind: "model-absent", guidance: DEFAULT_MODEL_ABSENT_GUIDANCE };
    case "stale":
      // Per-artifact staleness is rendered per section; the whole payload still renders.
      return { kind: "ready" };
    default:
      return fallback;
  }
}

/** The four availability outcomes for a sub-artifact. */
export type AvailabilityClass = "absent" | "empty" | "stale" | "ok";

/**
 * Classify one `AvailabilitySection<T>`. First match wins: null value → absent; non-`current`
 * availability (stale / unavailable / not-configured) → stale; `isEmpty` → empty; else ok. Never
 * `ok` unless the value is present AND current.
 */
export function classifyAvailability<T>(
  section: AvailabilitySection<T>,
  isEmpty: (value: T) => boolean,
): AvailabilityClass {
  if (section.value === null) return "absent";
  if (section.availability.state !== "current") return "stale";
  return isEmpty(section.value) ? "empty" : "ok";
}
