// apps/web/src/client/mutations/ExpireButton.tsx — per-silence expire row action (REQ-SIL-07/08).
// Offered on ANY listed silence, whoever created it (SIL-07). The mount effect lives in the outer component
// so ensureSession fetches while the capability is still unknown; the outer gate renders nothing unless
// canAct(store, "silence") (REQ-AUTHZ-04/05). The dialog stays a lazy chunk.
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import type { ActiveSilence } from "@pulse/web-data/wire";
import type { AppStore } from "../store/index.js";
import { ActionButton, useLazyDialog } from "./ActionButton.js";
import { PendingMarker } from "./StateBadge.js";
import { REASON_TEXT } from "./client.js";
import { canAct } from "./gating.js";
import { ensureSession } from "./session.js";
import { installPendingObserver } from "./pending.js";
import type { ExpireDialogProps } from "./dialogs/ExpireDialog.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Props for {@link ExpireButton}: the silence to expire and the app store. */
export interface ExpireButtonProps {
  readonly silence: ActiveSilence;
  readonly store: AppStore;
}

function ExpireButtonInner(p: ExpireButtonProps): ReactElement {
  const [open, setOpen] = useState(false);
  const lazy = useLazyDialog<ExpireDialogProps>(() => import("./dialogs/ExpireDialog.js").then((m) => m.default));
  const D = lazy.Comp;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <ActionButton variant="danger" icon="x" loading={lazy.loading} label={`Expire silence ${p.silence.id}`}
        onClick={() => { lazy.open(); setOpen(true); }}>Expire…</ActionButton>
      <PendingMarker target={{ kind: "silence", silenceId: p.silence.id }} />
      {lazy.error ? <span className="font-medium text-foreground">{REASON_TEXT.network}</span> : null}
      {D !== null && open ? (
        <D store={p.store} silence={p.silence} open={open} onClose={() => setOpen(false)} onDone={() => undefined} />
      ) : null}
    </span>
  );
}

/** Row action. Ensures session + observer on mount; outer gate renders nothing unless canAct(store, "silence"). */
export function ExpireButton(p: ExpireButtonProps): ReactElement | null {
  useSignals();
  useEffect(() => { void ensureSession(p.store); installPendingObserver(p.store); }, [p.store]);
  return canAct(p.store, "silence") ? <ExpireButtonInner silence={p.silence} store={p.store} /> : null;
}
