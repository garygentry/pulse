// src/client/views/alerts/detail/DetailPane.tsx — the read-only alert drill-down Sheet.
//
// A pure function of the URL selection and the payload: open iff `selected` is non-null. The pane owns
// no open signal and never navigates — `onClose` (wired by view.tsx) clears `sel`. The Sheet is opened
// without a DialogTrigger, so the pane records what had focus on open (the row-open control) and
// returns focus there on close.
import type { ReactElement } from "react";
import { useRef } from "react";

import {
  Button,
  EmptyState,
  Icon,
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  cssEscape,
} from "@/ui";
import type { AppStore } from "../../../store/index.js";
import type { ActiveAlert, AlertsPayload } from "@pulse/web-data/wire";
import { AckInfo } from "../../../mutations/AckInfo.js";
import { resolveSelected } from "../url-state.js";
import { ActionSlots } from "./ActionSlots.js";
import { History } from "./History.js";
import { LabelsAnnotations } from "./LabelsAnnotations.js";
import { Related } from "./Related.js";
import { Routing } from "./Routing.js";
import { Silences } from "./Silences.js";

/** Props for {@link DetailPane}. Selection is URL-derived; the pane owns no open signal. */
export interface DetailPaneProps {
  /** The whole app store (read-only): session capabilities for the action slots. */
  readonly store: AppStore;
  /** The already-narrowed alerts payload, or null before the first cycle populates it. */
  readonly payload: AlertsPayload | null;
  /** The URL `sel` value (an `ActiveAlert.fingerprint`), or null when the pane is closed. */
  readonly selected: string | null;
  /** Clears `sel` from the URL (implemented by view.tsx). Called when the Sheet asks to close (Escape, Close). */
  readonly onClose: () => void;
  /** Switch the open alert to a related one (view.tsx navigates `?sel=<fingerprint>`). */
  readonly onSelect?: (fingerprint: string) => void;
}

/** Accessible name of the visible close control. */
export const CLOSE_ALERT_DETAILS_LABEL = "Close alert details";

/** The element to give focus back to on close: the captured opener when it is still mounted, else
 *  the row-open control for the same alert (the triage table may have re-rendered it). */
function returnTarget(el: HTMLElement | null): HTMLElement | null {
  if (el === null) return null;
  if (el.isConnected) return el;
  const fingerprint = el.getAttribute("data-triage-open");
  if (fingerprint === null) return null;
  return el.ownerDocument.querySelector<HTMLElement>(`[data-triage-open="${cssEscape(fingerprint)}"]`);
}

/**
 * The alert detail pane. When `selected` resolves to a firing alert, renders the composed sections in
 * order (read-only ack info, labels/annotations, routing, silences, history, related, action slots);
 * when `selected` is set but resolves to no firing alert (churned fingerprint / resolved alert),
 * renders a distinct "no longer firing" EmptyState INSIDE the Sheet — never a blank pane or an error.
 */
export function DetailPane(props: DetailPaneProps): ReactElement {
  const selected = props.selected;
  const open = selected !== null;
  const alert: ActiveAlert | null =
    open && props.payload !== null ? resolveSelected(props.payload, selected) : null;

  const title = alert !== null ? alert.name : "Alert";

  const returnFocus = useRef<HTMLElement | null>(null);

  const onOpenAutoFocus = (event: Event): void => {
    const content = event.currentTarget as HTMLElement | null;
    const active = content?.ownerDocument.activeElement;
    returnFocus.current = active instanceof HTMLElement && active !== content?.ownerDocument.body ? active : null;
    if (content === null) return;
    // Focus the dialog itself (named by its title), so Tab reaches Close next.
    event.preventDefault();
    content.focus({ preventScroll: true });
  };
  const onCloseAutoFocus = (event: Event): void => {
    event.preventDefault();
    const el = returnTarget(returnFocus.current);
    returnFocus.current = null;
    el?.focus();
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      {open ? (
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          data-alerts-detail=""
          className="w-full gap-0 outline-none sm:max-w-xl"
        >
          <SheetHeader className="flex-row items-start justify-between gap-2 border-b">
            <SheetTitle className="min-w-0 self-center text-lg break-words">{title}</SheetTitle>
            <SheetClose asChild>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 min-w-11 shrink-0 border-border"
                aria-label={CLOSE_ALERT_DETAILS_LABEL}
              >
                <Icon name="x" />
                Close
              </Button>
            </SheetClose>
          </SheetHeader>
          <div className="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto p-4" data-detail-body="">
            {alert === null ? (
              <EmptyState
                icon="circle-alert"
                title="This alert is no longer firing"
                description="It may have resolved, or its fingerprint changed after an Alertmanager restart or rule edit. Close this panel to return to the current firing list."
              />
            ) : (
              <>
                <AckInfo ack={alert.ack} />
                <LabelsAnnotations alert={alert} />
                <Routing alert={alert} />
                <Silences alert={alert} payload={props.payload} store={props.store} />
                <History alert={alert} />
                <Related
                  payload={props.payload}
                  alert={alert}
                  {...(props.onSelect !== undefined ? { onSelect: props.onSelect } : {})}
                />
                <ActionSlots store={props.store} alert={alert} />
              </>
            )}
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
