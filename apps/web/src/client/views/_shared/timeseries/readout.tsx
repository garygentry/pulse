// Page-wide cursor readout: the source registry and the CursorReadout panel with its debounced
// polite summary (06 §7; REQ-ZOOM-01, REQ-A11Y-03, REQ-PERF-05).
// Every label renders as a JSX text child (REQ-SEC-02); state is always written in words (REQ-A11Y-01).
import type { ReactElement } from "react";
import { signal, useSignalEffect } from "@preact/signals-react";
import type { ReadonlySignal } from "@preact/signals-core";
import { useEffect, useRef, useState } from "react";
import { Button, cn } from "@/ui";
import type { EstateClock } from "../../../format.js";
import type { TimeAxis } from "./axis.js";
import {
  READOUT_ANNOUNCE_DEBOUNCE_MS,
  READOUT_MAX_LANE_ROWS,
  buildReadoutSummary,
  formatCursorTime,
  isChartReadout,
  laneGroupOf,
  laneGroupRank,
} from "./readout-model.js";
import type { ChartReadout, LaneReadout, ReadoutEntries, ReadoutSource } from "./readout-model.js";
import { useSignals } from "@preact/signals-react/runtime";

/** The page's collection of readout sources (one per visible lane group and chart). */
export interface ReadoutRegistry {
  /** Add (or replace, by id) a source; `order` sorts sources (ascending, stable; default +Infinity). Returns an unregister function. */
  register(source: ReadoutSource, order?: number): () => void;
  /** Remove a source by id. No-op when absent. */
  unregister(id: string): void;
  /** Mark readouts stale without a cursor move (data changed under a pinned cursor). */
  invalidate(): void;
  /** Bumps on register, unregister and invalidate; CursorReadout subscribes to it. */
  readonly version: ReadonlySignal<number>;
  /** Read every source at `t`. A throwing source is skipped and logged once per id. */
  read(t: number): ReadoutEntries;
}

interface Registration {
  readonly source: ReadoutSource;
  readonly order: number;
  readonly seq: number;
}

/** Create an empty registry (07 creates one per page; SyncedChart creates one per local-mode chart). */
export function createReadoutRegistry(): ReadoutRegistry {
  const version = signal(0);
  let entries: Registration[] = [];
  let seq = 0;
  const reported = new Set<string>();

  const remove = (id: string): boolean => {
    const next = entries.filter((r) => r.source.id !== id);
    const changed = next.length !== entries.length;
    entries = next;
    return changed;
  };

  return {
    version,
    register(source: ReadoutSource, order?: number): () => void {
      const o = typeof order === "number" && !Number.isNaN(order) ? order : Number.POSITIVE_INFINITY;
      remove(source.id);
      entries.push({ source, order: o, seq: seq++ });
      // Stable: ties keep registration order.
      entries.sort((a, b) => (a.order === b.order ? a.seq - b.seq : a.order < b.order ? -1 : 1));
      version.value = version.peek() + 1;
      return () => {
        // Identity check: a replaced source's unregister is a no-op (re-mount order is harmless).
        const current = entries.find((r) => r.source.id === source.id);
        if (current === undefined || current.source !== source) return;
        if (remove(source.id)) version.value = version.peek() + 1;
      };
    },
    unregister(id: string): void {
      if (remove(id)) version.value = version.peek() + 1;
    },
    invalidate(): void {
      version.value = version.peek() + 1;
    },
    read(t: number): ReadoutEntries {
      const lanes: LaneReadout[] = [];
      const charts: ChartReadout[] = [];
      for (const r of entries) {
        let out: readonly (LaneReadout | ChartReadout)[];
        try {
          out = r.source.read(t);
        } catch (err) {
          if (!reported.has(r.source.id)) {
            reported.add(r.source.id);
            console.error(`[timeline] readout source "${r.source.id}" failed; skipped`, err);
          }
          continue;
        }
        for (const e of out) {
          if (isChartReadout(e)) charts.push(e);
          else lanes.push(e);
        }
      }
      return { lanes, charts };
    },
  };
}

// ---------------------------------------------------------------------------
// §7.3 CursorReadout
// ---------------------------------------------------------------------------

/** Props for CursorReadout. */
export interface CursorReadoutProps {
  /** The axis whose cursor is read. */ axis: TimeAxis;
  /** Sources to read. */ registry: ReadoutRegistry;
  /** Formats the cursor time in the estate zone (REQ-RANGE-03). */ clock: EstateClock;
  /** id for the aria-live summary; overlays point aria-describedby at it. */ summaryId: string;
  /** "panel" (page, 07) or "inline" (one engine chart). Default "panel". */ variant?: "panel" | "inline";
  /** Extra class names. */ className?: string;
}

/** Run `cb` on the next animation frame; microtask fallback when rAF is missing or throws (§7.5). */
function requestFrame(cb: () => void): () => void {
  let cancelled = false;
  const run = (): void => {
    if (!cancelled) cb();
  };
  const raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame;
  let scheduled = false;
  if (typeof raf === "function") {
    try {
      raf(() => run());
      scheduled = true;
    } catch {
      /* fall through to the microtask fallback */
    }
  }
  if (!scheduled) queueMicrotask(run);
  return () => {
    cancelled = true;
  };
}

interface ReadoutFrame {
  readonly t: number;
  readonly pinned: boolean;
  readonly e: ReadoutEntries;
}

/**
 * Visible compact readout plus a polite live summary (tech-spec §3.7 "Readout").
 * Entries are recomputed at most once per animation frame from axis.cursor; the spoken summary
 * is debounced by READOUT_ANNOUNCE_DEBOUNCE_MS (250 ms) on the trailing edge.
 */
export function CursorReadout(props: CursorReadoutProps): ReactElement {
  useSignals();
  const { axis, registry, clock, summaryId } = props;
  const variant = props.variant ?? "panel";
  const [frame, setFrame] = useState<ReadoutFrame | null>(null);
  const [summary, setSummary] = useState("");
  const [showAll, setShowAll] = useState(false);
  const pending = useRef<{ fn: (() => void) | null; cancel: (() => void) | null }>({ fn: null, cancel: null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;

  const cancelSummary = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  useSignalEffect(() => {
    const t = axis.cursor.value; // tracked
    const pinned = axis.pinned.value; // tracked: the pinned mark
    registry.version.value; // tracked: sources added/removed/invalidated
    axis.view.value; // tracked: lanes re-clipped after zoom
    const p = pending.current;
    p.fn = () => {
      if (t === null) {
        setFrame(null);
        cancelSummary();
        return;
      }
      const e = registry.read(t);
      setFrame({ t, pinned, e });
      cancelSummary();
      timer.current = setTimeout(() => {
        timer.current = null;
        const text = buildReadoutSummary(formatCursorTime(t, clockRef.current), e, axis.pinned.peek());
        setSummary((prev) => (prev === text ? prev : text));
      }, READOUT_ANNOUNCE_DEBOUNCE_MS);
    };
    if (p.cancel === null) {
      // Coalesced: at most one pending frame; the latest cursor wins.
      p.cancel = requestFrame(() => {
        p.cancel = null;
        const fn = p.fn;
        p.fn = null;
        fn?.();
      });
    }
  });

  useEffect(
    () => () => {
      pending.current.cancel?.();
      pending.current.cancel = null;
      cancelSummary();
    },
    [],
  );

  const charts = frame?.e.charts ?? [];
  const lanes = variant === "panel" && frame !== null ? frame.e.lanes : [];
  const notOk = lanes
    .map((l, i) => ({ l, i, g: laneGroupOf(l) }))
    .filter((x): x is { l: LaneReadout; i: number; g: string } => x.g !== null)
    .sort((a, b) => laneGroupRank(a.g) - laneGroupRank(b.g) || a.i - b.i);
  const okCount = lanes.length - notOk.length;
  const shown = showAll ? notOk : notOk.slice(0, READOUT_MAX_LANE_ROWS);
  const hidden = notOk.length - shown.length;

  return (
    <section
      data-slot="cursor-readout"
      data-variant={variant}
      aria-label="Cursor readout"
      className={cn("flex min-w-0 flex-col gap-1 text-sm", props.className)}
    >
      <p data-slot="cursor-readout-time" className="m-0 text-muted-foreground tabular-nums">
        {frame === null ? "Point at the timeline, or focus it and use the arrow keys." : formatCursorTime(frame.t, clock)}
        {frame !== null && frame.pinned ? " (pinned)" : null}
      </p>
      {charts.length > 0 ? (
        <ul data-slot="cursor-readout-charts" className="m-0 list-none p-0 break-words">
          {charts.map((c, i) => (
            <li key={i}>
              {c.title}:{c.values.map((v) => ` ${v.label} ${v.text}`).join(";")}
            </li>
          ))}
        </ul>
      ) : null}
      {variant === "panel" && frame !== null ? (
        <>
          <ul data-slot="cursor-readout-lanes" className="m-0 list-none p-0 break-words">
            {shown.map(({ l, g }, i) => (
              <li key={i} data-status={l.status} data-group={g}>
                {`${l.label}: ${l.text}`}
                {l.partial !== null ? ` — partial evidence: ${l.partial}` : null}
              </li>
            ))}
          </ul>
          <p data-slot="cursor-readout-ok" className="m-0 text-muted-foreground">
            {`${okCount} lanes OK`}
            {hidden > 0 ? ` · +${hidden} more not OK` : null}
          </p>
          {notOk.length > READOUT_MAX_LANE_ROWS ? (
            <Button type="button" variant="link" size="sm" className="self-start px-0" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${notOk.length} lanes`}
            </Button>
          ) : null}
        </>
      ) : null}
      <p id={summaryId} role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {summary}
      </p>
    </section>
  );
}
