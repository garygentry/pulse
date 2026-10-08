// Timeline header controls (07 §4): the range radio group, the live/paused toggle, Reset zoom, the
// zone and resolution labels, the URL fallback notices and the kiosk status line.
// Presentational only: every state change goes through the callbacks the view passes in (07 §3.4).
// Upstream strings (notice messages) render as JSX text children, never as markup (REQ-SEC-02).
import type { ReactElement } from "react";
import { useState } from "react";
import type { RangeId } from "@pulse/web-data/wire";
import { Button, Callout, Icon, SegmentedControl } from "@/ui";
import { TZ_FALLBACK_MARKER } from "../../format.js";
import type { EstateClock } from "../../format.js";
import { TIMELINE_RANGES } from "../_shared/timeseries/query-meta.js";
import { formatStepLabel } from "../_shared/timeseries/axis.js";
import type { UrlFallbackNotice } from "./url-state.js";

/** Props for the desk header (REQ-RANGE-01/03, REQ-FOLLOW-02, REQ-ZOOM-02/03). */
export interface TimelineControlsProps {
  /** Selected range. */ readonly range: RangeId;
  /** Pause anchor in epoch seconds, or null while live. */ readonly pausedAt: number | null;
  /** True when a zoom window is active (enables Reset zoom). */ readonly zoomed: boolean;
  /** Effective resolution in seconds, or null before the first alerts payload. */ readonly stepSeconds: number | null;
  /** Estate clock for the zone label and the paused time. */ readonly clock: EstateClock;
  /** Select a range (push). */ readonly onRange: (range: RangeId) => void;
  /** Pause live follow. */ readonly onPause: () => void;
  /** Resume live follow. */ readonly onResume: () => void;
  /** Clear the zoom window. */ readonly onResetZoom: () => void;
}

/** The desk header: range selector, live/paused control, reset zoom, zone and resolution labels. */
export function TimelineControls(props: TimelineControlsProps): ReactElement {
  return (
    <div data-slot="timeline-controls" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 [@media(max-width:30rem)]:gap-2">
      <RangeSelector value={props.range} onChange={props.onRange} />
      <LiveControl pausedAt={props.pausedAt} clock={props.clock} onPause={props.onPause} onResume={props.onResume} />
      <ResetZoom zoomed={props.zoomed} onReset={props.onResetZoom} />
      <ZoneLabel clock={props.clock} />
      <StepLabel stepSeconds={props.stepSeconds} />
    </div>
  );
}

/** Props for RangeSelector. */
export interface RangeSelectorProps {
  /** The checked range. */ readonly value: RangeId;
  /** Called with the newly chosen range (click, Enter or Space on an option). */ readonly onChange: (range: RangeId) => void;
}

/** The four ranges as segmented-control options. */
const RANGE_OPTIONS = TIMELINE_RANGES.map((r) => ({ value: r, label: r }));

/**
 * Four-option segmented control (1h, 6h, 24h, 7d): a `radiogroup` "Time range" of `radio` buttons
 * with `aria-checked`. Arrow keys move focus between options (roving tabindex); Enter or Space
 * checks the focused one. Buttons, not native radios: the shortcut registry ignores keys typed into
 * INPUT elements (07 §2.1). Each radio (the focusable control) carries the `[` / `]` shortcut hint:
 * `aria-keyshortcuts` takes KeyboardEvent `key` values, so the bracket characters themselves (not
 * the `code` names BracketLeft/BracketRight), space-separated as two alternative shortcuts.
 */
export function RangeSelector(props: RangeSelectorProps): ReactElement {
  const { value, onChange } = props;
  return (
    <SegmentedControl<RangeId>
      label="Time range"
      options={RANGE_OPTIONS}
      value={value}
      keyShortcuts="[ ]"
      onValueChange={(next) => {
        if (next !== value) onChange(next);
      }}
    />
  );
}

/** Props for LiveControl. */
export interface LiveControlProps {
  /** Pause anchor (epoch seconds) or null while live. */ readonly pausedAt: number | null;
  /** Estate clock for "Showing until {t}". */ readonly clock: EstateClock;
  /** Pause live follow. */ readonly onPause: () => void;
  /** Resume live follow. */ readonly onResume: () => void;
}

/** ISO string for an epoch-seconds instant; "" when it cannot be represented (clock.format → "—"). */
function isoOf(sec: number): string {
  const d = new Date(sec * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

/** Live/paused state text plus the single toggle button (07 §4.3). */
export function LiveControl(props: LiveControlProps): ReactElement {
  const live = props.pausedAt === null;
  return (
    <span data-slot="timeline-live" className="inline-flex flex-wrap items-center gap-2">
      <span
        data-slot="timeline-live-state"
        data-live={live ? "true" : "false"}
        className="inline-flex items-center gap-1 text-sm"
      >
        <Icon name={live ? "activity" : "clock"} />
        {live ? "Live" : `Showing until ${props.clock.format(isoOf(props.pausedAt!))}`}
      </span>
      {live ? (
        <Button type="button" variant="outline" size="sm" aria-keyshortcuts="l" onClick={() => props.onPause()}>
          Pause
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-keyshortcuts="l"
          data-paused="true"
          className="border-status-warn-border font-bold"
          onClick={() => props.onResume()}
        >
          <Icon name="play" />
          Paused — resume live
        </Button>
      )}
    </span>
  );
}

/** Props for ResetZoom. */
export interface ResetZoomProps {
  /** True when a zoom window is active. */ readonly zoomed: boolean;
  /** Clear the zoom window. */ readonly onReset: () => void;
}

/** Always-visible "Reset zoom" button; `disabled` while not zoomed (07 §4.4). */
export function ResetZoom(props: ResetZoomProps): ReactElement {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!props.zoomed}
      aria-keyshortcuts="0"
      onClick={() => props.onReset()}
    >
      Reset zoom
    </Button>
  );
}

/** Props for ZoneLabel. */
export interface ZoneLabelProps { /** Estate clock. */ readonly clock: EstateClock; }

/** "Times in {zone}", plus TZ_FALLBACK_MARKER when the estate zone fell back to UTC (07 §4.5). */
export function ZoneLabel(props: ZoneLabelProps): ReactElement {
  return (
    <span data-slot="timeline-zone" className="text-sm text-muted-foreground">
      {`Times in ${props.clock.timezone}`}
      {props.clock.tzFallback ? (
        <span data-slot="timeline-tz-fallback" className="text-status-warn-fg">{` · ${TZ_FALLBACK_MARKER}`}</span>
      ) : null}
    </span>
  );
}

/** Props for StepLabel. */
export interface StepLabelProps { /** Effective step in seconds, or null before data. */ readonly stepSeconds: number | null; }

/** "resolution: {step}" for a nullable step. */
function stepText(stepSeconds: number | null): string {
  return `resolution: ${stepSeconds === null ? "—" : formatStepLabel(stepSeconds)}`;
}

/** "resolution: {step}" — the effective resolution stays visible while zoomed (REQ-ZOOM-03). */
export function StepLabel(props: StepLabelProps): ReactElement {
  return (
    <span data-slot="timeline-step" className="text-sm text-muted-foreground">
      {stepText(props.stepSeconds)}
    </span>
  );
}

/** Props for UrlNotices. */
export interface UrlNoticesProps {
  /** One notice per URL key that fell back (05 copy), plus the sel notice when present. */ readonly notices: readonly UrlFallbackNotice[];
  /**
   * `pausedWindowOutOfHistoryText(range)` (05 §4.3.1) when `pausedWindowOutsideHistory(url, now)` is
   * true (§3.6.4), else null. Informational, not a fallback notice.
   */ readonly historyNotice: string | null;
}

/** Visible, dismissible notices for URL fallbacks and the paused-window-out-of-history limit. Renders nothing when empty. */
export function UrlNotices(props: UrlNoticesProps): ReactElement | null {
  const { notices, historyNotice } = props;
  // Dismissal is keyed on the notice content, so a new, different notice appears again (07 §4.7).
  const contentKey = JSON.stringify([notices.map((n) => [n.key, n.message]), historyNotice]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  if (notices.length === 0 && historyNotice === null) return null;
  if (dismissedKey === contentKey) return null;
  return (
    <Callout
      tone="info"
      role="status"
      compact
      dismissLabel="Dismiss"
      onDismiss={() => setDismissedKey(contentKey)}
    >
      {notices.map((n) => (
        <p key={n.key} data-notice-key={n.key} className="m-0">
          {n.message}
        </p>
      ))}
      {historyNotice !== null ? (
        <p data-notice-key="latest-window" className="m-0">
          {historyNotice}
        </p>
      ) : null}
    </Callout>
  );
}

/** Props for KioskStatusLine. */
export interface KioskStatusLineProps {
  /** Range in use. */ readonly range: RangeId;
  /** Estate clock. */ readonly clock: EstateClock;
  /** Effective step or null. */ readonly stepSeconds: number | null;
}

/** Range phrases for the kiosk line. */
const RANGE_TEXT: Readonly<Record<RangeId, string>> = {
  "1h": "Last 1 hour", "6h": "Last 6 hours", "24h": "Last 24 hours", "7d": "Last 7 days",
};

/** Non-interactive wallboard header: "Last 24 hours · Live · Times in {zone} · resolution: {step}". */
export function KioskStatusLine(props: KioskStatusLineProps): ReactElement {
  const parts = [RANGE_TEXT[props.range] ?? props.range, "Live", `Times in ${props.clock.timezone}`];
  if (props.clock.tzFallback) parts.push(TZ_FALLBACK_MARKER); // follows the zone (07 §4.8)
  parts.push(stepText(props.stepSeconds));
  return (
    <p data-slot="timeline-kiosk-status" className="m-0 text-base text-muted-foreground">
      {parts.join(" · ")}
    </p>
  );
}
