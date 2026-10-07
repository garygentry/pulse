// packages/renderer/src/render/artifact-index.ts — the shared estate→artifact index (02 §3.4, 8).
//
// The SINGLE source of truth for "which rendered artifact(s), scrape identities, and Gatus
// endpoints relate to a given declared entity". Two callers import it: the emitters (02 §4) and
// `computeCoverage` (04 §3.2). Sharing one map is what makes REQ-COV-03/REQ-MODEL-12 structurally
// true — render, coverage, and the web model can never disagree about what is monitored. The v1
// artifact mapping table here MUST stay byte-identical to the emitters; scrape/Gatus identities are
// derived from the SAME rules used by scrape.ts and gatus.ts (02 §8.2), never by parsing a tree.
import type { EstateModel, Host } from "@pulse/core";
import { compareString } from "../order.js";
import { perHostProberPath } from "./prober.js";
import { RenderInvariantError } from "./scrape.js";
import type { WebScrapeTarget } from "./web-model.js";

const CADVISOR_PORT = 8080;
const NODE_EXPORTER_PORT = 9100;
const HEARTBEAT_PORT = 9110;
const PROBER_PORT = 9120;
const COMMAND_EXPORTER_PORT = 9130;
const PROCESS_EXPORTER_PORT = 9256;

/** Relationships for one declared host (02 §8.1). Every declared host receives an entry. */
export interface HostArtifactRelationships {
  /** Concrete rendered-root-relative artifact paths, raw code-point sorted and deduplicated. */
  artifacts: string[];
  /** Concrete Prometheus identities, sorted by `(job, instance)` and deduplicated. */
  scrapeTargets: WebScrapeTarget[];
}

/** Relationships for one declared service (02 §8.1). Every declared service receives an entry. */
export interface ServiceArtifactRelationships {
  /** Concrete rendered-root-relative artifact paths, raw code-point sorted and deduplicated. */
  artifacts: string[];
  /** Concrete Gatus endpoint names, raw code-point sorted and deduplicated. */
  gatusEndpoints: string[];
}

/**
 * The estate→artifact index: for each declared entity, the tree-relative rendered-artifact paths,
 * scrape identities, and Gatus endpoints that monitor it. Keys are entity identities; every declared
 * entity receives an entry (with empty relationship arrays where it maps to nothing, 02 §8.1).
 */
export interface ArtifactIndex {
  /** host `name` → complete host relationships. */
  hosts: Map<string, HostArtifactRelationships>;
  /** `"<host>/<service>"` → complete service relationships. */
  services: Map<string, ServiceArtifactRelationships>;
}

/**
 * Build the estate→artifact index from a validated model — the SAME mapping the emitters (02 §4)
 * render from, plus the concrete scrape identities of scrape.ts and Gatus endpoint names of
 * gatus.ts (02 §8.2). Pure, deterministic, no I/O. Set-like values are deduped and sorted
 * (`compareString`); scrape targets by `(job, instance)`. Estate-level artifacts
 * (`alertmanager/routing.yaml`, per-`domain` DNS endpoints, `web-estate-model.json`, the manifest)
 * are NOT entity edges and never appear here (02 §8.3).
 *
 * @param model - A validated `EstateModel` (REQ-VAL-02).
 * @returns The `ArtifactIndex` (shared by the coordinated emitter with `computeCoverage`, 04 §3.1).
 */
export function buildArtifactIndex(model: EstateModel): ArtifactIndex {
  // Conditional managed-host exporters are derived from service declarations as well as hosts,
  // exactly as scrape.ts derives them (02 §8.2).
  const perHostProberHosts = new Set<string>();
  const commandExporterHosts = new Set<string>();
  for (const host of model.hosts) {
    if (host.collectionClass === "managed-linux" && host.commandSignals.length > 0) {
      commandExporterHosts.add(host.name);
    }
  }
  for (const service of model.services) {
    if (service.deepHealth?.hostLocal === true) perHostProberHosts.add(service.host);
    if (service.backupFreshness?.command !== undefined) commandExporterHosts.add(service.host);
  }

  const hosts = new Map<string, HostArtifactRelationships>();
  for (const host of model.hosts) {
    hosts.set(host.name, {
      artifacts: hostArtifacts(host, perHostProberHosts, commandExporterHosts),
      scrapeTargets: hostScrapeTargets(host, perHostProberHosts, commandExporterHosts),
    });
  }

  const services = new Map<string, ServiceArtifactRelationships>();
  for (const service of model.services) {
    const key = `${service.host}/${service.name}`;
    services.set(key, {
      artifacts: serviceArtifacts(service),
      gatusEndpoints: serviceGatusEndpoints(service),
    });
  }

  return { hosts, services };
}

/** A declared port is custom unless its corresponding dedicated scrape target is present. */
function isDedicatedManagedPort(
  port: number,
  host: Extract<EstateModel["hosts"][number], { collectionClass: "managed-linux" }>,
  commandExporterHosts: Set<string>,
  perHostProberHosts: Set<string>,
): boolean {
  if (port === NODE_EXPORTER_PORT || port === PROCESS_EXPORTER_PORT) {
    return true;
  }
  if (port === HEARTBEAT_PORT) return host.heartbeat;
  if (port === CADVISOR_PORT) return host.cadvisor;
  if (port === PROBER_PORT) return perHostProberHosts.has(host.name);
  if (port === COMMAND_EXPORTER_PORT) return commandExporterHosts.has(host.name);
  return false;
}

/** The artifact paths for a host, keyed on its collection class (02 §3.4). A `managed-linux` host
 *  additionally owns its per-host agent bundle config `agent/<name>.yaml` (05 §4.1, emitAgent), and
 *  — iff it declares ≥1 command signal — its `command-exporter/<name>.yaml` config (issue #3/#1). */
function hostArtifacts(
  host: Host,
  perHostProberHosts: Set<string>,
  commandExporterHosts: Set<string>,
): string[] {
  const { name, collectionClass } = host;
  switch (collectionClass) {
    case "managed-linux": {
      const paths = ["scrape/file_sd/managed-linux.json", `agent/${name}.yaml`];
      // Heartbeat target is owned only when the host opts in (issue #30).
      if (host.heartbeat) paths.push("scrape/file_sd/managed-linux-heartbeat.json");
      if (host.cadvisor) paths.push("scrape/file_sd/cadvisor.json");
      if (host.exporterPorts.includes(PROCESS_EXPORTER_PORT)) {
        paths.push("scrape/file_sd/process-exporter.json");
      }
      if (
        host.exporterPorts.some(
          (port) =>
            !isDedicatedManagedPort(
              port,
              host,
              commandExporterHosts,
              perHostProberHosts,
            ),
        )
      ) {
        paths.push("scrape/file_sd/managed-linux-exporters.json");
      }
      if (commandExporterHosts.has(name)) {
        paths.push("scrape/file_sd/managed-linux-command-exporter.json");
      }
      if (host.commandSignals.length > 0) paths.push(`command-exporter/${name}.yaml`);
      if (perHostProberHosts.has(name)) {
        paths.push("scrape/file_sd/managed-linux-prober.json", perHostProberPath(name));
      }
      return sortDedupe(paths);
    }
    case "hypervisor-api":
    case "nas-api":
      return [`scrape/file_sd/${collectionClass}.json`];
    case "probe-only":
      // A probe-only host maps to THREE files: its class file_sd, a prober declaration, and a
      // gatus reachability check (02 §3.4). Sorted for determinism.
      return sortDedupe([
        "scrape/file_sd/probe-only.json",
        "prober/config.yaml",
        "gatus/config.yaml",
      ]);
    case "excluded":
      return []; // `excluded` contributes no target — routed to `suppressed` by coverage.
    default:
      return [];
  }
}

/**
 * The concrete Prometheus scrape identities for a host, derived from the SAME branches and target
 * strings scrape.ts emits (02 §8.2). `job` is the file-SD group name; `instance` is the exact
 * emitted target string (including port where emitted), before Prometheus relabeling. An `excluded`
 * host — and any unknown class — has no scrape target. A missing first address on a purportedly
 * validated managed/NAS host, or an empty hypervisor endpoint / probe target, is a fatal invariant:
 * we throw rather than emit an empty `instance` string (02 §8.2, REQ-REL-03).
 */
function hostScrapeTargets(
  host: Host,
  perHostProberHosts: Set<string>,
  commandExporterHosts: Set<string>,
): WebScrapeTarget[] {
  const targets: WebScrapeTarget[] = [];
  switch (host.collectionClass) {
    case "managed-linux": {
      const address = firstAddress(host);
      // node-exporter (:9100) is the only unconditional target; every other bundle member is gated
      // exactly as scrape.ts gates it.
      targets.push({ job: "managed-linux", instance: `${address}:${NODE_EXPORTER_PORT}` });
      if (host.heartbeat) {
        targets.push({ job: "managed-linux-heartbeat", instance: `${address}:${HEARTBEAT_PORT}` });
      }
      if (host.cadvisor) {
        targets.push({ job: "cadvisor", instance: `${address}:${CADVISOR_PORT}` });
      }
      if (host.exporterPorts.includes(PROCESS_EXPORTER_PORT)) {
        targets.push({
          job: "process-exporter",
          instance: `${address}:${PROCESS_EXPORTER_PORT}`,
        });
      }
      if (perHostProberHosts.has(host.name)) {
        targets.push({ job: "managed-linux-prober", instance: `${address}:${PROBER_PORT}` });
      }
      if (commandExporterHosts.has(host.name)) {
        targets.push({
          job: "managed-linux-command-exporter",
          instance: `${address}:${COMMAND_EXPORTER_PORT}`,
        });
      }
      const customPorts = [...new Set(host.exporterPorts)]
        .filter(
          (port) =>
            !isDedicatedManagedPort(port, host, commandExporterHosts, perHostProberHosts),
        )
        .sort((a, b) => a - b);
      for (const port of customPorts) {
        targets.push({ job: "managed-linux-exporters", instance: `${address}:${port}` });
      }
      break;
    }
    case "hypervisor-api":
      // scrape.ts targets the raw apiEndpoint for a hypervisor host.
      targets.push({
        job: "hypervisor-api",
        instance: requireNonEmpty(host.apiEndpoint, host, "apiEndpoint"),
      });
      break;
    case "nas-api":
      // scrape.ts renders a nas-api host as a DIRECT node_exporter scrape on its first address.
      targets.push({ job: "nas-api", instance: `${firstAddress(host)}:${NODE_EXPORTER_PORT}` });
      break;
    case "probe-only":
      targets.push({
        job: "probe-only",
        instance: requireNonEmpty(host.probe.target, host, "probe.target"),
      });
      break;
    case "excluded":
      break; // `excluded` hosts have no scrape target (02 §8.2).
    default:
      break; // an unknown class emits no scrape target (routed to gaps by coverage).
  }
  return sortDedupeTargets(targets);
}

/** The artifact paths for a service, keyed on its declared conditions (02 §3.4). */
function serviceArtifacts(service: EstateModel["services"][number]): string[] {
  const paths: string[] = [];
  if (service.ingressUrl !== undefined) paths.push("gatus/config.yaml");
  if (service.deepHealth !== undefined) {
    // A host-local deep-health probe is monitored by the PER-HOST prober config (issue #8); a
    // central probe by the shared prober/config.yaml.
    paths.push(
      service.deepHealth.hostLocal === true
        ? perHostProberPath(service.host)
        : "prober/config.yaml",
    );
  }
  if (service.backupFreshness !== undefined) paths.push("prober/config.yaml");
  // A backup service that declares a delivery `command` is ALSO monitored by the command-exporter
  // config on its host — that is where its freshness metric is actually produced (issue #3).
  if (service.backupFreshness?.command !== undefined) {
    paths.push(`command-exporter/${service.host}.yaml`);
  }
  // deepHealth + backupFreshness both map to prober/config.yaml — dedupe.
  return sortDedupe(paths);
}

/**
 * The concrete Gatus endpoint names for a service, derived from the SAME condition gatus.ts emits
 * (02 §8.2): a non-suppressed service with an `ingressUrl` has the endpoint `"<host>/<service>"`;
 * otherwise the service has no Gatus endpoint. Deep-health and backup checks contribute artifacts
 * but are NOT Gatus endpoints, and host-level probe / estate DNS endpoints are not service edges.
 */
function serviceGatusEndpoints(service: EstateModel["services"][number]): string[] {
  if (service.ingressUrl === undefined || service.suppressed !== undefined) return [];
  return [`${service.host}/${service.name}`];
}

/** Return a new list of `paths` deduped and sorted by raw code point (`compareString`). */
function sortDedupe(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(compareString);
}

/** Return a new list of scrape targets deduped by `(job, instance)` and sorted by `(job, instance)`
 *  (raw code point). U+0000 frames the dedupe key only; it never reaches output. */
function sortDedupeTargets(targets: readonly WebScrapeTarget[]): WebScrapeTarget[] {
  const seen = new Set<string>();
  const unique: WebScrapeTarget[] = [];
  for (const target of targets) {
    const key = `${target.job} ${target.instance}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  unique.sort(
    (a, b) => compareString(a.job, b.job) || compareString(a.instance, b.instance),
  );
  return unique;
}

/** The host's first declared address, or a fatal invariant when a validated model somehow lacks it
 *  (scrape.ts asserts the same non-null address; we refuse to emit an empty `instance`, 02 §8.2). */
function firstAddress(host: Host): string {
  const address = host.addresses[0];
  if (address === undefined || address === "") {
    throw new RenderInvariantError(
      `Host "${host.name}" has no address; the renderer cannot construct a scrape target for it.`,
    );
  }
  return address;
}

/** Guard a required non-empty target component, refusing to emit an empty `instance` (02 §8.2). */
function requireNonEmpty(value: string, host: Host, field: string): string {
  if (value === "") {
    throw new RenderInvariantError(
      `Host "${host.name}" has an empty ${field}; the renderer cannot construct a scrape target for it.`,
    );
  }
  return value;
}
