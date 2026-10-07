// agent/prober/src/metrics.ts
//
// Fail-visible last-good state + Prometheus exposition for the deep-health prober
// (02-deep-health-prober.md §6.2/§6.3, REQ-PROBE-04, REQ-OBS-02).
//
// `MetricStore` is the ONLY in-memory state the prober holds (00 §9 — transient, nothing
// persisted). It retains the last SUCCESSFUL samples/timestamp per host/service and, on a
// later failure, flips `pulse_deep_health_up` to 0 WITHOUT refreshing the value series or the
// last-scrape timestamp. The alert expression downstream therefore sees either a stale value
// or `_up == 0` — either way the "safe-mode trap" is caught (§9). `renderExposition` produces
// deterministic Prometheus 0.0.4 text for the three deep-health families with escaped labels.

import type { ProbeOutcome } from "./probe-outcome.js";
import {
  PULSE_DEEP_HEALTH,
  PULSE_DEEP_HEALTH_UP,
  PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS,
} from "../../contract/types.js";

/** The retained per-service state feeding one exposition render. `samples`/`lastScrapeSeconds`
 *  are the LAST SUCCESSFUL values (NOT refreshed on failure — REQ-PROBE-04). `up` reflects the
 *  MOST RECENT probe (1 ok, 0 failed). */
export interface ServiceState {
  host: string;
  service: string;
  up: 0 | 1;
  /** Last successful metricName → value; empty until the first success. */
  samples: Record<string, number>;
  /** Unix seconds of the last successful probe; undefined until the first success. */
  lastScrapeSeconds?: number;
}

/**
 * Holds the last-good deep-health state across cycles and renders Prometheus exposition text.
 * A single instance lives for the process lifetime (00 §9 — transient state only).
 */
export class MetricStore {
  private readonly byKey = new Map<string, ServiceState>();
  /** Per-host prober mode (issue #8): omit the self-set `host` label from the exposition so the
   *  scrape-time file_sd `host` label owns it (this prober uses managed-linux-prober, where
   *  probing-host == target-host for a host-local probe). Central prober leaves this false and
   *  self-labels host+service, unchanged. */
  private readonly suppressHostLabel: boolean;

  constructor(options: { suppressHostLabel?: boolean } = {}) {
    this.suppressHostLabel = options.suppressHostLabel ?? false;
  }

  /**
   * Fold one cycle's outcomes into the store (REQ-PROBE-04). Success → refresh `samples`,
   * `lastScrapeSeconds`, and set `up = 1`. Failure → set `up = 0` and LEAVE
   * `samples`/`lastScrapeSeconds` untouched (fail-visible stale value + timestamp).
   *
   * @param outcomes - The outcomes from one {@link import("./probe.js").runCycle}.
   */
  record(outcomes: ProbeOutcome[]): void {
    for (const o of outcomes) {
      const key = `${o.host}/${o.service}`;
      const prev: ServiceState =
        this.byKey.get(key) ?? { host: o.host, service: o.service, up: 0, samples: {} };
      if (o.ok) {
        this.byKey.set(key, {
          ...prev,
          up: 1,
          samples: o.samples,
          lastScrapeSeconds: o.scrapedAt,
        });
      } else {
        // Value/timestamp are NOT refreshed — only `_up` flips (fail-visible).
        this.byKey.set(key, { ...prev, up: 0 });
      }
    }
  }

  /** Render the full Prometheus exposition text for all known services (§6.3). In per-host mode the
   *  `host` label is omitted (scrape-time file_sd applies it, issue #8). */
  render(): string {
    return renderExposition([...this.byKey.values()], { suppressHostLabel: this.suppressHostLabel });
  }
}

/** Deterministic comparator: order services by host, then service. */
function byHostService(a: ServiceState, b: ServiceState): number {
  if (a.host !== b.host) return a.host < b.host ? -1 : 1;
  if (a.service !== b.service) return a.service < b.service ? -1 : 1;
  return 0;
}

/**
 * Render deep-health service states to Prometheus exposition text (§6.3, tech-spec §4.2). Emits
 * the three `# TYPE` headers once, then — per service, in a deterministic (host, service) order:
 * one `pulse_deep_health{host,service,metric}` line per last-good sample (metric names sorted),
 * one `pulse_deep_health_up{host,service}` line, and (only once a successful probe has happened)
 * one `pulse_deep_health_last_scrape_seconds{host,service}` line. A never-successful service
 * therefore emits only its `_up 0` line — no value and no timestamp. Label values are escaped
 * per the Prometheus text format. Output is a valid `text/plain; version=0.0.4` body terminated
 * by a trailing newline.
 *
 * @param states - The retained per-service states.
 * @param options - `suppressHostLabel` omits the `host` label (per-host prober mode, issue #8) so
 *   the scrape-time file_sd `host` label owns it; default false (central prober self-labels).
 * @returns The exposition body.
 */
export function renderExposition(
  states: ServiceState[],
  options: { suppressHostLabel?: boolean } = {},
): string {
  const suppressHost = options.suppressHostLabel ?? false;
  const lines: string[] = [
    `# TYPE ${PULSE_DEEP_HEALTH} gauge`,
    `# TYPE ${PULSE_DEEP_HEALTH_UP} gauge`,
    `# TYPE ${PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS} gauge`,
  ];
  for (const s of [...states].sort(byHostService)) {
    const base = suppressHost
      ? `service="${esc(s.service)}"`
      : `host="${esc(s.host)}",service="${esc(s.service)}"`;
    for (const [metric, value] of Object.entries(s.samples).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      lines.push(`${PULSE_DEEP_HEALTH}{${base},metric="${esc(metric)}"} ${value}`);
    }
    lines.push(`${PULSE_DEEP_HEALTH_UP}{${base}} ${s.up}`);
    if (s.lastScrapeSeconds !== undefined) {
      lines.push(`${PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS}{${base}} ${s.lastScrapeSeconds}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Escape a Prometheus label value (`\`, `"`, newline — the text-format escape set). */
function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
