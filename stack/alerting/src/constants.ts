// stack/alerting/src/constants.ts
// Stable names and windows referenced across 02–06 (00-core-definitions.md §6).

/** AM receivers the transform emits (04). */
export const RECEIVERS = {
  /** Root fallback receiver; an unmatched alert lands here (REQ-ROUTE-04). */
  defaultOps: "pulse-default-ops",
  /** Daily info digest receiver (REQ-SEV-04). */
  digest: "pulse-digest",
  /** Automation-webhook mirror; `send_resolved: true` (REQ-HOOK-01). */
  webhookMirror: "pulse-webhook-mirror",
  /** Independent external dead-man receiver (REQ-DEAD-01/03). */
  deadman: "pulse-deadman",
} as const;

/** Grouping/identity label names (REQ-ROUTE-02, REQ-RULE-04). AM `group_by`. */
export const GROUP_BY = ["estate", "host", "service", "alertname"] as const;

/** Engine-injected external label carrying estate identity (REQ-RULE-04; stack-core dependency §6.3). */
export const ESTATE_LABEL = "estate" as const;

/** Timing windows realized on the AM route tree (04). */
export const TIMING = {
  /** Critical group_wait — satisfies the ≤30s routing budget (REQ-SEV-02, REQ-PERF-02). */
  criticalGroupWait: "10s",
  /** Critical repeat cadence while firing (REQ-SEV-06). */
  criticalRepeatInterval: "30m",
  /** Warning grouping window (REQ-SEV-03). */
  warningGroupInterval: "15m",
  /** Dead-man send cadence — heartbeat every 5m (REQ-DEAD-02). */
  deadmanRepeatInterval: "5m",
  /** Dead-man group_interval. */
  deadmanGroupInterval: "1m",
  /** Info digest delivery time, estate-local (REQ-SEV-04). */
  digestTime: "09:00",
} as const;

/** Static-rule detection windows (`for:` / miss windows — 02). */
export const RULE_WINDOWS = {
  /** HostDown: three missed 30s scrapes (REQ-AVAIL-01). */
  hostDownFor: "90s",
  /** Capacity sustained-utilization window (REQ-CAP-01..03). */
  capacityFor: "15m",
  /** DeepHealthProbeFailed: `pulse_deep_health_up == 0` grace window (REQ-AVAIL-03, `02` §4.2). */
  deepHealthProbeFor: "2m",
  /** DeepHealthProbeStale: max seconds since last scrape before stale (safe-mode trap, `02` §4.2). */
  deepHealthStaleSeconds: 300,
} as const;

/** Capacity thresholds (percent) — REQ-CAP-01..03. */
export const CAPACITY_THRESHOLDS = {
  cpuPct: 90,
  memPct: 90,
  diskWarnFreePct: 20,
  diskCritFreePct: 10,
} as const;

/** host-agent metric series names the rules reference (agent-metrics-contract v1, §7 / 05). */
export const METRICS = {
  agentUp: "pulse_agent_up",
  deepHealth: "pulse_deep_health",
  deepHealthUp: "pulse_deep_health_up",
  deepHealthLastScrape: "pulse_deep_health_last_scrape_seconds",
  /** DELIVERED by the per-host command-exporter (issue #3): a service `backup_freshness.command`
   *  renders a scalar command signal emitting these `{service}`-labelled series. Previously
   *  REQUIRED-but-undelivered; the backup-freshness rule family now selects live data. */
  backupAgeSeconds: "pulse_backup_freshness_age_seconds",
  backupUp: "pulse_backup_freshness_up",
  /** Gatus's per-check result counter (`{group,key,name,success,type}`), scraped by the `gatus`
   *  job. The synthetic-check rule family pages on it (issue #1). Gatus v5.13.1 exposes no
   *  per-endpoint success gauge, so the rules work from `increase()` over this counter. */
  gatusResults: "gatus_results_total",
} as const;

/** Synthetic-check (Gatus) rule timing (issue #1) — the ONE place the check cadence, the binding
 *  threshold defaults and the rule's window factors live. The renderer sets no per-endpoint
 *  `interval`, so every Gatus ingress check runs at Gatus's default 60s — nominally. Gatus runs
 *  checks one at a time behind a global lock and waits `interval` AFTER each check finishes, so in
 *  a broad outage (many endpoints × 10s timeouts) the real cadence is slower. The windows below
 *  are sized so slow cadence DELAYS firing rather than making the alert flap.
 *
 *  For a binding with failure threshold F and success threshold S (I = checkIntervalSeconds), the
 *  rendered rule (see synthetic-rules.ts `syntheticExpr`):
 *    - fires when, within ONE window, there were ≥ F failed checks and NO passing check — tested
 *      over the nominal window F·I + `nominalWindowSlackSeconds` and over the slow-cadence window
 *      `slowWindowFactor`·F·I;
 *    - once firing, holds until, within the clear window ceil(`clearWindowFactor`·S)·I + I, there
 *      were ≥ S passing checks and NO failed check. With no fresh results (Gatus down) nothing
 *      clears it.
 *  The threshold defaults are the retired Gatus provider's `default-alert` values. */
export const GATUS_CHECKS = {
  /** Gatus's default endpoint interval (the renderer emits none). */
  checkIntervalSeconds: 60,
  /** Failed checks needed to fire when a binding omits `failureThreshold`. */
  defaultFailureThreshold: 3,
  /** Passing checks needed to resolve when a binding omits `successThreshold`. */
  defaultSuccessThreshold: 2,
  /** Slack on the nominal fire window for the 30s scrape: F checks at the nominal cadence span
   *  (F−1)·I, and the window must reach past the F-th failure's scrape yet exclude the last pass. */
  nominalWindowSlackSeconds: 30,
  /** The slow-cadence fire window is this many times the nominal F checks: F failures with no pass
   *  still fit in it when checks run up to this factor slower than nominal (default 3 → 12m). */
  slowWindowFactor: 4,
  /** The clear window holds this many times S checks (rounded up) plus one interval, so S passes
   *  still fit in it when checks run somewhat slower than nominal (default 2 → 4m). */
  clearWindowFactor: 1.5,
  /** The rule group's evaluation interval, pinned in the rendered group (`interval:`) because the
   *  HOLD term below depends on it. */
  evaluationIntervalSeconds: 60,
  /** The rule reads its own firing state back from the ALERTS series vmalert remote-writes to VM.
   *  A sample up to this old still counts, so the hold survives several failed evaluations in a row
   *  (a VictoriaMetrics restart, a query timeout, a vmalert restart): 5 intervals + 30s eval delay.
   *  A resolved alert is NOT resurrected inside this bound: vmalert writes a staleness marker for
   *  ALERTS when the alert resolves, which ends the series immediately. */
  firingStateMaxAgeSeconds: 330,
} as const;

/** The DeadMansSwitch internal label value (NOT in the `Severity` union — §3). */
export const DEADMAN_SEVERITY = "deadman" as const;

/** The alert-path delivery-canary alert name (issue #17). Matched by the routing tree — like the
 *  deadman, by alertname — and routed to the LIVE human receivers to prove end-to-end delivery.
 *  Authored as the always-scheduled rule in stack/compose/config/vmalert/rules/canary.yml. */
export const CANARY_ALERT = "PulseAlertPathCanary" as const;
/** Canary re-send cadence on the live human path (issue #17) — matches the rule's ~6h fire window. */
export const CANARY_REPEAT_INTERVAL = "6h" as const;

// ── Runbook links (issue #16) ────────────────────────────────────────────────

/** Base URL for the `runbook_url` alert annotation (issue #16). Estate-agnostic, deterministic
 *  placeholder host operators repoint (DNS/reverse-proxy) at their published runbooks — see
 *  docs/operator/alerting.md. Each rule appends a per-family slug. No estate literal. */
export const RUNBOOK_BASE_URL = "https://runbooks.pulse.local" as const;

/** Per-family runbook path slugs for the DYNAMIC (inventory-derived) rule builders only. The
 *  committed static rule files bake their own `${RUNBOOK_BASE_URL}/<family>` literal per file
 *  (availability, capacity, churn, deadman, engine, pipeline-health, canary). */
export const RUNBOOK_SLUGS = {
  deepHealth: "deep-health",
  backupFreshness: "backup-freshness",
  synthetic: "synthetic",
} as const;

/** Compose the full runbook URL for a family slug (issue #16). */
export function runbookUrl(slug: string): string {
  return `${RUNBOOK_BASE_URL}/${slug}`;
}

/** In-container glob the rendered Alertmanager config registers as its notification `templates:`
 *  (issue #16). Backed by ./config/alertmanager/templates mounted at this path. */
export const AM_TEMPLATE_GLOB = "/etc/alertmanager/templates/*.tmpl" as const;

/** Named template `define`s (in pulse.tmpl) the rendered email/telegram receivers reference so a
 *  `runbook_url` annotation renders as a link in the notification body (issue #16). */
export const AM_TEMPLATES = {
  emailHtml: "pulse.email.html",
  telegramMessage: "pulse.telegram.message",
} as const;

/** Non-secret .env placeholder keys the superseding config introduces (05 / REQ-SEC-01). */
export const ENV_KEYS = {
  estateName: "PULSE_ESTATE_NAME",
  deadmanUrl: "PULSE_DEADMANSSWITCH_URL",
  /** Automation-webhook mirror receiver URL (`pulse-webhook-mirror` — REQ-HOOK-01, 04 §6). */
  webhookMirrorUrl: "PULSE_WEBHOOK_MIRROR_URL",
} as const;
