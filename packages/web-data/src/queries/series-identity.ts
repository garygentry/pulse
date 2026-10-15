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
 * SILENTLY at runtime to `"address"`, which is what Prometheus does when no relabel rule writes
 * `instance`. Nothing checks the table against the live scrape config at runtime: the guard is
 * `tests/queries/series-identity-contract.test.ts`, which fails when a `scrape.yml` job is added,
 * removed or relabeled differently without updating this table.
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

/**
 * The scrape job whose `up` is a host's liveness, by collection class, and its helpers. Defined in
 * the browser-safe `wire/host-liveness.ts` (so the client drawer shares it) and re-exported here
 * for the server query modules. It matches the HostDown rule.
 */
export { HOST_LIVENESS_JOB, hostLivenessJob, isHostLivenessSample } from "../wire/host-liveness.js";

/**
 * The scrape jobs that scrape node_exporter directly (managed-linux :9100, and nas-api, which
 * TrueNAS serves as a direct node_exporter scrape). The host CPU/memory/disk/load queries read
 * `node_*` series, so they apply only to hosts with one of these jobs; a hypervisor-api host is
 * scraped through pve-exporter and has no `node_*` series.
 */
export const NODE_EXPORTER_JOBS: ReadonlySet<string> = new Set(["managed-linux", "nas-api"]);

/**
 * The stack's own static scrape jobs in `scrape.yml` (engine self-observability, the central
 * prober and the web app). They are expected on every stack and are never estate targets, so the
 * declared-versus-scraped comparison classifies them as `engine`, not `unexpected`.
 */
export const ENGINE_SCRAPE_JOBS: ReadonlySet<string> = new Set([
  "victoriametrics",
  "vmalert",
  "alertmanager",
  "gatus",
  "pve-exporter",
  "engine-cadvisor",
  "prober",
  "web",
]);

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
  return { job: target.job, instance: scrapeInstanceSource(target.job) === "host" ? hostName : target.instance };
}

/** Where `job`'s stored `instance` comes from; an unknown job falls back to `"address"`. */
export function scrapeInstanceSource(job: string): ScrapeInstanceSource {
  return Object.hasOwn(ESTATE_SCRAPE_INSTANCE_SOURCE, job) ? ESTATE_SCRAPE_INSTANCE_SOURCE[job]! : "address";
}
