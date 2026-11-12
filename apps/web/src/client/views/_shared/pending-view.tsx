// src/client/views/_shared/pending-view.tsx — the shared "no payload accepted yet" surface for a view
// (F49/F50). A view with no payload either has a recorded delivery failure (shown as an error with
// its real reason and a Retry, never an endless spinner) or is still waiting: the loading layout,
// plus a "still waiting" notice with a Retry once the wait passes a bound.

import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { Button, Callout, ErrorState, TARGET_STATUS } from "@/ui";
import type { ViewDeliveryFailure, ViewDeliveryState } from "@pulse/web-data/wire";

/** How long a view may wait for its first payload before it says so (ms). */
export const PENDING_NOTICE_AFTER_MS = 20_000;

/**
 * The delivery failure worth showing for a view with no payload, or null. NOT_READY (the server is
 * still starting) and REQUEST_CANCELLED (superseded by this client) are not failures.
 */
export function pendingFailure(delivery: ViewDeliveryState): ViewDeliveryFailure | null {
  const failure = delivery.failure;
  if (failure === null || failure.code === "NOT_READY" || failure.code === "REQUEST_CANCELLED") return null;
  return failure;
}

/** True once `ms` has passed since mount (re-armed when `key` changes). */
function useElapsed(ms: number, key: unknown): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    setElapsed(false);
    const id = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(id);
  }, [ms, key]);
  return elapsed;
}

/** Props for {@link PendingView}. */
export interface PendingViewProps {
  /** The view's delivery state from the store. */
  readonly delivery: ViewDeliveryState;
  /** What could not be loaded, e.g. "The alerts could not be loaded". */
  readonly failureTitle: string;
  /** The view's own loading layout (shown while waiting). */
  readonly loading: ReactNode;
  /** Re-request the view now. */
  readonly onRetry: () => void;
  /** Override the bounded wait (tests). */
  readonly noticeAfterMs?: number;
}

/**
 * The pre-first-payload surface: a recorded failure → an error with its message and Retry; otherwise
 * the loading layout, joined after {@link PENDING_NOTICE_AFTER_MS} by a "still waiting" notice.
 */
export function PendingView(props: PendingViewProps): ReactElement {
  const failure = pendingFailure(props.delivery);
  const waitedTooLong = useElapsed(props.noticeAfterMs ?? PENDING_NOTICE_AFTER_MS, failure?.code ?? null);
  if (failure !== null) {
    return (
      <div data-slot="pending-view" data-pending="failed" data-failure={failure.code}>
        <ErrorState
          title={props.failureTitle}
          message={`${failure.message} Pulse keeps retrying automatically.`}
          onRetry={props.onRetry}
        />
      </div>
    );
  }
  return (
    <div data-slot="pending-view" data-pending={waitedTooLong ? "slow" : "loading"} className="flex min-w-0 flex-col gap-4">
      {waitedTooLong ? (
        <Callout
          compact
          role="status"
          tone={TARGET_STATUS.unknown.tone}
          icon="clock"
          title="Still waiting for the first update"
          action={<Button type="button" variant="outline" size="sm" onClick={props.onRetry}>Retry</Button>}
        >
          This is taking longer than usual. Pulse keeps retrying automatically.
        </Callout>
      ) : null}
      {props.loading}
    </div>
  );
}
