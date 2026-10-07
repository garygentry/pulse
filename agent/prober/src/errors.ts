// agent/prober/src/errors.ts
//
// The prober error hierarchy (00-core-definitions.md §7). A base class with a stable
// string `code`, subclasses with typed context. Fail-visibility (REQ-PROBE-04): a
// per-probe execution error is caught, converted to `pulse_deep_health_up = 0`, and
// never propagated — it never crashes the prober or stalls other probes. Each subclass
// resets its prototype so `instanceof` survives the TS/ES class-extends-Error downlevel.

/** Base error for the deep-health prober. Carries a stable string `code`. */
export class ProberError extends Error {
  /** Stable, machine-matchable code. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProberError";
    this.code = code;
    Object.setPrototypeOf(this, ProberError.prototype);
  }
}

/** Malformed/unreadable mounted `prober/config.yaml`. FATAL at startup: surfaced as a
 *  failed container healthcheck (tech-spec §3.10, stack-core §3.10) — NOT a silent stop.
 *  Distinct from an ABSENT config, which is a non-event (the prober idles healthy). */
export class ProberConfigError extends ProberError {
  /** The config path that failed to parse. */
  readonly configPath: string;
  constructor(configPath: string, message: string) {
    super("PROBER_CONFIG_INVALID", message);
    this.name = "ProberConfigError";
    this.configPath = configPath;
    Object.setPrototypeOf(this, ProberConfigError.prototype);
  }
}

/** A single probe failed (unreachable, timeout, non-JSON body, JSONPath miss). CAUGHT
 *  per-probe — drives `pulse_deep_health_up = 0` (REQ-PROBE-04); never rethrown to the loop. */
export class ProbeExecutionError extends ProberError {
  /** "svc:<host>/<service>" of the failing probe. */
  readonly probeName: string;
  /** Sub-reason for observability. */
  readonly reason: "unreachable" | "timeout" | "bad-json" | "path-miss" | "http-status";
  constructor(probeName: string, reason: ProbeExecutionError["reason"], message: string) {
    super("PROBE_EXECUTION_FAILED", message);
    this.name = "ProbeExecutionError";
    this.probeName = probeName;
    this.reason = reason;
    Object.setPrototypeOf(this, ProbeExecutionError.prototype);
  }
}
