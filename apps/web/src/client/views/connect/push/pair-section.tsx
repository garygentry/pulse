// apps/web/src/client/views/connect/push/pair-section.tsx — the "Pair a device" section on /connect: issue a
// one-time pairing code on an explicit click, show its remaining validity, cancel it, and report when it was used.
// The issued link lives only in React state; it is never stored, logged or put in the URL.
import { useCallback, useEffect, useReducer, useRef, type ReactElement } from "react";
import type { PairingTokenIssued, PushStatusPayload } from "@pulse/web-data/wire";
import { Callout, LoadingState, Section, VisuallyHidden, focusIsLost } from "@/ui";

import { ActionButton } from "../../../mutations/ActionButton.js";
import { displayText } from "../../../mutations/client.js";
import { cancelPairingToken, issuePairingToken, pushErrorText, type PushClientError } from "./push-api.js";
import type { PairingLinkOverride } from "./push-sections.js";
import { PAIRING_STATE } from "./status-maps.js";
import { useCountdown } from "./use-countdown.js";

type Outstanding = {
  readonly kind: "outstanding";
  readonly link: string;
  readonly expiresAt: string;
  /** Device ids present when the code was issued (paired detection). */
  readonly knownIds: ReadonlySet<string>;
};
/** After a reload or another tab's issue: a web code exists but this page does not know its link. */
type OutstandingUnknown = { readonly kind: "outstanding-unknown"; readonly expiresAt: string };

/** The pair flow's state. */
export type PairFlowState =
  | { readonly kind: "idle" }
  | { readonly kind: "issuing" }
  | Outstanding
  | OutstandingUnknown
  | { readonly kind: "cancelling"; readonly from: Outstanding | OutstandingUnknown }
  | { readonly kind: "expired" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "paired"; readonly displayName: string }
  | { readonly kind: "error"; readonly error: PushClientError };

/** What moves the pair flow. */
export type PairEvent =
  | { readonly type: "issue" }
  | { readonly type: "issued"; readonly issued: PairingTokenIssued; readonly knownIds: ReadonlySet<string> }
  | { readonly type: "issue-failed"; readonly error: PushClientError }
  | { readonly type: "status"; readonly status: PushStatusPayload; readonly nowMs: number }
  | { readonly type: "expire" }
  | { readonly type: "cancel" }
  | { readonly type: "cancelled" }
  | { readonly type: "cancel-failed"; readonly error: PushClientError }
  | { readonly type: "dismiss" };

const ISSUABLE = new Set<PairFlowState["kind"]>(["idle", "expired", "cancelled", "paired", "error", "outstanding-unknown"]);
const DISMISSABLE = new Set<PairFlowState["kind"]>(["expired", "cancelled", "paired", "error"]);

/** Same instant, whatever the ISO spelling. */
function sameInstant(a: string, b: string): boolean {
  return a === b || Date.parse(a) === Date.parse(b);
}

function onStatus(state: PairFlowState, status: PushStatusPayload, nowMs: number): PairFlowState {
  const outstanding = status.outstanding;
  switch (state.kind) {
    case "idle":
      return outstanding !== null ? { kind: "outstanding-unknown", expiresAt: outstanding.expiresAt } : state;
    case "outstanding": {
      if (outstanding !== null) {
        return sameInstant(outstanding.expiresAt, state.expiresAt)
          ? state
          : { kind: "outstanding-unknown", expiresAt: outstanding.expiresAt };
      }
      const added = status.devices.find((device) => !state.knownIds.has(device.id));
      if (added !== undefined) return { kind: "paired", displayName: added.displayName };
      const expiresMs = Date.parse(state.expiresAt);
      return !Number.isFinite(expiresMs) || nowMs >= expiresMs ? { kind: "expired" } : { kind: "cancelled" };
    }
    case "outstanding-unknown":
      return outstanding === null ? { kind: "idle" } : state;
    default:
      return state;
  }
}

/** Pure transition function. Unlisted (state, event) pairs return the state unchanged. */
export function pairReducer(state: PairFlowState, event: PairEvent): PairFlowState {
  switch (event.type) {
    case "issue":
      return ISSUABLE.has(state.kind) ? { kind: "issuing" } : state;
    case "issued":
      return state.kind === "issuing"
        ? { kind: "outstanding", link: event.issued.link, expiresAt: event.issued.expiresAt, knownIds: event.knownIds }
        : state;
    case "issue-failed":
      return state.kind === "issuing" ? { kind: "error", error: event.error } : state;
    case "status":
      return onStatus(state, event.status, event.nowMs);
    case "expire":
      return state.kind === "outstanding" || state.kind === "outstanding-unknown" ? { kind: "expired" } : state;
    case "cancel":
      return state.kind === "outstanding" || state.kind === "outstanding-unknown" ? { kind: "cancelling", from: state } : state;
    case "cancelled":
      return state.kind === "cancelling" ? { kind: "cancelled" } : state;
    case "cancel-failed":
      return state.kind === "cancelling" ? state.from : state;
    case "dismiss":
      return DISMISSABLE.has(state.kind) ? { kind: "idle" } : state;
  }
}

/** Props for {@link PairSection}. */
export interface PairSectionProps {
  /** Latest status (configured). */
  readonly status: PushStatusPayload;
  /** True while the connect-link state is usable. False hides the section (a phone could not use the code). */
  readonly linkUsable: boolean;
  /** Report the code link to show in the page QR, or null to revert. */
  readonly onLinkChange: (override: PairingLinkOverride | null) => void;
  /** Ask the container to poll (true while a code is outstanding). */
  readonly onPollChange: (poll: boolean) => void;
  /** Refetch the status now. */
  readonly refresh: () => Promise<PushStatusPayload | null>;
  /** The fetch used for issue and cancel. */
  readonly fetchImpl: typeof fetch;
}

const CAPTION: PairingLinkOverride["caption"] = "Includes a one-time pairing code — don't share this screen";

/** The pair flow. Renders null when the connect link is not usable. */
export function PairSection(props: PairSectionProps): ReactElement | null {
  const { status, linkUsable, onLinkChange, onPollChange, refresh, fetchImpl } = props;
  const [state, dispatch] = useReducer(pairReducer, { kind: "idle" } as PairFlowState);
  const [cancelError, setCancelError] = useReducer(
    (_: PushClientError | null, next: PushClientError | null) => next,
    null,
  );
  const content = useRef<HTMLDivElement | null>(null);
  const hadFocus = useRef(false);

  // Callbacks from the container may change identity; effects read the latest through refs.
  const latest = useRef({ onLinkChange, onPollChange, refresh, status });
  latest.current = { onLinkChange, onPollChange, refresh, status };

  // Every status (first load and each poll) feeds the flow.
  useEffect(() => {
    dispatch({ type: "status", status, nowMs: Date.now() });
  }, [status]);

  // What the page shows and whether it polls follow the flow state.
  const shownLink = state.kind === "outstanding" ? state.link : state.kind === "cancelling" && state.from.kind === "outstanding" ? state.from.link : null;
  useEffect(() => {
    const { onLinkChange: report, onPollChange: poll, refresh: reload } = latest.current;
    switch (state.kind) {
      case "issuing":
      case "cancelling":
        break;
      case "outstanding":
      case "outstanding-unknown":
        report(shownLink !== null ? { link: shownLink, caption: CAPTION } : null);
        poll(true);
        break;
      case "paired":
        report(null);
        poll(false);
        void reload();
        break;
      default:
        report(null);
        poll(false);
    }
  }, [state.kind, shownLink]);

  // When the focused control unmounts on a transition, focus moves to the new callout's first action.
  useEffect(() => {
    if (!hadFocus.current || !focusIsLost()) return;
    const target = content.current?.querySelector<HTMLElement>("button");
    if (target) target.focus();
  }, [state.kind]);

  const outstandingExpiry =
    state.kind === "outstanding" || state.kind === "outstanding-unknown"
      ? state.expiresAt
      : state.kind === "cancelling"
        ? state.from.expiresAt
        : null;
  const expire = useCallback(() => dispatch({ type: "expire" }), []);
  const countdown = useCountdown(outstandingExpiry, expire);

  const issue = (): void => {
    const knownIds = new Set(latest.current.status.devices.map((device) => device.id));
    setCancelError(null);
    dispatch({ type: "issue" });
    void issuePairingToken(fetchImpl).then((result) => {
      if (result.ok) dispatch({ type: "issued", issued: result.value, knownIds });
      else dispatch({ type: "issue-failed", error: result.error });
    });
  };

  const cancel = (): void => {
    setCancelError(null);
    dispatch({ type: "cancel" });
    void cancelPairingToken(fetchImpl).then((result) => {
      // A 404 on a configured server means the code is already gone.
      if (result.ok || (result.error === "unavailable" && result.httpStatus === 404)) {
        dispatch({ type: "cancelled" });
        void latest.current.refresh();
        return;
      }
      setCancelError(result.error);
      dispatch({ type: "cancel-failed", error: result.error });
    });
  };

  if (!linkUsable) return null;

  const view: PairFlowState = state.kind === "cancelling" ? state.from : state;
  const cancelling = state.kind === "cancelling";

  return (
    <Section
      data-slot="connect-push-pair"
      title="Pair a device"
      description="Show a one-time code that lets the Pulse app receive alert notifications. It is valid for 10 minutes."
      actions={
        view.kind === "idle" ? (
          <ActionButton variant="primary" icon="smartphone" onClick={issue}>
            Pair a device
          </ActionButton>
        ) : null
      }
      onFocusCapture={() => {
        hadFocus.current = true;
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) hadFocus.current = false;
      }}
    >
      <div ref={content} className="flex flex-col gap-3 empty:hidden">
        {view.kind === "issuing" ? <LoadingState label="Creating a pairing code" /> : null}
        {view.kind === "outstanding" ? (
          <Callout
            tone={PAIRING_STATE.outstanding.tone}
            icon={PAIRING_STATE.outstanding.icon}
            title={`Pairing code active — expires in ${countdown.text}`}
            action={
              <ActionButton onClick={cancel} busy={cancelling}>
                Cancel
              </ActionButton>
            }
          >
            Scan the code above with the Pulse app. Issuing a new code replaces this one.
          </Callout>
        ) : null}
        {view.kind === "outstanding-unknown" ? (
          <Callout
            tone="info"
            icon="clock"
            title={`A pairing code is outstanding (expires in ${countdown.text})`}
            action={
              <>
                <ActionButton onClick={cancel} busy={cancelling}>
                  Cancel
                </ActionButton>
                <ActionButton variant="primary" onClick={issue}>
                  Issue new code
                </ActionButton>
              </>
            }
          >
            It was issued earlier and cannot be shown again.
          </Callout>
        ) : null}
        {view.kind === "expired" || view.kind === "cancelled" || view.kind === "paired" ? (
          <Callout
            tone={PAIRING_STATE[view.kind].tone}
            icon={PAIRING_STATE[view.kind].icon}
            role={PAIRING_STATE[view.kind].role ?? "status"}
            title={PAIRING_STATE[view.kind].label}
            action={
              <ActionButton onClick={issue}>{view.kind === "paired" ? "Pair another device" : "Issue new code"}</ActionButton>
            }
          >
            {view.kind === "paired" ? displayText(view.displayName) : null}
          </Callout>
        ) : null}
        {view.kind === "error" ? (
          <Callout
            tone="danger"
            title="Could not create a pairing code"
            action={<ActionButton onClick={issue}>Try again</ActionButton>}
          >
            {pushErrorText(view.error)}
          </Callout>
        ) : null}
        {cancelError !== null && (view.kind === "outstanding" || view.kind === "outstanding-unknown") ? (
          <Callout tone="danger" compact title="Could not cancel the pairing code">
            {pushErrorText(cancelError)}
          </Callout>
        ) : null}
      </div>
      <VisuallyHidden aria-live="polite" aria-atomic="true">
        {countdown.announcement}
      </VisuallyHidden>
    </Section>
  );
}
