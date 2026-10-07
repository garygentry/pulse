// apps/web/src/client/views/overview/drawer/TargetDrawer.tsx — the read-only selected-target drawer.
//
// A Radix Sheet (focus trap, scroll lock, Escape/overlay close) with one visible close control.
// The grid opens it without a DialogTrigger, so closing returns focus to whatever had it on open
// (the grid target) when that node is still connected; otherwise the view rescues focus to a
// surviving target. Every section renders from one TargetDrawerModel derived from the same accepted
// snapshot as the grid, except the liveness region: LivenessSparkline mounts only while open, so no
// history request precedes opening. Grafana is a plain external link to the server-resolved URL
// only: no iframe, chart, query input, secret or mutation control.

import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { OverviewSnapshotV2 } from "@pulse/web-data/wire";
import type { EstateClock } from "../../../format.js";
import type { SelectedTarget } from "../../../store/types.js";
import {
  Button,
  ExternalLink,
  Icon,
  Section,
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from "@/ui";
import type { HistoryController, OverviewTarget, TargetDrawerModel } from "../model.js";
import { TargetStatusBadge } from "../status-badges.js";
import { AlertList } from "./AlertList.js";
import { CheckHistory } from "./CheckHistory.js";
import { DeclaredFacts } from "./DeclaredFacts.js";
import { LivenessSparkline } from "./LivenessSparkline.js";
import { DRAWER_EMPTY_CLASS } from "./classes.js";
import { AVAILABILITY_LABEL, evidenceLastGood } from "./format.js";
import { LiveSignals } from "./LiveSignals.js";

/** Props for the read-only selected-target drawer. */
export interface TargetDrawerProps {
  /** Whether the modal Sheet is open. */
  readonly open: boolean;
  /** Coherent snapshot-derived model for the canonical selected target. */
  readonly model: TargetDrawerModel;
  /** Per-mounted-overview lazy liveness-history controller. */
  readonly history: HistoryController;
  /** Estate-timezone formatter for all absolute timestamps. */
  readonly clock: EstateClock;
  /** Clears canonical selection and closes the Sheet. */
  readonly onClose: () => void;
}

/** Accessible name of the visible close control. */
export const CLOSE_TARGET_DETAILS_LABEL = "Close target details";
/** Copy when the snapshot assigns no Grafana board to the target. */
export const NO_GRAFANA_BOARD_TEXT = "No Grafana dashboard is configured for this target.";
/** Copy when the server-resolved Grafana URL fails the safety check. */
export const UNSAFE_GRAFANA_TEXT = "Grafana link unavailable.";

/** Accept only an absolute credential-free HTTP(S) URL; return null for any unsafe value. */
export function safeGrafanaHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Convert a canonical target to the current store's compatibility selection shape. */
export function toStoreSelection(target: OverviewTarget): SelectedTarget {
  return target.service !== null
    ? { kind: "service", host: target.host.name, service: target.service.name }
    : { kind: "host", host: target.host.name };
}

/** Resolve legacy store selection through snapshot objects to an authoritative id; null if absent or ambiguous. */
export function canonicalIdFromStoreSelection(
  snapshot: OverviewSnapshotV2,
  selection: SelectedTarget,
): string | null {
  const hosts = snapshot.hosts.filter((host) => host.name === selection.host);
  if (hosts.length !== 1) return null;
  const host = hosts[0]!;
  if (selection.kind === "host") return host.drilldownId;
  const services = host.services.filter((service) => service.name === selection.service);
  return services.length === 1 ? services[0]!.drilldownId : null;
}

/** Drawer title naming the selected host or service. */
export function targetDrawerTitle(target: OverviewTarget): string {
  return target.service !== null ? `${target.service.name} on ${target.host.name}` : target.host.name;
}

function TargetStatusSummary(props: { readonly model: TargetDrawerModel; readonly clock: EstateClock }): ReactElement {
  const { status, availability } = props.model;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-status={status} data-availability={availability.state}>
      <TargetStatusBadge status={status} size="md" />
      <span data-slot="drawer-availability" className="font-medium">{AVAILABILITY_LABEL[availability.state] ?? availability.state}</span>
      {availability.message !== null ? <span data-slot="drawer-availability-message">{availability.message}</span> : null}
      <span data-slot="drawer-last-good" className="text-muted-foreground">{evidenceLastGood(props.clock, availability)}</span>
    </div>
  );
}

function GrafanaLink(props: { readonly grafana: TargetDrawerModel["grafana"] }): ReactElement {
  const { grafana } = props;
  const href = grafana === null || grafana.url === "" ? null : safeGrafanaHref(grafana.url);
  return (
    <Section level={3} title="Dashboards" data-section="grafana">
      {grafana === null ? (
        <p data-slot="drawer-empty" className={DRAWER_EMPTY_CLASS}>{NO_GRAFANA_BOARD_TEXT}</p>
      ) : href === null ? (
        <p data-slot="drawer-empty" className={DRAWER_EMPTY_CLASS}>{UNSAFE_GRAFANA_TEXT}</p>
      ) : (
        <ExternalLink href={href} className="min-h-11 self-start">
          Open in Grafana ({grafana.boardUid})
        </ExternalLink>
      )}
    </Section>
  );
}

/**
 * True once a frame has painted with the drawer open for `targetId`: one animation frame, then a
 * task, so the frame-producing work is done before the sections render.
 */
function usePaintedFor(targetId: string): boolean {
  const [painted, setPainted] = useState<string | null>(null);
  useEffect(() => {
    if (painted === targetId) return undefined;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const next = (): void => {
      timer = globalThis.setTimeout(() => setPainted(targetId), 0);
    };
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    const frame = typeof raf === "function" ? raf(next) : (next(), null);
    return () => {
      if (frame !== null) (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame?.(frame);
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [targetId, painted]);
  return painted === targetId;
}

/**
 * The drawer's sections. They render once the Sheet frame (title + close) has painted, so opening
 * the drawer paints the dialog first and the sections follow a frame later; until then a skeleton
 * holds the body. Liveness history therefore still loads only once the drawer is open.
 */
function DrawerBody(props: {
  readonly model: TargetDrawerModel;
  readonly clock: EstateClock;
  readonly history: HistoryController;
}): ReactElement {
  const { model, clock } = props;
  const painted = usePaintedFor(model.target.drilldownId);
  const { target } = model;
  if (!painted) {
    return (
      <div
        className="grid min-h-0 flex-1 content-start gap-4 p-4"
        data-target-kind={target.kind}
        data-drawer-target={target.drilldownId}
        data-drawer-body="pending"
        aria-busy="true"
      >
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  return (
    <div
      className="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto p-4"
      data-target-kind={target.kind}
      data-drawer-target={target.drilldownId}
      data-drawer-body="ready"
    >
      <TargetStatusSummary model={model} clock={clock} />
      <DeclaredFacts identity={model.target.identity} host={model.target.host} service={model.target.service} />
      <LiveSignals signals={model.signals} clock={clock} />
      <AlertList alerts={model.alerts} clock={clock} />
      <CheckHistory checks={model.checks} lanes={model.checkLanes} clock={clock} />
      <Section level={3} title="Liveness (1 h)" data-section="liveness">
        <LivenessSparkline target={model.target} controller={props.history} />
      </Section>
      <GrafanaLink grafana={model.grafana} />
    </div>
  );
}

/** Compose all drawer sections inside a right-hand modal Sheet. */
export function TargetDrawer(props: TargetDrawerProps): ReactElement {
  const { model, clock } = props;
  const { target } = model;
  // Radix returns focus only to a DialogTrigger; record what had focus on open instead.
  const returnFocus = useRef<HTMLElement | null>(null);
  // Initial focus goes to the dialog itself (named by its title), not the close button: Tab reaches
  // Close next, and no button focus ring animates while the Sheet slides in.
  const onOpenAutoFocus = (event: Event): void => {
    const content = event.currentTarget as HTMLElement | null;
    const active = content?.ownerDocument.activeElement;
    returnFocus.current = active instanceof HTMLElement ? active : null;
    if (content === null) return;
    event.preventDefault();
    content.focus({ preventScroll: true });
  };
  const onCloseAutoFocus = (event: Event): void => {
    event.preventDefault();
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el?.isConnected) el.focus();
  };
  return (
    <Sheet open={props.open} onOpenChange={(open) => {
      if (!open) props.onClose();
    }}>
      {props.open ? (
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          className="w-full gap-0 outline-none sm:max-w-md"
        >
          <SheetHeader className="flex-row items-start justify-between gap-2 border-b">
            <SheetTitle className="min-w-0 self-center text-lg break-words">{targetDrawerTitle(target)}</SheetTitle>
            <SheetClose asChild>
              <Button type="button" variant="outline" className="min-h-11 min-w-11 shrink-0" aria-label={CLOSE_TARGET_DETAILS_LABEL}>
                <Icon name="x" />
                Close
              </Button>
            </SheetClose>
          </SheetHeader>
          <DrawerBody model={model} clock={clock} history={props.history} />
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
