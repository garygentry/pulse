// apps/web/src/client/mutations/Field.tsx
import type { ReactNode, ReactElement } from "react";
import { useId } from "react";
import { Checkbox as UiCheckbox, Input, Label, RadioGroup as UiRadioGroup, RadioGroupItem, Textarea } from "@/ui";

/** Live counter; unit is code points ("characters") or UTF-8 bytes. */
export interface FieldCounter { readonly used: number; readonly limit: number; readonly unit: "characters" | "bytes"; }

interface BaseFieldProps {
  /** Visible label (always rendered, never placeholder-only). */ readonly label: string;
  /** Stable name used for server `fields` association ("rationale", "endsAt", "note"). */ readonly name: string;
  /** Error text; when non-null sets aria-invalid and joins aria-describedby. */ readonly error: string | null;
  /** Persistent hint (e.g. the visibility/audit notice). */ readonly hint?: ReactNode;
  /** Adds the text "(required)" to the label (never colour/asterisk only). */ readonly required?: boolean;
}

function describedBy(ids: readonly (string | false)[]): string | undefined {
  const v = ids.filter(Boolean).join(" ");
  return v === "" ? undefined : v;
}

/**
 * Error / over-limit text uses the foreground colour: AA on every surface. The ⚠ glyph, the wording and
 * aria-invalid carry the error, never colour alone (REQ-A11Y-01/04).
 */
const ERROR_TEXT = "font-medium text-foreground";

function ErrorLine(p: { readonly id: string; readonly text: string }): ReactElement {
  return <p id={p.id} className={`m-0 ${ERROR_TEXT}`}><span aria-hidden="true">⚠ </span>{p.text}</p>;
}

function Hint(p: { readonly id: string; readonly children: ReactNode }): ReactElement {
  return <p id={p.id} className="m-0 text-muted-foreground">{p.children}</p>;
}

/** Props for {@link TextField}: a single-line text or datetime-local input. */
export interface TextFieldProps extends BaseFieldProps {
  readonly value: string;
  readonly onInput: (v: string) => void;
  readonly type?: "text" | "datetime-local";
  /** datetime-local bounds, local "YYYY-MM-DDTHH:mm". */ readonly min?: string; readonly max?: string;
}
/** Labelled text input with hint and error wiring (aria-invalid, aria-describedby). */
export function TextField(p: TextFieldProps): ReactElement {
  const id = useId();
  const hintId = p.hint !== undefined ? `${id}-hint` : false;
  const errId = p.error !== null ? `${id}-err` : false;
  return (
    <div className="grid gap-1.5 text-sm" data-field={p.name}>
      <Label htmlFor={id}>{p.label}{p.required ? " (required)" : null}</Label>
      {hintId ? <Hint id={hintId}>{p.hint}</Hint> : null}
      <Input id={id} name={p.name} type={p.type ?? "text"} value={p.value} min={p.min} max={p.max}
        aria-invalid={p.error !== null ? "true" : undefined}
        aria-describedby={describedBy([hintId, errId])}
        onChange={(e) => p.onInput(e.currentTarget.value)} />
      {errId && p.error !== null ? <ErrorLine id={errId} text={p.error} /> : null}
    </div>
  );
}

/** Props for {@link TextArea}: a multi-line input with an optional live counter. */
export interface TextAreaProps extends BaseFieldProps {
  readonly value: string;
  readonly onInput: (v: string) => void;
  readonly counter?: FieldCounter;
  readonly rows?: number;
}
/** Textarea with optional counter ("N bytes left"); the counter becomes aria-live=polite past 90%. */
export function TextArea(p: TextAreaProps): ReactElement {
  const id = useId();
  const hintId = p.hint !== undefined ? `${id}-hint` : false;
  const errId = p.error !== null ? `${id}-err` : false;
  const cntId = p.counter !== undefined ? `${id}-cnt` : false;
  const left = p.counter !== undefined ? p.counter.limit - p.counter.used : 0;
  return (
    <div className="grid gap-1.5 text-sm" data-field={p.name}>
      <Label htmlFor={id}>{p.label}{p.required ? " (required)" : null}</Label>
      {hintId ? <Hint id={hintId}>{p.hint}</Hint> : null}
      <Textarea id={id} name={p.name} rows={p.rows ?? 4} value={p.value}
        aria-invalid={p.error !== null ? "true" : undefined} aria-describedby={describedBy([hintId, cntId, errId])}
        onChange={(e) => p.onInput(e.currentTarget.value)} />
      {cntId && p.counter !== undefined ? (
        <p id={cntId} className={left < 0 ? `m-0 ${ERROR_TEXT}` : "m-0 text-muted-foreground"}
          data-over={left < 0 ? "true" : "false"}
          aria-live={p.counter.used >= p.counter.limit * 0.9 ? "polite" : "off"}>
          {left >= 0 ? `${left} ${p.counter.unit} left` : `${-left} ${p.counter.unit} over the limit`}
        </p>
      ) : null}
      {errId && p.error !== null ? <ErrorLine id={errId} text={p.error} /> : null}
    </div>
  );
}

/** Props for {@link Checkbox}: a checkbox that can be locked with an explanation. */
export interface CheckboxProps {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  /** Locked: aria-disabled (still focusable/announced) with an explanation (SIL-02). */
  readonly locked?: boolean;
  readonly lockedReason?: string;
  /** Per-option error (e.g. an unsendable label). */ readonly error?: string | null;
}
// Option rows are at least 24px tall so each 16px box keeps a 24px target spacing (WCAG 2.5.8).

/** Labelled checkbox; a locked box stays focusable (aria-disabled), ignores toggles and shows its reason. */
export function Checkbox(p: CheckboxProps): ReactElement {
  const id = useId();
  const whyId = p.locked && p.lockedReason !== undefined ? `${id}-why` : false;
  const errId = p.error ? `${id}-err` : false;
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex min-h-6 items-center gap-2">
        <UiCheckbox id={id} checked={p.checked} aria-disabled={p.locked ? "true" : undefined}
          aria-invalid={p.error ? "true" : undefined} aria-describedby={describedBy([whyId, errId])}
          onCheckedChange={(v) => { if (!p.locked) p.onChange(v === true); }} />
        <Label htmlFor={id} className="font-normal">{p.label}</Label>
      </div>
      {whyId ? <span id={whyId} className="text-muted-foreground">{p.lockedReason}</span> : null}
      {errId && p.error ? <ErrorLine id={errId} text={p.error} /> : null}
    </div>
  );
}

/** One option of a {@link RadioGroup}. */
export interface RadioOption<V extends string> { readonly value: V; readonly label: string; }
/** Props for {@link RadioGroup}: the legend, options and the selected value. */
export interface RadioGroupProps<V extends string> {
  readonly legend: string; readonly name: string; readonly value: V;
  readonly options: readonly RadioOption<V>[]; readonly onChange: (v: V) => void; readonly error?: string | null;
}
/** A labelled radio group (one `radiogroup`, named by its visible label); arrow keys move the selection. */
export function RadioGroup<V extends string>(p: RadioGroupProps<V>): ReactElement {
  const id = useId();
  const legendId = `${id}-legend`;
  const errId = p.error ? `${id}-err` : undefined;
  return (
    <div className="grid min-w-0 gap-2 text-sm">
      <span id={legendId} className="mb-1.5 font-medium">{p.legend}</span>
      <UiRadioGroup name={`${id}-${p.name}`} value={p.value} aria-labelledby={legendId} aria-describedby={errId}
        className="gap-2"
        onValueChange={(v) => { const o = p.options.find((x) => x.value === v); if (o !== undefined) p.onChange(o.value); }}>
        {p.options.map((o) => (
          <div key={o.value} className="flex min-h-6 items-center gap-2">
            <RadioGroupItem id={`${id}-${o.value}`} value={o.value} aria-invalid={p.error ? "true" : undefined} />
            <Label htmlFor={`${id}-${o.value}`} className="font-normal">{o.label}</Label>
          </div>
        ))}
      </UiRadioGroup>
      {errId !== undefined && p.error ? <ErrorLine id={errId} text={p.error} /> : null}
    </div>
  );
}
