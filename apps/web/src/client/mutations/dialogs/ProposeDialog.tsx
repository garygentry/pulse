// apps/web/src/client/mutations/dialogs/ProposeDialog.tsx  (lazy chunk; default export)
// Propose-edit dialog for a host/service (REQ-PROP-02/03/04 client side, REQ-UX-01..03,
// REQ-A11Y-01..03, REQ-SEC-07). Loaded only through a dynamic import; other modules import it type-only.
// The pure logic (core mirrors, current-value twin, row validation, request body) lives in
// ../dialog-models/propose-model.ts; `@pulse/core/proposals` is imported for TYPES ONLY (see that header).
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProposableField, ProposalValue } from "@pulse/core/proposals";
import type { WebEstateHostV2, WebEstateServiceV2 } from "@pulse/renderer";
import { announce } from "../../a11y/index.js";
import { RATIONALE_MAX_CHARS } from "../../../shared/mutations.js";
import type { CreateProposalBody, CreateProposalResult } from "../../../shared/mutations.js";
import {
  MutationClientError, STORED_FAILURE_REASONS, codePoints, displayText, failureText, fieldHasError,
  newIdempotencyKey, postMutation,
} from "../client.js";
import { SESSION_REFRESH_REASONS, refreshSession } from "../session.js";
import { readEstate } from "../../views/estate/types.js";
import { ActionButton } from "../ActionButton.js";
import { MutationDialogFrame } from "../dialog-frame.js";
import { Checkbox, RadioGroup, TextArea, TextField } from "../Field.js";
import { StateBadge } from "../StateBadge.js";
import { formatValue } from "../proposals/format.js";
import {
  CLASS_OPTIONS, CLIENT_PROPOSAL_CHANGES_MAX, FIELD_LABEL, YES_NO, buildProposalBody, clientValuesEqual, initialRow,
  offeredFields, proposalRationaleError, rowIssue,
} from "../dialog-models/propose-model.js";
import type { RowState } from "../dialog-models/propose-model.js";
import type { MutationDialogBaseProps } from "./SilenceDialog.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Props for the propose-edit dialog: the target entity and its declared values. */
export interface ProposeDialogProps extends MutationDialogBaseProps<CreateProposalResult> {
  readonly target: { readonly kind: "host" | "service"; readonly id: string };
  readonly declared: WebEstateHostV2 | WebEstateServiceV2;
}

/** Propose-edit dialog (lazy chunk; loaded via dynamic import). */
export default function ProposeDialog(p: ProposeDialogProps): ReactElement | null {
  useSignals();
  const kind = p.target.kind;
  const model = readEstate(p.store)?.estate ?? null;
  const rows = useMemo(() => offeredFields(model, kind, p.declared), [model, kind, p.declared]);
  const keyRef = useRef(newIdempotencyKey());
  const inFlight = useRef(false); // synchronous re-entry guard (UX-03)
  // Keyed by field, not position: a new estate cycle can add, remove or reorder the offered rows while
  // the dialog is open, and an operator's choices must stay with their field.
  // Each edit remembers the `seen` it was based on: if a later cycle changes that field's current value,
  // the edit is dropped (the row re-seeds) rather than silently proposing a revert of the new value.
  const [edits, setEdits] = useState<Readonly<Partial<Record<ProposableField, { readonly seen: ProposalValue; readonly row: RowState }>>>>({});
  const editOf = (field: ProposableField, seen: ProposalValue): RowState | undefined => {
    const e = edits[field];
    return e !== undefined && clientValuesEqual(e.seen, seen) ? e.row : undefined;
  };
  const state = rows.map((r) => editOf(r.spec.field, r.seen) ?? initialRow(r.seen));
  const [rationale, setRationale] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<MutationClientError | null>(null);

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (err === null) return;
    const f = formRef.current;
    const t = f?.querySelector<HTMLElement>("[aria-invalid='true']") ?? f?.querySelector<HTMLElement>("[data-mut-result]");
    t?.focus();
  }, [err]);

  const setRow = (i: number, patch: Partial<RowState>): void => {
    const row = rows[i];
    if (row === undefined) return;
    const base = editOf(row.spec.field, row.seen) ?? initialRow(row.seen);
    setEdits((prev) => ({ ...prev, [row.spec.field]: { seen: row.seen, row: { ...base, ...patch } } }));
  };

  // Index in the submitted `changes` array for each included row (server `changes.<i>` fields).
  const includedIdx = rows.map((_, i) => i).filter((i) => state[i]?.include === true);
  const srv = err?.fields ?? [];
  /** Fields in the order they were last submitted: server `changes.<i>` errors name THAT list, not today's rows. */
  const submittedFields = useRef<readonly ProposableField[]>([]);
  const rationaleErr = attempted ? proposalRationaleError(rationale) : null;
  const countErr = attempted && includedIdx.length === 0 ? "Include at least one change."
    : includedIdx.length > CLIENT_PROPOSAL_CHANGES_MAX ? `Include at most ${CLIENT_PROPOSAL_CHANGES_MAX} changes.` : null;

  const submit = async (): Promise<void> => {
    if (inFlight.current || busy) return;
    setAttempted(true);
    const rowErrs = includedIdx.map((i) => rowIssue(rows[i]!.spec, kind, rows[i]!.seen, state[i]!)).filter((e) => e !== null);
    const n = rowErrs.length + (proposalRationaleError(rationale) !== null ? 1 : 0)
      + (includedIdx.length === 0 || includedIdx.length > CLIENT_PROPOSAL_CHANGES_MAX ? 1 : 0);
    if (n > 0) { announce(`Fix ${n} field${n === 1 ? "" : "s"}.`, "assertive"); return; }
    submittedFields.current = includedIdx.map((i) => rows[i]!.spec.field);
    const body: CreateProposalBody = buildProposalBody(p.target, rows, state, includedIdx, rationale);
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      const ok = await postMutation<CreateProposalResult>("/api/mutations/proposals", body, keyRef.current);
      // No tracker entry: a proposal does not change live data (UX-01).
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

  const title = `Propose edit: ${displayText(p.target.id)}`;
  if (rows.length === 0) {
    return (
      <MutationDialogFrame open={p.open} onClose={p.onClose} title={title} actions={<ActionButton onClick={p.onClose}>Close</ActionButton>}>
        <p className="m-0 text-sm">No proposable fields apply to this entity.</p>
      </MutationDialogFrame>
    );
  }

  return (
    <MutationDialogFrame open={p.open} onClose={p.onClose} dismissable={!busy} title={title}
      actions={<>
        <ActionButton onClick={p.onClose}>Cancel</ActionButton>
        <ActionButton variant="primary" icon="chevron-right" busy={busy} onClick={() => void submit()}>Submit proposal</ActionButton>
      </>}>
      <form ref={formRef} className="grid gap-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="m-0 text-sm text-muted-foreground">
          A proposal is reviewed and applied by an operator; it does not change the estate by itself.
          It is visible to everyone in Pulse and recorded in the audit log.
        </p>
        {rows.map((row, i) => {
          const r = state[i]!;
          const spec = row.spec;
          const label = FIELD_LABEL[spec.field];
          const pos = submittedFields.current.indexOf(spec.field);
          const issue = attempted && r.include ? rowIssue(spec, kind, row.seen, r) : null;
          const rowErr = issue ?? (r.include && pos >= 0 && fieldHasError(srv, `changes.${pos}`) ? "This change was refused by the server." : null);
          const nullable = spec.nullable[kind];
          return (
            <fieldset key={spec.field} className="m-0 grid gap-2 rounded-md border border-border p-3" data-field={spec.field}>
              <legend className="px-1 text-sm font-medium">{label}</legend>
              <p className="m-0 text-sm text-muted-foreground">Current: {displayText(formatValue(row.seen))}</p>
              <Checkbox label={`Include this change (${label})`} checked={r.include} onChange={(v) => setRow(i, { include: v })}
                error={rowErr} />
              {r.include && spec.valueKind === "boolean" ? (
                <RadioGroup legend={`Proposed ${label}`} name={spec.field} value={r.bool} options={YES_NO}
                  onChange={(v) => setRow(i, { bool: v })} />
              ) : null}
              {r.include && spec.valueKind === "string" ? (
                <>
                  {!r.clear ? (
                    <TextField name={`changes.${spec.field}`} label={`Proposed ${label}`} value={r.text}
                      onInput={(v) => setRow(i, { text: v })} error={null} />
                  ) : null}
                  {nullable ? (
                    <Checkbox label="Clear (remove overlay value)" checked={r.clear} onChange={(v) => setRow(i, { clear: v })} />
                  ) : null}
                </>
              ) : null}
              {r.include && spec.valueKind === "suppression" ? (
                <>
                  {!r.clear ? (
                    <>
                      <RadioGroup legend="Suppression class" name={`${spec.field}-class`} value={r.cls} options={CLASS_OPTIONS}
                        onChange={(v) => setRow(i, { cls: v })} />
                      <TextArea name={`changes.${spec.field}.rationale`} label="Suppression rationale" value={r.markRationale}
                        onInput={(v) => setRow(i, { markRationale: v })} error={null} />
                    </>
                  ) : null}
                  {nullable ? (
                    <Checkbox label="Clear suppression" checked={r.clear} onChange={(v) => setRow(i, { clear: v })} />
                  ) : null}
                </>
              ) : null}
            </fieldset>
          );
        })}
        {countErr !== null ? <p className="m-0 text-sm font-medium text-foreground"><span aria-hidden="true">⚠ </span>{countErr}</p> : null}
        <TextArea name="rationale" label="Rationale" required value={rationale} onInput={setRationale}
          hint="Why this change? Reviewers see this text."
          counter={{ used: codePoints(rationale.trim()), limit: RATIONALE_MAX_CHARS, unit: "characters" }}
          error={rationaleErr ?? (fieldHasError(srv, "rationale") ? "Rationale refused by the server." : null)} />
        {err !== null ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-mut-result="" tabIndex={-1}>
            <StateBadge state="failed" /> <span>{failureText(err)}</span>
          </div>
        ) : null}
      </form>
    </MutationDialogFrame>
  );
}
