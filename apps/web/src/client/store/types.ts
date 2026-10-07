// apps/web/src/client/store/types.ts — the state types of `00-core-definitions.md §4.1`, widened
// by `web-data-tier` (08 §6).
//
// Declarations only, no logic. `AppStore` (index.ts) holds one signal per slot; the four
// placeholder payload slots are narrowed to their concrete `/wire` types behind the same signal
// identity. `ConnectionState` gains the advancing cycle `observation` and the five per-view
// delivery states (08 §6); existing fields retain their local contact/accepted-payload meaning.

import type { CycleObservation, ViewDeliveryState, ViewId } from "@pulse/web-data/wire";

/** Colour scheme preference (REQ-STORE-04). Default `"system"`. */
export type Theme = "system" | "dark" | "light";

/** Layout density (REQ-STORE-04). Default `"desk"`; forced `"wallboard"` under `?kiosk=1`. */
export type Density = "wallboard" | "desk";

/** Live-data phase: before the first snapshot, steady state, or failing past the stale window. */
export type ConnectionPhase = "initial" | "live" | "stale";

/** Transport that filled the store. Only `"poll"` is produced in this member; `web-data-tier`
 *  adds `"sse"` behind the same field (REQ-STORE-03). */
export type Transport = "sse" | "poll";

/** Connection bookkeeping (REQ-STORE-01, 08 §6). Mirrors `PollState` minus the snapshot itself,
 *  widened with the advancing cycle observation and the five per-view delivery states. */
export interface ConnectionState {
  /** Live-data phase for the control channel (transport contact + advancing observation). */
  readonly phase: ConnectionPhase;
  /** Transport that last filled the store. */
  readonly transport: Transport;
  /** Epoch ms of the last valid 200/304 contact, or null before any. */
  readonly lastGoodAt: number | null;
  /** Epoch ms when the current transport/protocol failure streak began, or null when healthy. */
  readonly failingSince: number | null;
  /** Count of accepted new payloads (local monotonic; not the cycle sequence). */
  readonly seq: number;
  /** Latest accepted cycle observation, or null before the first one (08 §5). Distinct from
   *  transport contact and from any payload's material `generatedAt`. */
  readonly observation: CycleObservation | null;
  /** Per-view delivery state, keyed by every `ViewId`; defaults to `{phase:"initial",identity:null}`. */
  readonly views: Readonly<Record<ViewId, ViewDeliveryState>>;
}

/** The current route as written by the router on every navigation (REQ-STORE-05). Structurally
 *  identical to `RouteMatch` so the router's match is assigned without a mapper. */
export interface RouteState {
  path: string;
  view: string;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
}

/** Session identity (REQ-STORE-01). `null` on the store until `web-data-tier` ships the session
 *  route; the shape is fixed here so consumers can be written now. */
export interface SessionState {
  identity: string | null;
  capabilities: Readonly<Record<string, boolean>>;
  authMode: string;
}

/** The selected drill-down target (REQ-STORE-06). `null` on the store = detail panel closed. */
export type SelectedTarget =
  | { kind: "host"; host: string }
  | { kind: "service"; host: string; service: string };

/** Legacy generic per-view payload shape. The four placeholder slots are now narrowed to their
 *  concrete `/wire` types (08 §6); this alias is retained for any consumer that still reads a slot
 *  structurally (e.g. the shell's defensive command-index extraction). */
export type ViewPayload = Readonly<Record<string, unknown>>;
