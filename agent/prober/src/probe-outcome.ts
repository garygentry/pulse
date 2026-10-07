// agent/prober/src/probe-outcome.ts
//
// The ProbeOutcome result type (00-core-definitions.md §7). Its own module so both
// probe.ts (producer) and metrics.ts (consumer) can import it without a cycle.

import type { ProbeExecutionError } from "./errors.js";

/** The outcome of one probe cycle for one service. A discriminated union: on success the
 *  mapped samples are emitted and `up=1`; on failure only `up=0` is emitted and the value
 *  series are NOT refreshed (REQ-PROBE-04, tech-spec §3.4). */
export type ProbeOutcome =
  | {
      ok: true;
      host: string;
      service: string;
      /** metricName → numeric value, from responseMapping evaluation. */
      samples: Record<string, number>;
      /** Unix seconds of this successful probe (drives pulse_deep_health_last_scrape_seconds). */
      scrapedAt: number;
    }
  | {
      ok: false;
      host: string;
      service: string;
      /** Why it failed (for logs/observability only; the metric state is `up=0`). */
      error: ProbeExecutionError;
    };
