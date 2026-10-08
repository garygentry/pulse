// apps/web/src/client/views/timeline/url-state.ts
// Timeline URL codec (05 §4): decode/validate the router query into TimelineUrlState with one
// fallback notice per invalid key, encode state back (unrelated keys preserved, every key and value
// percent-encoded), and the pure transitions 07 applies before navigating. Pure and total: nothing
// here throws, and nothing here navigates (07 owns router.navigate).
import type { RangeId, TargetIdentity } from "@pulse/web-data/wire";
import type { RouteMatch } from "../../router.js";
import { isKiosk } from "../../shell/kiosk.js";
import { MIN_ZOOM_STEPS } from "../_shared/timeseries/axis.js";
import type { TimeWindow } from "../_shared/timeseries/axis.js";
import { normalizeTargetRef, targetRef } from "../../target-ref.js";
import { findLane } from "./model.js";
import type { LaneNode, LaneTree } from "./model.js";
import { DEFAULT_RANGE, RANGE_SECONDS, TIMELINE_RANGES, timelineStepSeconds } from "../_shared/timeseries/query-meta.js";

// ---------------------------------------------------------------------------
// Types and constants (00 §5.7, §6.3, §6.4)
// ---------------------------------------------------------------------------

/** Decoded, validated timeline URL state (REQ-URL-01, D6). */
export interface TimelineUrlState {
  /** Selected range. */ readonly range: RangeId;
  /** Pause anchor in epoch seconds; null = live. */ readonly end: number | null;
  /** Zoom window in epoch seconds; null = full range. */ readonly zoom: { readonly start: number; readonly end: number } | null;
  /** Selected lane target, or null. */ readonly sel: (TargetIdentity & { readonly kind: "host" | "service" }) | null;
}

/** A value that was present but invalid and fell back to default (REQ-URL-02). */
export interface UrlFallbackNotice {
  /** Which key fell back. */ readonly key: "range" | "end" | "zoom" | "sel";
  /** Human-readable notice text. */ readonly message: string;
}

/** Result of decoding the query map. */
export interface DecodedTimelineUrl {
  /** Validated state (defaults substituted for invalid values). */ readonly state: TimelineUrlState;
  /** One notice per key that fell back. */ readonly notices: readonly UrlFallbackNotice[];
}

/** Timeline-owned query keys (REQ-URL-01). The router's CARRIED_QUERY_KEYS (kiosk, rotate) are preserved, never owned. */
export const TIMELINE_QUERY_KEYS = { range: "range", end: "end", zoom: "zoom", sel: "sel" } as const;

/** How far in the future a URL `end` may lie before it is rejected (clock skew allowance), seconds. */
export const END_FUTURE_TOLERANCE_S = 60;

// ---------------------------------------------------------------------------
// Decode (05 §4.3)
// ---------------------------------------------------------------------------

const INT_PATTERN = /^\d{1,12}$/;
const ZOOM_PATTERN = /^(\d{1,12})-(\d{1,12})$/;
const SEL_ID_MAX = 512;
const DISPLAY_RAW_MAX = 40;

function present(v: string | undefined): string | null {
  return v === undefined || v === "" ? null : v;
}
function displayRaw(raw: string): string {
  return raw.length <= DISPLAY_RAW_MAX ? raw : `${raw.slice(0, DISPLAY_RAW_MAX)}…`;
}
function isTimelineRange(v: string): v is RangeId {
  return (TIMELINE_RANGES as readonly string[]).includes(v);
}
function parseEpochSeconds(raw: string): number | null {
  if (!INT_PATTERN.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Canonical id prefix → lane kind. Lane ids are the wire's canonical drilldown ids, so the prefix
 *  alone names the kind. */
const SEL_KINDS = [
  ["host:", "host"],
  ["svc:", "service"],
] as const;

/**
 * A `sel` value → its lane identity, or null when malformed. The value is a canonical reference
 * (`host:web01`, `svc:web01/nginx`); a pre-#17 double-prefixed one (`host:host:web01`,
 * `service:svc:web01/nginx`) is normalized to it first, so old links keep selecting their lane.
 */
function decodeSel(raw: string): TimelineUrlState["sel"] {
  const ref = normalizeTargetRef(raw);
  if (ref.length > SEL_ID_MAX) return null;
  for (const [prefix, kind] of SEL_KINDS) {
    if (ref.startsWith(prefix) && ref.length > prefix.length) return { kind, id: ref };
  }
  return null;
}

/**
 * Decode and validate the router's query map into timeline state. Each invalid key falls back to its
 * default and produces one notice (REQ-URL-02). Pure and total: never throws.
 *
 * Kiosk (`kiosk=1`): `range` is honoured; `end`, `zoom` and `sel` are ignored without notices, and
 * the state is always live (REQ-KIOSK-03, TS §3.11).
 *
 * `sel` is checked for shape only. Tree membership is checked later by `validateSel`, once the lane
 * tree exists (TS §5.2). Its value is the canonical target reference (`targetRef`): `host:web01` or
 * `svc:web01/nginx`, the kind shown once. Pre-#17 links wrote the internal `targetKey` form
 * (`host:host:web01`, `service:svc:web01/nginx`) and still decode to the same lane.
 *
 * If `zoom` is valid and `end` is absent (a hand-written URL; this module never encodes that
 * combination), `end` is set to `floor(nowSec)`. The zoom was validated against that window, and
 * a zoomed page is paused (REQ-FOLLOW-02). See §4.7 for the rewrite to canonical form.
 *
 * @param query - `router.current().query` (flat, already URL-decoded).
 * @param nowSec - Current time in epoch seconds. `07` passes the same value it uses for the initial live domain end.
 * @returns The validated state and its fallback notices.
 */
export function decodeTimelineUrl(query: RouteMatch["query"], nowSec: number): DecodedTimelineUrl {
  const notices: UrlFallbackNotice[] = [];
  const now = Math.floor(nowSec);

  // range
  let range: RangeId = DEFAULT_RANGE;
  const rawRange = present(query[TIMELINE_QUERY_KEYS.range]);
  if (rawRange !== null) {
    if (isTimelineRange(rawRange)) range = rawRange;
    else notices.push({ key: "range", message: `Unknown range '${displayRaw(rawRange)}' — showing ${DEFAULT_RANGE}` });
  }
  if (isKiosk(query)) return { state: { range, end: null, zoom: null, sel: null }, notices };

  // end
  let end: number | null = null;
  const rawEnd = present(query[TIMELINE_QUERY_KEYS.end]);
  if (rawEnd !== null) {
    const n = parseEpochSeconds(rawEnd);
    if (n === null) notices.push({ key: "end", message: `Invalid pause time '${displayRaw(rawEnd)}' — showing live` });
    else if (n > now + END_FUTURE_TOLERANCE_S) notices.push({ key: "end", message: `Pause time '${displayRaw(rawEnd)}' is in the future — showing live` });
    else end = n;
  }

  // zoom (validated against the post-fallback range and end)
  let zoom: { readonly start: number; readonly end: number } | null = null;
  const rawZoom = present(query[TIMELINE_QUERY_KEYS.zoom]);
  if (rawZoom !== null) {
    const m = ZOOM_PATTERN.exec(rawZoom);
    const zs = m === null ? NaN : Number(m[1]);
    const ze = m === null ? NaN : Number(m[2]);
    const anchor = end ?? now;
    const shown = displayRaw(rawZoom);
    if (m === null || !(zs < ze)) {
      notices.push({ key: "zoom", message: `Invalid zoom window '${shown}' — showing the full range` });
    } else if (zs < anchor - RANGE_SECONDS[range] || ze > anchor) {
      notices.push({ key: "zoom", message: `Zoom window '${shown}' is outside the selected range — showing the full range` });
    } else if (ze - zs < MIN_ZOOM_STEPS * timelineStepSeconds(range)) {
      notices.push({ key: "zoom", message: `Zoom window '${shown}' is narrower than 2 data steps — showing the full range` });
    } else {
      zoom = { start: zs, end: ze };
    }
  }

  // sel (shape only; tree membership via validateSel)
  let sel: TimelineUrlState["sel"] = null;
  const rawSel = present(query[TIMELINE_QUERY_KEYS.sel]);
  if (rawSel !== null) {
    sel = decodeSel(rawSel);
    if (sel === null) notices.push({ key: "sel", message: `Invalid selection '${displayRaw(rawSel)}' — showing no selection` });
  }

  if (zoom !== null && end === null) end = now; // zoomed ⇒ paused, anchored at the validated window
  return { state: { range, end, zoom, sel }, notices };
}

// ---------------------------------------------------------------------------
// Paused windows older than the served history (05 §4.3.1)
// ---------------------------------------------------------------------------

/**
 * Informational text shown when the paused window lies entirely before the latest served history.
 * `{range}` is the range id. (additive; rendered by 07 as plain text)
 */
export const PAUSED_WINDOW_OUT_OF_HISTORY_TEXT =
  "History is only available for the latest {range}; the paused window is older" as const;

/**
 * True when a paused domain [end − R, end] lies entirely before the served window [now − R, now].
 * Always false when live or in kiosk. Pure; O(1).
 * @param state - Decoded (and sel-validated) state.
 * @param nowSec - Current time, epoch seconds.
 */
export function pausedWindowOutsideHistory(state: TimelineUrlState, nowSec: number): boolean {
  return state.end !== null && state.end < Math.floor(nowSec) - RANGE_SECONDS[state.range];
}

/** The notice text with `{range}` substituted, e.g. "History is only available for the latest 24h; the paused window is older". */
export function pausedWindowOutOfHistoryText(range: RangeId): string {
  return PAUSED_WINDOW_OUT_OF_HISTORY_TEXT.replace("{range}", range);
}

// ---------------------------------------------------------------------------
// validateSel (05 §4.4)
// ---------------------------------------------------------------------------

/**
 * Check the decoded selection against the lane tree. An identity that is not a host or service lane
 * falls back to no selection with a notice. Pure; O(1) after findLane's per-tree index.
 *
 * `07` calls this whenever the tree or the decoded selection changes. Until the snapshot exists, the
 * selection is held as-is and the detail region shows its loading state.
 *
 * @param state - Decoded state (from decodeTimelineUrl).
 * @param tree - The current lane tree.
 * @returns The state (with `sel` cleared when unknown) and a notice, or null when valid or empty.
 */
export function validateSel(
  state: TimelineUrlState,
  tree: LaneTree,
): { readonly state: TimelineUrlState; readonly notice: UrlFallbackNotice | null } {
  if (state.sel === null || findLane(tree, state.sel) !== null) return { state, notice: null };
  return {
    state: { ...state, sel: null },
    notice: { key: "sel", message: `Unknown target '${displayRaw(targetRef(state.sel))}' — showing no selection` },
  };
}

// ---------------------------------------------------------------------------
// encodeTimelineUrl (05 §4.5)
// ---------------------------------------------------------------------------

/** The owned key/value pairs encodeTimelineUrl writes for `state`, in range, end, zoom, sel order. */
function ownedPairs(state: TimelineUrlState): [string, string][] {
  const out: [string, string][] = [];
  if (state.range !== DEFAULT_RANGE) out.push([TIMELINE_QUERY_KEYS.range, state.range]);
  if (state.end !== null) out.push([TIMELINE_QUERY_KEYS.end, String(Math.floor(state.end))]);
  if (state.zoom !== null) {
    out.push([TIMELINE_QUERY_KEYS.zoom, `${Math.floor(state.zoom.start)}-${Math.ceil(state.zoom.end)}`]);
  }
  if (state.sel !== null) out.push([TIMELINE_QUERY_KEYS.sel, targetRef(state.sel)]);
  return out;
}

const OWNED_KEYS: ReadonlySet<string> = new Set<string>(Object.values(TIMELINE_QUERY_KEYS));

/**
 * Encode timeline state into a query string (leading "?", or "" when empty), keeping every
 * unrelated key from `current`. That includes `kiosk`/`rotate` and other views' keys; this follows
 * the alerts `navigateQuery` precedent. Default values are omitted. Every key and value is passed
 * through `encodeURIComponent`, so no value can add a parameter, change the path or change the
 * origin (REQ-SEC-04).
 *
 * Output order is deterministic: unrelated keys in `current`'s insertion order, then range, end,
 * zoom, sel.
 *
 * @param state - The state to write.
 * @param current - `router.current().query` at write time.
 * @returns "" or "?k=v&…".
 */
export function encodeTimelineUrl(state: TimelineUrlState, current: RouteMatch["query"]): string {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(current)) if (!OWNED_KEYS.has(k)) out.push([k, v]);
  out.push(...ownedPairs(state));
  if (out.length === 0) return "";
  return "?" + out.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

// ---------------------------------------------------------------------------
// State transitions (05 §4.6)
// ---------------------------------------------------------------------------

/** What caused a URL write; decides history push vs replace (TS §5.2). */
export type TimelineUrlChange = "range" | "select" | "pause" | "resume" | "zoom" | "reset-zoom" | "cursor-pin";

/** Push for range, selection and pause/resume; replace for zoom- and cursor-driven writes (TS §5.2). */
export const URL_CHANGE_MODE: Readonly<Record<TimelineUrlChange, "push" | "replace">> = {
  range: "push", select: "push", pause: "push", resume: "push",
  zoom: "replace", "reset-zoom": "replace", "cursor-pin": "replace",
};

/** New range; zoom cleared (it may not fit the new range); end and sel kept. */
export function withRange(state: TimelineUrlState, range: RangeId): TimelineUrlState {
  return { ...state, range, zoom: null };
}

/**
 * Pause at the current domain end, for the `l` key ("pause") or a cursor pin ("cursor-pin").
 * Idempotent when already paused. A non-finite or non-positive `domainEnd` returns `state` unchanged.
 * @param domainEnd - The axis domain end (the live anchor of the last tick), epoch seconds. Using it
 *   instead of wall-clock now keeps the visible window from shifting on pause.
 */
export function withPause(state: TimelineUrlState, domainEnd: number): TimelineUrlState {
  if (state.end !== null) return state;
  const end = Math.floor(domainEnd);
  if (!Number.isSafeInteger(end) || end < 1) return state;
  return { ...state, end };
}

/** Resume live: end and zoom cleared (TS §3.7). */
export function withResume(state: TimelineUrlState): TimelineUrlState {
  return { ...state, end: null, zoom: null };
}

/**
 * Zoom to a window (brush or keyboard). If live, this also pauses at `domainEnd` (TS §5.2: "zoom
 * while live writes end=<now>"). The window is rounded outward to whole seconds and clamped into
 * [E − R, E]. Returns `state` unchanged if the result would be narrower than MIN_ZOOM_STEPS ×
 * timelineStepSeconds(range). `06`'s axis already rejects such brushes; this is a backstop.
 */
export function withZoom(state: TimelineUrlState, window: TimeWindow, domainEnd: number): TimelineUrlState {
  const anchor = state.end ?? Math.floor(domainEnd);
  if (!Number.isSafeInteger(anchor) || anchor < 1) return state;
  if (!Number.isFinite(window.start) || !Number.isFinite(window.end)) return state;
  const lo = Math.min(window.start, window.end);
  const hi = Math.max(window.start, window.end);
  const start = Math.max(Math.floor(lo), anchor - RANGE_SECONDS[state.range]);
  const end = Math.min(Math.ceil(hi), anchor);
  if (end - start < MIN_ZOOM_STEPS * timelineStepSeconds(state.range)) return state;
  return { ...state, end: anchor, zoom: { start, end } };
}

/** Clear zoom ("reset-zoom"). A paused page stays paused; resuming is a separate action. */
export function withResetZoom(state: TimelineUrlState): TimelineUrlState {
  return state.zoom === null ? state : { ...state, zoom: null };
}

/** Select a host/service lane, or clear the selection with null. An endpoint-kind node returns `state` unchanged. */
export function withSel(state: TimelineUrlState, node: LaneNode | null): TimelineUrlState {
  if (node === null) return { ...state, sel: null };
  const { kind, id } = node.target;
  if (kind !== "host" && kind !== "service") return state;
  return { ...state, sel: { kind, id } };
}

// ---------------------------------------------------------------------------
// Canonical form (05 §4.7)
// ---------------------------------------------------------------------------

/**
 * True when the URL's owned keys already equal what encodeTimelineUrl would write for `state`.
 * `07` uses this after decode: when it is false and the page is not in kiosk, `07` replace-navigates
 * to `encodeTimelineUrl(state, query)`. Invalid values drop out of the URL, and a zoom-without-end
 * URL gains its pinned `end`, so the next decode is idempotent. An owned key present with an empty
 * value is not canonical (the rewrite drops it).
 */
export function isCanonicalTimelineQuery(query: RouteMatch["query"], state: TimelineUrlState): boolean {
  const expected = new Map(ownedPairs(state));
  for (const key of OWNED_KEYS) {
    if (query[key] !== expected.get(key)) return false;
  }
  return true;
}
