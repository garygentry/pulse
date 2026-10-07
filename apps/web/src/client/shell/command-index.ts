// shell/command-index.ts — the command palette's pure index builder + matcher (07 §3.1).
//
// PURE: no DOM, no React, no signals. `buildIndex` reads store slots via `.peek()` so it
// establishes NO reactive dependency — the reactive rebuild is owned by the `computed()` in
// CommandPalette (07 §3.2). Null-safe throughout (REQ-ROBUST-01, REQ-CMD-01): every store slot may
// be `null` before data arrives. `matchEntries` is hand-rolled, case-insensitive, ranked, and capped
// (CON-02 — no fuzzy dependency; REQ-SCALE-01 — a single linear scan over the design envelope).

import type { AppStore } from "../store/index.js";
import type { OverviewSnapshot, ServiceStatus } from "../../shared/snapshot.js";
import { VIEWS } from "../views/registry.js";
import { STATUS_LABEL } from "../a11y/index.js"; // 05-a11y-primitives.md

/** One searchable target in the command palette. Declared in 00-core-definitions.md §4.1 and
 *  co-located here (07 §3.1.1) — imported by CommandPalette, never redefined. */
export interface PaletteEntry {
  /** Result category; also drives ranking priority (view > host > service > alert). */
  kind: "view" | "host" | "service" | "alert";
  /** Stable identity within its kind (view id, host name, "host/service", alert id). */
  id: string;
  /** Primary display text (what the user reads and matches against). */
  label: string;
  /** Optional secondary text (e.g. host for a service, summary for an alert). */
  sublabel?: string;
  /** Router path this entry navigates to on select — passed to router.navigate() (REQ-CMD-02). */
  navPath: string;
}

/**
 * Build the full, unranked palette index from a snapshot of the store's current values.
 *
 * PURE: reads signals via `.peek()` (never `.value`) so it establishes no reactive dependency —
 * the reactive rebuild is owned by the `computed()` in CommandPalette (§3.2). Order is
 * deterministic: all views (registry order), then all hosts (snapshot order), then all services
 * (host order, then service order), then firing alerts. Ranking/capping happens in `matchEntries`.
 *
 * NULL-SAFE (REQ-ROBUST-01, REQ-CMD-01):
 *  - `store.snapshot.peek() === null` → no host/service entries (views still present).
 *  - `store.alerts.peek() === null`   → no alert entries (web-data-tier not built; §3.1.4).
 * Views are ALWAYS present because they come from the static registry, never the store.
 *
 * @param store - the application store (00 §8)
 * @returns a fresh `PaletteEntry[]`; never throws, never returns `null`.
 */
export function buildIndex(store: AppStore): PaletteEntry[] {
  const entries: PaletteEntry[] = [];

  // 1. Views — always available from the registry (REQ-CMD-01, null-safe floor).
  for (const view of VIEWS) {
    entries.push({ kind: "view", id: view.id, label: view.label, navPath: `/${view.id}` });
  }

  // 2. Hosts + services — only when a snapshot exists (REQ-ROBUST-01).
  const snapshot: OverviewSnapshot | null = store.snapshot.peek();
  if (snapshot !== null) {
    for (const host of snapshot.hosts) {
      entries.push({
        kind: "host",
        id: host.name,
        label: host.name,
        sublabel: STATUS_LABEL[host.rollup], // e.g. "Critical"; from 05 STATUS_LABEL — always defined
        navPath: entityPath("host", host.name),
      });
      for (const service of host.services) {
        entries.push(serviceEntry(service));
      }
    }
  }

  // 3. Firing alerts — only when the alerts payload is present and shaped (REQ-ROBUST-01; §3.1.4).
  //    `store.alerts` is the concrete `AlertsPayload`; `firingAlertRows` still reads it defensively.
  for (const row of firingAlertRows(store.alerts.peek())) {
    entries.push({
      kind: "alert",
      id: row.id,
      label: row.label,
      ...(row.sublabel !== undefined ? { sublabel: row.sublabel } : {}),
      navPath: entityPath("alert", row.id),
    });
  }

  return entries;
}

/** One service entry. `sublabel` carries the owning host so duplicate service names disambiguate. */
export function serviceEntry(service: ServiceStatus): PaletteEntry {
  return {
    kind: "service",
    id: `${service.host}/${service.name}`,
    label: service.name,
    sublabel: service.host,
    navPath: entityPath("service", `${service.host}/${service.name}`),
  };
}

/**
 * Router path for a selected entity (REQ-CMD-02).
 *
 * Host/service selections land on the estate deep routes (`/estate/host/:name`,
 * `/estate/service/:host/:name` — registered on the estate entry in views/registry.ts; repointed
 * by estate-explorer under the rev-13 ECR). A service id is `${host}/${name}` (serviceEntry); each
 * segment is percent-encoded so reserved characters survive (the router decodes params once).
 *
 * Alert selections land on the alerts view's `/alerts/:fingerprint` deep route (registered on the
 * alerts entry in views/registry.ts; the alert branch is owned by alert-triage under the charter
 * 04 §2 carve-out). The id is the Alertmanager fingerprint, percent-encoded as one path segment.
 */
export function entityPath(kind: "host" | "service" | "alert", id: string): string {
  if (kind === "host") return `/estate/host/${encodeURIComponent(id)}`;
  if (kind === "service") {
    const slash = id.indexOf("/");
    const host = slash === -1 ? id : id.slice(0, slash);
    const name = slash === -1 ? "" : id.slice(slash + 1);
    return `/estate/service/${encodeURIComponent(host)}/${encodeURIComponent(name)}`;
  }
  return `/alerts/${encodeURIComponent(id)}`;
}

/** Minimal row this document needs from a firing-alert payload. */
interface AlertRow {
  id: string;
  label: string;
  sublabel?: string;
}

/** Alert states listed in the palette — the same rows the triage table shows (alerts model.ts
 *  `firingRows`: every current alert, suppressed ones included). */
const PALETTE_ALERT_STATES: ReadonlySet<string> = new Set(["firing", "silenced", "inhibited"]);

/**
 * Defensive extraction of palette alert rows from the `AlertsPayload` wire type
 * (`@pulse/web-data/wire`): one row per `alerts[]` entry whose state is firing/silenced/inhibited,
 * with id = fingerprint, label = name, and sublabel = target.id when the alert is attributed.
 *
 * Takes `unknown` because the payload arrives from the network, so every field is checked: returns
 * [] for a null or malformed payload (REQ-ROBUST-01), skips malformed entries, and never throws.
 */
export function firingAlertRows(payload: unknown): readonly AlertRow[] {
  if (typeof payload !== "object" || payload === null) return [];
  const alerts = (payload as Record<string, unknown>)["alerts"];
  if (!Array.isArray(alerts)) return [];
  const rows: AlertRow[] = [];
  for (const item of alerts) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const fingerprint = rec["fingerprint"];
    const name = rec["name"];
    const state = rec["state"];
    if (typeof fingerprint !== "string" || fingerprint === "" || typeof name !== "string") continue;
    if (typeof state !== "string" || !PALETTE_ALERT_STATES.has(state)) continue;
    const target = rec["target"];
    const targetId =
      typeof target === "object" && target !== null ? (target as Record<string, unknown>)["id"] : undefined;
    rows.push({ id: fingerprint, label: name, ...(typeof targetId === "string" ? { sublabel: targetId } : {}) });
  }
  return rows;
}

/** Max results returned — bounds render/DOM cost independent of index size (REQ-SCALE-01). */
export const MAX_RESULTS = 50;

/** Rank tiers, lower = better. Exact beats prefix beats substring. */
const enum Tier {
  Exact = 0,
  Prefix = 1,
  Substring = 2,
}

/** Kind priority within a tier (view > host > service > alert), per tech-spec §3.6. */
const KIND_PRIORITY: Readonly<Record<PaletteEntry["kind"], number>> = {
  view: 0,
  host: 1,
  service: 2,
  alert: 3,
};

/**
 * Filter + rank the index for `query`. Hand-rolled, case-insensitive, no fuzzy dependency (CON-02).
 *
 * Matching: `query` is trimmed and split on whitespace into tokens; EVERY token must be a substring
 * of the entry's `label` or `sublabel` (AND semantics). An empty query matches everything (the
 * initial palette listing). Ranking key, ascending: (tier, kindPriority, label). Tier is computed
 * from the whole trimmed query against `label`: equal → Exact, label starts-with → Prefix, otherwise
 * Substring (a token-only or sublabel-only match ranks Substring). Result is capped at MAX_RESULTS.
 *
 * Complexity: O(n · |query|) over the index (≤ ~100 hosts + ~300 services + views + firing alerts) —
 * a single linear scan, comfortable at the design envelope (REQ-SCALE-01).
 *
 * @param index - output of `buildIndex` (or any `PaletteEntry[]`)
 * @param query - raw user input from the palette text field
 * @returns up to MAX_RESULTS ranked entries; `[]` when nothing matches; never throws.
 */
export function matchEntries(index: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.trim().toLowerCase();
  const tokens = needle === "" ? [] : needle.split(/\s+/);

  const scored: { entry: PaletteEntry; tier: Tier }[] = [];
  for (const entry of index) {
    const label = entry.label.toLowerCase();
    const hay = entry.sublabel ? `${label} ${entry.sublabel.toLowerCase()}` : label;
    if (tokens.length > 0 && !tokens.every((t) => hay.includes(t))) continue;
    const tier =
      needle === ""
        ? Tier.Substring
        : label === needle
          ? Tier.Exact
          : label.startsWith(needle)
            ? Tier.Prefix
            : Tier.Substring;
    scored.push({ entry, tier });
  }

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      KIND_PRIORITY[a.entry.kind] - KIND_PRIORITY[b.entry.kind] ||
      a.entry.label.localeCompare(b.entry.label),
  );

  return scored.slice(0, MAX_RESULTS).map((s) => s.entry);
}
