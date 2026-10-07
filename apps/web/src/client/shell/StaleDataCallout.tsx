// shell/StaleDataCallout.tsx — REQ-LIVE-03: the prominent stale-data warning, a danger `Callout`
// (`role="alert"`) the shell renders under the top bar, on every route and under kiosk.
//
// Source failure/recovery warnings read `connection.observation.sources` — the per-source freshness
// carried on every cycle — so they stay correct even when the overview view is inactive (the overview
// payload's compatibility `snapshot.sources` is no longer consulted here). A source warns when its
// governing observation is `stale` or `unavailable`; `not-configured`/`current` never warn. The
// last-good time shown is the source's `lastSuccess` (or the cycle's `observedAt` for the app line),
// never a payload's material `generatedAt`.
import type { ReactElement } from "react";
import { useSignals } from "@preact/signals-react/runtime";

import type { SourceId } from "@pulse/web-data/wire";

// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { Callout } from "@/ui/patterns/callout";

import type { AppStore } from "../store/index.js";
import type { ConnectionState } from "../store/types.js";
import type { EstateClock } from "../format.js";

/** Props for the prominent stale-data warning (REQ-LIVE-03). */
export interface StaleDataWarningProps {
  /** `store.connection.value`; `observation.sources` drives per-source warnings, `phase`/`lastGoodAt`
   *  the app-server refresh-failure line. */
  connection: ConnectionState;
  /** Estate-timezone clock for last-good formatting; `null` until the first snapshot. */
  clock: EstateClock | null;
}

/** The three operator-facing source groups, each backed by its governing observation source id
 *  (08 §10). The keys/labels preserve the pre-migration `data-source` values and text; the state is
 *  now read from the cycle observation instead of the overview `snapshot.sources`. */
const WARNING_SOURCES: readonly { readonly key: string; readonly id: SourceId }[] = [
  { key: "metrics", id: "victoriametrics-signals" },
  { key: "alerts", id: "alertmanager-alerts" },
  { key: "checks", id: "gatus-statuses" },
];

/** REQ-LIVE-03: the prominent stale-data warning — names the failing source(s) and the
 *  last-good-data time on refresh failure (app server unreachable) or per-source unreachability
 *  (driven by `connection.observation.sources`). Renders `null` when everything is live. */
export function StaleDataWarning(props: StaleDataWarningProps): ReactElement | null {
  const { connection, clock } = props;
  const observation = connection.observation;
  const fmt = (isoUtc: string | null): string =>
    isoUtc === null ? "never" : clock ? clock.format(isoUtc) : isoUtc;

  const lines: ReactElement[] = [];

  // (a) Refresh failure — the app server itself is unreachable past the stale window.
  if (connection.phase === "stale") {
    const lastGood =
      connection.lastGoodAt !== null ? fmt(new Date(connection.lastGoodAt).toISOString()) : "never";
    const showing = observation
      ? ` Showing last good data from ${fmt(observation.observedAt)}.`
      : "";
    lines.push(
      <p className="font-medium" data-source="app" key="app">
        {`Data may be stale — app server unreachable since ${lastGood}.${showing}`}
      </p>,
    );
  }

  // (b) Source unreachability — a governing source's latest observation is stale or unavailable.
  if (observation) {
    for (const { key, id } of WARNING_SOURCES) {
      const source = observation.sources[id];
      if (source.state === "stale" || source.state === "unavailable") {
        lines.push(
          <p className="font-medium" data-source={key} key={key}>
            {`Source "${key}" unreachable — last good data ${fmt(source.lastSuccess)}.`}
          </p>,
        );
      }
    }
  }

  if (lines.length === 0) return null;

  return (
    <Callout tone="danger" title="Showing stale data" data-status="critical" data-stale-warning="">
      <div className="grid gap-1">{lines}</div>
    </Callout>
  );
}

export interface StaleDataCalloutProps {
  store: AppStore;
  /** Shell-owned estate clock; passed through for last-good formatting. */
  clock: EstateClock | null;
}

/** The shell's stale-data region: the warning over the live connection, laid out under the top bar.
 *  Renders nothing when everything is live. */
export function StaleDataCallout({ store, clock }: StaleDataCalloutProps): ReactElement | null {
  useSignals();
  const warning = StaleDataWarning({ connection: store.connection.value, clock });
  return warning === null ? null : <div className="px-4 pt-4 md:px-6">{warning}</div>;
}
