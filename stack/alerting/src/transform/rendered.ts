// stack/alerting/src/transform/rendered.ts
// Local mirror of the renderer's alertmanager/routing.yaml + prober/config.yaml output shapes.
// These are NOT imported from @pulse/renderer (its barrel exports none of them — 00 §2.1, verified).
// Canonical shape: stack-core 00-core-definitions.md §4.3.

/** One abstract receiver as emitted into rendered/alertmanager/routing.yaml. */
export interface AmReceiver {
  /** Receiver name referenced by the abstract route tree. */
  name: string;
  /** Provider-native receiver config (e.g. `slack_configs`, `email_configs`, `webhook_configs`). */
  config: Record<string, unknown>;
}

/** The abstract routing document AM does NOT read directly (stack-core mounts the bootstrap instead). */
export interface AmRoutingRendered {
  /** Abstract route tree: `{ receiver, routes: [{ continue, match: { severity }, receiver }] }`. */
  route: Record<string, unknown>;
  /** Declared receivers, already sorted by the renderer (determinism, invariant 3). */
  receivers: AmReceiver[];
}

/** One entry in the rendered prober/config.yaml (`{ probes: ProberEntry[] }`). */
export interface ProberEntry {
  /** `svc:<host>/<service>` for deep-health, `svc:<host>/<service>#backup` for backup-freshness. */
  name: string;
  /** Probe target (endpoint/URL). */
  target: string;
  /** `"deep-health"` | `"backup-freshness"` | … — the transform reads only these two kinds. */
  kind: string;
  /** Deep-health JSON→metric mapping (deep-health kind only). */
  responseMapping?: Record<string, string>;
  /** Per-service functional deep-health expression (deep-health kind only — REQ-AVAIL-02). */
  alertExpression?: string;
  /** Secret reference for an authenticated probe; never resolved by alerting. */
  credential?: string;
  /** Per-service backup max-age threshold (backup-freshness kind only — REQ-BACKUP-01). */
  threshold?: string;
  /** Optional human note. */
  note?: string;
}

/** Parsed rendered/prober/config.yaml. */
export interface ProberConfigRendered {
  probes: ProberEntry[];
}
