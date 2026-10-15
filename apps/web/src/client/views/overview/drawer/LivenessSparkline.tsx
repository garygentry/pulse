// apps/web/src/client/views/overview/drawer/LivenessSparkline.tsx — the drawer's lazy one-hour
// liveness region.
//
// The only drawer section that is not snapshot-backed. It renders solely from the history
// controller's published state: one effect per canonical target subscribes, resynchronizes from
// state() to close the render/effect race, and calls load() once; cleanup unsubscribes and cancels.
// No polling, no timers, no second request. Null samples reach the shared SVG Sparkline unchanged
// so gaps stay gaps.

import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { HistorySeries } from "@pulse/web-data/wire";
import { Button, Icon, Skeleton, Sparkline, type SparklineSample } from "@/ui";
import type { HistoryController, OverviewTarget, TargetHistoryState } from "../model.js";
import { DRAWER_EMPTY_CLASS } from "./classes.js";

/** Accessible name of the retry control. */
export const RETRY_LIVENESS_HISTORY_LABEL = "Retry liveness history";
/** Copy when a validated series holds no finite sample. */
export const LIVENESS_HISTORY_UNAVAILABLE_TEXT = "Liveness history unavailable";
/** Copy for a target the estate does not collect metrics for (no liveness to fetch). */
export const LIVENESS_NOT_COLLECTED_TEXT = "Not collected — this host has no metrics collection";
/** Annotation when the server marks the history payload stale. */
export const LIVENESS_HISTORY_STALE_TEXT = "Stale history";

/** Preserve timestamp order and explicit null discontinuities for the shared SVG Sparkline. */
export function toSparklineSamples(series: HistorySeries): readonly SparklineSample[] {
  return series.points.map(([at, value]) => ({ at, value }));
}

/**
 * Whether the liveness query applies to the target. An `excluded` host has no scrape targets, so
 * the server answers QUERY_NOT_APPLICABLE; the drawer says "Not collected" instead of fetching.
 */
export function livenessApplies(target: OverviewTarget): boolean {
  return !(target.kind === "host" && target.host.collectionClass === "excluded");
}

// Same wording as TargetDrawer's title; kept local so the two modules do not import each other.
function targetName(target: OverviewTarget): string {
  return target.service !== null ? `${target.service.name} on ${target.host.name}` : target.host.name;
}

/** Render only the lazy history region and its retry control. */
export function LivenessSparkline(props: {
  readonly target: OverviewTarget;
  readonly controller: HistoryController;
}): ReactElement {
  const { controller, target } = props;
  const targetId = target.drilldownId;
  const [state, setState] = useState<TargetHistoryState>(() => controller.state());
  // A new snapshot re-derives the target object; only a canonical id change may reload.
  const targetRef = useRef(target);
  targetRef.current = target;

  const applies = livenessApplies(target);

  useEffect(() => {
    if (!applies) return undefined; // nothing to fetch: no request, no subscription
    const unsubscribe = controller.subscribe(setState);
    setState(controller.state());
    void controller.load(targetRef.current);
    return () => {
      unsubscribe();
      controller.cancel();
    };
  }, [controller, targetId, applies]);

  if (!applies) {
    return (
      <p data-slot="drawer-liveness" data-history-state="not-collected" className={`flex items-center gap-1.5 ${DRAWER_EMPTY_CLASS}`}>
        <Icon name="circle-slash" size={14} />
        {LIVENESS_NOT_COLLECTED_TEXT}
      </p>
    );
  }

  // Idle before the effect, or a state still attributed to the previous target, reads as loading.
  const current = state.status !== "idle" && state.targetId === targetId ? state : null;

  if (current === null || current.status === "loading") {
    return (
      <div data-slot="drawer-liveness" data-history-state="loading" aria-busy="true" aria-live="polite">
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (current.status === "error") {
    return (
      <div data-slot="drawer-liveness" className="grid justify-items-start gap-2" data-history-state="error" data-error-code={current.code} aria-busy="false" aria-live="polite">
        <p data-slot="drawer-liveness-error" className={DRAWER_EMPTY_CLASS}>{current.message}</p>
        {current.retryable ? (
          <Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={() => void controller.retry()}>
            {RETRY_LIVENESS_HISTORY_LABEL}
          </Button>
        ) : null}
      </div>
    );
  }

  const { payload } = current;
  const samples = payload.series[0] !== undefined ? toSparklineSamples(payload.series[0]) : [];
  const hasFinite = samples.some((sample) => sample.value !== null && Number.isFinite(sample.value));
  return (
    <div data-slot="drawer-liveness" className="grid gap-1" data-history-state="ready" aria-busy="false" aria-live="polite">
      {hasFinite ? (
        <Sparkline samples={samples} min={0} max={1} ariaLabel={`One-hour liveness for ${targetName(target)}`} />
      ) : (
        <p data-slot="drawer-empty" className={DRAWER_EMPTY_CLASS}>{LIVENESS_HISTORY_UNAVAILABLE_TEXT}</p>
      )}
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span data-unit={payload.unit}>
          Unit: {payload.unit}
        </span>
        {payload.stale ? <span data-slot="drawer-liveness-stale" data-stale="">{LIVENESS_HISTORY_STALE_TEXT}</span> : null}
      </div>
    </div>
  );
}
