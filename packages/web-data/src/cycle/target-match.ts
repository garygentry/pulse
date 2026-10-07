// packages/web-data/src/cycle/target-match.ts — pure alert/endpoint → declared-target
// matching (04-cycle-and-current-view-folds.md §§7–8). Canonical identity is the DECLARED
// name: an alert's `host`/`service` labels or a Gatus endpoint name is resolved by exact
// string equality against the captured rendered model. Unknown or ambiguous values remain
// unmatched (null); there is no fuzzy matching and no fall-back to a broader scope.
//
// The Alertmanager client's triage allowlist retains only `alertname|severity|host|
// service|instance` labels, so alert attribution uses `host`/`service` (not a raw
// `endpoint` label); Gatus attribution parses the endpoint name convention directly.

import type { TargetIdentity } from "../wire/history.js";
import type { WebEstateModelV2 } from "@pulse/renderer";

/** A candidate declared identity parsed from alert labels or an endpoint name. */
export type TargetCandidate =
  | {
      /** Service candidate discriminant. */ readonly kind: "service";
      /** Candidate owning host name. */ readonly host: string;
      /** Candidate service name. */ readonly service: string;
    }
  | {
      /** Host candidate discriminant. */ readonly kind: "host";
      /** Candidate host name. */ readonly host: string;
    }
  | null;

/** A resolved declared target: the matched host, or host+service, by exact model equality. */
export type ResolvedTarget =
  | {
      /** Host target discriminant. */ readonly kind: "host";
      /** Matched declared host name. */ readonly host: string;
    }
  | {
      /** Service target discriminant. */ readonly kind: "service";
      /** Matched declared owning host name. */ readonly host: string;
      /** Matched declared service name. */ readonly service: string;
    };

/**
 * Determine the candidate declared identity for an Alertmanager alert from its allowlisted
 * labels. `host` + `service` names a service; `host` alone names a host; neither leaves the
 * alert unattributed (estate-wide).
 *
 * @param labels - The alert's allowlisted labels.
 * @returns The candidate identity, or `null` when no host attribution is present.
 */
export function candidateFromAlertLabels(
  labels: Readonly<Record<string, string>>,
): TargetCandidate {
  const host = labels["host"];
  const service = labels["service"];
  if (host !== undefined && host !== "" && service !== undefined && service !== "") {
    return { kind: "service", host, service };
  }
  if (host !== undefined && host !== "") return { kind: "host", host };
  return null;
}

/**
 * Parse a Gatus endpoint name into a candidate declared identity by the naming convention:
 * `<host>/<name>` (first `/`) is a service, `host:<name>` is a host, and anything else
 * (e.g. `dns:<domain>`) is estate-level/unattributed.
 *
 * @param endpoint - The Gatus endpoint name.
 * @returns The candidate identity, or `null` when the name is estate-level.
 */
export function candidateFromEndpointName(endpoint: string): TargetCandidate {
  const slash = endpoint.indexOf("/");
  if (slash >= 0) {
    const host = endpoint.slice(0, slash);
    const service = endpoint.slice(slash + 1);
    if (host !== "" && service !== "") return { kind: "service", host, service };
    return null;
  }
  if (endpoint.startsWith("host:")) {
    const host = endpoint.slice(5);
    return host !== "" ? { kind: "host", host } : null;
  }
  return null;
}

/**
 * Resolve a candidate against the captured model by exact equality (no fall-back). A
 * service candidate must match a declared `(host, name)` pair; a host candidate must match
 * a declared host name. An unknown candidate resolves to `null`.
 *
 * @param model - The captured rendered estate model.
 * @param candidate - The parsed candidate identity, or `null`.
 * @returns The resolved declared target, or `null` when unmatched.
 */
export function resolveCandidate(
  model: WebEstateModelV2,
  candidate: TargetCandidate,
): ResolvedTarget | null {
  if (candidate === null) return null;
  if (candidate.kind === "service") {
    const declared = model.services.some(
      (s) => s.host === candidate.host && s.name === candidate.service,
    );
    return declared ? { kind: "service", host: candidate.host, service: candidate.service } : null;
  }
  const declared = model.hosts.some((h) => h.name === candidate.host);
  return declared ? { kind: "host", host: candidate.host } : null;
}

/**
 * Map a resolved declared target to its stable {@link TargetIdentity} drilldown identity
 * (`host:<name>` / `svc:<host>/<name>`), or `null` when unmatched.
 *
 * @param resolved - The resolved declared target, or `null`.
 * @returns The drilldown target identity, or `null`.
 */
export function toTargetIdentity(resolved: ResolvedTarget | null): TargetIdentity | null {
  if (resolved === null) return null;
  if (resolved.kind === "host") return { kind: "host", id: `host:${resolved.host}` };
  return { kind: "service", id: `svc:${resolved.host}/${resolved.service}` };
}
