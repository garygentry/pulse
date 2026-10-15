// packages/web-data/src/wire/host-liveness.ts — the one host-liveness rule (issues #69, #72).
//
// A host is alive when `up` of its MAIN scrape job is 1, and nothing else counts. That is the
// series the `HostDown` rule reads for every class in the table below
// (`up{job=~"managed-linux|nas-api|hypervisor-api"} == 0`,
// stack/compose/config/vmalert/rules/availability.yml, issue #74), the series the liveness history query
// selects (queries/binding.ts), and the series the live overview and estate folds key on
// (cycle/fold-overview.ts, cycle/fold-estate.ts, and the server's snapshot/liveness.ts). Keeping
// the rule here, in the browser-safe `/wire` graph, lets the client drawer ask the same question
// (does this host have a liveness series at all?) without importing the server query builders.
//
// What does NOT count as host liveness:
//  - an auxiliary exporter's `up` on the same host (cadvisor, process-exporter, the heartbeat,
//    prober, command or custom exporters): each has its own job, so its state never stands in
//    for the host;
//  - `pulse_agent_up`, the agent heartbeat. It reports 1 while the per-host heartbeat exporter
//    process answers its scrape and is simply absent otherwise, so it can never show a host down,
//    and a heartbeat that answers while node_exporter does not is exactly the case `HostDown`
//    fires for. It is the agent's own health, not the host's.
//
// The "host liveness contract" block in packages/web-data/tests/queries/series-identity-contract.test.ts
// pins the live folds, the history query and the HostDown expression to this table: the rule's job
// set must equal this table's values, so widening one without the other fails the test.

/**
 * The scrape job whose `up` is a host's liveness, by collection class. probe-only hosts are
 * covered by Gatus (`host:<name>`) rather than a VM job, and excluded hosts have no signal, so
 * neither has an entry.
 */
export const HOST_LIVENESS_JOB: Readonly<Record<string, string>> = Object.freeze({
  "managed-linux": "managed-linux",
  "nas-api": "nas-api",
  "hypervisor-api": "hypervisor-api",
});

/** The main liveness job for a host collection class, or null when the class has no VM liveness job. */
export function hostLivenessJob(collectionClass: string): string | null {
  return Object.hasOwn(HOST_LIVENESS_JOB, collectionClass) ? HOST_LIVENESS_JOB[collectionClass]! : null;
}

/**
 * True when one instant sample is the affirmative liveness of host `hostName` of class
 * `collectionClass`: `up` of the host's main job, carrying the host's `host` label, with value 1.
 * Every estate scrape job keeps the rendered file_sd `host` label, so `host` identifies the host
 * for every class, including hypervisor-api whose `instance` is the rendered API URL.
 *
 * @param name - The sample's metric name (`__name__`, or the projection the source assigned).
 * @param labels - The sample's labels (without `__name__`).
 */
export function isHostLivenessSample(
  collectionClass: string,
  hostName: string,
  name: string,
  labels: Readonly<Record<string, string | undefined>>,
  value: number | null,
): boolean {
  const job = hostLivenessJob(collectionClass);
  return job !== null && name === "up" && labels["job"] === job && labels["host"] === hostName && value === 1;
}
