// actions/silence.tsx — the M2 silence affordance, mounted into the data-action-slot="silence" region
// (alert-triage REQ-ACTION-03 seam filled in place; REQ-SIL-01). The outer canAct wrapper is
// hook-free, so the component still returns null when the capability is false (REQ-AUTHZ-04) and can be
// called as a plain function. Hooks live only in the inner component.
import type { ReactElement } from "react";
import { useState } from "react";
import type { ActionSlotProps } from "../detail/ActionSlots.js"; // type-only: no runtime cycle
import type { CreateSilenceResult } from "../../../../shared/mutations.js";
import { ActionButton, useLazyDialog } from "../../../mutations/ActionButton.js";
import { PendingMarker } from "../../../mutations/StateBadge.js";
import { REASON_TEXT } from "../../../mutations/client.js";
import { canAct } from "../../../mutations/gating.js";
import type { SilenceDialogProps } from "../../../mutations/dialogs/SilenceDialog.js";
import { useSignals } from "@preact/signals-react/runtime";

function SilenceActionInner(p: ActionSlotProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const lazy = useLazyDialog<SilenceDialogProps>(() =>
    import("../../../mutations/dialogs/SilenceDialog.js").then((m) => m.default));
  const D = lazy.Comp;
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <ActionButton icon="bell" loading={lazy.loading} onClick={() => { lazy.open(); setOpen(true); }}>Silence…</ActionButton>
      {created !== null ? <PendingMarker target={{ kind: "silence", silenceId: created }} /> : null}
      {lazy.error ? <p className="font-medium text-foreground">{REASON_TEXT.network}</p> : null}
      {D !== null && open ? (
        <D store={p.store} alert={p.alert} open={open} onClose={() => setOpen(false)}
          onDone={(r: CreateSilenceResult) => setCreated(r.silenceId)} />
      ) : null}
    </div>
  );
}

/** Silence affordance (SIL-01). Hook-free outer gate: nothing at all unless canAct(store, "silence"). */
export const silenceActionGate = (p: ActionSlotProps): ReactElement | null =>
  canAct(p.store, "silence") ? <SilenceActionInner alert={p.alert} store={p.store} /> : null;

/** The silence slot: subscribes to the signals the gate reads, then applies it. */
export function SilenceAction(p: ActionSlotProps): ReactElement | null {
  useSignals();
  return silenceActionGate(p);
}
