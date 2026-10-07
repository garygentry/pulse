// apps/web/src/client/mutations/dialogs/ExpireDialog.tsx  (lazy chunk; default export)
// Expire-silence dialog (REQ-SIL-07, SIL-10). Same pattern as SilenceDialog.
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import type { ActiveSilence } from "@pulse/web-data/wire";
import { KeyValue, KeyValueList } from "@/ui";
import { announce } from "../../a11y/index.js";
import type { ExpireSilenceResult } from "../../../shared/mutations.js";
import {
  MutationClientError, REASON_TEXT, STORED_FAILURE_REASONS, displayText, failureText, fieldHasError,
  newIdempotencyKey, postMutation,
} from "../client.js";
import { SESSION_REFRESH_REASONS, refreshSession } from "../session.js";
import { pendingTracker, predicates } from "../pending.js";
import { matcherExpression } from "../../views/alerts/detail/silences-model.js";
import { silenceRationaleCounter } from "../matchers.js";
import { ActionButton } from "../ActionButton.js";
import { MutationDialogFrame } from "../dialog-frame.js";
import { TextArea } from "../Field.js";
import { StateBadge } from "../StateBadge.js";
import { expireIdError, expireRationaleError, expireSilenceBody } from "../dialog-models/expire-model.js";
import type { MutationDialogBaseProps } from "./SilenceDialog.js";

/** Props for the expire-silence dialog: the silence to expire. */
export interface ExpireDialogProps extends MutationDialogBaseProps<ExpireSilenceResult> {
  readonly silence: ActiveSilence;
}

/** Expire-silence dialog (lazy chunk; loaded via dynamic import). */
export default function ExpireDialog(p: ExpireDialogProps): ReactElement | null {
  const keyRef = useRef(newIdempotencyKey());
  // Synchronous re-entry guard: two clicks in one tick both see `busy === false` (UX-03).
  const inFlight = useRef(false);
  const [rationale, setRationale] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<MutationClientError | null>(null);

  const silenceId = p.silence.id;
  const ratCheck = (): string | null => expireRationaleError(rationale);
  const ratErr = attempted ? ratCheck() : null;
  const idErr = expireIdError(silenceId);
  const gone = err?.reason === "silence-gone"; // SIL-10: a distinct, terminal outcome
  const srv = err?.fields ?? [];

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (err === null) return;
    const f = formRef.current;
    const target = f?.querySelector<HTMLElement>("[aria-invalid='true']") ?? f?.querySelector<HTMLElement>("[data-mut-result]");
    target?.focus();
  }, [err]);

  const submit = async (): Promise<void> => {
    if (inFlight.current || busy || gone) return;
    setAttempted(true);
    const errs = [idErr, ratCheck()].filter((e) => e !== null);
    if (errs.length > 0) { announce(`Fix ${errs.length} field${errs.length === 1 ? "" : "s"}.`, "assertive"); return; }
    const body = expireSilenceBody(silenceId, rationale);
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      const ok = await postMutation<ExpireSilenceResult>("/api/mutations/silences/expire", body, keyRef.current);
      pendingTracker.add({ target: { kind: "silence", silenceId },
        reflected: predicates.silenceExpired(silenceId), since: performance.now() });
      announce("Silence expired. Pending until live data reflects it.", "polite");
      p.onDone(ok.result);
      p.onClose();
    } catch (e) {
      const ce = e instanceof MutationClientError ? e : new MutationClientError("malformed-response", 0, null, []);
      if (STORED_FAILURE_REASONS.has(ce.reason)) keyRef.current = newIdempotencyKey();
      if (SESSION_REFRESH_REASONS.has(ce.reason)) void refreshSession(p.store);
      setErr(ce);
      announce(failureText(ce), "assertive");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <MutationDialogFrame role="alertdialog" open={p.open} onClose={p.onClose} dismissable={!busy} title="Expire silence"
      actions={gone ? <ActionButton onClick={p.onClose}>Close</ActionButton> : <>
        <ActionButton onClick={p.onClose}>Cancel</ActionButton>
        <ActionButton variant="danger" busy={busy} onClick={() => void submit()}>Expire silence</ActionButton>
      </>}>
      <form ref={formRef} className="grid gap-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="m-0 text-sm">Expire this silence? Alerts it suppresses will notify again.</p>
        <ul className="m-0 grid list-none gap-1 p-0 text-sm" aria-label="Silence matchers">
          {p.silence.matchers.map((m, i) => <li key={i}><code>{displayText(matcherExpression(m))}</code></li>)}
        </ul>
        <KeyValueList>
          <KeyValue label="Silence"><code>{displayText(silenceId)}</code></KeyValue>
          <KeyValue label="Creator">{displayText(p.silence.createdBy)}</KeyValue>
          <KeyValue label="Comment">
            <span className="whitespace-pre-wrap wrap-anywhere">{p.silence.comment !== "" ? displayText(p.silence.comment) : "—"}</span>
          </KeyValue>
        </KeyValueList>
        {idErr !== null ? <p className="m-0 text-sm font-medium text-foreground"><span aria-hidden="true">⚠ </span>{idErr}</p> : null}
        {!gone ? (
          <TextArea name="rationale" label="Rationale (optional)" value={rationale} onInput={setRationale}
            hint="Recorded in the audit log."
            counter={silenceRationaleCounter(rationale)}
            error={ratErr ?? (fieldHasError(srv, "rationale") ? "Rationale refused by the server." : null)} />
        ) : null}
        {err !== null ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-mut-result="" tabIndex={-1}>
            {gone
              ? <><StateBadge state="failed" label="Already expired" /> <span>{REASON_TEXT["silence-gone"]}</span></>
              : <><StateBadge state="failed" /> <span>{failureText(err)}</span></>}
          </div>
        ) : null}
      </form>
    </MutationDialogFrame>
  );
}
