// stack/alerting/src/transform/routing.ts
// The composition root for the native Alertmanager config (04 §2/§3/§6/§7/§12). It lifts the abstract
// rendered receivers into native ones, builds the severity route tree, reconciles human-channel
// coverage, and assembles every fragment (time-intervals 005, deadman + inhibit 006) into one
// `AmNativeConfig` OBJECT — item 008's orchestrator owns the single YAML serialization.
//
// A pure module: no file I/O, no clock, and it NEVER resolves or emits a secret literal. Routing is
// the single source of truth (REQ-ROUTE-06): receivers/targets come only from the rendered routing,
// never re-derived from `Estate.channels`.

import type { AmRoutingRendered } from "./rendered.js";
import type { AmNativeReceiver, AmNativeConfig, AmRoute, AmWebhookConfig } from "./am-config.js";
import type { AlertingFinding } from "./findings.js";
import type { EstateModel, ChannelKind } from "./estate.js";
import {
  RECEIVERS,
  GROUP_BY,
  TIMING,
  ENV_KEYS,
  AM_TEMPLATE_GLOB,
  AM_TEMPLATES,
  CANARY_ALERT,
  CANARY_REPEAT_INTERVAL,
} from "../constants.js";
import { buildTimeIntervals } from "./time-intervals.js";
import { buildDeadman } from "./deadman.js";
import { buildInhibitRules } from "./inhibit.js";

/** The renderer's provider slots the transform preserves verbatim (chat→slack, email→email,
 *  telegram→telegram, push|webhook→webhook). A receiver with none of these is malformed (§2). */
const KNOWN_SLOTS = ["slack_configs", "email_configs", "telegram_configs", "webhook_configs"] as const;

/** The human channel kinds (chat/email/push/telegram); `webhook` is a non-human automation kind (§7).
 *  Telegram is a human-facing delivery channel (issue #2). */
const HUMAN_KINDS: readonly ChannelKind[] = ["chat", "email", "push", "telegram"];

/** In-stack no-op sink for the product-static default-ops/digest receivers — a valid in-stack DNS
 *  service:port (never a credential, CON-04/REQ-SEC-01) so a bring-up boots green (§3.4, bootstrap
 *  parity with the `null` sink). AM does not env-expand its config, so this is a literal in-stack URL. */
const IN_STACK_SINK_URL = "http://alertmanager:9093/-/healthy";

// ── §2 liftReceivers — strip the abstract wrapper, preserve slots + ${VAR} refs ─────────────────

/**
 * Lift each abstract `{ name, config }` receiver into a native `{ name, ...config }` receiver,
 * PRESERVING the renderer's `slack_configs`/`email_configs`/`webhook_configs` slots and their
 * `${VAR}`/`op://` credential references UNCHANGED (REQ-ROUTE-01/06, REQ-SEC-01 — never resolve a
 * ref). A receiver with no known slot → INVALID_ROUTE (error); one embedding a resolved credential
 * literal → SECRET_LITERAL (error). Both abort the whole config (REQ-CONFIG-01).
 *
 * @param rendered - The abstract routing parsed from rendered/alertmanager/routing.yaml.
 * @param findings - Accumulator.
 * @returns The native human receivers, sorted by `name` (the caller appends the product-static ones).
 */
export function liftReceivers(
  rendered: AmRoutingRendered,
  findings: AlertingFinding[],
): AmNativeReceiver[] {
  const out: AmNativeReceiver[] = [];
  for (const r of rendered.receivers) {
    const config = r.config ?? {};
    const present = KNOWN_SLOTS.filter((slot) => config[slot] !== undefined);
    if (present.length === 0) {
      findings.push({
        severity: "error",
        code: "INVALID_ROUTE",
        file: "alertmanager/routing.yaml",
        path: `receivers[name=${r.name}]`,
        message: `Receiver "${r.name}" declares no known provider slot (slack_configs/email_configs/webhook_configs).`,
        fix: "Ensure the renderer keyed the receiver config by a channel-kind slot.",
      });
      continue;
    }

    const receiver: AmNativeReceiver = { name: r.name };
    for (const slot of present) {
      const value = config[slot];
      // Preserve the renderer's slot verbatim — including ${VAR} credential refs (REQ-SEC-01).
      if (slot === "webhook_configs") receiver.webhook_configs = value as AmWebhookConfig[];
      else if (slot === "slack_configs") receiver.slack_configs = value as Record<string, unknown>[];
      // email/telegram bodies gain a runbook-link template reference (issue #16) — see withRunbookBody.
      // Telegram: also pin parse_mode to plain text ("") when we inject our message, so unescaped
      // annotation text (a stray `<`/`>`/`&`) can never make Telegram's HTML parser reject the send —
      // the bare runbook URL still auto-links in a plain message. (AM's telegram default is HTML.)
      else if (slot === "telegram_configs")
        receiver.telegram_configs = withRunbookBody(value, "message", AM_TEMPLATES.telegramMessage, {
          parse_mode: "",
        });
      else receiver.email_configs = withRunbookBody(value, "html", AM_TEMPLATES.emailHtml);
    }

    // A credential slot carrying a resolved literal (not a ${VAR}/op:// reference) leaks a secret.
    if (containsResolvedSecret(config)) {
      findings.push({
        severity: "error",
        code: "SECRET_LITERAL",
        file: "alertmanager/routing.yaml",
        path: `receivers[name=${r.name}]`,
        // Never echo the literal value into the message (REQ-SEC-02).
        message: `Receiver "${r.name}" embeds a resolved credential literal where a secret reference belongs.`,
        fix: "Replace the literal with a ${VAR} env reference or an op:// secret reference.",
      });
    }

    out.push(receiver);
  }

  out.sort(byName);
  return out;
}

/**
 * Attach a Pulse notification-body template reference to each entry of an email/telegram receiver
 * slot (issue #16) so a rule's `runbook_url` annotation renders as a link in the notification body.
 * Additive and credential-safe: it sets only the body field (`html` for email, `message` for
 * telegram) to `{{ template "<define>" . }}`, and never when the renderer already supplied one, so a
 * hand-authored override wins and the credential slot is untouched (REQ-ROUTE-06 / REQ-SEC-01).
 * `extraWhenInjected` sets additional non-credential presentation fields (e.g. telegram
 * `parse_mode`), but only when we actually inject the body and only when the field is absent, so an
 * operator-supplied value always wins.
 */
function withRunbookBody(
  value: unknown,
  bodyField: "html" | "message",
  templateName: string,
  extraWhenInjected: Record<string, unknown> = {},
): Record<string, unknown>[] {
  return asEntries(value).map((entry) => {
    if (entry[bodyField] !== undefined) return { ...entry }; // operator override wins — untouched
    const injected: Record<string, unknown> = {
      ...entry,
      [bodyField]: `{{ template "${templateName}" . }}`,
    };
    for (const [k, v] of Object.entries(extraWhenInjected)) {
      if (injected[k] === undefined) injected[k] = v; // never clobber an operator-set field
    }
    return injected;
  });
}

/** True iff a string is a secret REFERENCE (`${VAR}` or `op://…`), never a resolved literal. */
function isReference(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value) || value.startsWith("op://");
}

/** Whether any credential-bearing slot field carries a resolved literal (REQ-SEC-01). Pure-secret
 *  fields (slack `api_url`, email `auth_password`) flag any non-reference value; a webhook `url` is
 *  an endpoint, so only embedded userinfo credentials (`scheme://user:pass@…`) flag it. */
function containsResolvedSecret(config: Record<string, unknown>): boolean {
  for (const e of asEntries(config.slack_configs)) {
    const v = e.api_url;
    if (typeof v === "string" && v.length > 0 && !isReference(v)) return true;
  }
  for (const e of asEntries(config.email_configs)) {
    const v = e.auth_password;
    if (typeof v === "string" && v.length > 0 && !isReference(v)) return true;
  }
  // Telegram `bot_token` is a pure-secret field (issue #2): any non-reference value leaks a secret.
  for (const e of asEntries(config.telegram_configs)) {
    const v = e.bot_token;
    if (typeof v === "string" && v.length > 0 && !isReference(v)) return true;
  }
  for (const e of asEntries(config.webhook_configs)) {
    const v = e.url;
    if (typeof v === "string" && /:\/\/[^/@\s]+:[^/@\s]+@/.test(v)) return true;
  }
  return false;
}

/** Narrow an unknown slot value to an array of object entries (defensive against malformed input). */
function asEntries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    : [];
}

// ── §3 buildSeverityRoute — the native root + severity children ──────────────────────────────────

/**
 * Build the native root route + severity children. The critical/warning receiver targets are resolved
 * from the rendered route tree's severity matches (falling back to the rendered root, then
 * `pulse-default-ops`); the digest/default-ops/mirror receivers are product-static (constants.ts).
 *
 * @param rendered - Abstract routing (for the estate's severity→receiver targets).
 * @param quietHoursIntervalName - "quiet-hours" if the estate declares quiet hours, else undefined
 *                                 (the warning mute is attached only when declared — §3.1).
 * @param digestIntervalName - "daily-0900" (always present; the info gate).
 * @param findings - Accumulator (ROUTING_GAP, advisory, on unmatched-severity coverage — §3.4).
 * @returns The native root `AmRoute` (excluding the deadman child, appended by §12).
 */
export function buildSeverityRoute(
  rendered: AmRoutingRendered,
  quietHoursIntervalName: string | undefined,
  digestIntervalName: string,
  findings: AlertingFinding[],
): AmRoute {
  const criticalTarget = explicitSeverityTarget(rendered, "critical");
  const warningTarget = explicitSeverityTarget(rendered, "warning");
  const fallback = renderedRootReceiver(rendered) ?? RECEIVERS.defaultOps;

  // A rendered-sourced severity with no explicit target is a (non-aborting) routing gap (§3.4).
  if (criticalTarget === undefined) pushRoutingGap(findings, "critical");
  if (warningTarget === undefined) pushRoutingGap(findings, "warning");

  const children: AmRoute[] = [];

  // ---- critical: human channel; ≤30s budget, 30m repeat, bypasses quiet hours (REQ-SEV-02/06) ----
  // Inserted BEFORE the mirror so a stable sort keeps it first — AM must reach both (continue:true).
  children.push({
    receiver: criticalTarget ?? fallback,
    matchers: ['severity="critical"'],
    group_wait: TIMING.criticalGroupWait, // 10s
    group_interval: "5m",
    repeat_interval: TIMING.criticalRepeatInterval, // 30m
    continue: true, // also reach the mirror route below (REQ-HOOK-01, §6)
    // NO mute_time_intervals — critical bypasses quiet hours (REQ-ROUTE-03).
  });

  // ---- automation-webhook mirror (critical fan-out) — REQ-HOOK-01, §6 ----------------------------
  children.push({
    receiver: RECEIVERS.webhookMirror,
    matchers: ['severity="critical"'],
    group_wait: TIMING.criticalGroupWait, // 10s
    continue: false,
  });

  // ---- alert-path delivery canary (issue #17) — routed to the LIVE human receiver ----------------
  // Matched by alertname (like the deadman), so it captures the canary BEFORE the severity="info"
  // route (byMatcher sorts alertname routes ahead of severity routes) and delivers it through the
  // real email/Telegram path — proving end-to-end delivery, distinct from the deadman's webhook.
  children.push({
    receiver: criticalTarget ?? fallback,
    matchers: [`alertname="${CANARY_ALERT}"`],
    group_wait: TIMING.criticalGroupWait, // 10s — deliver promptly so a broken channel shows fast
    repeat_interval: CANARY_REPEAT_INTERVAL, // 6h — matches the rule's fire cadence
    continue: false,
  });

  // ---- warning: non-paging ops route, grouped ≤15m, deferred during quiet hours (REQ-SEV-03) -----
  const warning: AmRoute = {
    receiver: warningTarget ?? fallback,
    matchers: ['severity="warning"'],
    group_wait: "30s",
    group_interval: TIMING.warningGroupInterval, // 15m
    repeat_interval: "4h",
    continue: false,
  };
  if (quietHoursIntervalName !== undefined) {
    warning.mute_time_intervals = [quietHoursIntervalName]; // only when declared (§3.1)
  }
  children.push(warning);

  // ---- info: daily 09:00 digest, gated by the active window (REQ-SEV-04) -------------------------
  children.push({
    receiver: RECEIVERS.digest,
    matchers: ['severity="info"'],
    active_time_intervals: [digestIntervalName],
    group_interval: TIMING.warningGroupInterval, // 15m (shared grouping window)
    continue: false,
  });

  return {
    receiver: RECEIVERS.defaultOps, // root fallback — unmatched alerts land here (REQ-ROUTE-04)
    group_by: GROUP_BY,
    group_wait: "30s",
    group_interval: "5m",
    repeat_interval: "4h",
    routes: children,
  };
}

/** The rendered receiver explicitly targeting `severity` (via `match.severity` or a `severity="…"`
 *  matcher), or undefined if the rendered tree declares no explicit route for it. */
function explicitSeverityTarget(
  rendered: AmRoutingRendered,
  severity: string,
): string | undefined {
  for (const route of renderedChildRoutes(rendered)) {
    if (routeSeverity(route) !== severity) continue;
    const receiver = route.receiver;
    if (typeof receiver === "string" && receiver.length > 0) return receiver;
  }
  return undefined;
}

/** The rendered root receiver (the abstract catch-all), or undefined if unset. */
function renderedRootReceiver(rendered: AmRoutingRendered): string | undefined {
  const receiver = (rendered.route ?? {}).receiver;
  return typeof receiver === "string" && receiver.length > 0 ? receiver : undefined;
}

/** The child routes of the rendered route tree, as objects (defensive against malformed input). */
function renderedChildRoutes(rendered: AmRoutingRendered): Record<string, unknown>[] {
  return asEntries((rendered.route ?? {}).routes);
}

/** The severity a rendered child route matches — `match: { severity }` or a `severity="…"` matcher. */
function routeSeverity(route: Record<string, unknown>): string | undefined {
  const match = route.match;
  if (match !== null && typeof match === "object") {
    const sev = (match as Record<string, unknown>).severity;
    if (typeof sev === "string") return sev;
  }
  if (Array.isArray(route.matchers)) {
    for (const m of route.matchers) {
      if (typeof m !== "string") continue;
      const mm = /^severity\s*=~?\s*"?([A-Za-z]+)"?$/.exec(m.trim());
      if (mm) return mm[1];
    }
  }
  return undefined;
}

function pushRoutingGap(findings: AlertingFinding[], severity: string): void {
  findings.push({
    severity: "inconsistency",
    code: "ROUTING_GAP",
    file: "alertmanager/routing.yaml",
    path: `route.routes[severity=${severity}]`,
    message: `The rendered routing declares no ${severity} receiver; ${severity} alerts fall back to ${RECEIVERS.defaultOps}.`,
    fix: `Declare a ${severity} channel in the estate routing, or opt into a webhook-only policy.`,
  });
}

// ── §7 reconcileHumanCoverage — critical human coverage vs webhook-only policy ──────────────────

/**
 * Reconcile the critical route against the estate's human-channel coverage (REQ-ROUTE-05 × REQ-SEV-02):
 *  - a human critical channel present (chat/email/push)  → no finding (the common case).
 *  - NO human channel but a webhook channel declared     → WEBHOOK_ONLY_CRITICAL (improvement): the
 *    mirror satisfies the critical route; the human-less path stays operator-visible.
 *  - NO human channel and NO webhook policy              → NO_HUMAN_CHANNEL (error): fails validation.
 *
 * Reads the estate channel inventory as the human-coverage signal; routing targets still come from
 * the rendered tree (REQ-ROUTE-06). `rendered` is accepted for symmetry with the assembly seam.
 *
 * @param estate   - Read for the channel inventory / webhook-only declaration.
 * @param rendered - Read for the critical severity target (informational).
 * @param findings - Accumulator.
 */
export function reconcileHumanCoverage(
  estate: EstateModel,
  rendered: AmRoutingRendered,
  findings: AlertingFinding[],
): void {
  void rendered; // routing targets come from the rendered tree; coverage is an estate-inventory check.
  const hasHuman = estate.channels.some((c) => HUMAN_KINDS.includes(c.kind));
  if (hasHuman) return; // human critical channel present — no finding (§7).

  const hasWebhook = estate.channels.some((c) => c.kind === "webhook");
  if (hasWebhook) {
    findings.push({
      severity: "improvement",
      code: "WEBHOOK_ONLY_CRITICAL",
      file: "estate",
      path: "estate.channels",
      message:
        "Estate declares no human channel; the critical path is satisfied by the automation-webhook mirror only.",
      fix: "Declare a human channel (chat/email/push), or keep the webhook-only policy intentionally.",
    });
    return;
  }

  findings.push({
    severity: "error",
    code: "NO_HUMAN_CHANNEL",
    file: "estate",
    path: "estate.channels",
    message:
      "Estate declares no human channel and no webhook-only policy; critical alerts have no destination.",
    fix: "Declare a human channel (chat/email/push), or opt into a webhook-only policy.",
  });
}

// ── §3.4/§3.1/§6 product-static receivers ───────────────────────────────────────────────────────

/** `pulse-default-ops` — the root fallback webhook sink (in-stack no-op default, boots green). */
function pulseDefaultOpsReceiver(): AmNativeReceiver {
  return {
    name: RECEIVERS.defaultOps,
    webhook_configs: [{ url: IN_STACK_SINK_URL, send_resolved: false }],
  };
}

/** `pulse-digest` — the daily info digest sink; `send_resolved: false` (info sends no resolved). */
function pulseDigestReceiver(): AmNativeReceiver {
  return {
    name: RECEIVERS.digest,
    webhook_configs: [{ url: IN_STACK_SINK_URL, send_resolved: false }],
  };
}

/** `pulse-webhook-mirror` — the automation mirror; `send_resolved: true` (firing AND resolved). */
function pulseWebhookMirrorReceiver(): AmNativeReceiver {
  return {
    name: RECEIVERS.webhookMirror,
    webhook_configs: [{ url: `\${${ENV_KEYS.webhookMirrorUrl}}`, send_resolved: true }],
  };
}

// ── §12 buildAlertmanagerConfig — deterministic assembly ────────────────────────────────────────

/**
 * Compose every fragment into one `AmNativeConfig` in the deterministic order of §12. Returns null if
 * ANY error-severity finding was pushed (whole-or-nothing, REQ-CONFIG-01); item 008 then sets the
 * serialized config to "" and writes nothing.
 *
 * @param input    - `{ estate, routing }` — the validated estate model + the abstract rendered routing.
 * @param findings - Accumulator shared with every fragment generator.
 * @returns The assembled config with every collection stably sorted, or null on any error finding.
 */
export function buildAlertmanagerConfig(
  input: { estate: EstateModel; routing: AmRoutingRendered },
  findings: AlertingFinding[],
): AmNativeConfig | null {
  const { estate, routing } = input;

  // 1. Lift the abstract human receivers (sorted by name).
  const humanReceivers = liftReceivers(routing, findings);
  // 2. Time intervals (quiet-hours mute + daily-0900 digest window).
  const { intervals, quietHoursName, digestName } = buildTimeIntervals(estate.estate, findings);
  // 3. Severity route tree + human-coverage reconciliation.
  const route = buildSeverityRoute(routing, quietHoursName, digestName, findings);
  reconcileHumanCoverage(estate, routing, findings);
  // 4. DeadMansSwitch route (appended under root) + pulse-deadman receiver.
  const deadman = buildDeadman(estate.estate, findings);
  route.routes = [...(route.routes ?? []), deadman.route];
  // 5. Product-static receivers.
  const staticReceivers = [
    pulseDefaultOpsReceiver(),
    pulseDigestReceiver(),
    pulseWebhookMirrorReceiver(),
  ];
  // 6. Inhibit rules (already sorted by a stable key inside buildInhibitRules).
  const { rules: inhibitRules } = buildInhibitRules(estate, findings);

  // Whole-or-nothing: any error finding aborts the config (REQ-CONFIG-01).
  if (findings.some((f) => f.severity === "error")) return null;

  // 7. Sort every generated collection by a stable key; emit no clock-derived value.
  const receivers = [...humanReceivers, deadman.receiver, ...staticReceivers].sort(byName);
  route.routes = [...route.routes].sort(byMatcher);
  const timeIntervals = [...intervals].sort(byName);

  return {
    global: { resolve_timeout: "5m" },
    // Register the runbook-link notification templates (issue #16); email/telegram receiver bodies
    // reference them. Backed by ./config/alertmanager/templates mounted at AM_TEMPLATE_GLOB's dir.
    templates: [AM_TEMPLATE_GLOB],
    route,
    receivers,
    time_intervals: timeIntervals,
    inhibit_rules: inhibitRules,
  };
}

/** Stable ascending comparator over a named collection member (receivers, time intervals). */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Stable ascending comparator over a route's matcher set (deterministic route order, §12). A stable
 *  sort keeps same-matcher siblings (critical human before mirror) in their inserted order. */
function byMatcher(a: AmRoute, b: AmRoute): number {
  const ka = JSON.stringify(a.matchers ?? []);
  const kb = JSON.stringify(b.matchers ?? []);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
