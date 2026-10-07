// src/client/views/estate/types.ts — view-local types + shared helpers for the estate view
// (spec 00 §3–§7, 01 §2).
//
// Every view-local type the estate surfaces share lives HERE; no other module re-declares them.
// Wire/model types are consumed type-only from their owners (`@pulse/web-data/wire`,
// `@pulse/renderer`) and never redefined in views/estate/** (00 §0).

import type { ReactNode } from "react";
import type { EstatePayload } from "@pulse/web-data/wire";

import type { AppStore } from "../../store/index.js";

// ── §7 URL-state param vocabulary ────────────────────────────────────────────

/** Tab ids double as the Tabs values and the `?tab=` value. */
export type EstateTabId = "inventory" | "coverage" | "findings";
export const DEFAULT_TAB: EstateTabId = "inventory";

const TAB_IDS: readonly EstateTabId[] = ["inventory", "coverage", "findings"];

/** The full landing query vocabulary. Read from store.route.value.query. */
export interface EstateQuery {
  readonly tab: EstateTabId; // ?tab=  (defaults to "inventory")
  readonly q: string; // ?q=    search query (REQ-SRCH-02)
  readonly sev: string; // ?sev=  findings severity filter (REQ-FIND-03)
  readonly code: string; // ?code= findings code filter (REQ-FIND-03)
}

/** Route patterns the estate view owns (registered via its ViewDefinition.routes). */
export const ESTATE_ROUTES = ["/estate/host/:name", "/estate/service/:host/:name"] as const;

// ── §4.1 Delivery state ──────────────────────────────────────────────────────

/** The four semantic delivery causes REQ-DEG-03 requires, plus loading/ready. degrade.tsx adapts
 *  whatever concrete shape web-data-tier writes into this union at a single seam (00 §4.1). */
export type EstateDeliveryState =
  | { readonly kind: "loading" } // first fetch in flight → skeleton
  | { readonly kind: "ready" } // render surfaces from payload
  | { readonly kind: "not-ready"; readonly retryable: true } // 503 before first cycle
  | { readonly kind: "model-absent"; readonly guidance: string } // no rendered tree
  | { readonly kind: "error"; readonly message: string; readonly retryable: true }; // fetch failed

// ── §6 Error-boundary contract ───────────────────────────────────────────────

/** Props for the per-region React boundary (error-boundary.tsx; REQ-OBS-01). */
export interface RegionErrorBoundaryProps {
  /** Region name surfaced in the localized error (e.g. "coverage table"). */
  readonly region: string;
  readonly children: ReactNode;
}

// ── §5 Store read seam ───────────────────────────────────────────────────────

/** Read the typed estate payload through the view's shared store seam. */
export function readEstate(store: AppStore): EstatePayload | null {
  return store.estate.value;
}

// ── §7 Landing query helpers ─────────────────────────────────────────────────

function isTabId(value: string | undefined): value is EstateTabId {
  return value !== undefined && (TAB_IDS as readonly string[]).includes(value);
}

/** Parse the landing query off `store.route.value.query`; an absent or unrecognized `?tab=` falls
 *  back to DEFAULT_TAB, and absent q/sev/code read as `""`. */
export function readEstateQuery(store: AppStore): EstateQuery {
  const query = store.route.value.query;
  const tab = query["tab"];
  return {
    tab: isTabId(tab) ? tab : DEFAULT_TAB,
    q: query["q"] ?? "",
    sev: query["sev"] ?? "",
    code: query["code"] ?? "",
  };
}

/** Serialize a full EstateQuery (no leading `?`). Omits `tab` when it is DEFAULT_TAB and omits
 *  empty q/sev/code so the canonical `/estate` URL stays bare. */
export function estateQueryString(q: EstateQuery): string {
  const params = new URLSearchParams();
  if (q.tab !== DEFAULT_TAB) params.set("tab", q.tab);
  if (q.q !== "") params.set("q", q.q);
  if (q.sev !== "") params.set("sev", q.sev);
  if (q.code !== "") params.set("code", q.code);
  return params.toString();
}
