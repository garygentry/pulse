// packages/renderer/src/render/scrape.ts — Prometheus `file_sd` targets per collection class
// (02 §4.1, REQ-RND-01).
//
// Managed Linux targets are split by exporter identity so `up{job="managed-linux"}` is a
// one-series-per-host node-exporter liveness signal. Every auxiliary group retains the rendered
// `host` label; stack-core promotes it to `instance` in each corresponding scrape job.
import type { EstateModel, Host } from "@pulse/core";
import { FINDING_CODES } from "@pulse/core";

import { compareString, COLLECTION_CLASSES } from "../order.js";
import { toCanonicalJson } from "../format.js";
import type { EmitResult } from "./emit-result.js";
import { renderSecretRef } from "./secrets.js";
import type { CredentialSite } from "./secrets.js";

/** Fixed per-host bundle scrape ports (host-agent contract, 03 §8). Re-declared locally because
 *  the renderer does not import `agent/` (CON-06). */
const NODE_EXPORTER_PORT = 9100;
const CADVISOR_PORT = 8080;
const HEARTBEAT_PORT = 9110;
const PROBER_PORT = 9120;
const COMMAND_EXPORTER_PORT = 9130;
/** Conventional process-exporter port used by the current estate contract. */
const PROCESS_EXPORTER_PORT = 9256;

/** Managed-host file_sd identities, in deterministic emission order. */
const MANAGED_SCRAPE_GROUPS = [
  "managed-linux",
  "cadvisor",
  "process-exporter",
  "managed-linux-heartbeat",
  "managed-linux-prober",
  "managed-linux-command-exporter",
  "managed-linux-exporters",
] as const;
type ManagedScrapeGroup = (typeof MANAGED_SCRAPE_GROUPS)[number];


/** One Prometheus `file_sd` entry: a target group with a fixed label set. */
export interface FileSdEntry {
  /** Scrape targets (`host:port` or bare address), sorted (raw code-point). */
  targets: string[];
  /** Fixed labels attached to every target in this group; keys emitted in fixed order. */
  labels: Record<string, string>;
}

/** A renderer invariant that should be impossible on a validated model. */
export class RenderInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderInvariantError";
    Object.setPrototypeOf(this, RenderInvariantError.prototype);
  }
}

function assertNever(x: never): never {
  throw new RenderInvariantError(
    `unhandled collection class: ${JSON.stringify((x as { collectionClass?: unknown }).collectionClass)}`,
  );
}

/**
 * Emit deterministic Prometheus file_sd files. Non-managed classes retain the v1 one-file-per-class
 * mapping. Managed Linux emits node-exporter separately from every auxiliary exporter class so a
 * failed auxiliary scrape cannot trigger HostDown.
 */
export function emitScrape(model: EstateModel): EmitResult {
  const findings: EmitResult["findings"] = [];
  const groups = new Map<string, FileSdEntry[]>();

  const commandExporterHosts = new Set<string>();
  for (const host of model.hosts) {
    if (host.collectionClass === "managed-linux" && host.commandSignals.length > 0) {
      commandExporterHosts.add(host.name);
    }
  }
  for (const service of model.services) {
    if (service.backupFreshness?.command !== undefined) commandExporterHosts.add(service.host);
  }

  const perHostProberHosts = new Set<string>();
  for (const service of model.services) {
    if (service.deepHealth?.hostLocal === true) perHostProberHosts.add(service.host);
  }

  for (const host of model.hosts) {
    try {
      if (host.collectionClass === "managed-linux") {
        for (const [group, entry] of managedHostEntries(
          host,
          commandExporterHosts,
          perHostProberHosts,
        )) {
          addEntry(groups, group, entry);
        }
        continue;
      }

      const entry = nonManagedHostEntry(host, findings);
      if (entry !== null) addEntry(groups, host.collectionClass, entry);
    } catch (err) {
      if (err instanceof RenderInvariantError) {
        findings.push({
          severity: "error",
          code: FINDING_CODES.INVALID_ENUM,
          file: host.provenance.file,
          path: host.name,
          message: `Host "${host.name}" has an unsupported collection class; the renderer cannot emit a scrape target for it.`,
          fix: "Use one of the supported collection classes (managed-linux, hypervisor-api, nas-api, probe-only, excluded).",
        });
        continue;
      }
      throw err;
    }
  }

  const files: EmitResult["files"] = [];
  const emissionOrder = [
    ...MANAGED_SCRAPE_GROUPS,
    ...COLLECTION_CLASSES.filter(
      (value) => value !== "managed-linux" && value !== "excluded",
    ),
  ];
  for (const groupName of emissionOrder) {
    const entries = groups.get(groupName);
    if (entries === undefined || entries.length === 0) continue;
    entries.sort(
      (a, b) =>
        compareString(a.labels.host ?? "", b.labels.host ?? "") ||
        compareString(a.targets[0] ?? "", b.targets[0] ?? ""),
    );
    files.push({
      path: `scrape/file_sd/${groupName}.json`,
      contents: toCanonicalJson(entries),
    });
  }

  return { files, findings };
}

function addEntry(groups: Map<string, FileSdEntry[]>, group: string, entry: FileSdEntry): void {
  const entries = groups.get(group);
  if (entries === undefined) groups.set(group, [entry]);
  else entries.push(entry);
}

/** Build one target per managed exporter identity for one host. */
function managedHostEntries(
  host: Extract<Host, { collectionClass: "managed-linux" }>,
  commandExporterHosts: Set<string>,
  perHostProberHosts: Set<string>,
): [ManagedScrapeGroup, FileSdEntry][] {
  const address = host.addresses[0]!;
  const labels = commonLabels(host);
  // node-exporter (:9100) is the only unconditional target — HostDown reads
  // up{job="managed-linux"} (issue #30). Every other bundle member, heartbeat now included, is gated.
  const entries: [ManagedScrapeGroup, FileSdEntry][] = [
    ["managed-linux", singleTarget(address, NODE_EXPORTER_PORT, labels)],
  ];

  if (host.heartbeat) {
    entries.push(["managed-linux-heartbeat", singleTarget(address, HEARTBEAT_PORT, labels)]);
  }
  if (host.cadvisor) {
    entries.push(["cadvisor", singleTarget(address, CADVISOR_PORT, labels)]);
  }
  if (host.exporterPorts.includes(PROCESS_EXPORTER_PORT)) {
    entries.push(["process-exporter", singleTarget(address, PROCESS_EXPORTER_PORT, labels)]);
  }
  if (perHostProberHosts.has(host.name)) {
    entries.push(["managed-linux-prober", singleTarget(address, PROBER_PORT, labels)]);
  }
  if (commandExporterHosts.has(host.name)) {
    entries.push([
      "managed-linux-command-exporter",
      singleTarget(address, COMMAND_EXPORTER_PORT, labels),
    ]);
  }

  const customPorts = [...new Set(host.exporterPorts)]
    .filter(
      (port) =>
        !isDedicatedManagedPort(
          port,
          host,
          commandExporterHosts,
          perHostProberHosts,
        ),
    )
    .sort((a, b) => a - b);
  for (const port of customPorts) {
    entries.push([
      "managed-linux-exporters",
      {
        targets: [`${address}:${port}`],
        // Arbitrary exporter ports have no semantic class in the v1 model. Preserve host identity
        // while distinguishing their `up` series from one another.
        labels: { ...labels, exporter_port: String(port) },
      },
    ]);
  }

  return entries;
}

/** Deduplicate a declared port only when its dedicated scrape target is actually emitted. */
function isDedicatedManagedPort(
  port: number,
  host: Extract<Host, { collectionClass: "managed-linux" }>,
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

function singleTarget(
  address: string,
  port: number,
  labels: Record<string, string>,
): FileSdEntry {
  return { targets: [`${address}:${port}`], labels: { ...labels } };
}

/** Build the file_sd entry for a non-managed host. */
function nonManagedHostEntry(
  host: Exclude<Host, { collectionClass: "managed-linux" }>,
  findings: EmitResult["findings"],
): FileSdEntry | null {
  switch (host.collectionClass) {
    case "hypervisor-api": {
      const labels = commonLabels(host);
      const site: CredentialSite = {
        file: `scrape/file_sd/${host.collectionClass}.json`,
        path: `${host.name}.credential`,
      };
      const secret = renderSecretRef(host.credential, site);
      if (secret.ok) labels.__pulse_credential__ = secret.ref;
      else findings.push(secret.finding);
      return { targets: [host.apiEndpoint], labels };
    }
    case "nas-api":
      return {
        targets: [`${host.addresses[0]}:${NODE_EXPORTER_PORT}`],
        labels: commonLabels(host),
      };
    case "probe-only": {
      const labels = commonLabels(host);
      labels.__pulse_probe_kind__ = host.probe.kind;
      return { targets: [host.probe.target], labels };
    }
    case "excluded":
      return null;
    default:
      return assertNever(host);
  }
}

/** The common label set every group carries: host identity + its collection class. */
function commonLabels(host: Host): Record<string, string> {
  return { host: host.name, collection_class: host.collectionClass };
}
