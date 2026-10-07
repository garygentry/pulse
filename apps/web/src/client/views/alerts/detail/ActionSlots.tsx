// detail/ActionSlots.tsx — the capability-gated action-slot seam. Always emits the named slot
// regions; gates the affordance inside each.
import type { ReactElement } from "react";
import { useEffect } from "react";
import { Section } from "@/ui";
import type { AppStore } from "../../../store/index.js";
import type { ActiveAlert } from "@pulse/web-data/wire";
import type { ActionProps, ActionSlotName } from "../constants.js";
import { ACTION_SLOTS } from "../constants.js";
import { canAct } from "../../../mutations/gating.js";
import { ensureSession } from "../../../mutations/session.js";
import { installPendingObserver } from "../../../mutations/pending.js";
import { useSignals } from "@preact/signals-react/runtime";
import { SilenceAction } from "../actions/silence.js"; // slot component (its inner branch holds the affordance)
import { AckAction } from "../actions/ack.js"; // slot component (its inner branch holds the affordance)

/** Slot component props: the pinned ActionProps extended by intersection with the store. */
export type ActionSlotProps = ActionProps & { readonly store: AppStore };

/** Static map from slot name → its slot component. */
const SLOT_COMPONENT: Record<ActionSlotName, (p: ActionSlotProps) => ReactElement | null> = {
  silence: SilenceAction,
  ack: AckAction,
};

/**
 * Render the two capability-gated action-slot regions for the selected alert. Each region is always
 * emitted as a stable, queryable DOM seam (`data-action-slot="<name>"`) so M2 can mount into the SAME
 * regions without restructuring the pane. Each region is gated by `canAct`, which denies by default,
 * and never on wallboard density or under ?kiosk=1, so a false/absent capability renders nothing —
 * never a disabled control (a muted note says so when no slot is enabled). Identity is NOT threaded
 * through props: slot components get only `alert` and `store`; no raw forwarded header is ever
 * surfaced — a slot reads the minimized `Identity` from `store.session` if needed.
 */
export function ActionSlots(props: { store: AppStore; alert: ActiveAlert }): ReactElement {
  useSignals();
  // Lazy session load + pending observer. ensureSession is a no-op when store.session is
  // already set, so a seeded session is never overwritten.
  useEffect(() => {
    void ensureSession(props.store);
    installPendingObserver(props.store);
  }, [props.store]);
  const enabled = ACTION_SLOTS.map((name) => [name, canAct(props.store, name)] as const);
  return (
    <Section level={3} title="Actions" data-section="actions">
      <div className="flex flex-wrap items-center gap-2">
        {enabled.map(([name, on]) => {
          const Affordance = SLOT_COMPONENT[name];
          return (
            <div key={name} data-action-slot={name} className="flex flex-wrap items-center gap-2 empty:hidden">
              {on ? <Affordance alert={props.alert} store={props.store} /> : null}
            </div>
          );
        })}
      </div>
      {enabled.every(([, on]) => !on) ? (
        <p className="text-sm text-muted-foreground" data-actions-none="">
          No actions are available in this session.
        </p>
      ) : null}
    </Section>
  );
}
