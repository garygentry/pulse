// apps/web/src/client/views/alerts/estate-clock.ts — the alerts view's estate clock (#51), so the
// view formats absolute times in the estate zone like the timeline and overview views.
import { useMemo } from "react";
import { useComputed } from "@preact/signals-react";

import { FALLBACK_ESTATE, createEstateClock } from "../../format.js";
import type { EstateClock } from "../../format.js";
import type { AppStore } from "../../store/index.js";

/**
 * The estate clock for the snapshot's zone (UTC, flagged as the fallback, before a snapshot). It
 * subscribes to the zone only (`estate.timezone`/`tzFallback`), not the whole snapshot, so a new
 * snapshot cycle does not re-render the caller. The caller must call `useSignals()` first.
 */
export function useEstateClock(store: AppStore): EstateClock {
  const zone = useComputed(() => {
    const estate = store.snapshot.value?.estate ?? FALLBACK_ESTATE;
    return `${estate.tzFallback ? "1" : "0"}${estate.timezone}`;
  });
  const key = zone.value;
  return useMemo(
    () => createEstateClock({ name: "", timezone: key.slice(1), tzFallback: key.startsWith("1") }),
    [key],
  );
}
