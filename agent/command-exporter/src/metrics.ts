// agent/command-exporter/src/metrics.ts
//
// Fail-visible last-good state + Prometheus exposition for the command-exporter (issue #3/#1),
// mirroring the prober's MetricStore (02 §6). `MetricStore` is the only in-memory state the exporter
// holds. Per signal it retains the last SUCCESSFUL value/text and, on a later failure, flips the
// signal's `up` to 0 WITHOUT refreshing the value/text — so a downstream sees either a stale value
// or `_up == 0`, never a silently-missing failure (never pretend healthy when blind).
//
// `host` is NOT emitted here: it is applied by the managed-linux-command-exporter scrape job
// label (the bundle stays estate-agnostic, exactly like node_exporter/heartbeat). A `scalar` signal
// emits its declared `metric`/`upMetric` with the signal's baked `labels`; an `exposition` signal
// passes its command's Prometheus text through and adds `pulse_command_signal_up{signal}`.

import type { CommandSignalConfig } from "../../contract/types.js";
import { PULSE_COMMAND_SIGNAL_UP } from "../../contract/types.js";
import type { SignalOutcome } from "./run.js";

/** The retained per-signal state feeding one exposition render. `value`/`text` are the LAST
 *  SUCCESSFUL output (NOT refreshed on failure); `up` reflects the MOST RECENT run. */
interface SignalState {
  signal: CommandSignalConfig;
  up: 0 | 1;
  value?: number;
  text?: string;
}

/**
 * Holds the last-good per-signal state across cycles and renders Prometheus exposition text. A
 * single instance lives for the process lifetime. Seeded with every configured signal so a
 * never-run signal still emits its `_up 0` line.
 */
export class MetricStore {
  private readonly byName = new Map<string, SignalState>();

  constructor(signals: CommandSignalConfig[]) {
    for (const signal of signals) this.byName.set(signal.name, { signal, up: 0 });
  }

  /**
   * Fold one signal's outcome into the store. Success → `up = 1` and refresh `value`/`text`.
   * Failure → `up = 0`, leaving `value`/`text` untouched (fail-visible stale output).
   */
  record(name: string, outcome: SignalOutcome): void {
    const state = this.byName.get(name);
    if (state === undefined) return; // unknown signal (never configured) — ignore defensively
    if (!outcome.ok) {
      state.up = 0;
      return;
    }
    state.up = 1;
    if (outcome.value !== undefined) state.value = outcome.value;
    if (outcome.text !== undefined) state.text = outcome.text;
  }

  /** Render the full Prometheus exposition text for all configured signals. */
  render(): string {
    return renderExposition([...this.byName.values()]);
  }
}

/** Deterministic comparator: order signals by name. */
function byName(a: SignalState, b: SignalState): number {
  return a.signal.name < b.signal.name ? -1 : a.signal.name > b.signal.name ? 1 : 0;
}

/**
 * Render signal states to Prometheus exposition text. Emits every needed `# TYPE … gauge` header
 * once (deduped, sorted) up front, then — per signal in name order — its sample lines: a scalar
 * signal emits `metric{labels} value` (only once a run has succeeded) and `upMetric{labels} up`; an
 * exposition signal emits its last-good command text (verbatim) and `pulse_command_signal_up{signal} up`.
 * Output is a valid `text/plain; version=0.0.4` body terminated by a trailing newline.
 */
export function renderExposition(states: SignalState[]): string {
  const sorted = [...states].sort(byName);

  // Pass 1 — TYPE headers (deduped, deterministic). Scalar signals declare their metric + upMetric;
  // any exposition signal declares the shared liveness. Exposition command output carries its own
  // TYPE lines inline (opaque to us).
  const types = new Set<string>();
  let anyExposition = false;
  for (const s of sorted) {
    if (s.signal.output === "scalar") {
      types.add(s.signal.metric);
      types.add(s.signal.upMetric);
    } else {
      anyExposition = true;
    }
  }
  if (anyExposition) types.add(PULSE_COMMAND_SIGNAL_UP);

  const lines: string[] = [];
  for (const name of [...types].sort()) lines.push(`# TYPE ${name} gauge`);

  // Pass 2 — sample lines.
  for (const s of sorted) {
    if (s.signal.output === "scalar") {
      const lbl = renderLabels(s.signal.labels);
      if (s.value !== undefined) lines.push(`${s.signal.metric}${lbl} ${s.value}`);
      lines.push(`${s.signal.upMetric}${lbl} ${s.up}`);
    } else {
      if (s.text !== undefined && s.text.trim().length > 0) lines.push(s.text.trimEnd());
      lines.push(`${PULSE_COMMAND_SIGNAL_UP}{signal="${esc(s.signal.name)}"} ${s.up}`);
    }
  }

  return lines.join("\n") + "\n";
}

/** Render a baked label set to `{k="v",...}` (keys sorted) or `""` when empty. host is NEVER here
 *  (it is scrape-applied). Values are escaped per the Prometheus text format. */
function renderLabels(labels: Record<string, string> | undefined): string {
  if (labels === undefined) return "";
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${esc(labels[k]!)}"`).join(",")}}`;
}

/** Escape a Prometheus label value (`\`, `"`, newline — the text-format escape set). */
function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
