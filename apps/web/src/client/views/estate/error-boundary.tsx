// src/client/views/estate/error-boundary.tsx — unexpected-exception containment (spec 00 §6, 07 §5;
// REQ-OBS-01, REQ-ENT-04).
//
// Complementary to degrade.tsx: the degrade states are EXPECTED, first-class rendered states; this
// module handles UNEXPECTED throws. `RegionErrorBoundary` contains a throw to one region (the view
// never blanks); `safeCell` keeps one malformed row from throwing through a DataTable (which does
// NOT catch a throwing cell); `safeNavigate` makes a deep link to an unregistered route a no-op.

import { Component } from "react";
import type { ReactNode, ReactElement } from "react";

import { Callout, Icon } from "@/ui";
import { announce } from "../../a11y/index.js";
import type { PathRouter } from "../../router.js";
import type { RegionErrorBoundaryProps } from "./types.js";

/** Boundary state: the caught error (or null when the region is healthy). */
interface RegionErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Reusable per-region React error boundary (07 §5.1). On catch it records the error, announces the
 * failure assertively, and renders a localized callout naming `props.region` while sibling regions keep
 * rendering. The callout shows a generic message — never the caught error's message/stack (REQ-SEC-01).
 * It does not reset itself; a fresh payload that remounts the region clears it.
 */
export class RegionErrorBoundary extends Component<RegionErrorBoundaryProps, RegionErrorBoundaryState> {
  override state: RegionErrorBoundaryState = { error: null };

  /** Contain the error to this region: the next render shows the localized callout. */
  static getDerivedStateFromError(error: Error): RegionErrorBoundaryState {
    return { error };
  }

  /** Inform AT users of the contained fault. */
  override componentDidCatch(): void {
    announce(`The ${this.props.region} could not be displayed.`, "assertive");
  }

  /** Children when healthy; the localized error callout once caught. */
  override render(): ReactElement {
    if (this.state.error !== null) {
      return (
        <Callout
          tone="danger"
          icon="circle-alert"
          role="note"
          title={`This ${this.props.region} could not be displayed.`}
          data-region-error={this.props.region}
          data-status="critical"
        >
          The rest of the estate view is unaffected.
        </Callout>
      );
    }
    return <>{this.props.children}</>;
  }
}

/** The inline marker a guarded cell renders on throw: data-status + glyph + text (REQ-A11Y-01). */
function CellError(): ReactElement {
  return (
    <span data-status="critical" data-cell-error="" className="inline-flex items-center gap-1 font-medium">
      <Icon name="circle-alert" className="shrink-0" /> error
    </span>
  );
}

/**
 * Wrap a `DataTable` column cell renderer so a single malformed row degrades to an inline error cell
 * instead of throwing through the whole table/region (07 §5.2). Does not announce (per-row
 * announcements would be noisy). Generic over the cell's return type so a wrapped cell stays
 * assignable to the column's `cell` type.
 */
export function safeCell<Row, Out extends ReactNode = ReactNode>(
  cell: (row: Row) => Out,
): (row: Row) => Out | ReactElement {
  return (row) => {
    try {
      return cell(row);
    } catch {
      return <CellError />;
    }
  };
}

/**
 * Navigate defensively (07 §5.3). A deep link to a route that is not registered yet (e.g.
 * `/alerts/:fingerprint` before alert-triage lands) must never throw; any throw is swallowed.
 */
export function safeNavigate(router: PathRouter, path: string): void {
  try {
    router.navigate(path);
  } catch {
    /* unregistered route → benign no-op */
  }
}
