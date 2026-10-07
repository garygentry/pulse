// src/client/views/estate/degrade.tsx — the two EXPECTED degradation axes (spec 00 §4, 07 §2–§4;
// REQ-DEG-01/02/03, REQ-A11Y-01, invariant I3 never-silent-green).
//
// 1. Whole-payload delivery state: `toDeliveryState` is the SINGLE adapter site translating the
//    store's per-view delivery state into the view-local `EstateDeliveryState`; `renderDelivery`
//    gates every surface on `kind === "ready"`.
// 2. Per-artifact availability: `classifyAvailability` + the absent / clean / stale renderers every
//    surface shares (07 §3.3), so absent-vs-clean-vs-stale reads the same view-wide.
//
// Whole-payload delivery states and staleness notices carry data-status + glyph + text label (never
// color alone) and announce on mount. Unexpected exceptions are error-boundary.tsx's job.

import type { ReactNode, ReactElement } from "react";
import { useEffect } from "react";
import type { DataAvailability } from "@pulse/web-data/wire";

import { Button, Callout, EmptyState, ErrorState, Icon, LoadingState, TARGET_STATUS } from "@/ui";
import type { IconName } from "@/ui";
import { announce } from "../../a11y/index.js";
import type { EstateDeliveryState } from "./types.js";

// ── §2.3 Retry seam ──────────────────────────────────────────────────────────

/** Asks the live-state adapter to refetch; the view itself never performs network I/O. */
export type DeliveryRetry = () => void;

// ── §2.5 Per-state components ────────────────────────────────────────────────

/** Announce once per mount (re-renders do not re-announce). */
function useAnnounceOnMount(message: string, politeness: "polite" | "assertive" = "polite"): void {
  useEffect(() => {
    announce(message, politeness);
  }, []);
}

function RetryButton({ onRetry }: { readonly onRetry: DeliveryRetry }): ReactElement {
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => onRetry()}>
      <Icon name="refresh-cw" /> Retry
    </Button>
  );
}

/** `kind: "loading"` — first fetch in flight. Skeleton inside an aria-busy labelled region. */
export function DeliveryLoading(): ReactElement {
  useAnnounceOnMount("Loading the estate");
  return (
    <section
      className="flex items-start gap-2"
      data-degrade="loading"
      data-status="unknown"
      aria-busy="true"
      aria-label="Loading the estate"
    >
      <Icon name="loader" className="mt-0.5 shrink-0 text-muted-foreground" />
      <LoadingState label="Loading the estate…" rows={3} />
    </section>
  );
}

/** Props for {@link DeliveryNotReady}. */
export interface DeliveryNotReadyProps {
  /** Retry seam; when omitted, no retry button is rendered. */
  readonly onRetry?: DeliveryRetry;
}

/** `kind: "not-ready"` — server has not completed its first cycle (503). */
export function DeliveryNotReady(props: DeliveryNotReadyProps): ReactElement {
  useAnnounceOnMount("Estate is still warming up");
  return (
    <section data-degrade="not-ready" data-status="unknown">
      <EmptyState
        icon="loader"
        title="Estate is still warming up"
        description="The server has not completed its first cycle yet."
        {...(props.onRetry !== undefined ? { action: <RetryButton onRetry={props.onRetry} /> } : {})}
      />
    </section>
  );
}

/** Props for {@link DeliveryModelAbsent}. */
export interface DeliveryModelAbsentProps {
  /** Configuration guidance (from `state.guidance`). */
  readonly guidance: string;
}

/** `kind: "model-absent"` — no rendered tree. A HARD empty-state (not clean, not loading); no retry. */
export function DeliveryModelAbsent(props: DeliveryModelAbsentProps): ReactElement {
  useAnnounceOnMount(`No rendered estate. ${props.guidance}`);
  return (
    <section data-degrade="model-absent" data-status="warning">
      <EmptyState icon="server" title="No rendered estate" description={props.guidance} />
    </section>
  );
}

/** Props for {@link DeliveryError}. */
export interface DeliveryErrorProps {
  /** Display-only failure detail (from `state.message`). */
  readonly message: string;
  /** Retry seam; when omitted, no retry button is rendered. */
  readonly onRetry?: DeliveryRetry;
}

/** `kind: "error"` — fetch failed. Announced assertively by the ErrorState `role="alert"`. */
export function DeliveryError(props: DeliveryErrorProps): ReactElement {
  return (
    <section data-degrade="error" data-status="critical">
      <ErrorState
        title="The estate could not be loaded"
        message={props.message}
        {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
      />
    </section>
  );
}

// ── §2.4 renderDelivery ──────────────────────────────────────────────────────

/** Options for {@link renderDelivery}. */
export interface RenderDeliveryOptions {
  /** Retry seam for `not-ready`/`error`. */
  readonly onRetry?: DeliveryRetry;
  /** Thunk building the ready surfaces — evaluated ONLY on `kind === "ready"` (I3). */
  readonly children: () => ReactNode;
}

/** The outermost gate of the view: one first-class degrade state, or the ready surfaces. */
export function renderDelivery(state: EstateDeliveryState, opts: RenderDeliveryOptions): ReactNode {
  const retry = opts.onRetry !== undefined ? { onRetry: opts.onRetry } : {};
  switch (state.kind) {
    case "loading":
      return <DeliveryLoading />;
    case "not-ready":
      return <DeliveryNotReady {...retry} />;
    case "model-absent":
      return <DeliveryModelAbsent guidance={state.guidance} />;
    case "error":
      return <DeliveryError message={state.message} {...retry} />;
    case "ready":
      return opts.children();
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

// ── §3.2 Empty-state / staleness components ──────────────────────────────────

/** Props for {@link AbsentArtifactState}. */
export interface AbsentArtifactStateProps {
  /** Human name of the sub-artifact, e.g. "Coverage", "Findings". */
  readonly artifact: string;
  /** Reason from `section.availability.message` (may be null). */
  readonly reason: string | null;
}

/** `"absent"` — null on an older rendered tree. The "re-render to populate" state, DISTINCT from clean. */
export function AbsentArtifactState(props: AbsentArtifactStateProps): ReactElement {
  return (
    <div data-degrade="absent" data-status="unknown">
      <EmptyState
        compact
        icon="info"
        title={`${props.artifact} not available — re-render to populate`}
        description={
          props.reason ?? `This rendered estate has no ${props.artifact.toLowerCase()} data. Re-render to populate it.`
        }
      />
    </div>
  );
}

/** Props for {@link CleanEmptyState}. */
export interface CleanEmptyStateProps {
  /** Title, e.g. "No findings". */
  readonly title: string;
  /** Optional secondary text. */
  readonly description?: string;
  /** Icon for the clean state; defaults to `circle-check`. */
  readonly icon?: IconName;
}

/** `"empty"` — present, current, genuinely empty. The ONLY empty-state that may imply "all good". */
export function CleanEmptyState(props: CleanEmptyStateProps): ReactElement {
  return (
    <div data-degrade="clean" data-status="ok">
      <EmptyState
        compact
        icon={props.icon ?? "circle-check"}
        title={props.title}
        {...(props.description !== undefined ? { description: props.description } : {})}
      />
    </div>
  );
}

/** Props for {@link StaleNote}. */
export interface StaleNoteProps {
  /** The section's availability envelope. */
  readonly availability: DataAvailability;
}

const STALE_LABEL: Readonly<Record<DataAvailability["state"], string>> = {
  current: "Data is current",
  stale: "Data may be out of date",
  unavailable: "Data unavailable — showing last known",
  "not-configured": "Source not configured",
};

/**
 * `"stale"` — present but not `current`. A banner rendered ALONGSIDE (not instead of) the content,
 * which must never be badged ok (I3). role="status"; announced politely on mount. Spec 07 names
 * this `StalenessNote`; exported as `StaleNote` (the name findings.tsx imports) plus the alias.
 */
export function StaleNote(props: StaleNoteProps): ReactElement {
  const { availability } = props;
  const label = STALE_LABEL[availability.state];
  useAnnounceOnMount(availability.message !== null ? `${label}: ${availability.message}` : label);
  return (
    <Callout
      tone={TARGET_STATUS.warning.tone}
      icon="wifi-off"
      role="status"
      compact
      title={label}
      data-status="warning"
      data-availability={availability.state}
    >
      {availability.message !== null || availability.lastGoodAt !== null ? (
        <>
          {availability.message !== null ? <p data-stale-message="">{availability.message}</p> : null}
          {availability.lastGoodAt !== null ? (
            <p data-stale-last-good="" className="text-muted-foreground">
              Last good: <time dateTime={availability.lastGoodAt}>{availability.lastGoodAt}</time>
            </p>
          ) : null}
        </>
      ) : null}
    </Callout>
  );
}

/** Spec-07 name for {@link StaleNote}. */
export const StalenessNote = StaleNote;
export type StalenessNoteProps = StaleNoteProps;
