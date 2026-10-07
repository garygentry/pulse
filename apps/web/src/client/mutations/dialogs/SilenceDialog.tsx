// apps/web/src/client/mutations/dialogs/SilenceDialog.tsx  (lazy chunk; default export)
// Create-silence dialog (REQ-SIL-01..05, UX-01..03, A11Y-01..03; bounds mirror the server's silence validation).
// Loaded only through a dynamic import; other modules import it type-only. The pure logic (presets, caps,
// validation, request body) lives in ../dialog-models/silence-model.ts.
import type { ReactElement } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActiveAlert } from "@pulse/web-data/wire";
import { announce } from "../../a11y/index.js";
import type { AppStore } from "../../store/index.js";
import { ALERTNAME_LABEL, SILENCE_DEFAULT_DURATION_MS, SILENCE_MATCHERS_MAX } from "../../../shared/mutations.js";
import type { CreateSilenceBody, CreateSilenceResult, SilenceMatcherInput } from "../../../shared/mutations.js";
import {
  MutationClientError, STORED_FAILURE_REASONS, displayText, failureText, fieldHasError,
  newIdempotencyKey, postMutation,
} from "../client.js";
import { SESSION_REFRESH_REASONS, refreshSession } from "../session.js";
import { pendingTracker, predicates } from "../pending.js";
import { readAlerts } from "../../views/alerts/model.js";
import { defaultMatchers, matchedCount, matcherIssue, silenceRationaleCounter } from "../matchers.js";
import {
  PRESET_MS, PRESET_OPTIONS, REPLAY_WINDOW_MS, SILENCE_CLIENT_MAX_MS, buildSilenceBody, endsAtError, fingerprintError,
  rationaleError, toLocalInput,
} from "../dialog-models/silence-model.js";
import type { Preset } from "../dialog-models/silence-model.js";
import { ActionButton } from "../ActionButton.js";
import { MutationDialogFrame } from "../dialog-frame.js";
import { Checkbox, RadioGroup, TextArea, TextField } from "../Field.js";
import { StateBadge } from "../StateBadge.js";
import { useSignals } from "@preact/signals-react/runtime";

/** The shared dialog contract; imported type-only by the other dialogs. */
export interface MutationDialogBaseProps<R> {
  readonly store: AppStore;
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called with the success result, before close. */
  readonly onDone: (result: R) => void;
}

/** Props for the create-silence dialog: the alert whose labels seed the matchers. */
export interface SilenceDialogProps extends MutationDialogBaseProps<CreateSilenceResult> {
  readonly alert: ActiveAlert;
}

/** Create-silence dialog (lazy chunk; loaded via dynamic import). */
export default function SilenceDialog(p: SilenceDialogProps): ReactElement | null {
  useSignals();
  const keyRef = useRef(newIdempotencyKey());
  /** The body last sent under `key` (first sent at `sentAt`), reused for a prompt same-key retry. */
  const lastSent = useRef<{ key: string; inputs: string; body: CreateSilenceBody; sentAt: number } | null>(null);
  // Synchronous re-entry guard: two clicks in one tick both see `busy === false` (UX-03).
  const inFlight = useRef(false);
  const countId = useId();
  const all = useMemo(() => defaultMatchers(p.alert), [p.alert.fingerprint]);
  // Default: every label checked (SIL-01), except labels the server would refuse; those start unchecked with an error.
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(all.filter((m) => matcherIssue(m) === null).map((m) => m.name)));
  const [preset, setPreset] = useState<Preset>("2h");                           // default 2 h (SIL-04)
  const [custom, setCustom] = useState(() => toLocalInput(Date.now() + SILENCE_DEFAULT_DURATION_MS));
  const [rationale, setRationale] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<MutationClientError | null>(null);

  const isChecked = (m: SilenceMatcherInput): boolean => m.name === ALERTNAME_LABEL || checked.has(m.name);
  const chosen = all.filter(isChecked);
  const payload = readAlerts(p.store);                                    // signal read → recount each cycle
  const count = payload === null ? null : matchedCount(payload, chosen);  // SIL-03, display-only

  const endsMs = (now: number): number => (preset === "custom" ? new Date(custom).getTime() : now + PRESET_MS[preset]);
  const alertname = all.find((m) => m.name === ALERTNAME_LABEL);
  const matcherErr =
    alertname === undefined ? "This alert has no alertname label; silence it in Alertmanager instead."
    : matcherIssue(alertname) !== null ? "This alert's name cannot be used in a silence; use Alertmanager instead."
    : chosen.some((m) => matcherIssue(m) !== null) ? "Uncheck the labels marked as unusable."
    : chosen.length > SILENCE_MATCHERS_MAX ? `Keep at most ${SILENCE_MATCHERS_MAX} labels (uncheck some).`
    : null;
  const fpErr = fingerprintError(p.alert.fingerprint);
  const ratErr = attempted ? rationaleError(rationale) : null;
  const endErr = attempted ? endsAtError(endsMs(Date.now()), Date.now()) : null;
  const srv = err?.fields ?? [];

  // After a refusal: focus the first invalid field, else the result block.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (err === null) return;
    const f = formRef.current;
    const target = f?.querySelector<HTMLElement>("[aria-invalid='true']") ?? f?.querySelector<HTMLElement>("[data-mut-result]");
    target?.focus();
  }, [err]);

  const submit = async (): Promise<void> => {
    if (inFlight.current || busy) return;
    setAttempted(true);
    const now = Date.now();
    // A prompt retry (within REPLAY_WINDOW_MS) under the same key with unchanged inputs resends the SAME
    // body, so a request whose response was lost is replayed by the server instead of conflicting. Any
    // later or changed submit is a new action with a new key and a freshly computed end time, so a
    // preset never yields a silently shorter silence.
    const inputs = JSON.stringify([chosen.map((m) => [m.name, m.value]), preset, custom, rationale.trim()]);
    const prior = lastSent.current;
    const sameKey = prior !== null && prior.key === keyRef.current;
    const replay = sameKey && prior.inputs === inputs && now - prior.sentAt <= REPLAY_WINDOW_MS ? prior.body : null;
    if (sameKey && replay === null) keyRef.current = newIdempotencyKey();
    const endsAtMs = replay !== null ? Date.parse(replay.endsAt) : endsMs(now);
    const errs = [fpErr, matcherErr, rationaleError(rationale), endsAtError(endsAtMs, now)].filter((e) => e !== null);
    if (errs.length > 0) { announce(`Fix ${errs.length} field${errs.length === 1 ? "" : "s"}.`, "assertive"); return; }
    const body: CreateSilenceBody = replay ?? buildSilenceBody(p.alert.fingerprint, chosen, endsAtMs, rationale);
    lastSent.current = { key: keyRef.current, inputs, body, sentAt: replay !== null && prior !== null ? prior.sentAt : now };
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      const ok = await postMutation<CreateSilenceResult>("/api/mutations/silences", body, keyRef.current);
      pendingTracker.add({ target: { kind: "silence", silenceId: ok.result.silenceId },
        reflected: predicates.silenceCreated(ok.result.silenceId), since: performance.now() });
      announce("Silence created. Pending until live data shows it.", "polite");
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
    <MutationDialogFrame open={p.open} onClose={p.onClose} dismissable={!busy} title={`Silence ${displayText(p.alert.name)}`}
      actions={<>
        <ActionButton onClick={p.onClose}>Cancel</ActionButton>
        <ActionButton variant="primary" busy={busy} onClick={() => void submit()}>Create silence</ActionButton>
      </>}>
      <form ref={formRef} className="grid gap-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <fieldset className="m-0 grid gap-2 rounded-md border border-border p-3" aria-describedby={countId}>
          <legend className="px-1 text-sm font-medium">Labels to match (exact equality)</legend>
          {all.map((m) => (
            <Checkbox key={m.name}
              label={<><code>{displayText(m.name)}</code>=<code>{displayText(m.value)}</code></>}
              checked={isChecked(m)}
              locked={m.name === ALERTNAME_LABEL} lockedReason="The alert name is always matched."
              error={matcherIssue(m)} // unsendable labels start unchecked and say why
              onChange={(v) => setChecked((s) => { const n = new Set(s); if (v) n.add(m.name); else n.delete(m.name); return n; })} />
          ))}
          {matcherErr !== null || fieldHasError(srv, "matchers")
            ? <p className="m-0 text-sm font-medium text-foreground"><span aria-hidden="true">⚠ </span>{matcherErr ?? "The labels were refused."}</p> : null}
          <p id={countId} className="m-0 text-sm text-muted-foreground" aria-live="polite">
            {count === null ? "Matched alerts unknown (no live data yet)."
              : `Would silence ${count} currently firing alert${count === 1 ? "" : "s"}.`}
          </p>
        </fieldset>
        <RadioGroup<Preset> legend="Duration" name="duration" value={preset} onChange={setPreset}
          options={PRESET_OPTIONS}
          error={preset !== "custom" ? (endErr ?? (fieldHasError(srv, "endsAt") ? "End time refused by the server." : null)) : null} />
        {preset === "custom" ? (
          <TextField type="datetime-local" name="endsAt" label="Ends at (local time)" value={custom} onInput={setCustom}
            min={toLocalInput(Date.now())} max={toLocalInput(Date.now() + SILENCE_CLIENT_MAX_MS)}
            error={endErr ?? (fieldHasError(srv, "endsAt") ? "End time refused by the server." : null)} />
        ) : null}
        <TextArea name="rationale" label="Rationale" required value={rationale} onInput={setRationale}
          hint="Visible to everyone viewing this silence in Pulse and Alertmanager, and recorded in the audit log."
          counter={silenceRationaleCounter(rationale)}
          error={ratErr ?? (fieldHasError(srv, "rationale") ? "Rationale refused by the server." : null)} />
        {err !== null ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-mut-result="" tabIndex={-1}><StateBadge state="failed" /> <span>{failureText(err)}</span></div>
        ) : null}
      </form>
    </MutationDialogFrame>
  );
}
