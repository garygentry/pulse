// apps/web/src/client/mutations/dialogs/AckDialog.tsx  (lazy chunk; default export)
// Set / replace / remove an acknowledgement (REQ-ACK-01, ACK-05, UX-01..03, A11Y-01..03).
// Loaded only through a dynamic import; other modules import it type-only.
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import type { ActiveAlert } from "@pulse/web-data/wire";
import { announce } from "../../a11y/index.js";
import { ACK_NOTE_MAX_CHARS } from "../../../shared/mutations.js";
import type { RemoveAckResult, SetAckResult } from "../../../shared/mutations.js";
import {
  MutationClientError, STORED_FAILURE_REASONS, codePoints, displayText, failureText, fieldHasError,
  newIdempotencyKey, postMutation,
} from "../client.js";
import { SESSION_REFRESH_REASONS, refreshSession } from "../session.js";
import { pendingTracker, predicates } from "../pending.js";
import { AckInfo } from "../AckInfo.js";
import { MutationDialogFrame } from "../dialog-frame.js";
import { ActionButton } from "../ActionButton.js";
import { TextArea } from "../Field.js";
import { StateBadge } from "../StateBadge.js";
import { ackFingerprintError, ackNoteError, removeAckBody, setAckBody } from "../dialog-models/ack-model.js";
import type { AckAction } from "../dialog-models/ack-model.js";
import type { MutationDialogBaseProps } from "./SilenceDialog.js";

/** Props for the ack dialog: the alert to acknowledge or un-acknowledge. */
export interface AckDialogProps extends MutationDialogBaseProps<SetAckResult | RemoveAckResult> {
  readonly alert: ActiveAlert;
}

/** Set, replace or remove an ack (lazy chunk; loaded via dynamic import). */
export default function AckDialog(p: AckDialogProps): ReactElement | null {
  // One key per logical action: replace/set and remove never share a key.
  const setKey = useRef(newIdempotencyKey());
  const removeKey = useRef(newIdempotencyKey());
  // Synchronous re-entry guard: two clicks in one tick both see `busy === null` (UX-03).
  const inFlight = useRef(false);
  const [note, setNote] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<AckAction | null>(null);
  const [err, setErr] = useState<MutationClientError | null>(null);

  const fingerprint = p.alert.fingerprint;
  const acked = p.alert.ack !== undefined;
  const trimmed = note.trim();
  const notFiring = err?.reason === "alert-not-firing"; // terminal: only Close remains
  const noteErr = attempted ? ackNoteError(note) : null;
  const fpErr = ackFingerprintError(fingerprint);
  const srv = err?.fields ?? [];

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (err === null) return;
    const f = formRef.current;
    const target = f?.querySelector<HTMLElement>("[aria-invalid='true']") ?? f?.querySelector<HTMLElement>("[data-mut-result]");
    target?.focus();
  }, [err]);

  const fail = (e: unknown, key: { current: string }): void => {
    const ce = e instanceof MutationClientError ? e : new MutationClientError("malformed-response", 0, null, []);
    if (STORED_FAILURE_REASONS.has(ce.reason)) key.current = newIdempotencyKey();
    if (SESSION_REFRESH_REASONS.has(ce.reason)) void refreshSession(p.store);
    setErr(ce);
    announce(failureText(ce), "assertive");
  };

  const submitSet = async (): Promise<void> => {
    if (inFlight.current || busy !== null || notFiring) return;
    setAttempted(true);
    const errs = [fpErr, ackNoteError(note)].filter((e) => e !== null);
    if (errs.length > 0) { announce(`Fix ${errs.length} field${errs.length === 1 ? "" : "s"}.`, "assertive"); return; }
    const body = setAckBody(fingerprint, note);
    inFlight.current = true;
    setBusy("set");
    setErr(null);
    try {
      const ok = await postMutation<SetAckResult>("/api/mutations/acks", body, setKey.current);
      pendingTracker.add({ target: { kind: "alert", fingerprint },
        reflected: predicates.ackSet(fingerprint, ok.result.at), since: performance.now() });
      announce("Alert acknowledged. Pending until live data shows it.", "polite");
      p.onDone(ok.result);
      p.onClose();
    } catch (e) {
      fail(e, setKey);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const submitRemove = async (): Promise<void> => {
    if (inFlight.current || busy !== null || notFiring) return;
    if (fpErr !== null) { announce(fpErr, "assertive"); return; }
    const body = removeAckBody(fingerprint);
    inFlight.current = true;
    setBusy("remove");
    setErr(null);
    try {
      const ok = await postMutation<RemoveAckResult>("/api/mutations/acks/remove", body, removeKey.current);
      if (ok.result.removed) {
        pendingTracker.add({ target: { kind: "alert", fingerprint },
          reflected: predicates.ackRemoved(fingerprint), since: performance.now() });
        announce("Acknowledgement removed. Pending until live data reflects it.", "polite");
      } else {
        announce("There was no acknowledgement to remove.", "polite");
      }
      p.onDone(ok.result);
      p.onClose();
    } catch (e) {
      fail(e, removeKey);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const actions = notFiring ? <ActionButton onClick={p.onClose}>Close</ActionButton> : <>
    <ActionButton onClick={p.onClose}>Cancel</ActionButton>
    {acked ? <ActionButton variant="danger" busy={busy === "remove"} onClick={() => void submitRemove()}>Remove acknowledgement</ActionButton> : null}
    <ActionButton variant="primary" icon="circle-check" busy={busy === "set"} onClick={() => void submitSet()}>
      {acked ? "Replace acknowledgement" : "Acknowledge"}
    </ActionButton>
  </>;

  return (
    <MutationDialogFrame open={p.open} onClose={p.onClose} dismissable={busy === null}
      title={`${acked ? "Update acknowledgement" : "Acknowledge"} ${displayText(p.alert.name)}`} actions={actions}>
      <form ref={formRef} className="grid gap-4" noValidate onSubmit={(e) => { e.preventDefault(); void submitSet(); }}>
        <AckInfo ack={p.alert.ack} />
        {fpErr !== null ? <p className="m-0 text-sm font-medium text-foreground"><span aria-hidden="true">⚠ </span>{fpErr}</p> : null}
        {!notFiring ? (
          <TextArea name="note" label="Note (optional)" value={note} onInput={setNote}
            hint={acked
              ? "Replacing overwrites the current acknowledgement. Visible to everyone in Pulse and recorded in the audit log."
              : "Visible to everyone in Pulse and recorded in the audit log."}
            counter={{ used: codePoints(trimmed), limit: ACK_NOTE_MAX_CHARS, unit: "characters" }}
            error={noteErr ?? (fieldHasError(srv, "note") ? "Note refused by the server." : null)} />
        ) : null}
        {err !== null ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-mut-result="" tabIndex={-1}>
            <StateBadge state="failed" /> <span>{failureText(err)}</span>
          </div>
        ) : null}
      </form>
    </MutationDialogFrame>
  );
}
