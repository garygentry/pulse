// src/client/views/estate/delivery.ts — pure delivery-state adapter and per-artifact availability
// classifier for the estate view. The renderers live in degrade.tsx.

import type {
  AvailabilitySection,
  DataAvailability,
  EstatePayload,
  EstateTargetState,
} from "@pulse/web-data/wire";

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
  // A transport failure (Pulse unreachable or too slow, or the auth proxy's session expired) with a retained estate keeps that estate on
  // screen: the phase branch below renders it, and readEstate marks it app-stale with the transport
  // problem named, as engine/timeline and the shell's stale callout do. Only a first load with
  // nothing to show falls through to the full error state.
  const retainedThroughTransportFailure =
    payload !== null && isRecord(failure) && isTransportFailureCode(failure["code"]);
  if (isRecord(failure) && !retainedThroughTransportFailure) {
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
      // The whole payload still renders. While the app itself is stale, readEstate downgrades its
      // current sections (withAppStaleness), so no badge stays ok.
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

// ── App-level staleness ──────────────────────────────────────────────────────

/** The note a section carries when the payload says `current` but the app itself is not. */
export const APP_STALE_MESSAGE = "Not refreshed from the Pulse server; showing the last delivered estate.";

/** Client transport failure codes: the Pulse server was unreachable or did not answer in time, or
 *  an auth proxy answered in its place because the sign-in session expired. */
const TRANSPORT_FAILURE_CODES: ReadonlySet<unknown> = new Set(["SERVER_UNREACHABLE", "SERVER_TIMEOUT", "SESSION_EXPIRED"]);

function isTransportFailureCode(code: unknown): boolean {
  return TRANSPORT_FAILURE_CODES.has(code);
}

/**
 * The app-stale note for the current connection: when the estate refetch failed in transport, the
 * note names that problem ("The Pulse server could not be reached; showing the last delivered
 * estate."); otherwise the generic {@link APP_STALE_MESSAGE}.
 */
export function appStaleMessage(connection: unknown): string {
  const views = isRecord(connection) ? connection["views"] : undefined;
  const estate = isRecord(views) ? views["estate"] : undefined;
  const failure = isRecord(estate) ? estate["failure"] : undefined;
  if (!isRecord(failure) || !isTransportFailureCode(failure["code"])) return APP_STALE_MESSAGE;
  const message = failure["message"];
  if (typeof message !== "string" || message === "") return APP_STALE_MESSAGE;
  return `${message.replace(/\.$/, "")}; showing the last delivered estate.`;
}

/**
 * Whether the retained estate payload can no longer be trusted as current. Stale when the connection
 * is not `live` (the same signal as the shell's stale-data callout: the app server unreachable or
 * its cycle stalled past the stale window, or no cycle observation yet), or when estate delivery is
 * not current AND its refetch actually failed. A non-current delivery with no failure is an
 * in-flight refetch of a newer identity on a healthy connection; treating that as stale would flip
 * every badge on each estate change. Unrecognized shapes fail closed to stale.
 */
export function isEstateViewStale(connection: unknown): boolean {
  if (!isRecord(connection) || connection["phase"] !== "live") return true;
  const views = connection["views"];
  const estate = isRecord(views) ? views["estate"] : undefined;
  if (!isRecord(estate)) return true;
  if (estate["phase"] === "current") return false;
  const failure = estate["failure"];
  return failure !== null && failure !== undefined;
}

function downgrade(availability: DataAvailability, message: string): DataAvailability {
  return availability.state === "current"
    ? { ...availability, state: "stale", message }
    : availability;
}

/** A live target with `current` evidence gets the stale copy; anything else, including a malformed
 *  entry the inventory renders as its own error row, passes through untouched. */
function downgradeTarget(entry: EstateTargetState, message: string): EstateTargetState {
  const raw: unknown = entry;
  if (!isRecord(raw)) return entry;
  const availability = raw["availability"];
  if (!isRecord(availability) || availability["state"] !== "current") return entry;
  return { ...entry, availability: downgrade(entry.availability, message) };
}

function downgradeSection<T>(section: AvailabilitySection<T>, message: string): AvailabilitySection<T> {
  const raw: unknown = section;
  if (!isRecord(raw) || !isRecord(raw["availability"])) return section;
  return section.availability.state === "current"
    ? ({ ...section, availability: downgrade(section.availability, message) } as AvailabilitySection<T>)
    : section;
}

/** One downgraded copy per payload object and note, so memoized consumers see a stable identity. */
const appStaleCache = new WeakMap<EstatePayload, Map<string, EstatePayload>>();

/** A memoized getter: computes on first successful read, rethrows a failing read every time. */
function lazy<T>(compute: () => T): PropertyDescriptor {
  let done = false;
  let value: T | undefined;
  return {
    enumerable: true,
    get(): T {
      if (!done) {
        value = compute();
        done = true;
      }
      return value as T;
    },
  };
}

/**
 * The payload as an app-stale view must render it: every `current` availability (each live target
 * and each artifact section) becomes `stale` with `message` (default {@link APP_STALE_MESSAGE}), so every badge that
 * already downgrades on non-current evidence (inventory coverage/live, coverage tab, entity page)
 * stops reading ok (I3). Non-current states keep their own, more specific state. The rendered
 * model itself is reused unchanged.
 *
 * Each field is read lazily, where its consumer reads it, so a fault in one section still lands in
 * that region's error boundary rather than at the view root.
 */
export function withAppStaleness(payload: EstatePayload, message: string = APP_STALE_MESSAGE): EstatePayload {
  let byMessage = appStaleCache.get(payload);
  if (byMessage === undefined) {
    byMessage = new Map();
    appStaleCache.set(payload, byMessage);
  }
  const cached = byMessage.get(message);
  if (cached !== undefined) return cached;
  const stale = Object.defineProperties({} as EstatePayload, {
    generatedAt: lazy(() => payload.generatedAt),
    estate: lazy(() => payload.estate),
    liveTargets: lazy(() => {
      const targets: unknown = payload.liveTargets;
      return Array.isArray(targets)
        ? targets.map((t: EstateTargetState) => downgradeTarget(t, message))
        : payload.liveTargets;
    }),
    coverage: lazy(() => downgradeSection(payload.coverage, message)),
    findings: lazy(() => downgradeSection(payload.findings, message)),
    declaredVersusScraped: lazy(() => downgradeSection(payload.declaredVersusScraped, message)),
  });
  byMessage.set(message, stale);
  return stale;
}
