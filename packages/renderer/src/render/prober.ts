// packages/renderer/src/render/prober.ts — deep-health / backup-freshness / reachability prober
// declarations (02 §4.4, REQ-RND-01).
//
// Emits `prober/config.yaml` (the CENTRAL prober) of DECLARATIONS ONLY, derived from service
// `deepHealth` probes, service `backupFreshness` specs, and `probe-only` host probes. It carries the
// probe vocabulary core already captured — it never executes or evaluates a probe (REQ-SEC-01), and
// `alertExpression`/`threshold` are OPAQUE pass-throughs (the alerting semantics are downstream,
// REQ-RND-08).
//
// PER-HOST probers (issue #8): a deep-health probe marked `hostLocal` targets a loopback/bridge-local
// endpoint the central prober (a container elsewhere) cannot reach. Such probes are routed OUT of the
// central config into a per-host `agent/<host>/prober/config.yaml` — the SAME `{ probes: [...] }`
// shape, consumed by a prober that runs ON that host under network_mode: host (agent bundle). The
// central prober keeps every non-host-local probe unchanged.
//
// Emits NO central file when no central probe of any kind is declared, and NO per-host file for a
// host with no host-local probe (an empty prober config is meaningless) — the tree omits the file and
// the manifest reflects that.
import type { EstateModel } from "@pulse/core";

import { compareString } from "../order.js";
import { toCanonicalYaml } from "../format.js";
import type { EmitResult } from "./emit-result.js";
import { renderSecretRef } from "./secrets.js";
import type { CredentialSite } from "./secrets.js";

/** One deep-health / backup-freshness / reachability prober declaration. */
export interface ProberEntry {
  /** Stable name: `"svc:<host>/<service>"`, `"svc:<host>/<service>#backup"`, or `"host:<name>"`. */
  name: string;
  /** Probe endpoint/target/signal (`DeepHealthProbe.endpoint`, `BackupFreshness.signal`, or `ProbeSpec.target`). */
  target: string;
  /** Probe kind: `"deep-health"`, `"backup-freshness"`, or a host `ProbeSpec.kind`. */
  kind: string;
  /** Response mapping (JSON-path → metric) for a deep-health probe; omitted otherwise. */
  responseMapping?: Record<string, string>;
  /** The declared alert expression for a deep-health probe (opaque); omitted otherwise. */
  alertExpression?: string;
  /**
   * The credential REFERENCE string for an authenticated deep-health probe (`SecretRef.raw`,
   * e.g. `${TOKEN}` or `op://vault/item/field`); omitted when absent or refused as a literal.
   */
  credential?: string;
  /** The declared freshness threshold for a backup-freshness probe (opaque); omitted otherwise. */
  threshold?: string;
  /** A probe-only host's `ProbeSpec.expect`, carried through when present; omitted otherwise. */
  note?: string;
}

/** The tree-relative path of a host's per-host prober config (issue #8). Kept as a helper so the
 *  emitter, the artifact index, and the CLI `kindOfPath` agree on the one layout. */
export function perHostProberPath(host: string): string {
  return `agent/${host}/prober/config.yaml`;
}

/**
 * Emit prober configs of `{ probes: ProberEntry[] }` — one `ProberEntry` per declared probe
 * (REQ-RND-01): a service `deepHealth` → a `deep-health` entry; a service `backupFreshness` → a
 * `backup-freshness` entry (`#backup` name suffix, so a service declaring BOTH yields TWO entries);
 * a `probe-only` host → a reachability entry keyed on its `ProbeSpec.kind`. `alertExpression` and
 * `threshold` pass through verbatim as opaque declarations.
 *
 * A deep-health probe marked `hostLocal` (issue #8) is routed to a PER-HOST config at
 * `agent/<host>/prober/config.yaml` (grouped by the service's host) instead of the central
 * `prober/config.yaml`; every other probe stays central. Entries are sorted by `name` (raw
 * code-point) within each file, and files by path. An authenticated deep-health probe's `credential`
 * flows through the shared `renderSecretRef` choke point (02 §7): a valid `SecretRef` emits only its
 * raw reference string; a non-`SecretRef` literal is REFUSED — the field is omitted and a
 * `SECRET_LITERAL` finding is appended for the OWNING file (central or per-host; defense-in-depth,
 * REQ-RND-09/REQ-SEC-02). Returns `{ files: [], findings: [] }` when the estate declares no probe.
 *
 * @param model - The validated estate.
 * @returns The central `prober/config.yaml` (if any central probe) plus one
 *   `agent/<host>/prober/config.yaml` per host with a host-local probe; a `SECRET_LITERAL` finding
 *   per refused deep-health credential literal, else no findings.
 */
export function emitProber(model: EstateModel): EmitResult {
  const central: ProberEntry[] = [];
  // hostName → host-local deep-health entries (issue #8), in declaration order pre-sort.
  const byHost = new Map<string, ProberEntry[]>();
  const findings: EmitResult["findings"] = [];

  for (const service of model.services) {
    if (service.deepHealth !== undefined) {
      const name = `svc:${service.host}/${service.name}`;
      const hostLocal = service.deepHealth.hostLocal === true;
      const file = hostLocal ? perHostProberPath(service.host) : "prober/config.yaml";
      const entry: ProberEntry = {
        name,
        target: service.deepHealth.endpoint,
        kind: "deep-health",
        responseMapping: service.deepHealth.responseMapping,
        alertExpression: service.deepHealth.alertExpression,
      };
      // Authenticated deep-health probes carry a credential through the secret choke point
      // (02 §7): emit only the raw reference; refuse a literal with a precise finding. The site
      // names the OWNING file so a refusal points at the right config.
      if (service.deepHealth.credential !== undefined) {
        const site: CredentialSite = { file, path: `${name}.credential` };
        const secret = renderSecretRef(service.deepHealth.credential, site);
        if (secret.ok) entry.credential = secret.ref;
        else findings.push(secret.finding); // omit the key; never emit a literal (02 §7).
      }
      if (hostLocal) {
        const list = byHost.get(service.host);
        if (list === undefined) byHost.set(service.host, [entry]);
        else list.push(entry);
      } else {
        central.push(entry);
      }
    }
    if (service.backupFreshness !== undefined) {
      central.push({
        name: `svc:${service.host}/${service.name}#backup`,
        target: service.backupFreshness.signal,
        kind: "backup-freshness",
        threshold: service.backupFreshness.threshold,
      });
    }
  }

  for (const host of model.hosts) {
    if (host.collectionClass !== "probe-only") continue;
    const { probe } = host;
    central.push({
      name: `host:${host.name}`,
      target: probe.target,
      kind: probe.kind,
      // `expect` is optional; omit the key entirely when absent (exactOptionalPropertyTypes).
      ...(probe.expect !== undefined ? { note: probe.expect } : {}),
    });
  }

  const files: EmitResult["files"] = [];
  if (central.length > 0) {
    central.sort((a, b) => compareString(a.name, b.name));
    files.push({ path: "prober/config.yaml", contents: toCanonicalYaml({ probes: central }) });
  }
  for (const [host, entries] of byHost) {
    entries.sort((a, b) => compareString(a.name, b.name));
    files.push({ path: perHostProberPath(host), contents: toCanonicalYaml({ probes: entries }) });
  }
  // The pipeline's final path-sort is authoritative; sort here too so the fragment is self-consistent.
  files.sort((a, b) => compareString(a.path, b.path));
  return { files, findings };
}
