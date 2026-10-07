// src/client/views/estate/view.tsx — the /estate view composition root (spec 01 §3–§6; REQ-INT-01,
// REQ-NAV-01/02, REQ-ENT-01).
//
// The single public export (default) the estate ViewDefinition loads. It reads `store.route` and the
// narrowed payload (`readEstate`), adapts delivery at ONE site (`toDeliveryState`), and renders the
// payload surfaces only when delivery is `ready` (I3). Path prefixes select the entity route kind;
// entity names come from `route.params` and are never parsed from the path tail by EntityPage.

import type { ReactElement, ReactNode } from "react";
import { useMemo } from "react";
import type { EstatePayload } from "@pulse/web-data/wire";

import type { ViewProps } from "../../../shared/registry.js";
import type { AppStore } from "../../store/index.js";
import { refetchView } from "../../store/live-state.js";
import type { PathRouter } from "../../router.js";
import { Icon, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger, usePageHeadingId } from "@/ui";
import type { IconName } from "@/ui";
import { CoverageExplorer } from "./coverage.js";
import { renderDelivery } from "./degrade.js";
import { toDeliveryState } from "./delivery.js";
import { EntityPage } from "./entity-page.js";
import type { EntityRouteTarget } from "./entity-model.js";
import { RegionErrorBoundary } from "./error-boundary.js";
import { FindingsTab } from "./findings.js";
import { Inventory } from "./inventory.js";
import { SearchBox, useFilteredEstate } from "./search.js";
import { estateQueryString, readEstate, readEstateQuery } from "./types.js";
import type { EstateQuery, EstateTabId } from "./types.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Landing tabs, in display order; ids double as the `?tab=` value (00 §7). */
interface TabItem {
  readonly id: EstateTabId;
  readonly label: string;
  readonly icon: IconName;
}

const TAB_ITEMS: readonly TabItem[] = [
  { id: "inventory", label: "Inventory", icon: "server" },
  { id: "coverage", label: "Coverage", icon: "network" },
  { id: "findings", label: "Findings", icon: "info" },
];

/** Region names surfaced by each tab body's error boundary (REQ-OBS-01). */
const TAB_REGION: Readonly<Record<EstateTabId, string>> = {
  inventory: "inventory tree",
  coverage: "coverage explorer",
  findings: "findings",
};

/** Write the full landing query (01 §6); `navigate` carries kiosk/rotate itself. */
function navigateQuery(router: PathRouter, next: EstateQuery, replace: boolean): void {
  const qs = estateQueryString(next);
  router.navigate(qs === "" ? "/estate" : `/estate?${qs}`, replace ? { replace: true } : undefined);
}

/** Map a deep route's params to the entity target, or `null` for the landing (01 §4). */
function entityTarget(route: AppStore["route"]["value"]): EntityRouteTarget | null {
  if (route.view !== "estate") return null;
  if (route.path.startsWith("/estate/host/")) {
    return { kind: "host", name: route.params["name"] ?? "" };
  }
  if (route.path.startsWith("/estate/service/")) {
    return { kind: "service", host: route.params["host"] ?? "", name: route.params["name"] ?? "" };
  }
  return null;
}

interface LandingProps {
  readonly store: AppStore;
  readonly router: PathRouter;
  readonly payload: EstatePayload;
}

/** The landing: controlled tabs + search, each tab body in its own error boundary. */
function Landing({ store, router, payload }: LandingProps): ReactElement {
  useSignals();
  const query = readEstateQuery(store);
  const filtered = useFilteredEstate(payload.estate, query.q);

  // drilldownIds of matched hosts + services; null when no query is active (02 §11).
  const matchedIds = useMemo<ReadonlySet<string> | null>(() => {
    if (filtered === null || !filtered.isFiltered) return null;
    return new Set([...filtered.hosts, ...filtered.services].map((e) => e.drilldownId));
  }, [filtered]);

  const onTabChange = (id: string): void => {
    const tab = TAB_ITEMS.find((t) => t.id === id)?.id;
    if (tab !== undefined && tab !== query.tab) navigateQuery(router, { ...query, tab }, false);
  };
  const onQueryChange = (q: string): void => navigateQuery(router, { ...query, q }, true);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="estate-landing" data-tab={query.tab}>
      {/* Manual activation: arrows move focus, Enter/Space/click select (each selection is a navigation). */}
      <Tabs value={query.tab} onValueChange={onTabChange} activationMode="manual" className="min-w-0 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList aria-label="Estate sections">
            {TAB_ITEMS.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                <Icon name={item.icon} />
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <SearchBox
            value={query.q}
            onQueryChange={onQueryChange}
            {...(matchedIds !== null ? { resultCount: matchedIds.size } : {})}
          />
        </div>
        <TabsContent value={query.tab} className="min-w-0">
          {/* key per tab: a boundary that caught in one tab resets when the user switches tabs. */}
          <RegionErrorBoundary key={query.tab} region={TAB_REGION[query.tab]}>
            {query.tab === "inventory" ? (
              <Inventory
                estate={payload.estate}
                liveTargets={payload.liveTargets}
                coverage={payload.coverage}
                matchedIds={matchedIds}
                router={router}
              />
            ) : query.tab === "coverage" ? (
              <CoverageExplorer payload={payload} />
            ) : (
              <FindingsTab findings={payload.findings} query={query} router={router} />
            )}
          </RegionErrorBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The landing and delivery-state frame: the "Estate" page heading over the given body. */
function EstateFrame({ children }: { readonly children: ReactNode }): ReactElement {
  const headingId = usePageHeadingId("Estate");
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <PageHeader title="Estate" id={headingId} />
      {children}
    </section>
  );
}

/** The estate view (default export — the only public symbol, 01 §3). */
export default function EstateView(props: ViewProps): ReactElement {
  useSignals();
  const { store, router } = props;
  const route = store.route.value;
  const payload = readEstate(store);

  // The single delivery adapter site. Fetch causes are published alongside the estate payload.
  const delivery = toDeliveryState(store.connection.value.views.estate, payload);
  const target = entityTarget(route);

  return (
    <div data-slot="estate-page" data-testid="estate-view" className="h-full min-w-0">
      {/* Entity pages carry their own frame and h1; the landing and delivery states share "Estate". */}
      {delivery.kind === "ready" && payload !== null && target !== null ? (
        <EntityPage store={store} router={router} target={target} />
      ) : (
        <EstateFrame>
          {renderDelivery(delivery, {
            onRetry: () => refetchView(store, "estate"),
            children: () => (payload === null ? null : <Landing store={store} router={router} payload={payload} />),
          })}
        </EstateFrame>
      )}
    </div>
  );
}
