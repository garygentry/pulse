// apps/web/src/client/views/engine/view.tsx — the /engine self-health view.
//
// Loaded by the frozen registry entry `load: () => import("./engine/view.js").then((m) => m.default)`.
// The store is read ONLY through the model.ts readers. Each region sits in its own FragmentBoundary,
// and the whole body in a PageErrorBoundary. Kiosk is read from the route query or the rotation
// prop; the view never writes rotation.

import type { ReactElement, ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { useSignal } from "@preact/signals-react";
import type { EnginePayload, OverviewSnapshotV2 } from "@pulse/web-data/wire";

import { Callout, EmptyState, ExternalLink, FragmentBoundary, Icon, LoadingState, PageErrorBoundary, PageHeader } from "@/ui";
import { isKiosk } from "../../shell/kiosk.js";
import { createEstateClock, TZ_FALLBACK_MARKER } from "../../format.js";
import type { EstateClock } from "../../format.js";
import type { ViewProps } from "../../../shared/registry.js";
import { useNotCurrent } from "../_shared/timeseries/history/freshness.js";

import {
  readEngine, readEngineDelivery, readSnapshot, readObservation, readLastGoodAt, readConnectionPhase,
  overviewEngineOf, scrapeSection, ruleSection, canaryRule, notificationSection, capacityTiles,
  deriveGrafanaBase,
} from "./model.js";
import { presentVerdict, rollUpVerdict } from "./verdict.js";
import { engineBoardUrl } from "./labels.js";
import { VerdictBanner } from "./verdict-banner.js";
import { ComponentCards, EngineStatusBadge } from "./components.js";
import { ScrapeJobs } from "./scrape.js";
import { RuleGroups } from "./rules.js";
import { CapacityTiles, DeadmanPanel, NotificationTiles } from "./pipeline.js";
import { EngineTrends } from "./trends.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Logs a view-level render fault; the boundary shows the fallback. */
function logViewFault(error: unknown): void {
  console.error("[engine-view] render fault", error);
}

/**
 * The /engine self-health view.
 *
 * @param props - `ViewProps` from the shell: the app store, the path router and the optional kiosk
 *   rotation context (read only).
 * @returns The view tree wrapped in a `PageErrorBoundary`.
 */
export default function EngineView(props: ViewProps): ReactElement {
  return (
    <PageErrorBoundary
      pageSlot="engine-page"
      title="The engine view hit a rendering error"
      message="Reload to try again — other views are unaffected."
      onError={logViewFault}
    >
      <EngineViewBody store={props.store} router={props.router} rotation={props.rotation ?? null} />
    </PageErrorBoundary>
  );
}

/** Fallback estate used when no snapshot is held (00 §3.3): UTC, with the fallback marker shown. */
const FALLBACK_ESTATE: OverviewSnapshotV2["estate"] = { name: "", timezone: "UTC", tzFallback: true };

/**
 * The estate clock for the view (00 §3.3). A time is never printed without a zone.
 *
 * @param snapshot - The overview snapshot, or null.
 * @returns An EstateClock for the estate zone, or for UTC with `tzFallback` when null.
 */
export function estateClockFor(snapshot: OverviewSnapshotV2 | null): EstateClock {
  return createEstateClock(snapshot?.estate ?? FALLBACK_ESTATE);
}

function EngineViewBody({ store, router, rotation }: ViewProps): ReactElement {
  useSignals();
  // Route as a signal so that a kiosk-flag change re-renders (alerts precedent).
  const route = useSignal(router.current());
  useEffect(() => {
    const off = router.subscribe((m) => {
      route.value = m;
    });
    route.value = router.current(); // resync between first render and effect
    return off;
  }, [router]);

  // Kiosk (tech-spec §3.11): the query flag OR an active rotation context. Read only (CON-08).
  const kiosk = isKiosk(route.value.query) || (rotation !== undefined && rotation !== null);

  // Store reads — model.ts only (00 §1, 03 §2.1).
  const engine = readEngine(store);
  const delivery = readEngineDelivery(store);
  const snapshot = readSnapshot(store);
  const observation = readObservation(store);
  const lastGoodAt = readLastGoodAt(store);
  const notCurrent = useNotCurrent(readConnectionPhase(store), delivery.phase);

  const clock = useMemo(
    () => estateClockFor(snapshot),
    [snapshot?.estate.timezone, snapshot?.estate.tzFallback],
  );

  // Sections are memoized on (payload, observation) identity (REQ-PERF-01).
  const sections = useMemo(
    () =>
      engine === null
        ? null
        : {
            scrape: scrapeSection(engine, observation),
            rules: ruleSection(engine),
            canary: canaryRule(engine),
            notifications: notificationSection(engine.notifications),
            capacity: capacityTiles(engine.capacity),
          },
    [engine, observation],
  );
  const boardUrl = useMemo(
    () => (engine === null ? null : engineBoardUrl(deriveGrafanaBase(snapshot), engine)),
    [engine, snapshot],
  );

  const verdict = rollUpVerdict({
    engine,
    delivery,
    notCurrent,
    observation,
    overviewEngine: overviewEngineOf(snapshot),
    lastGoodAt,
  });
  const presentation = presentVerdict(verdict, clock.format);

  if (verdict.kind === "loading") return <EngineLoading text={presentation.headline} />;

  return (
    <div
      data-slot="engine-page"
      className={kiosk ? "flex min-w-0 flex-col gap-6 p-4" : "flex min-w-0 flex-col gap-6"}
      data-kiosk={kiosk ? "1" : "0"}
      data-not-current={notCurrent ? "true" : "false"}
    >
      <PageHeader
        title={ENGINE_PAGE_TITLE}
        meta={
          <span className="text-sm text-muted-foreground" data-zone="">
            Times in {clock.timezone}
            {clock.tzFallback ? <span> · {TZ_FALLBACK_MARKER}</span> : null}
          </span>
        }
      />

      <Region id="verdict" label="Engine verdict">
        <VerdictBanner verdict={verdict} presentation={presentation} kiosk={kiosk} />
      </Region>

      {engine === null || sections === null ? (
        <EngineUnavailable />
      ) : (
        <>
          {notCurrent ? <NotCurrentNotice engine={engine} clock={clock} /> : null}

          <Region id="components" label="Components">
            <ComponentCards components={engine.components} clock={clock} notCurrent={notCurrent} />
          </Region>

          <Region id="deadman" label="Deadman">
            <DeadmanPanel deadman={engine.deadman} canary={sections.canary} clock={clock} />
          </Region>

          <Region id="scrape" label="Scrape targets">
            <ScrapeJobs section={sections.scrape} hosts={snapshot?.hosts ?? []} clock={clock} kiosk={kiosk} />
          </Region>

          <Region id="rules" label="Rule groups">
            <RuleGroups section={sections.rules} clock={clock} kiosk={kiosk} />
          </Region>

          <Region id="notifications" label="Notifications">
            <NotificationTiles section={sections.notifications} clock={clock} />
          </Region>

          <Region id="capacity" label="Capacity">
            <CapacityTiles tiles={sections.capacity} availability={engine.capacity.availability} clock={clock} />
          </Region>
        </>
      )}

      <Region id="trends" label="Trends">
        <EngineTrends clock={clock} kiosk={kiosk} generation={observation?.generation ?? null} />
      </Region>

      <Region id="grafana" label="Grafana link">
        <EngineGrafanaLink href={boardUrl} />
      </Region>
    </div>
  );
}

/** One page region: a `data-region` slot whose content is isolated by its own FragmentBoundary. */
function Region({ id, label, children }: { readonly id: string; readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="min-w-0" data-region={id}>
      <FragmentBoundary label={label}>{children}</FragmentBoundary>
    </div>
  );
}

/** The page's one h1, loaded or not. */
const ENGINE_PAGE_TITLE = "Monitoring engine";

/** Pre-first-payload layout. The skeletons are aria-hidden; the visible status text carries the
 *  meaning, and aria-busy marks the region. The page keeps its one h1 while it loads. */
function EngineLoading({ text }: { readonly text: string }): ReactElement {
  return (
    <div data-slot="engine-page" data-region="loading" className="flex min-w-0 flex-col gap-6">
      <PageHeader title={ENGINE_PAGE_TITLE} />
      <LoadingState label={text} preset="cards" rows={6} />
    </div>
  );
}

/** Shown in place of the payload-backed regions when no engine payload is held and the verdict is
 *  Unknown: after the initial phase, or while not current. */
function EngineUnavailable(): ReactElement {
  return (
    <div className="min-w-0" data-region="unavailable">
      <EmptyState
        icon="wifi-off"
        title="Engine data unavailable"
        description="No engine payload has been received. This page updates automatically when one arrives."
      />
    </div>
  );
}

/** Says that the regions below show the last payload received. */
function NotCurrentNotice({ engine, clock }: { readonly engine: EnginePayload; readonly clock: EstateClock }): ReactElement {
  return (
    <Callout tone="neutral" role="status" icon="clock" data-not-current-notice="">
      <span className="flex flex-wrap items-center gap-2">
        <EngineStatusBadge status="unknown" icon="clock" label="Not current" />
        <span>
          Showing the last engine data received, generated {clock.format(engine.generatedAt)}.
          Values below may be out of date.
        </span>
      </span>
    </Callout>
  );
}

/** Props for {@link EngineGrafanaLink}. */
export interface EngineGrafanaLinkProps {
  /** Board URL from `engineBoardUrl`, or null to hide the link. */
  readonly href: string | null;
}

/**
 * The pulse-engine Grafana deep link. Renders nothing when `href` is null: Grafana not configured,
 * no derivable base, or no payload.
 */
export function EngineGrafanaLink({ href }: EngineGrafanaLinkProps): ReactElement | null {
  if (href === null) return null;
  return (
    <p className="m-0 text-sm">
      <ExternalLink href={href}>
        <Icon name="activity" className="shrink-0" />
        Open the pulse-engine board in Grafana
      </ExternalLink>
    </p>
  );
}
