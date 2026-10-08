// packages/renderer/src/render/gatus.ts — Gatus endpoint/check config (02 §4.2, REQ-RND-01).
//
// Emits exactly one `gatus/config.yaml` (possibly with an empty `endpoints:` list) so the tree
// shape is stable across estates (REQ-DET-01). Endpoints are derived from service ingress URLs,
// probe-only host probes (by `probe.kind`), and estate domains. No credentials → no findings.
import type { EstateModel, Host, Service } from "@pulse/core";

import { compareString } from "../order.js";
import { toCanonicalYaml } from "../format.js";
import type { EmitResult } from "./emit-result.js";

/** One Gatus endpoint (check) declaration. Fields map to Gatus's endpoint schema. */
export interface GatusEndpoint {
  /** Stable, human-readable check name, e.g. `"web01/grafana"` or `"host:web01"`. */
  name: string;
  /** The URL/target the check probes: HTTPS ingress, `tcp://host:port`, or — for a DNS
   *  endpoint — the resolver the query is sent to. */
  url: string;
  /** Logical group for the Gatus UI (the owning host); omitted for a bare DNS endpoint. */
  group?: string;
  /** DNS query parameters (Gatus `dns:` block); present only on a per-domain DNS endpoint. */
  dns?: { "query-name": string; "query-type": string };
  /** Ordered condition expressions (Gatus `conditions`). Gatus requires at least one condition
   *  per endpoint, so every emitted endpoint declares this. No `alerts:` block is ever emitted:
   *  Gatus checks page through vmalert rules over Gatus's own metrics (issue #1), not a Gatus
   *  alerting provider. */
  conditions?: string[];
}

/**
 * The Gatus endpoint name for a service's ingress check: `<host>/<service>`. Single source of
 * truth shared with `stack/alerting` (the synthetic-check rules select `gatus_results_total` by
 * this `name` label), so the check and the rule that pages on it can never drift apart.
 */
export function gatusEndpointName(service: Pick<Service, "host" | "name">): string {
  return `${service.host}/${service.name}`;
}

/** Compatibility default for DNS checks when an estate does not declare `dnsResolver`.
 *  A concrete default keeps existing renders byte-identical and deterministic (REQ-DET-01). */
const DEFAULT_DNS_RESOLVER_URL = "1.1.1.1";

/**
 * Emit `gatus/config.yaml`: one endpoint per checkable declaration (REQ-RND-01) — a service with
 * an `ingressUrl` (unless suppressed), a `probe-only` host keyed on `probe.kind`, and one DNS
 * check per estate domain. Endpoints are sorted by `name` (raw code-point). Always emits the
 * file, even with an empty list, so the tree shape is stable (REQ-DET-01).
 *
 * @param model - The validated estate.
 * @returns Exactly one `RenderedFile` (`gatus/config.yaml`); no findings (no credentials).
 */
export function emitGatus(model: EstateModel): EmitResult {
  const endpoints: GatusEndpoint[] = [];

  // Service ingress (HTTPS). A suppressed service produces no check. A service's `alerts:`
  // binding does NOT change the endpoint: paging is a vmalert rule over this check's
  // `gatus_results_total` series, rendered by stack/alerting (issue #1).
  for (const service of model.services) {
    if (service.ingressUrl === undefined || service.suppressed !== undefined) continue;
    endpoints.push({
      name: gatusEndpointName(service),
      group: service.host,
      url: service.ingressUrl,
      conditions: ["[STATUS] == 200"],
    });
  }

  // Probe-only host reachability, keyed on `probe.kind`.
  for (const host of model.hosts) {
    if (host.collectionClass !== "probe-only") continue;
    endpoints.push(probeEndpoint(host));
  }

  // Per-domain DNS reachability endpoints (estate-scoped, keyed on `Estate.domains`). Each is a
  // Gatus DNS check: query the domain's A record against the estate override or the compatibility
  // default and require a successful RCODE. The `conditions` entry is mandatory — Gatus rejects a
  // condition-less endpoint.
  const dnsResolver = model.estate.dnsResolver ?? DEFAULT_DNS_RESOLVER_URL;
  for (const domain of model.estate.domains) {
    endpoints.push({
      name: `dns:${domain}`,
      url: dnsResolver,
      dns: { "query-name": domain, "query-type": "A" },
      conditions: ["[DNS_RCODE] == NOERROR"],
    });
  }

  endpoints.sort((a, b) => compareString(a.name, b.name));

  return {
    files: [{ path: "gatus/config.yaml", contents: toCanonicalYaml({ endpoints }) }],
    findings: [],
  };
}

/**
 * Map a `probe-only` host's `ProbeSpec` to a Gatus endpoint by `probe.kind` (02 §4.2):
 * `http` → `[STATUS] == 200` on the target; `tcp`/`icmp` → the `tcp://`/`icmp://` target form with
 * `[CONNECTED] == true`; any other kind → the transport-agnostic reachability form on the bare
 * target. `probe.kind` is an opaque core string, so unknown kinds fall through to reachability.
 */
function probeEndpoint(host: Host & { collectionClass: "probe-only" }): GatusEndpoint {
  const { probe } = host;
  const name = `host:${host.name}`;
  const group = host.name;
  switch (probe.kind) {
    case "http":
      return { name, group, url: probe.target, conditions: ["[STATUS] == 200"] };
    case "tcp":
      return { name, group, url: `tcp://${probe.target}`, conditions: ["[CONNECTED] == true"] };
    case "icmp":
      return { name, group, url: `icmp://${probe.target}`, conditions: ["[CONNECTED] == true"] };
    default:
      return { name, group, url: probe.target, conditions: ["[CONNECTED] == true"] };
  }
}
