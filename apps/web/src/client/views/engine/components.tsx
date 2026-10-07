// apps/web/src/client/views/engine/components.tsx — shared engine presentation primitives and the
// component cards. Every function renders values that model.ts/labels.ts have already derived;
// nothing here derives state, reads the store or imports CSS. Every upstream string renders as a
// JSX text child.
import type { ReactElement, ReactNode } from "react";
import type { DataAvailability, EngineComponent, TargetStatus } from "@pulse/web-data/wire";
import {
  Button, Callout, Card, EmptyState, KeyValueList, Section, StatusBadge, TARGET_STATUS, Tooltip, TooltipContent,
  TooltipTrigger,
} from "@/ui";
import type { IconName, StatusBadgeSize } from "@/ui";
import type { EstateClock } from "../../format.js";
import {
  COMPONENT_LABEL, NOT_REPORTED, NO_LAST_GOOD, PRESENTATION_ICON, componentPresentation, degradedText,
  formatUptime, formatVersion,
} from "./labels.js";
import { presentationLabel } from "./presentation.js";

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

/** Props for {@link EngineStatusBadge}. */
export interface EngineStatusBadgeProps {
  /** Target status; picks the tone (and the default icon) from TARGET_STATUS. */ readonly status: TargetStatus;
  /** Visible status word. */ readonly label: ReactNode;
  /** Overrides the status's own icon (e.g. a presentation-kind icon). */ readonly icon?: IconName;
  /** Badge size. */ readonly size?: StatusBadgeSize;
  /** Let a long label wrap instead of truncating (labels carrying a time, e.g. "Stale — last good …"). */
  readonly wrap?: boolean;
}

/** A TARGET_STATUS badge carrying `data-status` as the stable test hook. */
export function EngineStatusBadge({ status, label, icon, size = "sm", wrap = false }: EngineStatusBadgeProps): ReactElement {
  const s = TARGET_STATUS[status];
  return (
    <StatusBadge
      tone={s.tone}
      icon={icon ?? s.icon}
      label={label}
      size={size}
      data-status={status}
      {...(wrap ? { className: "h-auto whitespace-normal [&>span]:whitespace-normal" } : {})}
      {...(s.variant !== undefined ? { variant: s.variant } : {})}
    />
  );
}

// ---------------------------------------------------------------------------
// NotReported and ValueText
// ---------------------------------------------------------------------------

/**
 * The single "not reported" element. It renders the `NOT_REPORTED` copy with `data-not-reported`,
 * so tests can find every occurrence. It is never blank, never zero, and never styled like data.
 */
export function NotReported(): ReactElement {
  return (
    <span className="text-muted-foreground italic" data-not-reported="">
      {NOT_REPORTED}
    </span>
  );
}

/** Props for {@link ValueText}. */
export interface ValueTextProps {
  /** Output of a labels.ts formatter; NOT_REPORTED means the value is absent. */
  readonly text: string;
  /** Append the "last known" qualifier. */
  readonly lastKnown: boolean;
}

/**
 * Render a formatter result. The `NOT_REPORTED` sentinel becomes the one `NotReported` element.
 * Any other string is plain text, followed by `LastKnown` when `lastKnown` is set.
 */
export function ValueText({ text, lastKnown }: ValueTextProps): ReactElement {
  if (text === NOT_REPORTED) return <NotReported />;
  return (
    <span data-value="">
      {text}
      {lastKnown ? <> <LastKnown /></> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LastKnown qualifier
// ---------------------------------------------------------------------------

/** Qualifier placed after a value whose governing source is not current. */
export function LastKnown(): ReactElement {
  return (
    <span className="text-xs text-muted-foreground" data-last-known="">
      last known
    </span>
  );
}

// ---------------------------------------------------------------------------
// Source-named degraded notice
// ---------------------------------------------------------------------------

/** Props for {@link SourceDegradedBadge}. */
export interface SourceDegradedBadgeProps {
  /** Governing source availability for the region or card. */
  readonly availability: DataAvailability;
  /** Estate clock; `clock.format` is passed to `degradedText`. */
  readonly clock: EstateClock;
}

/**
 * Source-named degraded notice, e.g. "Alertmanager unavailable — last good 2026-09-24 10:03:22
 * CDT". Renders nothing when the source is current. A compact, static note in the `unknown` tone
 * (never a live alert); the source's own `message`, when present, follows as plain text.
 */
export function SourceDegradedBadge({ availability, clock }: SourceDegradedBadgeProps): ReactElement | null {
  const text = degradedText(availability, clock.format);
  if (text === null) return null;
  return (
    <Callout
      compact
      role="note"
      tone={TARGET_STATUS.unknown.tone}
      icon="triangle-alert"
      title={text}
      data-status="unknown"
      data-availability={availability.state}
      data-source={availability.source}
    >
      {availability.message !== null ? <span data-degraded-detail="">{availability.message}</span> : null}
    </Callout>
  );
}

// ---------------------------------------------------------------------------
// ErrorText and ErrorDetail
// ---------------------------------------------------------------------------

/** Props for {@link ErrorText}. */
export interface ErrorTextProps {
  /** Verbatim upstream error text, rendered only as a JSX text child. */
  readonly text: string;
  /** Whether the owner's full-text detail is currently open. */
  readonly expanded: boolean;
  /** Id of the full-text detail element this control opens. */
  readonly detailId: string;
  /** Toggle handler; null renders a non-interactive truncated span (kiosk). */
  readonly onToggle: (() => void) | null;
}

/**
 * A one-line error, truncated with CSS. The DOM holds the full text; only the visual rendering is
 * clipped, so assistive technology always reads all of it. The Tooltip shows the full text on hover
 * and on keyboard focus. Activating the button opens the owner's full-text detail.
 */
export function ErrorText({ text, expanded, detailId, onToggle }: ErrorTextProps): ReactElement {
  if (onToggle === null) {
    return <span className="block max-w-[24rem] truncate font-mono text-xs" data-error-text="">{text}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="link"
          className="h-auto max-w-[24rem] justify-start p-0 font-mono text-xs font-normal text-foreground"
          aria-expanded={expanded ? "true" : "false"}
          aria-controls={detailId}
          onClick={onToggle}
        >
          <span className="truncate" data-error-text="">{text}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-sm break-words">{text}</TooltipContent>
    </Tooltip>
  );
}

/** Props for {@link ErrorDetail}. */
export interface ErrorDetailProps {
  /** Element id referenced by the toggle's aria-controls. */ readonly id: string;
  /** Owner named in the region label, e.g. a target instance or rule name. */ readonly owner: string;
  /** Full verbatim error text. */ readonly text: string;
}

/** Full-text error panel, shown below a table when an ErrorText is expanded. */
export function ErrorDetail({ id, owner, text }: ErrorDetailProps): ReactElement {
  return (
    <div
      id={id}
      role="region"
      aria-label={`Full last error for ${owner}`}
      className="mt-2 flex flex-col gap-1 rounded-md border bg-muted p-3 text-sm"
    >
      <p className="font-medium" data-error-owner="">{owner}</p>
      <p className="font-mono text-xs break-words whitespace-pre-wrap" data-error-full="">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComponentCards
// ---------------------------------------------------------------------------

/** Props for {@link ComponentCards}. */
export interface ComponentCardsProps {
  /** Components in payload order (the authoritative display order). */
  readonly components: readonly EngineComponent[];
  /** Estate clock for last-good times. */
  readonly clock: EstateClock;
  /** Persistent view staleness; passed to componentPresentation as `viewNotCurrent`. */
  readonly notCurrent: boolean;
}

/** Props for {@link ComponentCard}. */
export interface ComponentCardProps {
  /** The wire component. */ readonly component: EngineComponent;
  /** Estate clock. */ readonly clock: EstateClock;
  /** Persistent view staleness. */ readonly notCurrent: boolean;
}

/** One card per engine component, in payload order. */
export function ComponentCards({ components, clock, notCurrent }: ComponentCardsProps): ReactElement {
  return (
    <Section title="Components" level={2}>
      {components.length === 0 ? (
        <EmptyState title="No engine components reported" icon="circle-help" />
      ) : (
        <ul role="list" className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-3 p-0">
          {components.map((c) => (
            <li key={c.id} className="min-w-0" data-component={c.id}>
              <ComponentCard component={c} clock={clock} notCurrent={notCurrent} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** One component card: name, status badge, facts, and a degraded notice when the source is not current. */
export function ComponentCard({ component: c, clock, notCurrent }: ComponentCardProps): ReactElement {
  const p = componentPresentation(c, { viewNotCurrent: notCurrent });
  const name = (COMPONENT_LABEL as Readonly<Record<string, string>>)[c.id] ?? String(c.id);
  const chip = presentationLabel(p, clock.format);
  const notConfigured = p.kind === "not-configured";

  return (
    <Card role="article" aria-label={`${name}: ${chip}`} className="h-full gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2" data-presentation={p.kind}>
        <h3 className="text-sm font-semibold">{name}</h3>
        <EngineStatusBadge status={p.status} label={chip} icon={PRESENTATION_ICON[p.kind]} size="md" wrap />
      </div>
      <KeyValueList
        layout="grid"
        items={[
          { label: "Version", value: <ValueText text={formatVersion(c.version)} lastKnown={p.qualifyValues} /> },
          { label: "Uptime", value: <ValueText text={formatUptime(c.uptimeSeconds)} lastKnown={p.qualifyValues} /> },
          ...(notConfigured
            ? []
            : [{ label: "Last good", value: p.lastGoodAt === null ? NO_LAST_GOOD : clock.format(p.lastGoodAt) }]),
        ]}
      />
      {notConfigured ? (
        <p className="text-sm text-muted-foreground">Not configured in this estate.</p>
      ) : (
        <SourceDegradedBadge availability={c.availability} clock={clock} />
      )}
    </Card>
  );
}
