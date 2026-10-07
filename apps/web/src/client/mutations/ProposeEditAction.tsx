// apps/web/src/client/mutations/ProposeEditAction.tsx — "Propose edit…" trigger for an estate entity
// (REQ-PROP-02, REQ-UX-01). Always rendered inside EntityActions' canAct gate. The dialog stays
// a lazy chunk; a success bumps proposalListRefresh so the new proposal shows as pending.
import type { ReactElement } from "react";
import { useState } from "react";
import type { WebEstateHostV2, WebEstateServiceV2 } from "@pulse/renderer";
import type { AppStore } from "../store/index.js";
import { announce } from "../a11y/index.js";
import { ActionButton, useLazyDialog } from "./ActionButton.js";
import { REASON_TEXT } from "./client.js";
import { proposalListRefresh } from "./proposals/ProposalList.js";
import type { ProposeDialogProps } from "./dialogs/ProposeDialog.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Props for {@link ProposeEditAction}: the estate entity and its declared values. */
export interface ProposeEditActionProps {
  readonly store: AppStore;
  readonly target: { readonly kind: "host" | "service"; readonly id: string };
  readonly declared: WebEstateHostV2 | WebEstateServiceV2;
}

/** "Propose edit…" button that lazily loads and opens the propose dialog. */
export function ProposeEditAction(p: ProposeEditActionProps): ReactElement {
  useSignals();
  const [open, setOpen] = useState(false);
  const lazy = useLazyDialog<ProposeDialogProps>(() => import("./dialogs/ProposeDialog.js").then((m) => m.default));
  const D = lazy.Comp;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <ActionButton icon="chevron-right" loading={lazy.loading} onClick={() => { lazy.open(); setOpen(true); }}>
        Propose edit…
      </ActionButton>
      {lazy.error ? <span className="font-medium text-foreground">{REASON_TEXT.network}</span> : null}
      {D !== null && open ? (
        <D store={p.store} target={p.target} declared={p.declared} open={open} onClose={() => setOpen(false)}
          onDone={() => {
            proposalListRefresh.value += 1;
            announce("Proposal submitted. It is pending review.", "polite");
          }} />
      ) : null}
    </span>
  );
}
