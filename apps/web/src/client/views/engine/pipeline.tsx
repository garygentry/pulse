// apps/web/src/client/views/engine/pipeline.tsx — deadman panel, notification tiles and capacity
// tiles. Renders values model.ts/labels.ts derived; no Gauge, no thresholds, no store reads.
import type { ReactElement } from "react";
import type { DataAvailability, DeadmanState, RuleState } from "@pulse/web-data/wire";
import { EmptyState, KeyValueList, Section, StatGrid, StatTile, TARGET_STATUS } from "@/ui";
import type { EstateClock } from "../../format.js";
import { CAPACITY_TILE_LABEL, PRESENTATION_ICON, UNAVAILABLE, deadmanPresentation, toStatus } from "./labels.js";
import type { CapacityTile, NotificationSection, TileValue } from "./model.js";
import { EngineStatusBadge, NotReported, SourceDegradedBadge } from "./components.js";
import { CAPACITY_FORMAT, NOTIFICATION_FORMAT } from "./pipeline-format.js";
import { healthText, presentationLabel } from "./presentation.js";

// ---------------------------------------------------------------------------
// DeadmanPanel
// ---------------------------------------------------------------------------

/** Props for {@link DeadmanPanel}. */
export interface DeadmanPanelProps {
  /** Wire deadman state. */ readonly deadman: DeadmanState;
  /** `canaryRule(engine)`: the first `deadman === true` rule, or null. */ readonly canary: RuleState | null;
  /** Estate clock. */ readonly clock: EstateClock;
}

/**
 * Dedicated deadman/canary panel. It renders on every non-loading engine page, even though deadman
 * rules are excluded from the operator firing-alert list elsewhere. "Not configured" uses the
 * `unknown` status with the `minus` icon and its own word, so it is visibly distinct from healthy
 * and from a real unknown.
 */
export function DeadmanPanel({ deadman, canary, clock }: DeadmanPanelProps): ReactElement {
  const p = deadmanPresentation(deadman);
  return (
    <Section title="Deadman" level={2}>
      <SourceDegradedBadge availability={deadman.availability} clock={clock} />
      <p className="flex" data-configured={deadman.configured ? "true" : "false"} data-presentation={p.kind}>
        <EngineStatusBadge status={p.status} label={presentationLabel(p, clock.format)} icon={PRESENTATION_ICON[p.kind]} size="md" wrap />
      </p>
      {deadman.configured ? null : (
        <p className="text-sm text-muted-foreground">
          No deadman (canary) rule is configured. Without it, an OK verdict cannot be fully trusted.
        </p>
      )}
      <KeyValueList
        items={[
          { label: "Configured", value: deadman.configured ? "Yes" : "No" },
          {
            label: "Last evaluation",
            value: deadman.lastEvaluationAt === null ? <NotReported /> : clock.format(deadman.lastEvaluationAt),
          },
        ]}
      />
      {canary === null ? (
        deadman.configured ? (
          <p className="text-sm text-muted-foreground">The canary rule is not present in rule state.</p>
        ) : null
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-canary="">
          <span className="font-medium break-all" data-rule-name="">{canary.name}</span>
          <EngineStatusBadge status={toStatus(canary.health)} label={healthText(canary.health)} />
          <span className="text-muted-foreground" data-last-eval="">
            Last evaluated{" "}
            {canary.lastEvaluationAt === null ? <NotReported /> : clock.format(canary.lastEvaluationAt)}
          </span>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// TileValue rendering
// ---------------------------------------------------------------------------

/** Props for {@link TileValueView}. */
export interface TileValueViewProps {
  /** Derived tile value. */ readonly value: TileValue;
  /** Formatter binding for a present value. */ readonly format: (n: number) => string;
}

/** Render one TileValue: formatted text, the NotReported element, or "unavailable" (never zero). */
export function TileValueView({ value, format }: TileValueViewProps): ReactElement {
  if (value.kind === "value") {
    return <span data-tile-value="">{format(value.value)}</span>;
  }
  if (value.kind === "not-reported") return <NotReported />;
  return <span className="text-muted-foreground italic" data-unavailable="">{UNAVAILABLE}</span>;
}

// ---------------------------------------------------------------------------
// NotificationTiles
// ---------------------------------------------------------------------------

/** Props for {@link NotificationTiles}. */
export interface NotificationTilesProps {
  /** `notificationSection(engine.notifications)`. */ readonly section: NotificationSection;
  /** Estate clock. */ readonly clock: EstateClock;
}

/**
 * One stat tile per integration: failures per second as the headline and p95 latency beneath it. A
 * tile shows a "Failing" badge (and the critical tone) when its failure rate is a value > 0. There
 * is no "OK" badge: the text carries the status, and the verdict owns the roll-up.
 */
export function NotificationTiles({ section, clock }: NotificationTilesProps): ReactElement {
  return (
    <Section title="Notifications" level={2}>
      <SourceDegradedBadge availability={section.availability} clock={clock} />
      {section.state === "none-reported" ? (
        <EmptyState icon="bell" title="No notification integrations reported" />
      ) : null}
      {section.state === "rows" ? (
        <StatGrid>
          {section.rows.map((r) => {
            const failing = r.failuresPerSecond.kind === "value" && r.failuresPerSecond.value > 0;
            return (
              <div key={r.integration} className="min-w-0" data-integration={r.integration}>
                <StatTile
                  className="h-full"
                  tone={failing ? TARGET_STATUS.critical.tone : "neutral"}
                  label={
                    <>
                      <span className="min-w-0 break-all">{r.integration}</span>
                      {failing ? <EngineStatusBadge status="critical" label="Failing" /> : null}
                    </>
                  }
                  value={
                    <>
                      <span className="sr-only">Failures: </span>
                      <TileValueView value={r.failuresPerSecond} format={NOTIFICATION_FORMAT.failures} />
                    </>
                  }
                  subLabel={
                    <>
                      Failures · p95 latency <TileValueView value={r.latencyP95Seconds} format={NOTIFICATION_FORMAT.latency} />
                    </>
                  }
                />
              </div>
            );
          })}
        </StatGrid>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// CapacityTiles
// ---------------------------------------------------------------------------

/** Props for {@link CapacityTiles}. */
export interface CapacityTilesProps {
  /** `capacityTiles(engine.capacity)`: four tiles, in order. */ readonly tiles: readonly CapacityTile[];
  /** `engine.capacity.availability`, used for the section's degraded notice. */ readonly availability: DataAvailability;
  /** Estate clock. */ readonly clock: EstateClock;
}

/**
 * Four current-value stat tiles. There is no Gauge, because the payload has no total or used disk
 * figure. Tiles carry no status and no tone: capacity never changes the verdict, and the view
 * invents no thresholds.
 */
export function CapacityTiles({ tiles, availability, clock }: CapacityTilesProps): ReactElement {
  return (
    <Section title="Capacity" level={2}>
      <SourceDegradedBadge availability={availability} clock={clock} />
      <StatGrid>
        {tiles.map((t) => (
          <div key={t.id} className="min-w-0" data-capacity={t.id}>
            <StatTile
              className="h-full"
              label={CAPACITY_TILE_LABEL[t.id]}
              value={<TileValueView value={t.value} format={CAPACITY_FORMAT[t.id]} />}
            />
          </div>
        ))}
      </StatGrid>
    </Section>
  );
}
