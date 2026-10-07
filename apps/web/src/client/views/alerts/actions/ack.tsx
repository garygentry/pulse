// actions/ack.tsx — the M2 ack affordance, mounted into the data-action-slot="ack" region (see
// actions/silence.tsx; REQ-ACK-01). The outer canAct wrapper is hook-free, so the component
// returns null when the capability is false (REQ-AUTHZ-04). Hooks live only in the inner component.
import type { ReactElement } from "react";
import { useState } from "react";
import type { ActionSlotProps } from "../detail/ActionSlots.js"; // type-only: no runtime cycle
import { ActionButton, useLazyDialog } from "../../../mutations/ActionButton.js";
import { PendingMarker } from "../../../mutations/StateBadge.js";
import { REASON_TEXT } from "../../../mutations/client.js";
import { canAct } from "../../../mutations/gating.js";
import type { AckDialogProps } from "../../../mutations/dialogs/AckDialog.js";
import { useSignals } from "@preact/signals-react/runtime";

function AckActionInner(p: ActionSlotProps): ReactElement {
  const [open, setOpen] = useState(false);
  const lazy = useLazyDialog<AckDialogProps>(() =>
    import("../../../mutations/dialogs/AckDialog.js").then((m) => m.default));
  const D = lazy.Comp;
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <ActionButton icon="circle-check" loading={lazy.loading} onClick={() => { lazy.open(); setOpen(true); }}>
        {p.alert.ack === undefined ? "Acknowledge…" : "Update acknowledgement…"}
      </ActionButton>
      <PendingMarker target={{ kind: "alert", fingerprint: p.alert.fingerprint }} />
      {lazy.error ? <p className="font-medium text-foreground">{REASON_TEXT.network}</p> : null}
      {D !== null && open ? (
        <D store={p.store} alert={p.alert} open={open} onClose={() => setOpen(false)} onDone={() => undefined} />
      ) : null}
    </div>
  );
}

/** Ack affordance (ACK-01). Hook-free outer gate: nothing at all unless canAct(store, "ack"). */
export const ackActionGate = (p: ActionSlotProps): ReactElement | null =>
  canAct(p.store, "ack") ? <AckActionInner alert={p.alert} store={p.store} /> : null;

/** The ack slot: subscribes to the signals the gate reads, then applies it. */
export function AckAction(p: ActionSlotProps): ReactElement | null {
  useSignals();
  return ackActionGate(p);
}
