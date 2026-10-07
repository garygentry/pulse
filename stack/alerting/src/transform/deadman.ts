// stack/alerting/src/transform/deadman.ts
// The dedicated DeadMansSwitch route + `pulse-deadman` receiver (04 §5, REQ-DEAD-01..04,
// REQ-SUPP-04). The always-firing `vector(1)` rule is authored in the static `deadman.yml` (02);
// this fragment owns the ROUTE that carries `alertname="DeadMansSwitch"` out of the default sink to
// an independently hosted dead-man service, and the receiver that posts to it.
//
// A pure fragment generator: no file I/O, no clock, and it NEVER resolves or emits a secret literal.
// The receiver URL is ALWAYS the `${PULSE_DEADMANSSWITCH_URL}` env reference (ENV_KEYS.deadmanUrl),
// resolved by compose/deploy substitution (AM does not env-expand its config file — §13).

import type { Estate, SecretRef } from "./estate.js";
import { isSecretRef } from "./estate.js";
import type { AmRoute, AmNativeReceiver } from "./am-config.js";
import type { AlertingFinding } from "./findings.js";
import { RECEIVERS, TIMING, ENV_KEYS } from "../constants.js";

/** The one alertname the deadman route carries (§5.1). The `deadman` label value is intentionally
 *  outside the `Severity` union (00 §3), so a DeadMansSwitch alert is structurally unreachable by any
 *  `severity=` matcher. */
const DEADMAN_ALERTNAME = "DeadMansSwitch";

/**
 * Classify `estate.deadmanHook` (REQ-SEC-01):
 *  - a `SecretRef` object            → a proper reference (`env`/`op`) — OK.
 *  - a `${VAR}` / `op://` string     → a reference — OK.
 *  - a plain identifier (no scheme)  → a non-credential identifier — OK (core allows this, §3.1).
 *  - a raw URL/token literal         → a RESOLVED LITERAL — SECRET_LITERAL (never committed).
 *  - missing/empty                   → INVALID_ROUTE.
 */
type HookClass = "reference" | "literal" | "missing";

function classifyDeadmanHook(hook: SecretRef | string): HookClass {
  if (isSecretRef(hook)) return "reference";
  const value = hook.trim();
  if (value.length === 0) return "missing";
  // `${VAR}` env reference or an `op://…` secret reference — both are references, never literals.
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value) || value.startsWith("op://")) {
    return "reference";
  }
  // A raw URL with an embedded credential (e.g. `https://…?token=…`) is a resolved literal — any
  // `<scheme>://` that is not the `op://` reference form counts (04 §5.2).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return "literal";
  // A bare, scheme-less identifier is an intentional non-credential hook name — accepted as-is.
  return "reference";
}

/**
 * Build the DeadMansSwitch route + `pulse-deadman` receiver from `Estate.deadmanHook`. The route is
 * appended under the root by routing.ts (§12); the receiver is appended to the config receivers.
 * Independent of every human channel (REQ-DEAD-03): a distinct receiver with its own matcher route
 * and `continue: false`, never composed with a human severity route.
 *
 * The emitted URL is ALWAYS `${PULSE_DEADMANSSWITCH_URL}` — the hook's own value is validated only,
 * never copied into the config, so no literal can leak (REQ-SEC-01).
 *
 * @param estate   - Reads `estate.deadmanHook` (SecretRef | string).
 * @param findings - Accumulator: SECRET_LITERAL (error) for a resolved literal; INVALID_ROUTE (error)
 *                   for a missing/empty hook. Both abort the whole config (REQ-CONFIG-01).
 * @returns The deadman child route and the `pulse-deadman` receiver.
 */
export function buildDeadman(
  estate: Estate,
  findings: AlertingFinding[],
): { route: AmRoute; receiver: AmNativeReceiver } {
  const kind = classifyDeadmanHook(estate.deadmanHook);
  if (kind === "literal") {
    findings.push({
      severity: "error",
      code: "SECRET_LITERAL",
      file: "estate",
      path: "estate.deadmanHook",
      // Never echo the literal value into the message (REQ-SEC-02).
      message:
        "estate.deadmanHook is a resolved literal (a raw URL/token) where a secret reference belongs.",
      fix: `Replace the literal with a reference such as \${${ENV_KEYS.deadmanUrl}} or an op:// ref.`,
    });
  } else if (kind === "missing") {
    findings.push({
      severity: "error",
      code: "INVALID_ROUTE",
      file: "estate",
      path: "estate.deadmanHook",
      message: "estate.deadmanHook is missing or empty; the DeadMansSwitch receiver cannot be routed.",
      fix: `Declare estate.deadmanHook as a reference such as \${${ENV_KEYS.deadmanUrl}}.`,
    });
  }

  const route: AmRoute = {
    receiver: RECEIVERS.deadman,
    matchers: [`alertname="${DEADMAN_ALERTNAME}"`],
    group_wait: "0s", // heartbeat starts immediately on (re)start (REQ-DEAD-02)
    group_interval: TIMING.deadmanGroupInterval, // 1m
    repeat_interval: TIMING.deadmanRepeatInterval, // 5m — send every 5m (REQ-DEAD-02)
    continue: false, // never falls through to human routes (REQ-DEAD-03)
  };

  const receiver: AmNativeReceiver = {
    name: RECEIVERS.deadman,
    webhook_configs: [
      {
        url: `\${${ENV_KEYS.deadmanUrl}}`, // ${PULSE_DEADMANSSWITCH_URL} — runtime ref (REQ-SEC-01)
        send_resolved: false, // a heartbeat has no "resolved" state
      },
    ],
  };

  return { route, receiver };
}
