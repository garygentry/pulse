// src/server/snapshot/match.ts — alert→target and check→target identity matching
// (OQ-02). Pure, side-effect-free.
//
// Canonical identity = the DECLARED names. The join key is `host = WebEstateHost.name` and
// `(host, service) = (WebEstateService.host, WebEstateService.name)`. Matching is exact string
// equality against declared targets — no fuzzy matching, no normalization. DeadMansSwitch is
// dropped entirely (never colours, never listed). An alert/check with no declared match is
// unattributed (listed in the strip with `target: null`; colours/details nothing).

import { DEADMANS_SWITCH_ALERTNAME } from "../../shared/constants.js";
import type { ActiveAlert, CheckResult } from "../../shared/snapshot.js";
import type { WebEstateModel } from "@pulse/renderer";
import type { RawActiveAlert, RawCheckStatus } from "../sources/types.js";

/** Composite service key — NUL separator (no declared name contains NUL). §2.4. */
export function serviceKey(host: string, service: string): string {
  return `${host}\0${service}`;
}

/** Result of matching every active alert against the declared estate. */
export interface MatchedAlerts {
  /** Every non-DeadMansSwitch alert as an `ActiveAlert`; `target` is the matched declared identity
   *  or `null` (unattributed). Drives the strip (§8). */
  all: ActiveAlert[];
  /** Alerts attributed to a declared host, keyed by host name (cell colouring). */
  byHost: Map<string, ActiveAlert[]>;
  /** Alerts attributed to a declared service, keyed by `${host}\0${service}` (cell colouring). */
  byService: Map<string, ActiveAlert[]>;
}

/** A candidate declared identity parsed from an alert's/check's labels or endpoint name. */
type Candidate =
  | { kind: "service"; host: string; service: string }
  | { kind: "host"; host: string }
  | null;

/**
 * Parse a Gatus-style endpoint name into a candidate declared identity (§4.1 step 4 / §4.2):
 * `<host>/<name>` (first `/`) → service; `host:<name>` → host; anything else (`dns:<domain>`) → none.
 */
function parseEndpoint(endpoint: string): Candidate {
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
  return null; // dns:<domain> or anything else — estate-level / unattributed.
}

/** Resolve a candidate against the declared estate — exact equality, no fall-back to a broader scope. */
function resolveCandidate(
  model: WebEstateModel,
  candidate: Candidate,
): { kind: "host" | "service"; id: string; host: string; service?: string } | null {
  if (candidate === null) return null;
  if (candidate.kind === "service") {
    const service = model.services.find(
      (item) => item.host === candidate.host && item.name === candidate.service,
    );
    return service === undefined
      ? null
      : { kind: "service", id: service.drilldownId, host: candidate.host, service: candidate.service };
  }
  const host = model.hosts.find((item) => item.name === candidate.host);
  return host === undefined ? null : { kind: "host", id: host.drilldownId, host: candidate.host };
}

/**
 * Match active alerts to declared targets by the identity convention (§4.1). DeadMansSwitch is
 * dropped entirely. An alert with no declared match is `all`-listed with `target: null` and appears
 * in neither `byHost` nor `byService`.
 */
export function matchAlerts(model: WebEstateModel, raw: RawActiveAlert[]): MatchedAlerts {
  const all: ActiveAlert[] = [];
  const byHost = new Map<string, ActiveAlert[]>();
  const byService = new Map<string, ActiveAlert[]>();

  for (const r of raw) {
    // 1. DeadMansSwitch drop — never colours, never listed.
    if (r.labels.alertname === DEADMANS_SWITCH_ALERTNAME) continue;

    // 2-4. Determine the candidate (first match wins).
    let candidate: Candidate;
    if (r.labels.host !== undefined && r.labels.service !== undefined) {
      candidate = { kind: "service", host: r.labels.host, service: r.labels.service };
    } else if (r.labels.host !== undefined) {
      candidate = { kind: "host", host: r.labels.host };
    } else if (r.labels.endpoint !== undefined) {
      candidate = parseEndpoint(r.labels.endpoint);
    } else {
      candidate = null;
    }

    const target = resolveCandidate(model, candidate);

    const severity = ((): ActiveAlert["severity"] => {
      const s = r.labels.severity;
      return s === "critical" || s === "warning" || s === "info" ? s : "info"; // unknown → info
    })();

    const alert: ActiveAlert = {
      fingerprint: r.fingerprint,
      name: r.labels.alertname ?? "",
      severity,
      startsAt: r.startsAt,
      target: target === null ? null : { kind: target.kind, id: target.id },
      ...(r.annotations.summary !== undefined ? { summary: r.annotations.summary } : {}),
    };

    all.push(alert);
    if (target !== null) {
      if (target.kind === "service" && target.service !== undefined) {
        const key = serviceKey(target.host, target.service);
        (byService.get(key) ?? byService.set(key, []).get(key)!).push(alert);
      } else {
        (byHost.get(target.host) ?? byHost.set(target.host, []).get(target.host)!).push(alert);
      }
    }
  }

  return { all, byHost, byService };
}

/** Check results attributed to declared targets (supporting detail only, REQ-STATE-04). */
export interface MatchedChecks {
  /** Keyed by host name — endpoint `host:<name>`. */
  byHost: Map<string, CheckResult[]>;
  /** Keyed by `${host}\0${service}` — endpoint `<host>/<name>`. */
  byService: Map<string, CheckResult[]>;
}

/**
 * Attribute Gatus endpoint statuses to declared targets by endpoint-name convention (§4.2).
 * `dns:<domain>` endpoints are estate-level and excluded from both maps. An endpoint whose parsed
 * identity is undeclared is dropped (a check with no declared owner colours and details nothing).
 */
export function matchChecks(model: WebEstateModel, raw: RawCheckStatus[]): MatchedChecks {
  const byHost = new Map<string, CheckResult[]>();
  const byService = new Map<string, CheckResult[]>();

  for (const r of raw) {
    const target = resolveCandidate(model, parseEndpoint(r.name));
    if (target === null) continue;

    const check: CheckResult = {
      endpoint: r.name,
      success: r.latest?.success ?? false,
      lastEvaluatedAt: r.latest?.timestamp ?? "", // "" only when never evaluated (latest === null)
      ...(r.latest?.durationMs !== undefined ? { responseTimeMs: r.latest.durationMs } : {}),
    };

    if (target.kind === "service" && target.service !== undefined) {
      const key = serviceKey(target.host, target.service);
      (byService.get(key) ?? byService.set(key, []).get(key)!).push(check);
    } else {
      (byHost.get(target.host) ?? byHost.set(target.host, []).get(target.host)!).push(check);
    }
  }

  return { byHost, byService };
}
