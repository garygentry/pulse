// apps/web/src/client/mutations/StateBadge.tsx — action-state badge + pending marker
// (REQ-UX-04, REQ-A11Y-04).
import type { ReactElement } from "react";
import { Button, Icon, MUTATION_STATE, StatusBadge } from "@/ui";
import { pendingTracker } from "./pending.js";
import type { PendingTarget } from "./pending.js";
import { useSignals } from "@preact/signals-react/runtime";

/** The three action states (REQ-UX-04, REQ-A11Y-04). */
export type ActionState = "acked" | "pending" | "failed";
/** Props for {@link StateBadge}: the action state and an optional label override. */
export interface StateBadgeProps {
  /** Which action state to render. */ readonly state: ActionState;
  /** Overrides the default label. */ readonly label?: string;
}

/** Glyph + visible text + tone: never colour alone (A11Y-04). */
export function StateBadge(p: StateBadgeProps & { readonly onDismiss?: () => void }): ReactElement {
  const label = p.label ?? MUTATION_STATE[p.state].label;
  return (
    <span className="inline-flex items-center gap-1" data-state={p.state}>
      {StatusBadge.fromMap(MUTATION_STATE, p.state, { label })}
      {p.onDismiss !== undefined ? (
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Dismiss: ${label}`} onClick={p.onDismiss}>
          <Icon name="x" />
        </Button>
      ) : null}
    </span>
  );
}

/** Tracker state for a target: nothing | "Pending" | "Not yet reflected in live data" (dismissable). */
export function PendingMarker(p: { readonly target: PendingTarget }): ReactElement | null {
  useSignals();
  void pendingTracker.version.value; // subscribe
  const st = pendingTracker.stateOf(p.target, performance.now());
  if (st === null) return null;
  return st === "pending"
    ? <StateBadge state="pending" />
    : <StateBadge state="pending" label="Not yet reflected in live data" onDismiss={() => pendingTracker.dismiss(p.target)} />;
}
