// shell/HealthRegion.tsx — the top bar's health region: the estate name and the always-visible
// live/staleness pill (REQ-LIVE-02, REQ-OBS-01). Shown under kiosk too. DISTINCT from the REQ-LIVE-03
// stale-data callout (StaleDataCallout.tsx).
//
// Shell currentness is the LATEST ADVANCING OBSERVATION (`connection.observation.observedAt`), not a
// payload's material `generatedAt`. An unchanged 304/tick keeps the connection current without a
// payload write, so the pill stays current across many identical cycles; a stalled observation turns
// the connection `stale` (data-status="critical"). Material `generatedAt` (body materialization time)
// is never shown here — it appears only where explicitly labelled "content generated".
import type { ReactElement } from "react";
import { useSignals } from "@preact/signals-react/runtime";

// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { HealthPill } from "@/ui/patterns/health-pill";

import type { AppStore } from "../store/index.js";
import type { ConnectionState } from "../store/types.js";
import { TZ_FALLBACK_MARKER, type EstateClock } from "../format.js";

export interface LiveStatusPillProps {
  /** `store.connection.value`. `observation.observedAt` drives the displayed currentness; `phase ===
   *  "stale"` marks the data stale. */
  connection: ConnectionState;
  /** Estate-timezone clock derived from `snapshot.estate`. `null` until the first snapshot. */
  clock: EstateClock | null;
}

/**
 * The always-visible liveness read: a pill whose tone and short label say live / stale / waiting,
 * with the absolute estate-TZ time plus a relative age beside it (and in its tooltip). Absolute time
 * is never shown alone; the tzFallback marker is surfaced when UTC is a fallback. Only the phase is
 * announced (politely), never the ticking time.
 * The pill links to the engine view, which owns source health.
 */
export function LiveStatusPill({ connection, clock }: LiveStatusPillProps): ReactElement {
  const observation = connection.observation;
  const stale = connection.phase === "stale";
  // F3: "Live" needs data, not just a ticking stream: until the first snapshot is accepted (no
  // estate clock) the pill says Connecting, matching "Waiting for first update…" beside it.
  const live = observation !== null && clock !== null;
  const updated = `${
    live
      ? `Updated ${clock.absoluteWithRelative(observation.observedAt)}`
      : "Waiting for first update…"
  }${clock?.tzFallback ? ` ${TZ_FALLBACK_MARKER}` : ""}`;
  const label = stale ? "Stale" : live ? "Live" : "Connecting";

  return (
    <div
      data-slot="staleness-indicator"
      data-status={stale ? "critical" : "ok"}
      className="flex min-w-0 items-center gap-2"
    >
      <HealthPill
        tone={stale ? "danger" : live ? "ok" : "neutral"}
        icon={stale ? "wifi-off" : live ? "wifi" : "loader"}
        label={label}
        href="/engine"
        title={updated}
        className="shrink-0"
      />
      {/* Visible beside the pill from md; below md it stays readable to screen readers on demand. */}
      <span className="sr-only truncate text-xs text-muted-foreground tabular-nums md:not-sr-only">
        {updated}
      </span>
      {/* F44: announce only phase changes (Connecting → Live → Stale). The timestamp changes every
          tick and every second of relative age, so it stays OUT of the live region. */}
      <span className="sr-only" aria-live="polite" data-slot="staleness-announcement">
        {`Data ${label.toLowerCase()}`}
      </span>
    </div>
  );
}

export interface HealthRegionProps {
  store: AppStore;
  clock: EstateClock | null;
}

/** Estate identity + liveness. Before the first poll the name is a neutral placeholder, never a
 *  fabricated estate name. */
export function HealthRegion({ store, clock }: HealthRegionProps): ReactElement {
  useSignals();
  const estateName = store.snapshot.value?.estate.name ?? "Pulse";
  return (
    <div data-slot="health-header" className="flex min-w-0 items-center gap-2">
      <span data-slot="estate-name" className="min-w-0 truncate text-sm font-semibold">
        {estateName}
      </span>
      <LiveStatusPill connection={store.connection.value} clock={clock} />
    </div>
  );
}
