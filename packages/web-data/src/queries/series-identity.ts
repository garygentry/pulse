// packages/web-data/src/queries/series-identity.ts — the stored-series identity of a rendered
// scrape target (issue #69). The estate model's `scrapeTargets[].instance` is the target string
// the renderer emits into file_sd BEFORE VictoriaMetrics relabeling (an `address:port`, an API
// URL, or a probe target). The series VM stores carry the label set AFTER relabeling, so any
// query or comparison against stored series must translate through the scrape config first.
//
// `stack/compose/config/victoriametrics/scrape.yml` is the source of truth: every managed-host
// and nas-api job relabels the file_sd `host` label onto `instance` (the estate-wide
// `instance == host` contract that alert rules and Grafana boards rely on), while
// hypervisor-api passes the rendered target through `__param_target` back onto `instance`.
// `packages/web-data/tests/queries/series-identity-contract.test.ts` replays those relabel
// rules against this table and the rendered bundles, so the two cannot drift.

import type { WebScrapeTarget } from "@pulse/renderer";

/** Where a scrape job's stored `instance` label comes from after relabeling. */
export type ScrapeInstanceSource =
  /** `instance` is the file_sd `host` label, i.e. the estate host name. */
  | "host"
  /** `instance` is the rendered target string itself (Prometheus' default `__address__`). */
  | "address";

/**
 * Every estate (file_sd) scrape job in `scrape.yml`, mapped to how it derives `instance`.
 * A job missing from this table (for example `probe-only`, which no VM job scrapes) falls back
 * to `"address"`, which is what Prometheus does when no relabel rule writes `instance`.
 */
export const ESTATE_SCRAPE_INSTANCE_SOURCE: Readonly<Record<string, ScrapeInstanceSource>> = Object.freeze({
  "managed-linux": "host",
  cadvisor: "host",
  "process-exporter": "host",
  "managed-linux-heartbeat": "host",
  "managed-linux-prober": "host",
  "managed-linux-command-exporter": "host",
  "managed-linux-exporters": "host",
  "hypervisor-api": "address",
  "nas-api": "host",
});

/** The `job`/`instance` label pair a stored series carries for one rendered scrape target. */
export interface ScrapeSeriesIdentity {
  /** The scrape job name (`job` label). */ readonly job: string;
  /** The post-relabel `instance` label. */ readonly instance: string;
}

/**
 * Translate one rendered scrape target of host `hostName` into the `job`/`instance` labels its
 * stored series carry, applying the `scrape.yml` relabel contract.
 *
 * @param hostName - The estate host name (the file_sd `host` label the renderer emits).
 * @param target - The model's pre-relabel scrape target.
 */
export function scrapeSeriesIdentity(hostName: string, target: WebScrapeTarget): ScrapeSeriesIdentity {
  const source = Object.hasOwn(ESTATE_SCRAPE_INSTANCE_SOURCE, target.job)
    ? ESTATE_SCRAPE_INSTANCE_SOURCE[target.job]
    : "address";
  return { job: target.job, instance: source === "host" ? hostName : target.instance };
}
