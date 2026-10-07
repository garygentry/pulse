// apps/web/src/client/views/overview/drawer/LiveSignals.tsx — live signals attributed to exactly the
// selected target. Rows keep server order and show label, formatted value with its declared unit,
// availability state and estate-time last-good. A null (or non-finite) value is "Unavailable" with
// its availability message — never 0 or false.

import type { ReactElement } from "react";

import type { LiveSignal } from "@pulse/web-data/wire";
import { Section } from "@/ui";
import type { EstateClock } from "../../../format.js";
import {
  AVAILABILITY_LABEL,
  NO_SIGNALS_TEXT,
  SIGNAL_UNAVAILABLE_TEXT,
  evidenceLastGood,
  formatSignalValue,
} from "./format.js";
import { DRAWER_EMPTY_CLASS, DRAWER_LIST_CLASS, DRAWER_ROW_CLASS } from "./classes.js";

function SignalRow(props: { readonly signal: LiveSignal; readonly clock: EstateClock }): ReactElement {
  const { signal, clock } = props;
  const formatted = formatSignalValue(signal);
  const { availability } = signal;
  return (
    <li className={DRAWER_ROW_CLASS} data-signal-id={signal.id} data-target-kind={signal.target.kind} data-availability={availability.state}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span data-slot="drawer-signal-label" className="font-medium">{signal.label}</span>
        {formatted === null ? (
          <span data-slot="drawer-signal-value" data-value="unavailable" className="text-muted-foreground">
            {SIGNAL_UNAVAILABLE_TEXT}
            {availability.message !== null ? <span data-slot="drawer-signal-message"> — {availability.message}</span> : null}
          </span>
        ) : (
          <span data-slot="drawer-signal-value" className="font-semibold tabular-nums">
            {formatted.value}
            {formatted.unit !== "" ? <span data-unit={signal.unit} className="font-normal text-muted-foreground"> {formatted.unit}</span> : null}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span data-slot="drawer-signal-state">{AVAILABILITY_LABEL[availability.state] ?? availability.state}</span>
        <span data-slot="drawer-signal-last-good">{evidenceLastGood(clock, availability)}</span>
      </div>
    </li>
  );
}

/** Render attributed signal values, units, availability, and last-good context. */
export function LiveSignals(props: {
  readonly signals: readonly LiveSignal[];
  readonly clock: EstateClock;
}): ReactElement {
  return (
    <Section level={3} title="Live signals" data-section="signals">
      {props.signals.length === 0 ? (
        <p data-slot="drawer-empty" className={DRAWER_EMPTY_CLASS}>{NO_SIGNALS_TEXT}</p>
      ) : (
        <ul className={DRAWER_LIST_CLASS}>
          {props.signals.map((signal, i) => <SignalRow key={`${signal.id}:${i}`} signal={signal} clock={props.clock} />)}
        </ul>
      )}
    </Section>
  );
}
