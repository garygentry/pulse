// One history-backed region rendered from its HistoryRegionState (02 §8, tech-spec §7.1/§7.3).
// Every phase renders something, so a region is never blank (REQ-HISTERR-01), and every string is a
// JSX text child, never markup (REQ-SEC-02).
import type { ReactNode, ReactElement } from "react";
import { useEffect, useState } from "react";
import { Button, EmptyState, Skeleton, cn } from "@/ui";
import type { IconName } from "@/ui";
import type { ClassifiedFailure, HistoryFailureKind, HistoryRegionState } from "./client.js";

/** Per-cause failure copy, exact text from tech-spec §7.1 (REQ-HISTERR-01). Plain strings. */
export const FAILURE_COPY: Readonly<Record<HistoryFailureKind, string>> = {
  overloaded: "History service is busy.",
  timeout: "History query timed out.",
  unavailable: "Metrics source unavailable.",
  "too-many": "Too many lanes/series for this range — try a shorter range.",
  "not-applicable": "Not applicable to this target/range.",
  superseded: "Estate model changed — history could not be reloaded.",
  "not-ready": "Engine starting — history not ready yet.",
  unexpected: "Unexpected error loading history.",
};

/** Fixed region UI text (plain strings; REQ-HISTERR-02/03, REQ-DEGRADE-01). */
export const REGION_TEXT = {
  /** Marker shown with retained data when a refresh failed (REQ-HISTERR-02). */
  stalePrevious: "Stale — showing previously loaded data.",
  /** Marker shown when the server served an expired-but-allowed cache entry (`payload.stale`). */
  staleCache: "Stale — history served from cache.",
  /** Retry button label. */
  retry: "Retry",
  /** Retry button label while a Retry-After delay is running. */
  retryIn: (seconds: number): string => `Retry in ${seconds}s`,
  /** Shorter-range affordance label (too-many). */
  shorterRange: "Try a shorter range",
  /** too-many title when no shorter range is available (`onShorterRange` null/absent): no suggestion. */
  tooManyNoShorter: "Too many lanes/series for this range.",
  /** Loading text for a region with nothing to show yet. */
  loading: (label: string): string => `Loading ${label}…`,
} as const;

/** Decorative icon per failure kind; the copy is the carrier (REQ-A11Y-01). */
const FAILURE_ICON: Readonly<Record<HistoryFailureKind, IconName>> = {
  overloaded: "circle-alert",
  timeout: "circle-alert",
  unavailable: "circle-alert",
  unexpected: "circle-alert",
  "too-many": "alert-triangle",
  "not-applicable": "minus",
  superseded: "refresh-cw",
  "not-ready": "clock",
};

/** Muted note text (not-applicable reason, loading label). */
const NOTE = "m-0 text-sm text-muted-foreground";
/** Stale / compact-failure notice: a left-bordered paragraph; the text carries the meaning. */
const NOTICE = "m-0 border-s-4 border-status-neutral-border bg-muted px-2 py-1 text-sm text-foreground";

/** Props for HistoryRegion. `T` is a history payload (all three carry `stale`). */
export interface HistoryRegionProps<T extends { readonly stale: boolean }> {
  /** Region state from useHistory. */
  readonly state: HistoryRegionState<T>;
  /** Short plain-text region name, e.g. "ingestion rate" or "alert history"; used in loading text and aria-label. */
  readonly label: string;
  /** Renders the data. `stale` is true for retained data after a failed refresh, or when `data.stale` is true. */
  readonly children: (data: T, stale: boolean) => ReactNode;
  /** Manual retry (useHistory().retry). When absent, no Retry button is rendered even for retryable kinds. */
  readonly onRetry?: () => void;
  /** Select a shorter range (timeline only). Absent/null = no shorter range exists: too-many renders `REGION_TEXT.tooManyNoShorter`, with no suggestion. */
  readonly onShorterRange?: (() => void) | null;
  /** Content for the idle phase (e.g. "Select a lane to see its charts"). Default: nothing. */
  readonly idle?: ReactNode;
  /** Skeleton height class for the empty-loading phase. Default "h-12". */
  readonly loadingHeight?: string;
  /** Extra class names for the region root. */
  readonly className?: string;
}

/**
 * Render one history-backed region from its HistoryRegionState (tech-spec §7.1, §7.3).
 * Every phase renders something, so a region is never blank (REQ-HISTERR-01). All text is JSX text
 * children, never markup (REQ-SEC-02).
 */
export function HistoryRegion<T extends { readonly stale: boolean }>(props: HistoryRegionProps<T>): ReactElement {
  const { state, label } = props;
  const cls = cn("flex flex-col gap-2", props.className);
  const shorter = typeof props.onShorterRange === "function" ? props.onShorterRange : null;
  const onRetry = props.onRetry ?? null;

  switch (state.phase) {
    case "idle":
      return (
        <section data-slot="history-region" className={cls} aria-label={label} data-history-phase="idle">
          {props.idle ?? null}
        </section>
      );
    case "not-applicable":
      return (
        <section data-slot="history-region" className={cls} aria-label={label} data-history-phase="not-applicable">
          <p data-slot="history-region-note" className={NOTE}>{state.reason}</p>
        </section>
      );
    case "loading":
      if (state.previous === null) {
        return (
          <section data-slot="history-region" className={cls} aria-label={label} aria-busy="true" data-history-phase="loading">
            <Skeleton className={cn("w-full", props.loadingHeight ?? "h-12")} />
            <p data-slot="history-region-note" className={NOTE}>{REGION_TEXT.loading(label)}</p>
          </section>
        );
      }
      return (
        <section
          data-slot="history-region"
          className={cls}
          aria-label={label}
          aria-busy="true"
          data-history-phase="loading"
          data-history-refreshing="true"
        >
          {props.children(state.previous, state.previous.stale)}
        </section>
      );
    case "ready":
      return (
        <section data-slot="history-region" className={cls} aria-label={label} data-history-phase="ready" data-history-stale={String(state.data.stale)}>
          {state.data.stale ? <p data-slot="history-region-stale" className={NOTICE}>{REGION_TEXT.staleCache}</p> : null}
          {props.children(state.data, state.data.stale)}
        </section>
      );
    case "error":
      if (state.previous !== null) {
        return (
          <section
            data-slot="history-region"
            className={cls}
            aria-label={label}
            data-history-phase="error"
            data-history-kind={state.failure.kind}
            data-history-code={state.failure.code}
            data-history-stale="true"
          >
            <FailureNotice failure={state.failure} compact onRetry={onRetry} onShorterRange={shorter} />
            <p data-slot="history-region-stale" className={NOTICE}>{REGION_TEXT.stalePrevious}</p>
            {props.children(state.previous, true)}
          </section>
        );
      }
      return (
        <section
          data-slot="history-region"
          className={cls}
          aria-label={label}
          data-history-phase="error"
          data-history-kind={state.failure.kind}
          data-history-code={state.failure.code}
        >
          <FailureNotice failure={state.failure} compact={false} onRetry={onRetry} onShorterRange={shorter} />
        </section>
      );
  }
}

interface FailureNoticeProps {
  readonly failure: ClassifiedFailure;
  /** Compact paragraph above retained data, instead of a full EmptyState. */
  readonly compact: boolean;
  readonly onRetry: (() => void) | null;
  readonly onShorterRange: (() => void) | null;
}

/** Failure copy plus its actions, as an EmptyState or a compact status paragraph (02 §8.3/§8.4). */
function FailureNotice(props: FailureNoticeProps): ReactElement {
  const { failure, onRetry, onShorterRange } = props;
  const title =
    failure.kind === "too-many" && onShorterRange === null ? REGION_TEXT.tooManyNoShorter : FAILURE_COPY[failure.kind];
  const retry = failure.retryable && onRetry !== null ? <RetryButton failure={failure} onRetry={onRetry} /> : null;
  const shorterButton =
    failure.kind === "too-many" && onShorterRange !== null ? (
      <Button type="button" variant="outline" size="sm" onClick={() => onShorterRange()}>
        {REGION_TEXT.shorterRange}
      </Button>
    ) : null;

  if (props.compact) {
    return (
      <p data-slot="history-region-failure" className={NOTICE} role="status">
        {title}
        {retry !== null ? " " : null}
        {retry}
        {shorterButton !== null ? " " : null}
        {shorterButton}
      </p>
    );
  }
  const action = retry !== null || shorterButton !== null ? <>{retry}{shorterButton}</> : null;
  return <EmptyState title={title} icon={FAILURE_ICON[failure.kind]} {...(action !== null ? { action } : {})} />;
}

/** Whole seconds of the server-suggested delay, or 0 when none. */
function retryDelaySeconds(failure: ClassifiedFailure): number {
  const s = failure.retryAfterSeconds;
  return s !== null && Number.isFinite(s) && s > 0 ? Math.ceil(s) : 0;
}

/**
 * Retry button with an optional Retry-After countdown keyed by the failure object's identity: it
 * reads "Retry in Ns" (disabled) until the delay has elapsed, then "Retry" (enabled).
 */
function RetryButton(props: { readonly failure: ClassifiedFailure; readonly onRetry: () => void }): ReactElement {
  const { failure, onRetry } = props;
  const initial = retryDelaySeconds(failure);
  const [countdown, setCountdown] = useState<{ readonly failure: ClassifiedFailure; readonly remaining: number }>(
    () => ({ failure, remaining: initial }),
  );
  const remaining = countdown.failure === failure ? countdown.remaining : initial;

  useEffect(() => {
    const total = retryDelaySeconds(failure);
    setCountdown({ failure, remaining: total });
    if (total <= 0) return;
    let left = total;
    const id = setInterval(() => {
      left -= 1;
      setCountdown({ failure, remaining: left });
      if (left <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [failure]);

  const waiting = remaining > 0;
  return (
    <Button type="button" variant="outline" size="sm" disabled={waiting} onClick={() => onRetry()}>
      {waiting ? REGION_TEXT.retryIn(remaining) : REGION_TEXT.retry}
    </Button>
  );
}
