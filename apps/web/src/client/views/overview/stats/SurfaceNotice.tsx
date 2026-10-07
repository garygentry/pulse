// apps/web/src/client/views/overview/stats/SurfaceNotice.tsx — the no-snapshot overview states.
// `loading` renders a busy LoadingState with the not-ready copy; `unavailable` renders the
// EmptyState "Overview unavailable" with a "Reload overview" button. The page-reload fallback is an
// INJECTED callback: the view passes a window-reload adapter, tests pass a spy. Nothing here
// fetches, retries or arms a timer — automatic recovery stays owned by live-state.

import type { ReactElement } from "react";

import { Button, EmptyState, LoadingState } from "@/ui";
import type { OverviewSurfaceState } from "../model.js";

/** EmptyState title for the no-snapshot failed-delivery state. */
export const OVERVIEW_UNAVAILABLE_TITLE = "Overview unavailable";
/** Visible/accessible name of the page-level recovery action. */
export const RELOAD_OVERVIEW_LABEL = "Reload overview";

/** Props for {@link OverviewSurfaceNotice}. */
export interface OverviewSurfaceNoticeProps {
  /** A surface state without an accepted snapshot. */
  readonly surface: Extract<OverviewSurfaceState, { status: "loading" | "unavailable" }>;
  /** Page-level recovery action (the view injects a window reload). */
  readonly onReload: () => void;
}

/** Render the explicit loading/not-ready or unavailable-with-reload state; never a blank grid. */
export function OverviewSurfaceNotice(props: OverviewSurfaceNoticeProps): ReactElement {
  const { surface, onReload } = props;
  if (surface.status === "loading") {
    return (
      <div className="grid gap-4" data-surface="loading" aria-busy="true">
        <LoadingState label={surface.message} preset="cards" rows={3} />
      </div>
    );
  }
  return (
    <div className="grid gap-4" data-surface="unavailable">
      <EmptyState
        title={OVERVIEW_UNAVAILABLE_TITLE}
        description={surface.message}
        action={
          <Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={() => onReload()}>
            {RELOAD_OVERVIEW_LABEL}
          </Button>
        }
      />
    </div>
  );
}
